// Bank statement reader (AI) + automatic reminders for missing documents
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, getSetting, filesDir } = require('./db');
const tz = require('./tz');
const { claudeDocs } = require('./ai');
const mail = require('./mail');

const now = () => Date.now();
const safeJSON = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const MIME = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const QUIET = Number(process.env.CHASE_QUIET_HOURS ?? 3) * 3600000;   // don't interrupt a live conversation
const num = v => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : null; };

const CHASE_DEFAULTS = {
  enabled: true, hours: [4, 24, 48, 96, 168], sms: true, email: true,
  sms_tpl: "Hi {first}, it's {rep} at {company}. To get {business} an offer we still need: {missing}. You can finish from your phone here: {link}",
  email_subject: 'Still needed for {business}: {missing}',
  email_body: "Hi {first},\n\nWe're almost there. To get {business} an offer, we still need:\n\n{missing_list}\n\nIt only takes a couple of minutes from your phone:\n{link}\n\n{rep}\n{company}",
};

module.exports = function docs(ctx) {
  const { emitAll, emitTo, sendSms, sendLeadEmail, fillTpl, PUBLIC_URL, log, adminOnly, deals } = ctx;
  const r = express.Router();
  const event = (dealId, userId, kind, body) => deals.event(dealId, userId, kind, body);

  // ================= statement analysis =================
  const running = new Set(), timers = new Map();
  async function analyze(dealId, userId) {
    const d = deals.getDeal(dealId); if (!d || running.has(dealId)) return { ok: false, error: 'Already running' };
    const set = f => { const k = Object.keys(f); db.prepare(`UPDATE deals SET ${k.map(x => x + '=?').join(',')} WHERE id=?`).run(...k.map(x => f[x]), dealId); };
    if (!process.env.ANTHROPIC_API_KEY) { set({ stmt_status: 'error', stmt_error: 'Anthropic key is not set, so statements can’t be read.' }); return { ok: false, error: 'AI key not set' }; }
    const files = db.prepare("SELECT * FROM deal_files WHERE deal_id=? AND kind='statement' ORDER BY id DESC LIMIT 8").all(dealId)
      .filter(f => MIME[path.extname(f.file).toLowerCase()] && fs.existsSync(path.join(filesDir, f.file)));
    if (!files.length) { set({ stmt_status: 'error', stmt_error: 'No PDF or image statements to read yet.' }); return { ok: false, error: 'No readable statements' }; }
    running.add(dealId); set({ stmt_status: 'running', stmt_error: '' }); emitAll('deal_update', { dealId, leadId: d.lead_id });
    try {
      let total = 0; const docs = [];
      for (const f of files) {
        const buf = fs.readFileSync(path.join(filesDir, f.file)); if (total + buf.length > 24e6) continue;
        total += buf.length; docs.push({ mime: MIME[path.extname(f.file).toLowerCase()], base64: buf.toString('base64'), name: f.name });
      }
      const prompt = `These are business bank statements for a small business applying for a merchant cash advance. Read every statement and return ONLY a JSON object (no markdown):
{
 "bank_name": "", "account_holder": "", "account_last4": "",
 "statements": [{"month": "YYYY-MM", "total_deposits": number, "true_revenue": number (deposits excluding transfers between own accounts, loan or advance proceeds, refunds), "ending_balance": number, "avg_daily_balance": number or null, "lowest_balance": number or null, "nsf_count": number, "negative_days": number, "deposit_count": number}],
 "avg_monthly_revenue": number (average of true_revenue across the months),
 "avg_daily_balance": number or null,
 "total_nsf": number,
 "revenue_trend": "up" | "flat" | "down",
 "existing_funders": [{"name": "funder / lender name as it appears", "amount": number (each debit), "frequency": "daily" | "weekly" | "monthly", "evidence": "short description of the repeating debit"}],
 "flags": ["anything an underwriter should know: large unexplained deposits, falling revenue, frequent overdrafts, statements for different accounts or missing months, signs of altered documents, personal rather than business account"],
 "summary": "2 plain-English sentences"
}
Existing funders means repeating ACH debits to merchant cash advance companies, business loan or lender names (not rent, payroll, utilities or taxes). Use null / empty arrays for anything you cannot read. Do not invent numbers.`;
      const x = await claudeDocs(prompt, docs, 4000);
      const out = {
        bank_name: String(x.bank_name || ''), account_holder: String(x.account_holder || ''), account_last4: String(x.account_last4 || ''),
        statements: (Array.isArray(x.statements) ? x.statements : []).map(s => ({ month: String(s.month || ''), total_deposits: num(s.total_deposits), true_revenue: num(s.true_revenue), ending_balance: num(s.ending_balance),
          avg_daily_balance: num(s.avg_daily_balance), lowest_balance: num(s.lowest_balance), nsf_count: num(s.nsf_count) || 0, negative_days: num(s.negative_days) || 0, deposit_count: num(s.deposit_count) })).sort((a, b) => a.month.localeCompare(b.month)),
        avg_monthly_revenue: num(x.avg_monthly_revenue), avg_daily_balance: num(x.avg_daily_balance), total_nsf: num(x.total_nsf) || 0, revenue_trend: ['up', 'flat', 'down'].includes(x.revenue_trend) ? x.revenue_trend : '',
        existing_funders: (Array.isArray(x.existing_funders) ? x.existing_funders : []).map(f => ({ name: String(f.name || '').slice(0, 80), amount: num(f.amount), frequency: ['daily', 'weekly', 'monthly'].includes(f.frequency) ? f.frequency : '', evidence: String(f.evidence || '').slice(0, 160) })).filter(f => f.name),
        flags: (Array.isArray(x.flags) ? x.flags : []).map(f => String(f).slice(0, 200)).slice(0, 12), summary: String(x.summary || '').slice(0, 500), files: docs.map(f => f.name),
      };
      if (!out.avg_monthly_revenue && out.statements.length) { const v = out.statements.map(s => s.true_revenue ?? s.total_deposits).filter(n => n != null); if (v.length) out.avg_monthly_revenue = Math.round(v.reduce((a, b) => a + b, 0) / v.length); }
      // compare with what the merchant said, and fill in anything they left blank
      const fresh = deals.getDeal(dealId), a = deals.appOf(fresh), auto = [];
      const stated = num(a.monthly_revenue);
      if (stated && out.avg_monthly_revenue && Math.abs(stated - out.avg_monthly_revenue) / stated > 0.25) out.flags.unshift(`Merchant stated $${Math.round(stated).toLocaleString('en-US')}/mo but statements show about $${Math.round(out.avg_monthly_revenue).toLocaleString('en-US')}/mo`);
      if (!a.monthly_revenue && out.avg_monthly_revenue) { a.monthly_revenue = String(Math.round(out.avg_monthly_revenue)); auto.push('monthly revenue'); }
      if ((a.existing_positions == null || a.existing_positions === '') && out.statements.length) { a.existing_positions = String(out.existing_funders.length); auto.push('open positions'); }
      if (!a.existing_lenders && out.existing_funders.length) { a.existing_lenders = out.existing_funders.map(f => f.name).join(', ').slice(0, 300); auto.push('current lenders'); }
      if (!a.bank_name && out.bank_name) { a.bank_name = out.bank_name; auto.push('bank'); }
      set({ stmt_analysis: JSON.stringify(out), stmt_analyzed_at: now(), stmt_status: 'done', stmt_error: '', app: JSON.stringify(a), updated_at: now() });
      event(dealId, userId || null, 'analysis', `Statements read: about $${Math.round(out.avg_monthly_revenue || 0).toLocaleString('en-US')}/mo, ${out.total_nsf} NSF, ${out.existing_funders.length} existing funder${out.existing_funders.length === 1 ? '' : 's'}${auto.length ? '. Filled in: ' + auto.join(', ') : ''}`);
      if (out.flags.length && fresh.owner_id) emitTo(fresh.owner_id, 'deal_alert', { dealId, text: `${fresh.title || 'Deal'}: statements flagged — ${out.flags[0]}` });
      return { ok: true };
    } catch (e) {
      log('Statement analysis failed:', e.message);
      set({ stmt_status: 'error', stmt_error: String(e.message).slice(0, 300) }); return { ok: false, error: e.message };
    } finally { running.delete(dealId); emitAll('deal_update', { dealId, leadId: d.lead_id }); }
  }
  // merchant (or rep) uploaded something: read the statements once the uploads settle
  ctx.onFilesUploaded = (dealId, kind) => {
    if (kind !== 'statement') return;
    clearTimeout(timers.get(dealId));
    timers.set(dealId, setTimeout(() => { timers.delete(dealId); analyze(dealId).catch(() => {}); }, Number(process.env.STMT_DELAY_SECONDS || 25) * 1000));
  };
  r.post('/api/deals/:id/analyze', async (req, res) => {
    const id = Number(req.params.id); if (!deals.getDeal(id)) return res.status(404).json({ error: 'Deal not found' });
    analyze(id, req.user.id).catch(() => {}); res.json({ ok: true });
  });

  // ================= document reminders =================
  const cfg = () => ({ ...CHASE_DEFAULTS, ...getSetting('chase', {}) });
  const missingOf = d => deals.checklist(d).filter(x => !x.done);
  function linkSentAt(d) { return db.prepare("SELECT MIN(created_at) t FROM deal_events WHERE deal_id=? AND kind='link'").get(d.id).t; }
  const fillChase = (tpl, lead, owner, d, miss) => fillTpl(tpl, lead, owner && owner.name)
    .replace(/\{link\}/g, `${PUBLIC_URL}/apply/${d.upload_token}`).replace(/\{missing\}/g, miss.map(m => m.label.toLowerCase()).join(', '))
    .replace(/\{missing_list\}/g, miss.map(m => '  • ' + m.label).join('\n'));

  async function chaseOne(d, { force } = {}) {
    const c = cfg(), lead = db.prepare('SELECT * FROM leads WHERE id=?').get(d.lead_id);
    if (!lead || !d.upload_token) return { sent: false, why: 'No application link has been sent yet' };
    if (lead.status === 'dnc' || db.prepare('SELECT 1 FROM dnc WHERE phone=?').get(lead.phone)) return { sent: false, why: 'Lead is on the DNC list' };
    const miss = missingOf(d); if (!miss.length) return { sent: false, why: 'Nothing is missing' };
    const owner = d.owner_id ? db.prepare('SELECT id, name FROM users WHERE id=?').get(d.owner_id) : null;
    const via = [];
    if (c.sms && tz.okNow(lead.tz)) { try { const m = await sendSms(lead, fillChase(c.sms_tpl, lead, owner, d, miss), owner); if (m.status !== 'failed') via.push('text'); } catch {} }
    if (c.email && lead.email && mail.enabled()) { try { await sendLeadEmail(lead, owner, { subject: fillChase(c.email_subject, lead, owner, d, miss), text: fillChase(c.email_body, lead, owner, d, miss), dealId: d.id }); via.push('email'); } catch {} }
    if (!via.length) return { sent: false, why: tz.okNow(lead.tz) ? 'No way to reach the merchant (no email, or texting failed)' : 'Outside calling hours for this merchant and no email on file' };
    db.prepare('UPDATE deals SET chase_count=chase_count+1, last_chase_at=?, updated_at=? WHERE id=?').run(now(), now(), d.id);
    event(d.id, null, 'chase', `Reminder #${d.chase_count + 1} sent by ${via.join(' and ')} — still needed: ${miss.map(m => m.label).join(', ')}`);
    emitAll('deal_update', { dealId: d.id, leadId: d.lead_id });
    return { sent: true, via, missing: miss.map(m => m.label) };
  }
  let ticking = false;
  async function tick() {
    if (ticking) return; ticking = true;
    try {
      const c = cfg(); if (!c.enabled) return;
      const t = now(), rows = db.prepare("SELECT * FROM deals WHERE stage IN ('app_sent','app_in','docs_in') AND upload_token IS NOT NULL AND chase_off=0").all();
      for (const d of rows) {
        if (d.chase_count >= c.hours.length) continue;
        const base = linkSentAt(d); if (!base) continue;
        if (t < base + Number(c.hours[d.chase_count]) * 3600000) continue;
        if (d.last_chase_at && t - d.last_chase_at < QUIET) continue;
        // don't step on a live conversation
        const recent = t - QUIET;
        if (db.prepare('SELECT 1 FROM messages WHERE lead_id=? AND created_at>? AND user_id IS NOT NULL LIMIT 1').get(d.lead_id, recent) || db.prepare('SELECT 1 FROM messages WHERE lead_id=? AND direction=\'in\' AND created_at>? LIMIT 1').get(d.lead_id, recent)
          || db.prepare('SELECT 1 FROM calls WHERE lead_id=? AND started_at>? AND connected=1 LIMIT 1').get(d.lead_id, recent)) continue;
        // merchant is actively uploading: wait
        if (db.prepare("SELECT 1 FROM deal_events WHERE deal_id=? AND kind IN ('files','app') AND user_id IS NULL AND created_at>? LIMIT 1").get(d.id, recent)) continue;
        await chaseOne(d).catch(e => log('Chase failed:', e.message));
      }
    } finally { ticking = false; }
  }
  setInterval(tick, Number(process.env.CHASE_TICK_SECONDS || 300) * 1000); setTimeout(tick, 20000);

  r.post('/api/deals/:id/chase', async (req, res) => {
    const d = deals.getDeal(Number(req.params.id)); if (!d) return res.status(404).json({ error: 'Deal not found' });
    if (!d.upload_token) return res.status(400).json({ error: 'Send the application link first' });
    const out = await chaseOne(d, { force: true });
    if (!out.sent) return res.status(400).json({ error: out.why });
    db.prepare("UPDATE deal_events SET user_id=? WHERE id=(SELECT MAX(id) FROM deal_events WHERE deal_id=? AND kind='chase')").run(req.user.id, d.id);
    res.json(out);
  });
  r.post('/api/deals/:id/chase-toggle', (req, res) => {
    const d = deals.getDeal(Number(req.params.id)); if (!d) return res.status(404).json({ error: 'Deal not found' });
    db.prepare('UPDATE deals SET chase_off=? WHERE id=?').run(req.body.off ? 1 : 0, d.id);
    event(d.id, req.user.id, 'chase', req.body.off ? 'Automatic reminders turned off' : 'Automatic reminders turned on'); res.json({ ok: true });
  });
  return { router: r, analyze, tick, checklist: deals.checklist, CHASE_DEFAULTS };
};
module.exports.CHASE_DEFAULTS = CHASE_DEFAULTS;
