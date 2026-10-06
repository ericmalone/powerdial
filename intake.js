// Lead intake webhook (speed-to-lead), lead scoring for the smart queue, alternate phone numbers
const express = require('express');
const crypto = require('crypto');
const { db, getSetting, audit } = require('./db');
const tz = require('./tz');

const now = () => Date.now();
const safeJSON = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const key = k => String(k).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const ALIAS = {
  phone: ['phone', 'phone_number', 'mobile', 'mobile_phone', 'cell', 'cell_phone', 'lead_phone', 'telephone', 'tel', 'owner_phone', 'business_phone', 'contact_phone', 'phonenumber'],
  name: ['name', 'full_name', 'fullname', 'contact_name', 'owner_name', 'your_name', 'contact'],
  first: ['first_name', 'firstname', 'fname', 'first'], last: ['last_name', 'lastname', 'lname', 'last'],
  business: ['business', 'company', 'company_name', 'companyname', 'business_name', 'businessname', 'legal_name', 'dba', 'organization', 'organisation'],
  email: ['email', 'lead_email', 'email_address', 'e_mail', 'work_email'], state: ['state', 'region', 'province', 'st'],
  notes: ['notes', 'message', 'comments', 'comment', 'reply', 'reply_text', 'text', 'body', 'details'],
};
const pickField = (o, names) => { for (const n of names) if (o[n] != null && String(o[n]).trim() !== '') return String(o[n]).trim(); return ''; };

