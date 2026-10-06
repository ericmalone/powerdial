// Payment tracking on funded deals: ACH payments / NSFs, behind-on-payments alerts, bulk CSV import
const express = require('express');
const { db, getSetting, audit } = require('./db');
const now = () => Date.now();
const r2 = n => Math.round(n * 100) / 100;
const day = ms => { const d = new Date(ms); d.setHours(12, 0, 0, 0); return d.getTime(); };

module.exports = function payments(ctx) {
  const { emitTo, emitAll, log, adminOnly } = ctx;
  const r = express.Router();
  const D = () => ctx.deals;

  // how many scheduled payments should have happened since funding (day after funding onward, weekdays for daily)
  function scheduledCount(d, until = new Date()) {
    if (!d.funded_at) return 0;
    const t = new Date(d.funded_at); t.setHours(0, 0, 0, 0);
    if (d.payment_freq === 'weekly') return Math.max(0, Math.floor((until - t) / (7 * 864e5)));
    let n = 0; for (const x = new Date(t.getTime() + 864e5); x <= until; x.setDate(x.getDate() + 1)) if (x.getDay() % 6) n++;
    return n;
  }
  function summary(d) {
    const rows = db.prepare('SELECT * FROM payments WHERE deal_id=? ORDER BY paid_on DESC, id DESC').all(d.id);
    const received = r2(rows.filter(x => x.kind !== 'nsf').reduce((a, x) => a + x.amount, 0));
    const nsfs = rows.filter(x => x.kind === 'nsf'), nsf30 = nsfs.filter(x => x.paid_on > now() - 30 * 864e5).length;
    const last = rows.find(x => x.kind === 'payment');
    const cnt = scheduledCount(d), expected = d.payment_amount ? Math.min(d.payback || Infinity, cnt * d.payment_amount) : null;
    const shortfall = expected != null ? Math.max(0, r2(expected - received)) : null;
    const missed = d.payment_amount && shortfall != null ? Math.floor(shortfall / d.payment_amount + 0.02) : null;
    const limit = Math.max(1, Number(getSetting('behind_after', 2)) || 2);
    let status = 'no_data';
    if (d.payback && received >= d.payback * 0.999) status = 'paid_off';
    else if (rows.length && missed != null) status = missed >= limit ? 'behind' : 'current';
    return { rows, received, expected: expected == null ? null : r2(expected), shortfall, missed, nsf_total: nsfs.length, nsf_30: nsf30, last_payment_on: last ? last.paid_on : null, last_amount: last ? last.amount : null, status, outstanding: d.payback ? Math.max(0, r2(d.payback - received)) : null, limit };
  }
  function recompute(dealId, who) {
    const d = D().getDeal(dealId); if (!d || d.stage !== 'funded' || !d.payback) return null;
    const s = summary(d), prev = d.pay_status || '';
    if (s.status !== prev) {
      const f = { pay_status: s.status }; if (s.status === 'behind') f.behind_alert_at = now();
      db.prepare(`UPDATE deals SET ${Object.keys(f).map(k => k + '=?').join(',')} WHERE id=?`).run(...Object.values(f), d.id);
      const lead = db.prepare('SELECT business,name FROM leads WHERE id=?').get(d.lead_id) || {}, who2 = lead.business || lead.name || d.title;
      if (s.status === 'behind') {
        D().event(d.id, null, 'payment', `Behind on payments — about ${s.missed} missed (${'$' + Math.round(s.shortfall).toLocaleString('en-US')} short)`);
        const text = `${who2} is behind on payments (${s.missed} missed)`;
        if (d.owner_id) emitTo(d.owner_id, 'deal_alert', { dealId: d.id, text });
        for (const a of db.prepare("SELECT id FROM users WHERE role='admin' AND active=1 AND id!=?").all(d.owner_id || 0)) emitTo(a.id, 'deal_alert', { dealId: d.id, text });
      } else if (s.status === 'paid_off') D().event(d.id, null, 'payment', 'Paid in full');
      else if (prev === 'behind' && s.status === 'current') D().event(d.id, null, 'payment', 'Back on track with payments');
      emitAll('deal_update', { dealId: d.id, leadId: d.lead_id });
    }
    return s;
  }
  function checkAll() { for (const x of db.prepare("SELECT d.id FROM deals d WHERE d.stage='funded' AND d.funded_at IS NOT NULL AND d.payback>0 AND (d.lender_id IS NULL OR d.lender_id IN (SELECT id FROM lenders WHERE in_house=1))").all()) { try { recompute(x.id); } catch (e) { log('Payment check error:', e.message); } } }
  setTimeout(checkAll, 8000); setInterval(checkAll, Number(process.env.PAYMENT_CHECK_MINUTES || 60) * 60000).unref();

  const parseDate = v => { if (!v) return day(now()); const s = String(v).trim(); const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/); let d; if (m) d = new Date(+(m[3].length === 2 ? '20' + m[3] : m[3]), +m[1] - 1, +m[2]); else d = new Date(s.length <= 10 ? s + 'T12:00:00' : s); return isNaN(d) ? null : day(d.getTime()); };
  const kindOf = v => { const s = String(v || '').toLowerCase(); return /nsf|return|reject|bounce|fail|insufficient|r0\d/.test(s) ? 'nsf' : /adjust|credit|correct/.test(s) ? 'adjust' : 'payment'; };
  const amt = v => { const n = Number(String(v == null ? '' : v).replace(/[$,\s()]/g, '')); return isNaN(n) ? null : Math.abs(n); };
  function add(dealId, f, userId) {
    db.prepare('INSERT INTO payments(deal_id,paid_on,amount,kind,note,user_id,created_at) VALUES(?,?,?,?,?,?,?)').run(dealId, f.paid_on, f.amount, f.kind, String(f.note || '').slice(0, 200), userId || null, now());
  }
  const csvSplit = line => { const out = []; let cur = '', q = false; for (const c of line) { if (c === '"') q = !q; else if (c === ',' && !q) { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return out.map(x => x.trim()); };

  r.get('/api/deals/:id/payments', (req, res) => {
    const d = D().getDeal(Number(req.params.id)); if (!d) return res.status(404).json({ error: 'Deal not found' });
    res.json({ funded: d.stage === 'funded', ...summary(d) });
  });
  r.post('/api/deals/:id/payments', (req, res) => {
    const d = D().getDeal(Number(req.params.id)); if (!d) return res.status(404).json({ error: 'Deal not found' });
    const paid_on = parseDate(req.body.paid_on), amount = amt(req.body.amount), kind = ['payment', 'nsf', 'adjust'].includes(req.body.kind) ? req.body.kind : 'payment';
    if (paid_on == null) return res.status(400).json({ error: 'Date not understood' });
    if (amount == null || (!amount && kind !== 'nsf')) return res.status(400).json({ error: 'Enter the amount' });
    add(d.id, { paid_on, amount: kind === 'nsf' && !amount ? (d.payment_amount || 0) : amount, kind, note: req.body.note }, req.user.id);
    D().event(d.id, req.user.id, 'payment', `${kind === 'nsf' ? 'NSF / returned payment' : kind === 'adjust' ? 'Adjustment' : 'Payment received'} ${'$' + Math.round(amount).toLocaleString('en-US')}${req.body.note ? ' — ' + req.body.note : ''}`);
    recompute(d.id); res.json({ ok: true });
  });
  r.delete('/api/payments/:id', (req, res) => {
    const p = db.prepare('SELECT * FROM payments WHERE id=?').get(Number(req.params.id)); if (!p) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM payments WHERE id=?').run(p.id); audit(req, 'payment.delete', 'deal', p.deal_id, `${p.kind} ${p.amount}`); recompute(p.deal_id); res.json({ ok: true });
  });
  // CSV: per-deal (date,amount[,type[,note]]) or all deals (deal id or business name column required)
  function importCsv(text, forDeal, userId) {
    const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean); if (!lines.length) return { added: 0, skipped: 0, unmatched: [] };
    let head = csvSplit(lines[0]).map(h => h.toLowerCase()), hasHead = head.some(h => /date|amount|deal|business|merchant|type|status/.test(h));
    const idx = names => head.findIndex(h => names.some(n => h.includes(n)));
    let iDate, iAmt, iKind, iNote, iDeal, iBiz;
    if (hasHead) { iDate = idx(['date', 'paid', 'debit']); iAmt = idx(['amount', 'amt', 'payment']); iKind = idx(['type', 'status', 'kind', 'result']); iNote = idx(['note', 'memo', 'desc']); iDeal = idx(['deal id', 'deal_id', 'deal']); iBiz = idx(['business', 'merchant', 'company', 'name']); if (iAmt === iDate) iAmt = head.findIndex((h, i) => i !== iDate && /amount|amt/.test(h)); }
    else { iDate = 0; iAmt = 1; iKind = 2; iNote = 3; iDeal = -1; iBiz = -1; }
    let added = 0, skipped = 0; const unmatched = new Set(), touched = new Set();
    const funded = db.prepare("SELECT d.id, l.business, l.name FROM deals d JOIN leads l ON l.id=d.lead_id WHERE d.stage='funded'").all();
    db.transaction(() => {
      for (const line of lines.slice(hasHead ? 1 : 0)) {
        const c = csvSplit(line); let dealId = forDeal;
        if (!dealId) {
          if (iDeal >= 0 && c[iDeal] && /^\d+$/.test(c[iDeal])) dealId = Number(c[iDeal]);
          else if (iBiz >= 0 && c[iBiz]) { const nm = c[iBiz].toLowerCase(); const m = funded.filter(f => (f.business || '').toLowerCase() === nm || (f.name || '').toLowerCase() === nm); if (m.length === 1) dealId = m[0].id; else { unmatched.add(c[iBiz]); continue; } }
          else { skipped++; continue; }
          if (!funded.some(f => f.id === dealId)) { unmatched.add(String(c[iDeal] || c[iBiz])); continue; }
        }
        const paid_on = parseDate(c[iDate]), amount = amt(c[iAmt]), kind = kindOf(iKind >= 0 ? c[iKind] : '');
        if (paid_on == null || amount == null) { skipped++; continue; }
        if (db.prepare('SELECT 1 FROM payments WHERE deal_id=? AND paid_on=? AND amount=? AND kind=?').get(dealId, paid_on, amount, kind)) { skipped++; continue; }
        add(dealId, { paid_on, amount, kind, note: iNote >= 0 ? c[iNote] : '' }, userId); added++; touched.add(dealId);
      }
    })();
    for (const id of touched) { D().event(id, userId, 'payment', 'Payments imported from file'); recompute(id); }
    return { added, skipped, unmatched: [...unmatched].slice(0, 30) };
  }
  r.post('/api/deals/:id/payments/import', (req, res) => { const d = D().getDeal(Number(req.params.id)); if (!d) return res.status(404).json({ error: 'Deal not found' }); res.json(importCsv(req.body.text, d.id, req.user.id)); });
  r.post('/api/payments/import', adminOnly, (req, res) => { const o = importCsv(req.body.text, null, req.user.id); audit(req, 'payments.import', 'payments', null, `${o.added} added`); res.json(o); });
  r.post('/api/payments/check', adminOnly, (req, res) => { checkAll(); res.json({ ok: true }); });

  // data for the Portfolio report
  function portfolio() {
    const deals = db.prepare("SELECT d.*, l.business lead_business, l.name lead_name, l.phone lead_phone, u.name owner_name, ln.name lender_name FROM deals d JOIN leads l ON l.id=d.lead_id LEFT JOIN users u ON u.id=d.owner_id LEFT JOIN lenders ln ON ln.id=d.lender_id WHERE d.stage='funded' AND d.funded_at IS NOT NULL AND d.payback>0 AND (d.lender_id IS NULL OR d.lender_id IN (SELECT id FROM lenders WHERE in_house=1)) ORDER BY d.funded_at DESC").all();
    return deals.map(d => { const s = summary(d); return { d, s }; });
  }
  return { router: r, summary, recompute, checkAll, portfolio, scheduledCount };
};
