// Money flow (MCA Pilot style): funder pays the house a commission on each funded deal -> the house pays its
// originator / closer / partner their split -> whatever is left is profit.
//   funder_payments : what the funder owes / paid us (outstanding | received)
//   distributions   : what we owe each rep / partner out of that payment (pending | paid)
//   advances        : funded deals with paid-in %, funder, originator, closer, status
//   export          : CSV downloads
const express = require('express');
const { db, audit } = require('./db');

const DAY = 864e5, now = () => Date.now();
const round2 = n => Math.round(n * 100) / 100;

function ensureCol(table, col, type) { try { if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch (e) { console.error('ensureCol', table, col, e.message); } }

module.exports = function money(ctx) {
  const { adminOnly, log } = ctx;
  const D = () => ctx.deals;
  const r = express.Router();

  db.exec(`
  CREATE TABLE IF NOT EXISTS funder_payments (
    id INTEGER PRIMARY KEY, deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    type TEXT NOT NULL DEFAULT 'commission',              -- commission | fee
    amount REAL NOT NULL DEFAULT 0, expected_on INTEGER, paid_on INTEGER,
    status TEXT NOT NULL DEFAULT 'outstanding',           -- outstanding | received
    auto INTEGER NOT NULL DEFAULT 0, note TEXT DEFAULT '', created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS fp_deal ON funder_payments(deal_id);
  CREATE TABLE IF NOT EXISTS distributions (
    id INTEGER PRIMARY KEY, deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    payment_id INTEGER REFERENCES funder_payments(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,                                   -- originator | closer | iso
    split_pct REAL, amount REAL NOT NULL DEFAULT 0, type TEXT NOT NULL DEFAULT 'commission',
    status TEXT NOT NULL DEFAULT 'pending',               -- pending | paid
    expected_on INTEGER, paid_on INTEGER, created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS dist_deal ON distributions(deal_id);
  CREATE INDEX IF NOT EXISTS dist_user ON distributions(user_id, status);
  `);
  ensureCol('users', 'split_pct', 'REAL');                 // % of the funder commission this person gets as originator
  ensureCol('users', 'closer_split_pct', 'REAL');          // % they get when they close someone else's deal
  ensureCol('deals', 'closer_id', 'INTEGER');
  ensureCol('deals', 'orig_split', 'REAL');                // per-deal override (percent)
  ensureCol('deals', 'closer_split', 'REAL');
  ensureCol('deals', 'money_skip', 'INTEGER DEFAULT 0');      // admin deleted the automatic payment on purpose
  ensureCol('deals', 'advance_status', "TEXT DEFAULT ''"); // '' = automatic

  // ---------------------------------------------------------------- engine
  function splitsFor(d) {
    const owner = d.owner_id ? db.prepare('SELECT id,split_pct,closer_split_pct FROM users WHERE id=?').get(d.owner_id) : null;
    const closer = d.closer_id ? db.prepare('SELECT id,split_pct,closer_split_pct FROM users WHERE id=?').get(d.closer_id) : null;
    return {
      owner, closer,
      orig: d.orig_split != null ? d.orig_split : (owner && owner.split_pct != null ? owner.split_pct : null),
      clos: d.closer_split != null ? d.closer_split : (closer ? (closer.closer_split_pct != null ? closer.closer_split_pct : null) : null),
    };
  }

  // rebuild the pending distributions for one funder payment (paid ones are never touched)
  function rebuild(p, d) {
    const sp = splitsFor(d);
    const keep = db.prepare("SELECT role,user_id FROM distributions WHERE payment_id=? AND status='paid'").all(p.id).map(x => x.role + ':' + x.user_id);
    db.prepare("DELETE FROM distributions WHERE payment_id=? AND status='pending'").run(p.id);
    const ins = (role, uid, pct, amt) => {
      if (!uid || !(amt > 0) || keep.includes(role + ':' + uid)) return;
      db.prepare('INSERT INTO distributions(deal_id,payment_id,user_id,role,split_pct,amount,type,status,expected_on,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(d.id, p.id, uid, role, pct, round2(amt), p.type, 'pending', p.expected_on, now());
    };
    if (sp.owner) {
      if (sp.orig != null && sp.orig > 0) ins('originator', sp.owner.id, sp.orig, p.amount * sp.orig / 100);
      else if (p.auto && p.type === 'commission') {                                   // no split set: fall back to the older "% of funded amount" commission
        const legacy = D().commission(d); if (legacy > 0) ins('originator', sp.owner.id, p.amount ? round2(legacy / p.amount * 100) : null, legacy);
      }
    }
    if (sp.closer && sp.clos != null && sp.clos > 0) ins('closer', sp.closer.id, sp.clos, p.amount * sp.clos / 100);
    if (p.auto && p.type === 'commission' && d.iso_id && d.iso_pct > 0 && d.funded_amount) ins('iso', d.iso_id, d.iso_pct, d.funded_amount * d.iso_pct / 100);
  }

  // make sure a funded deal has its funder payment and distributions
  function sync(dealId) {
    try {
      const d = D().getDeal(Number(dealId)); if (!d) return;
      if (d.stage === 'funded' && d.funded_amount > 0) {
        const rev = D().revenue(d);
        let p = db.prepare("SELECT * FROM funder_payments WHERE deal_id=? AND type='commission' ORDER BY auto DESC, id LIMIT 1").get(d.id);
        if (!p && rev > 0 && !d.money_skip) {
          const id = db.prepare("INSERT INTO funder_payments(deal_id,type,amount,expected_on,status,auto,created_at) VALUES(?,?,?,?,?,1,?)").run(d.id, 'commission', round2(rev), (d.funded_at || now()) + DAY, 'outstanding', now()).lastInsertRowid;
          p = db.prepare('SELECT * FROM funder_payments WHERE id=?').get(id);
        } else if (p && p.auto && p.status === 'outstanding' && rev > 0 && Math.abs(p.amount - rev) > 0.005) {
          db.prepare('UPDATE funder_payments SET amount=? WHERE id=?').run(round2(rev), p.id); p.amount = round2(rev);
        }
      }
      for (const p of db.prepare('SELECT * FROM funder_payments WHERE deal_id=?').all(d.id)) rebuild(p, d);
    } catch (e) { log && log('money.sync failed', dealId, e.message); }
  }
  function sweep() {
    const rows = db.prepare(`SELECT d.id FROM deals d WHERE d.stage='funded' AND d.funded_amount>0 AND (d.updated_at>? OR (NOT EXISTS(SELECT 1 FROM funder_payments f WHERE f.deal_id=d.id) AND COALESCE(d.money_skip,0)=0)) LIMIT 2000`).all(now() - 2 * DAY);
    for (const x of rows) sync(x.id);
  }
  setTimeout(sweep, 3000); setInterval(sweep, 60000).unref();

  // ---------------------------------------------------------------- helpers
  const isAdmin = u => u.role === 'admin';
  const like = q => '%' + String(q).replace(/[%_]/g, m => '\\' + m) + '%';
  const rng = (col, q) => { const w = [], a = []; if (q.from) { w.push(`${col}>=?`); a.push(Number(q.from)); } if (q.to) { w.push(`${col}<?`); a.push(Number(q.to)); } return { w, a }; };
  const nameOf = id => id ? (db.prepare('SELECT name FROM users WHERE id=?').get(id) || {}).name || '' : '';
  const bizOf = x => x.business || x.lead_name || 'Deal #' + x.deal_id;
  const sum = (rows, k) => round2(rows.reduce((a, x) => a + (Number(x[k]) || 0), 0));
  const LIMIT = 1000;

  // ---------------------------------------------------------------- payments (funder -> house)
  function paymentRows(q) {
    const w = ['1=1'], a = [];
    if (q.status) { w.push('f.status=?'); a.push(q.status); }
    if (q.type) { w.push('f.type=?'); a.push(q.type); }
    if (q.funder) { w.push('d.lender_id=?'); a.push(Number(q.funder)); }
    if (q.user) { w.push('(d.owner_id=? OR d.closer_id=?)'); a.push(Number(q.user), Number(q.user)); }
    if (q.q) { w.push("(l.business LIKE ? ESCAPE '\\' OR l.name LIKE ? ESCAPE '\\')"); a.push(like(q.q), like(q.q)); }
    const g = rng('d.funded_at', q); w.push(...g.w); a.push(...g.a);
    const rows = db.prepare(`SELECT f.*, d.funded_amount, d.funded_at, d.owner_id, d.closer_id, d.lender_id, ln.name funder, l.business, l.name lead_name,
        COALESCE((SELECT SUM(amount) FROM distributions x WHERE x.payment_id=f.id),0) dist_out
      FROM funder_payments f JOIN deals d ON d.id=f.deal_id JOIN leads l ON l.id=d.lead_id LEFT JOIN lenders ln ON ln.id=d.lender_id
      WHERE ${w.join(' AND ')} ORDER BY COALESCE(d.funded_at,f.created_at) DESC, f.id DESC LIMIT ${LIMIT}`).all(...a);
    return rows.map(x => ({ id: x.id, deal_id: x.deal_id, deal: bizOf(x), funder: x.funder || 'In-house', type: x.type, status: x.status, funded_amount: x.funded_amount, amount: x.amount, dist_out: round2(x.dist_out), profit: round2(x.amount - x.dist_out),
      originator: nameOf(x.owner_id), closer: nameOf(x.closer_id), funded_at: x.funded_at, expected_on: x.expected_on, paid_on: x.paid_on, auto: !!x.auto, note: x.note }));
  }
  r.get('/api/money/payments', adminOnly, (req, res) => {
    const rows = paymentRows(req.query);
    res.json({ rows, sums: { funded_amount: sum(rows, 'funded_amount'), amount: sum(rows, 'amount'), dist_out: sum(rows, 'dist_out'), profit: sum(rows, 'profit'), outstanding: sum(rows.filter(x => x.status === 'outstanding'), 'amount'), received: sum(rows.filter(x => x.status === 'received'), 'amount') },
      funders: db.prepare('SELECT id,name FROM lenders ORDER BY name').all(), capped: rows.length >= LIMIT });
  });
  r.post('/api/money/payments/receive', adminOnly, (req, res) => {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Boolean).slice(0, 2000), got = req.body.received !== false, t = Number(req.body.paid_on) || now();
    db.transaction(() => { for (const id of ids) db.prepare('UPDATE funder_payments SET status=?, paid_on=? WHERE id=?').run(got ? 'received' : 'outstanding', got ? t : null, id); })();
    audit(req, got ? 'payment.received' : 'payment.unreceived', 'funder_payment', ids.join(','), `${ids.length} payment(s)`); res.json({ ok: true, n: ids.length });
  });
  r.post('/api/money/payments', adminOnly, (req, res) => {
    const d = D().getDeal(Number(req.body.deal_id)); if (!d) return res.status(404).json({ error: 'Deal not found' });
    const amount = Number(req.body.amount); if (!(amount > 0)) return res.status(400).json({ error: 'Enter an amount' });
    const type = req.body.type === 'fee' ? 'fee' : 'commission';
    const id = db.prepare('INSERT INTO funder_payments(deal_id,type,amount,expected_on,status,auto,note,created_at) VALUES(?,?,?,?,?,0,?,?)').run(d.id, type, round2(amount), Number(req.body.expected_on) || now() + DAY, 'outstanding', String(req.body.note || '').slice(0, 200), now()).lastInsertRowid;
    db.prepare('UPDATE deals SET money_skip=1 WHERE id=?').run(d.id);
    sync(d.id); audit(req, 'payment.create', 'deal', d.id, `${type} $${amount}`); res.json({ ok: true, id });
  });
  r.patch('/api/money/payments/:id', adminOnly, (req, res) => {
    const p = db.prepare('SELECT * FROM funder_payments WHERE id=?').get(Number(req.params.id)); if (!p) return res.status(404).json({ error: 'Not found' });
    const f = {};
    if ('amount' in req.body) { const a = Number(req.body.amount); if (!(a >= 0)) return res.status(400).json({ error: 'Bad amount' }); f.amount = round2(a); f.auto = 0; }
    if ('expected_on' in req.body) f.expected_on = Number(req.body.expected_on) || null;
    if ('note' in req.body) f.note = String(req.body.note || '').slice(0, 200);
    if (Object.keys(f).length) db.prepare(`UPDATE funder_payments SET ${Object.keys(f).map(k => k + '=?').join(',')} WHERE id=?`).run(...Object.values(f), p.id);
    sync(p.deal_id); audit(req, 'payment.update', 'funder_payment', p.id, Object.keys(f).join(', ')); res.json({ ok: true });
  });
  r.delete('/api/money/payments/:id', adminOnly, (req, res) => {
    const p = db.prepare('SELECT * FROM funder_payments WHERE id=?').get(Number(req.params.id)); if (!p) return res.status(404).json({ error: 'Not found' });
    if (db.prepare("SELECT 1 FROM distributions WHERE payment_id=? AND status='paid'").get(p.id)) return res.status(400).json({ error: 'Some of this payment has already been paid out. Mark those unpaid first.' });
    if (p.type === 'commission') db.prepare('UPDATE deals SET money_skip=1 WHERE id=?').run(p.deal_id);
    db.prepare('DELETE FROM funder_payments WHERE id=?').run(p.id); audit(req, 'payment.delete', 'funder_payment', p.id, ''); res.json({ ok: true });
  });

  // ---------------------------------------------------------------- distributions (house -> reps)
  function distRows(q, user) {
    const w = ['1=1'], a = [];
    if (!isAdmin(user)) { w.push('x.user_id=?'); a.push(user.id); } else if (q.recipient) { w.push('x.user_id=?'); a.push(Number(q.recipient)); }
    if (q.status) { w.push('x.status=?'); a.push(q.status); }
    if (q.role) { w.push('x.role=?'); a.push(q.role); }
    if (q.type) { w.push('x.type=?'); a.push(q.type); }
    if (q.funder) { w.push('d.lender_id=?'); a.push(Number(q.funder)); }
    if (q.q) { w.push("(l.business LIKE ? ESCAPE '\\' OR l.name LIKE ? ESCAPE '\\')"); a.push(like(q.q), like(q.q)); }
    const g = rng('d.funded_at', q); w.push(...g.w); a.push(...g.a);
    return db.prepare(`SELECT x.*, f.amount payment_amount, f.status funder_status, d.funded_amount, d.funded_at, ln.name funder, u.name recipient, l.business, l.name lead_name
      FROM distributions x JOIN deals d ON d.id=x.deal_id JOIN leads l ON l.id=d.lead_id JOIN users u ON u.id=x.user_id LEFT JOIN funder_payments f ON f.id=x.payment_id LEFT JOIN lenders ln ON ln.id=d.lender_id
      WHERE ${w.join(' AND ')} ORDER BY COALESCE(d.funded_at,x.created_at) DESC, x.id DESC LIMIT ${LIMIT}`).all(...a)
      .map(x => ({ id: x.id, deal_id: x.deal_id, deal: bizOf(x), funder: x.funder || 'In-house', type: x.type, role: x.role, recipient: x.recipient, user_id: x.user_id, funded_amount: x.funded_amount, payment_amount: x.payment_amount, split_pct: x.split_pct,
        amount: x.amount, status: x.status, funder_status: x.funder_status, funded_at: x.funded_at, expected_on: x.expected_on, paid_on: x.paid_on }));
  }
  r.get('/api/money/distributions', (req, res) => {
    if (req.user.role === 'iso') return res.status(403).json({ error: 'Not available' });
    const rows = distRows(req.query, req.user);
    res.json({ rows, sums: { funded_amount: sum(rows, 'funded_amount'), payment_amount: sum(rows, 'payment_amount'), amount: sum(rows, 'amount'), pending: sum(rows.filter(x => x.status === 'pending'), 'amount'), paid: sum(rows.filter(x => x.status === 'paid'), 'amount') },
      users: isAdmin(req.user) ? db.prepare("SELECT id,name FROM users WHERE active=1 ORDER BY name").all() : [], funders: db.prepare('SELECT id,name FROM lenders ORDER BY name').all(), capped: rows.length >= LIMIT });
  });
  r.post('/api/money/distributions/pay', adminOnly, (req, res) => {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Boolean).slice(0, 2000), paid = req.body.paid !== false, t = Number(req.body.paid_on) || now();
    db.transaction(() => { for (const id of ids) db.prepare('UPDATE distributions SET status=?, paid_on=? WHERE id=?').run(paid ? 'paid' : 'pending', paid ? t : null, id); })();
    audit(req, paid ? 'distribution.paid' : 'distribution.unpaid', 'distribution', ids.join(','), `${ids.length} payout(s)`); res.json({ ok: true, n: ids.length });
  });
  // splits on a deal (admin)
  r.get('/api/money/deal/:id', (req, res) => {
    const d = D().getDeal(Number(req.params.id)); if (!d) return res.status(404).json({ error: 'Not found' });
    const sp = splitsFor(d), own = d.owner_id === req.user.id || d.closer_id === req.user.id;
    if (!isAdmin(req.user) && !own) return res.status(403).json({ error: 'Not yours' });
    const pays = isAdmin(req.user) ? db.prepare('SELECT * FROM funder_payments WHERE deal_id=? ORDER BY id').all(d.id) : [];
    const dist = db.prepare(`SELECT x.*, u.name recipient FROM distributions x JOIN users u ON u.id=x.user_id WHERE x.deal_id=? ${isAdmin(req.user) ? '' : 'AND x.user_id=' + Number(req.user.id)} ORDER BY x.id`).all(d.id);
    res.json({ payments: pays, distributions: dist, orig_split: d.orig_split, closer_split: d.closer_split, closer_id: d.closer_id, effective: { orig: sp.orig, closer: sp.clos } });
  });

  // ---------------------------------------------------------------- advances ledger
  const ADV_STATUS = ['Current', 'Paid off', 'Collections', 'Default', 'Renewed', 'Cancelled'];
  r.get('/api/money/advances', (req, res) => {
    if (req.user.role === 'iso') return res.status(403).json({ error: 'Not available' });
    const q = req.query, w = ["d.stage='funded'"], a = [];
    if (!isAdmin(req.user)) { w.push('(d.owner_id=? OR d.closer_id=?)'); a.push(req.user.id, req.user.id); } else if (q.user) { w.push('(d.owner_id=? OR d.closer_id=?)'); a.push(Number(q.user), Number(q.user)); }
    if (q.funder) { w.push('d.lender_id=?'); a.push(Number(q.funder)); }
    if (q.q) { w.push("(l.business LIKE ? ESCAPE '\\' OR l.name LIKE ? ESCAPE '\\')"); a.push(like(q.q), like(q.q)); }
    const g = rng('d.funded_at', q); w.push(...g.w); a.push(...g.a);
    let rows = db.prepare(`SELECT d.id, d.owner_id, d.closer_id, d.funded_amount, d.funded_at, d.payback, d.advance_status, d.notes, ln.name funder, l.business, l.name lead_name, l.source
      FROM deals d JOIN leads l ON l.id=d.lead_id LEFT JOIN lenders ln ON ln.id=d.lender_id WHERE ${w.join(' AND ')} ORDER BY d.funded_at DESC LIMIT ${LIMIT}`).all(...a).map(x => {
      const full = D().getDeal(x.id), pi = full ? D().paidIn(full) : null, pctPaid = pi ? pi.pct : null;
      const auto = pctPaid != null && pctPaid >= 100 ? 'Paid off' : 'Current';
      return { id: x.id, deal_id: x.id, deal: x.business || x.lead_name, funder: x.funder || 'In-house', status: x.advance_status || auto, auto_status: auto, funded_amount: x.funded_amount, funded_at: x.funded_at, payback: x.payback, paid_pct: pctPaid, estimated: pi ? !!pi.estimated : null,
        originator: nameOf(x.owner_id), closer: nameOf(x.closer_id), source: x.source || '', notes: (x.notes || '').slice(0, 120) };
    });
    if (q.status) rows = rows.filter(x => x.status === q.status);
    res.json({ rows, sums: { funded_amount: sum(rows, 'funded_amount'), payback: sum(rows, 'payback'), count: rows.length }, statuses: ADV_STATUS, users: isAdmin(req.user) ? db.prepare("SELECT id,name FROM users WHERE active=1 ORDER BY name").all() : [], funders: db.prepare('SELECT id,name FROM lenders ORDER BY name').all(), capped: rows.length >= LIMIT });
  });
  r.patch('/api/money/advances/:id', adminOnly, (req, res) => {
    const d = D().getDeal(Number(req.params.id)); if (!d) return res.status(404).json({ error: 'Not found' });
    const s = String(req.body.status || ''); if (s && !ADV_STATUS.includes(s)) return res.status(400).json({ error: 'Unknown status' });
    db.prepare('UPDATE deals SET advance_status=? WHERE id=?').run(s, d.id); audit(req, 'advance.status', 'deal', d.id, s || 'automatic'); res.json({ ok: true });
  });

  // ---------------------------------------------------------------- exports
  const csvq = v => { v = v == null ? '' : String(v); if (/^[=+\-@]/.test(v)) v = "'" + v; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const dt = t => t ? new Date(t).toISOString().slice(0, 10) : '';
  const EXPORTS = {
    deals: { title: 'Deals', cols: ['ID', 'Merchant', 'Stage', 'Requested', 'Funded', 'Funder', 'Owner', 'Closer', 'Source', 'Created', 'Funded on'], rows: q => {
      const g = rng('d.created_at', q);
      return db.prepare(`SELECT d.*, l.business, l.name lead_name, l.source, ln.name funder FROM deals d JOIN leads l ON l.id=d.lead_id LEFT JOIN lenders ln ON ln.id=d.lender_id ${g.w.length ? 'WHERE ' + g.w.join(' AND ') : ''} ORDER BY d.id DESC`).all(...g.a)
        .map(x => [x.id, x.business || x.lead_name, x.stage, x.amount_requested, x.funded_amount, x.funder || '', nameOf(x.owner_id), nameOf(x.closer_id), x.source, dt(x.created_at), dt(x.funded_at)]); } },
    submissions: { title: 'Submissions', cols: ['Deal', 'Merchant', 'Funder', 'Status', 'Sent', 'Offer amount', 'Offer factor', 'Decline reason'], rows: q => {
      const g = rng('s.sent_at', q);
      return db.prepare(`SELECT s.*, ln.name funder, l.business, l.name lead_name FROM submissions s JOIN deals d ON d.id=s.deal_id JOIN leads l ON l.id=d.lead_id LEFT JOIN lenders ln ON ln.id=s.lender_id ${g.w.length ? 'WHERE ' + g.w.join(' AND ') : ''} ORDER BY s.id DESC`).all(...g.a)
        .map(x => [x.deal_id, x.business || x.lead_name, x.funder, x.status, dt(x.sent_at), x.offer_amount, x.offer_factor, x.decline_reason || '']); } },
    advances: { title: 'Advances', cols: ['Deal', 'Merchant', 'Funder', 'Status', 'Funded', 'Funded on', 'Payback', 'Paid in %', 'Originator', 'Closer', 'Source'], rows: q => {
      const rows = (() => { const w = ["d.stage='funded'"], a = []; const g = rng('d.funded_at', q); w.push(...g.w); a.push(...g.a);
        return db.prepare(`SELECT d.id FROM deals d WHERE ${w.join(' AND ')} ORDER BY d.funded_at DESC`).all(...a).map(x => x.id); })();
      return rows.map(id => { const d = D().getDeal(id), pi = D().paidIn(d), l = db.prepare('SELECT business,name,source FROM leads WHERE id=?').get(d.lead_id) || {}, ln = d.lender_id ? db.prepare('SELECT name FROM lenders WHERE id=?').get(d.lender_id) : null;
        return [id, l.business || l.name, ln ? ln.name : 'In-house', d.advance_status || (pi && pi.pct >= 100 ? 'Paid off' : 'Current'), d.funded_amount, dt(d.funded_at), d.payback, pi ? pi.pct : '', nameOf(d.owner_id), nameOf(d.closer_id), l.source || '']; }); } },
    payments: { title: 'Funder payments', cols: ['Deal', 'Merchant', 'Funder', 'Type', 'Status', 'Funded amount', 'Payment', 'Paid out', 'Profit', 'Expected', 'Received'], rows: q => paymentRows({ ...q }).map(x => [x.deal_id, x.deal, x.funder, x.type, x.status, x.funded_amount, x.amount, x.dist_out, x.profit, dt(x.expected_on), dt(x.paid_on)]) },
    distributions: { title: 'Distributions', cols: ['Deal', 'Merchant', 'Funder', 'Recipient', 'Role', 'Split %', 'Payment', 'Payout', 'Status', 'Expected', 'Paid'], rows: (q, u) => distRows({ ...q }, u).map(x => [x.deal_id, x.deal, x.funder, x.recipient, x.role, x.split_pct, x.payment_amount, x.amount, x.status, dt(x.expected_on), dt(x.paid_on)]) },
  };
  r.get('/api/export', adminOnly, (req, res) => res.json(Object.entries(EXPORTS).map(([k, v]) => ({ kind: k, title: v.title }))));
  r.get('/api/export/:kind', adminOnly, (req, res) => {
    const e = EXPORTS[req.params.kind]; if (!e) return res.status(404).json({ error: 'Unknown export' });
    const rows = e.rows(req.query, req.user);
    audit(req, 'export', req.params.kind, null, `${rows.length} rows`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${req.params.kind}-${dt(now())}.csv"`);
    res.send([e.cols.map(csvq).join(','), ...rows.map(x => x.map(csvq).join(','))].join('\n'));
  });

  return { router: r, sync, sweep, ADV_STATUS };
};