module.exports = function intake(ctx) {
  const { emitTo, emitAll, sendSms, fillTpl, normPhone, isDnc, insertLead, getLead, log, adminOnly, PUBLIC_URL, onlineReps } = ctx;
  const r = express.Router();

  // ================= webhook =================
  const hits = new Map();
  const limited = req => { const k = req.ip, t = now(), h = (hits.get(k) || []).filter(x => t - x < 60000); h.push(t); hits.set(k, h); return h.length > 120; };
  const cors = (req, res, next) => { res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }); if (req.method === 'OPTIONS') return res.status(204).end(); next(); };

  function pickOwner(k) {
    if (k.assign === 'none') return null;
    if (/^user:\d+$/.test(k.assign)) { const u = db.prepare("SELECT id FROM users WHERE id=? AND active=1").get(Number(k.assign.slice(5))); return u ? u.id : null; }
    const { online, inRoom, all } = onlineReps();
    const pool = inRoom.length ? inRoom : online.length ? online : all; if (!pool.length) return null;
    const since = new Date().setHours(0, 0, 0, 0), cnt = id => db.prepare('SELECT COUNT(*) n FROM intake_log WHERE assigned_to=? AND received_at>?').get(id, since).n;
    return pool.map(u => [u.id, cnt(u.id)]).sort((a, b) => a[1] - b[1] || a[0] - b[0])[0][0];
  }
  async function receive(k, payload, req) {
    const o = {}; for (const [kk, v] of Object.entries(payload || {})) if (v != null && typeof v !== 'object') o[key(kk)] = String(v);
    const phone = normPhone(pickField(o, ALIAS.phone)), t = now();
    const name = pickField(o, ALIAS.name) || [pickField(o, ALIAS.first), pickField(o, ALIAS.last)].filter(Boolean).join(' ');
    const business = pickField(o, ALIAS.business), email = pickField(o, ALIAS.email), state = pickField(o, ALIAS.state).slice(0, 30), msg = pickField(o, ALIAS.notes);
    const used = new Set(Object.values(ALIAS).flat());
    const extra = {}; for (const [kk, v] of Object.entries(o)) if (!used.has(kk) && v && kk.length < 60) extra[kk] = v.slice(0, 300);
    const L = (status, f = {}) => db.prepare('INSERT INTO intake_log(key_id,received_at,status,lead_id,assigned_to,reason,payload) VALUES(?,?,?,?,?,?,?)').run(k.id, t, status, f.lead_id || null, f.assigned_to || null, f.reason || '', JSON.stringify(payload).slice(0, 4000));
    db.prepare('UPDATE intake_keys SET received=received+1, last_at=? WHERE id=?').run(t, k.id);
    if (!phone) { L('rejected', { reason: 'No valid phone number' + (email ? ' (email only: ' + email + ')' : '') }); return { status: 400, body: { ok: false, error: 'A valid phone number is required' } }; }
    const note = `Via ${k.name}${msg ? ': ' + msg : ''}${Object.keys(extra).length ? '\n' + Object.entries(extra).map(([a, b]) => `${a}: ${b}`).join('\n') : ''}`;
    let lead = db.prepare('SELECT * FROM leads WHERE phone=?').get(phone), isNew = false;
    if (lead) {
      if (lead.status === 'dnc') { L('dnc', { lead_id: lead.id, reason: 'On DNC list' }); return { status: 200, body: { ok: true, duplicate: true, dnc: true } }; }
      db.prepare('INSERT INTO notes(lead_id,user_id,body,created_at) VALUES(?,?,?,?)').run(lead.id, null, 'Submitted again. ' + note, t);
      if (email && !lead.email) db.prepare('UPDATE leads SET email=? WHERE id=?').run(email, lead.id);
    } else {
      const id = insertLead({ name, business, phone, email, state, extra, source: k.source, notes: note }, null, t);
      if (id === 'dnc' || isDnc(phone)) { L('dnc', { reason: 'On DNC list' }); return { status: 200, body: { ok: true, dnc: true } }; }
      lead = getLead(id); isNew = true;
      tz.backfill().catch(() => {});
    }
    const owner = lead.owner_id || pickOwner(k);
    const f = { updated_at: t };
    if (owner && !lead.owner_id) f.owner_id = owner;
    if (k.hot) { f.hot = 1; f.status = 'callback'; f.callback_at = t; f.last_outcome = 'New inbound lead'; }
    else if (isNew) f.status = 'new';
    const cols = Object.keys(f); db.prepare(`UPDATE leads SET ${cols.map(c => c + '=?').join(',')} WHERE id=?`).run(...cols.map(c => f[c]), lead.id);
    lead = getLead(lead.id);
    L(isNew ? 'added' : 'duplicate', { lead_id: lead.id, assigned_to: owner });
    const label = lead.business || lead.name || lead.phone;
    const text = `${isNew ? 'New lead' : 'Lead came back'}: ${label}${msg ? ' — “' + msg.slice(0, 80) + '”' : ''} (${k.source})`;
    if (owner) emitTo(owner, 'hot_lead', { leadId: lead.id, text, hot: !!k.hot });
    else for (const u of onlineReps().online) emitTo(u.id, 'hot_lead', { leadId: lead.id, text, hot: !!k.hot });
    emitAll('lead_update', { leadId: lead.id });
    if (isNew && ctx.seqs) { const auto = getSetting('auto_sequences', {})['New intake lead']; if (auto) ctx.seqs.enroll(lead.id, Number(auto), owner); }
    // instant text (only if the admin turned it on for this form, inside calling hours, never to DNC numbers)
    if (isNew && k.auto_text && k.text_template && !isDnc(lead.phone) && tz.okNow((getLead(lead.id) || lead).tz)) {
      const u = owner ? db.prepare('SELECT id,name FROM users WHERE id=?').get(owner) : null;
      setTimeout(() => { const L2 = getLead(lead.id); if (!L2 || L2.status === 'dnc' || isDnc(L2.phone)) return; sendSms(L2, fillTpl(k.text_template, lead, u && u.name), u).catch(() => {}); }, Number(process.env.INTAKE_TEXT_DELAY_SECONDS || 20) * 1000);
    }
    return { status: 200, body: { ok: true, lead_id: lead.id, duplicate: !isNew } };
  }
  r.all('/intake/:token', cors, async (req, res) => {
    if (req.method === 'GET') return res.type('text').send('This is a lead intake address. Send leads here with a POST request.');
    if (req.method !== 'POST') return res.status(405).end();
    if (limited(req)) return res.status(429).json({ ok: false, error: 'Too many requests' });
    const k = db.prepare('SELECT * FROM intake_keys WHERE token=? AND active=1').get(String(req.params.token));
    if (!k) return res.status(404).json({ ok: false, error: 'Unknown or disabled intake address' });
    let payload = { ...(req.query || {}), ...(req.body || {}) };
    if (Array.isArray(req.body)) payload = req.body[0] || {};
    try {
      const out = await receive(k, payload, req);
      const wantsRedirect = payload._redirect || payload.redirect;
      if (out.status === 200 && wantsRedirect && /^https?:\/\//.test(wantsRedirect) && !(req.get('content-type') || '').includes('json')) return res.redirect(303, wantsRedirect);
      res.status(out.status).json(out.body);
    } catch (e) { log('Intake failed:', e.message); res.status(500).json({ ok: false, error: 'Server error' }); }
  });

  // ================= admin: keys + log =================
  const keyOut = k => ({ ...k, url: `${PUBLIC_URL}/intake/${k.token}` });
  r.get('/api/intake', adminOnly, (req, res) => {
    const keys = db.prepare('SELECT * FROM intake_keys ORDER BY active DESC, id DESC').all().map(keyOut);
    const logRows = db.prepare(`SELECT g.*, k.name key_name, l.name lead_name, l.business lead_business, u.name assigned_name FROM intake_log g LEFT JOIN intake_keys k ON k.id=g.key_id LEFT JOIN leads l ON l.id=g.lead_id LEFT JOIN users u ON u.id=g.assigned_to ORDER BY g.id DESC LIMIT 100`).all();
    res.json({ keys, log: logRows, users: db.prepare("SELECT id,name FROM users WHERE active=1 AND role!='iso' ORDER BY name").all() });
  });
  const keyFields = b => ({ name: String(b.name || '').trim().slice(0, 80), source: String(b.source || '').trim().slice(0, 80), hot: b.hot === false || b.hot === 0 ? 0 : 1,
    auto_text: b.auto_text ? 1 : 0, text_template: String(b.text_template || '').slice(0, 500), assign: /^(none|round_robin|user:\d+)$/.test(b.assign) ? b.assign : 'round_robin' });
  r.post('/api/intake', adminOnly, (req, res) => {
    const f = keyFields(req.body); if (!f.name || !f.source) return res.status(400).json({ error: 'Give it a name and a lead source name' });
    const x = db.prepare('INSERT INTO intake_keys(name,token,source,hot,auto_text,text_template,assign,created_at) VALUES(?,?,?,?,?,?,?,?)').run(f.name, crypto.randomBytes(18).toString('base64url'), f.source, f.hot, f.auto_text, f.text_template, f.assign, now());
    audit(req, 'intake.create', 'intake_key', x.lastInsertRowid, f.name); res.json({ id: x.lastInsertRowid });
  });
  r.patch('/api/intake/:id', adminOnly, (req, res) => {
    const id = Number(req.params.id), b = req.body, f = {};
    if ('active' in b) f.active = b.active ? 1 : 0;
    if (b.rotate) f.token = crypto.randomBytes(18).toString('base64url');
    if (b.name !== undefined) Object.assign(f, keyFields({ ...db.prepare('SELECT * FROM intake_keys WHERE id=?').get(id), ...b }));
    const cols = Object.keys(f); if (cols.length) db.prepare(`UPDATE intake_keys SET ${cols.map(c => c + '=?').join(',')} WHERE id=?`).run(...cols.map(c => f[c]), id);
    audit(req, b.rotate ? 'intake.rotate' : 'intake.update', 'intake_key', id); res.json({ ok: true });
  });

  // ================= lead scoring (smart queue) =================
  const INTR = "(c.disposition IN ('Interested','App Sent'))";
  function rescore() {
    const t = now();
    const g = db.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN EXISTS(SELECT 1 FROM calls c WHERE c.lead_id=l.id AND ${INTR}) OR EXISTS(SELECT 1 FROM deals d WHERE d.lead_id=l.id) THEN 1 ELSE 0 END) i FROM leads l WHERE l.attempts>0`).get();
    const gi = Math.max(0.005, g.n ? g.i / g.n : 0.03);
    const agg = col => Object.fromEntries(db.prepare(`SELECT ${col} k, COUNT(*) n, SUM(CASE WHEN EXISTS(SELECT 1 FROM calls c WHERE c.lead_id=l.id AND ${INTR}) OR EXISTS(SELECT 1 FROM deals d WHERE d.lead_id=l.id) THEN 1 ELSE 0 END) i FROM leads l WHERE l.attempts>0 AND ${col}!='' GROUP BY ${col}`).all().map(x => [x.k, x]));
    const bySrc = agg('l.source'), byState = agg('l.state');
    const fac = (row, k) => { if (!row) return 1; return Math.min(3, Math.max(0.35, ((row.i + k * gi) / (row.n + k)) / gi)); };
    const tries = [1, 0.92, 0.78, 0.62, 0.48, 0.36, 0.3];
    const replied = new Set(db.prepare("SELECT DISTINCT lead_id FROM messages WHERE direction='in' AND created_at>?").all(t - 7 * 864e5).map(x => x.lead_id));
    const emailed = new Set(db.prepare("SELECT DISTINCT lead_id FROM emails WHERE direction='in' AND lead_id IS NOT NULL AND created_at>?").all(t - 7 * 864e5).map(x => x.lead_id));
    const talked = new Set(db.prepare("SELECT DISTINCT lead_id FROM calls WHERE connected=1 AND disposition=''").all().map(x => x.lead_id));
    const leads = db.prepare("SELECT id, source, state, attempts, hot, business, email, score FROM leads WHERE status IN ('new','callback')").all();
    const up = db.prepare('UPDATE leads SET score=?, score_why=? WHERE id=?');
    let n = 0;
    db.transaction(() => {
      for (const l of leads) {
        const sf = fac(bySrc[l.source], 40), stf = fac(byState[l.state], 25), af = tries[Math.min(l.attempts, 6)];
        let b = sf * stf * af; const why = [];
        if (Math.abs(sf - 1) > 0.15) why.push(`list converts ${sf >= 1 ? sf.toFixed(1) + '× better' : (1 / sf).toFixed(1) + '× worse'} than average`);
        if (Math.abs(stf - 1) > 0.2) why.push(`${l.state} ${stf >= 1 ? 'above' : 'below'} average`);
        why.push(l.attempts === 0 ? 'never dialed' : `${l.attempts} ${l.attempts === 1 ? 'try' : 'tries'} so far`);
        if (replied.has(l.id)) { b *= 2; why.push('texted back this week'); }
        if (emailed.has(l.id)) { b *= 1.8; why.push('emailed back this week'); }
        if (talked.has(l.id)) { b *= 1.3; why.push('talked before, no outcome yet'); }
        if (l.hot) { b *= 3; why.push('new inbound lead'); }
        if (l.business) b *= 1.05; if (l.email) b *= 1.05;
        const score = Math.max(1, Math.min(100, Math.round(38 * b)));
        if (score !== l.score) { up.run(score, why.join(' · ').slice(0, 300), l.id); n++; }
      }
    })();
    return n;
  }
  let scoreT; const rescoreSoon = (ms = 5000) => { clearTimeout(scoreT); scoreT = setTimeout(() => { try { rescore(); } catch (e) { log('Scoring failed:', e.message); } }, ms); };
  setInterval(() => rescoreSoon(100), 15 * 60000); rescoreSoon(6000);

  r.get('/api/queue/preview', adminOnly, (req, res) => {
    const rows = db.prepare(`SELECT id,name,business,state,source,score,score_why,attempts,hot,status,callback_at FROM leads WHERE status IN ('new','callback') AND (status!='callback' OR callback_at<=?) AND phone NOT IN (SELECT phone FROM dnc)
      ORDER BY CASE WHEN hot=1 THEN 0 WHEN status='callback' THEN 1 ELSE 2 END, CASE WHEN status='callback' THEN callback_at END, COALESCE(score,0) DESC, attempts, id LIMIT 25`).all(now());
    res.json({ rows, smart: getSetting('smart_queue', true) !== false });
  });
  r.post('/api/queue/rescore', adminOnly, (req, res) => res.json({ updated: rescore() }));

  // ================= alternate phone numbers =================
  const phonesOf = leadId => db.prepare('SELECT * FROM lead_phones WHERE lead_id=? ORDER BY bad, id').all(leadId);
  function addAlt(leadId, phone, label) {
    const p = normPhone(phone), l = getLead(leadId); if (!p || !l || p === l.phone) return null;
    try { return db.prepare('INSERT INTO lead_phones(lead_id,phone,label,created_at) VALUES(?,?,?,?)').run(leadId, p, String(label || '').slice(0, 40), now()).lastInsertRowid; } catch { return null; }
  }
  // make an alternate the main number; the old main becomes an alternate (flagged bad if asked)
  function swapTo(leadId, altId, { markOldBad } = {}) {
    const alt = db.prepare('SELECT * FROM lead_phones WHERE id=? AND lead_id=?').get(altId, leadId), l = getLead(leadId);
    if (!alt || !l) return { error: 'Number not found' };
    if (isDnc(alt.phone)) return { error: 'That number is on the DNC list' };
    if (db.prepare('SELECT 1 FROM leads WHERE phone=? AND id!=?').get(alt.phone, leadId)) return { error: 'That number belongs to another lead' };
    db.transaction(() => {
      db.prepare('DELETE FROM lead_phones WHERE id=?').run(altId);
      db.prepare('UPDATE leads SET phone=?, tz=\'\', updated_at=? WHERE id=?').run(alt.phone, now(), leadId);
      db.prepare('INSERT OR REPLACE INTO lead_phones(lead_id,phone,label,bad,created_at) VALUES(?,?,?,?,?)').run(leadId, l.phone, 'previous main', markOldBad ? 1 : 0, now());
    })();
    tz.backfill().catch(() => {});
    return { phone: alt.phone };
  }
  // after a "Wrong Number" outcome: try the next alternate automatically
  function rotateWrong(leadId) {
    const l = getLead(leadId); if (!l) return null;
    const next = db.prepare('SELECT * FROM lead_phones WHERE lead_id=? AND bad=0 ORDER BY id').all(leadId).find(a => !isDnc(a.phone) && !db.prepare('SELECT 1 FROM leads WHERE phone=? AND id!=?').get(a.phone, leadId));
    if (!next) return null;
    const out = swapTo(leadId, next.id, { markOldBad: true }); if (out.error) return null;
    db.prepare("UPDATE leads SET status='new', attempts=0, last_called=NULL, disposition='', last_outcome='Wrong number — trying alternate number', updated_at=? WHERE id=?").run(now(), leadId);
    return out;
  }
  r.get('/api/leads/:id/phones', (req, res) => res.json(phonesOf(Number(req.params.id))));
  r.post('/api/leads/:id/phones', (req, res) => {
    const id = addAlt(Number(req.params.id), req.body.phone, req.body.label);
    if (!id) return res.status(400).json({ error: 'Enter a valid, different phone number' });
    res.json({ id });
  });
  r.patch('/api/phones/:id', (req, res) => { db.prepare('UPDATE lead_phones SET bad=? WHERE id=?').run(req.body.bad ? 1 : 0, Number(req.params.id)); res.json({ ok: true }); });
  r.delete('/api/phones/:id', (req, res) => { db.prepare('DELETE FROM lead_phones WHERE id=?').run(Number(req.params.id)); res.json({ ok: true }); });
  r.post('/api/phones/:id/use', (req, res) => {
    const a = db.prepare('SELECT * FROM lead_phones WHERE id=?').get(Number(req.params.id)); if (!a) return res.status(404).json({ error: 'Not found' });
    const out = swapTo(a.lead_id, a.id, { markOldBad: !!req.body.old_bad }); if (out.error) return res.status(400).json(out);
    res.json({ ok: true, phone: out.phone });
  });
  return { router: r, rescore, rescoreSoon, addAlt, rotateWrong, phonesOf };
};
