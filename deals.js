// Deals: pipeline, merchant application link, documents, lender submissions, renewals, commissions
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, getSetting, filesDir, audit } = require('./db');
const { enc, dec, SENSITIVE, mask } = require('./secure');
const { applicationPdf } = require('./pdf');
const mail = require('./mail');

const STAGES = ['interested', 'app_sent', 'app_in', 'docs_in', 'submitted', 'offer', 'contract', 'funded', 'lost'];
const STAGE_LABEL = { interested: 'Interested', app_sent: 'App sent', app_in: 'App in', docs_in: 'Docs in', submitted: 'Submitted', offer: 'Offer', contract: 'Contract out', funded: 'Funded', lost: 'Lost' };
const OPEN = STAGES.filter(s => !['funded', 'lost'].includes(s));
const now = () => Date.now();
const safeJSON = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const num = v => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : null; };
const FILE_KINDS = ['statement', 'application', 'id', 'voided_check', 'contract', 'other'];

const upload = multer({
  storage: multer.diskStorage({ destination: filesDir, filename: (req, f, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(f.originalname).toLowerCase().slice(0, 6)) }),
  limits: { fileSize: 25 * 1024 * 1024, files: 20 },
  fileFilter: (req, f, cb) => cb(null, /pdf|png|jpe?g|heic|tiff?|csv|xlsx?|msword|officedocument/.test(f.mimetype) || /\.(pdf|png|jpe?g|heic|tiff?|csv|xlsx?|docx?)$/i.test(f.originalname)),
});

module.exports = function deals(ctx) {
  const { emitTo, emitAll, sendSms, PUBLIC_URL, leadOut, log, adminOnly, claude } = ctx;
  const r = express.Router();
  const getDeal = id => db.prepare('SELECT * FROM deals WHERE id=?').get(id);
  const event = (dealId, userId, kind, body) => db.prepare('INSERT INTO deal_events(deal_id,user_id,kind,body,created_at) VALUES(?,?,?,?,?)').run(dealId, userId || null, kind, body || '', now());
  const touch = id => db.prepare('UPDATE deals SET updated_at=? WHERE id=?').run(now(), id);
  const appOf = d => safeJSON(d.app, {});
  const decApp = a => { const o = { ...a }; for (const k of SENSITIVE) if (o[k]) o[k] = dec(o[k]); return o; };
  const maskApp = a => { const o = { ...a }; for (const k of SENSITIVE) if (o[k]) o[k] = mask(dec(o[k])); delete o.signature; return o; };

  function paidIn(d) {
    if (!d.funded_at || !d.payback) return null;
    let collected = d.collected, actual = false;
    const pay = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN kind IN ('payment','adjust') THEN amount END),0) s FROM payments WHERE deal_id=?").get(d.id);
    if (pay.n) { collected = pay.s; actual = true; }    // real payment records win over any estimate
    if (collected == null) {
      let n = 0; const t = new Date(d.funded_at); t.setHours(0, 0, 0, 0); const end = new Date();
      if (d.payment_freq === 'weekly') n = Math.floor((end - t) / (7 * 864e5));
      else for (const x = new Date(t.getTime() + 864e5); x <= end; x.setDate(x.getDate() + 1)) if (x.getDay() % 6) n++;
      collected = Math.min(d.payback, n * (d.payment_amount || 0));
    }
    return { collected, pct: Math.min(100, Math.round(collected / d.payback * 100)), estimated: !actual && d.collected == null, actual };
  }
  function commission(d) {
    if (!d.funded_amount) return null;
    if (d.commission_amt != null) return d.commission_amt;
    const pct = d.commission_pct ?? (db.prepare('SELECT commission_pct FROM users WHERE id=?').get(d.owner_id)?.commission_pct || 0);
    return Math.round(d.funded_amount * pct) / 100;
  }
  // what the company earns: manual override, else the spread on in-house deals, else the lender's broker % of the funded amount
  function revenue(d) {
    if (d.revenue_override != null) return d.revenue_override;
    if (!d.funded_amount) return null;
    const L = d.lender_id ? db.prepare('SELECT in_house, broker_pct FROM lenders WHERE id=?').get(d.lender_id) : null;
    if (!L || L.in_house) return d.payback ? Math.round((d.payback - d.funded_amount) * 100) / 100 : null;
    return L.broker_pct ? Math.round(d.funded_amount * L.broker_pct) / 100 : null;
  }
  function dealOut(d, extra = {}) {
    const a = appOf(d);
    return { ...d, app: maskApp(a), app_complete: !!d.app_signed_at, upload_token: undefined, has_link: !!d.upload_token,
      link: d.upload_token ? `${PUBLIC_URL}/apply/${d.upload_token}` : null, stmt: safeJSON(d.stmt_analysis, null), stmt_analysis: undefined, contract_sig: d.contract_sig ? { ...safeJSON(d.contract_sig, {}), image: undefined } : null, paid_in: paidIn(d), commission_due: commission(d), iso_name: d.iso_id ? (db.prepare('SELECT name FROM users WHERE id=?').get(d.iso_id) || {}).name || null : null, iso_due: d.iso_id && d.funded_amount ? Math.round(d.funded_amount * (d.iso_pct || 0)) / 100 : null, revenue: revenue(d), source: db.prepare('SELECT source FROM leads WHERE id=?').get(d.lead_id)?.source || '', ...extra };
  }
  // what we still need from the merchant (drives the checklist, reminders and the merchant page)
  function checklist(d) {
    const need = getSetting('required_docs', { id: false, voided_check: false }), stmts = Number(getSetting('statements_required', 3));
    const cnt = k => db.prepare('SELECT COUNT(*) n FROM deal_files WHERE deal_id=? AND kind=?').get(d.id, k).n;
    const items = [{ key: 'app', label: 'Signed application', done: !!d.app_signed_at }];
    if (stmts > 0) items.push({ key: 'statements', label: `Last ${stmts} bank statements`, done: cnt('statement') >= stmts, detail: `${cnt('statement')} of ${stmts}` });
    if (need.id) items.push({ key: 'id', label: "Driver's license / ID", done: cnt('id') > 0 });
    if (need.voided_check) items.push({ key: 'voided_check', label: 'Voided check', done: cnt('voided_check') > 0 });
    return items;
  }
  function ensureToken(d) {
    if (d.upload_token) return d.upload_token;
    const t = crypto.randomBytes(18).toString('base64url');
    db.prepare('UPDATE deals SET upload_token=? WHERE id=?').run(t, d.id); return t;
  }
  function setStage(d, stage, userId, why) {
    if (!STAGES.includes(stage) || d.stage === stage) return;
    const f = { stage, updated_at: now() };
    if (stage === 'funded' && !d.funded_at) f.funded_at = now();
    db.prepare(`UPDATE deals SET ${Object.keys(f).map(k => k + '=?').join(',')} WHERE id=?`).run(...Object.values(f), d.id);
    if (stage === 'funded') setTimeout(() => ctx.money && ctx.money.sync(d.id), 50);
    if (stage === 'funded') db.prepare("UPDATE leads SET status='done', disposition='Funded', last_outcome='Funded', updated_at=? WHERE id=?").run(now(), d.lead_id);
    event(d.id, userId, 'stage', `${STAGE_LABEL[d.stage]} → ${STAGE_LABEL[stage]}${why ? ' (' + why + ')' : ''}`);
    emitAll('deal_update', { dealId: d.id, leadId: d.lead_id, stage });
  }
  // move forward only (never backwards automatically)
  const advance = (d, stage, why) => { if (STAGES.indexOf(stage) > STAGES.indexOf(d.stage) && d.stage !== 'lost') setStage(d, stage, null, why); };
  function openDealFor(leadId, userId) {
    const ex = db.prepare(`SELECT * FROM deals WHERE lead_id=? AND stage NOT IN ('funded','lost') ORDER BY id DESC LIMIT 1`).get(leadId);
    if (ex) return ex;
    const l = db.prepare('SELECT * FROM leads WHERE id=?').get(leadId); if (!l) return null;
    const ins = db.prepare('INSERT INTO deals(lead_id,owner_id,title,created_at,updated_at) VALUES(?,?,?,?,?)').run(leadId, l.owner_id || userId || null, l.business || l.name || l.phone, now(), now());
    event(ins.lastInsertRowid, userId, 'created', 'Deal created');
    return getDeal(ins.lastInsertRowid);
  }

  function stmtSummary(d) {
    const x = safeJSON(d.stmt_analysis, null); if (!x) return '';
    const $ = n => n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US');
    return `Bank statements (${(x.statements || []).length} mo): avg deposits ${$(x.avg_monthly_revenue)}/mo, avg daily balance ${$(x.avg_daily_balance)}, NSFs ${x.total_nsf ?? '—'}${(x.existing_funders || []).length ? '\nExisting funders: ' + x.existing_funders.map(f => `${f.name} ${$(f.amount)} ${f.frequency || ''}`.trim()).join('; ') : ''}\n`;
  }

  // lender matching from the application
  function dealFacts(d) {
    const a = decApp(appOf(d)), l = db.prepare('SELECT * FROM leads WHERE id=?').get(d.lead_id) || {};
    let tib = null;
    if (a.start_date) { const s = new Date(a.start_date); if (!isNaN(s)) tib = Math.floor((now() - s) / (30.44 * 864e5)); }
    return { revenue: num(a.monthly_revenue), tib, fico: num(a.fico_estimate), positions: num(a.existing_positions), amount: num(a.amount_requested) ?? d.amount_requested,
      state: String(a.state || l.state || '').trim().toUpperCase().slice(0, 2), industry: String(a.industry || '').toLowerCase() };
  }
  function matchLender(L, f) {
    const fail = [], unknown = [];
    const chk = (have, min, label, fmt, max) => { if (min == null) return; if (have == null) unknown.push(label); else if (max ? have > min : have < min) fail.push(`${label} ${fmt(have)} ${max ? '>' : '<'} ${fmt(min)}`); };
    const $ = n => '$' + Math.round(n).toLocaleString('en-US');
    chk(f.revenue, L.min_monthly_revenue, 'Revenue', $);
    chk(f.tib, L.min_tib_months, 'Time in business', n => n + ' mo');
    chk(f.fico, L.min_fico, 'Credit', n => String(n));
    chk(f.positions, L.max_positions, 'Positions', n => String(n), true);
    chk(f.amount, L.min_amount, 'Amount', $);
    chk(f.amount, L.max_amount, 'Amount', $, true);
    const ex = s => String(s || '').toUpperCase().split(/[\s,;]+/).filter(Boolean);
    if (f.state && ex(L.excluded_states).includes(f.state)) fail.push(`Doesn't fund ${f.state}`);
    if (f.industry && String(L.excluded_industries || '').toLowerCase().split(/[,;\n]+/).map(x => x.trim()).filter(Boolean).some(x => f.industry.includes(x))) fail.push('Restricted industry');
    return { ok: !fail.length, fail, unknown };
  }

  // ---------- public merchant application ----------
  const hits = new Map();
  const limited = (req, max = 60) => { const k = req.ip, t = now(), h = (hits.get(k) || []).filter(x => t - x < 10 * 60000); h.push(t); hits.set(k, h); return h.length > max; };
  const byToken = t => t && db.prepare('SELECT * FROM deals WHERE upload_token=?').get(String(t));
  r.get('/apply/:token', (req, res) => { if (!byToken(req.params.token)) return res.status(404).send('This link has expired. Please contact your funding specialist.'); res.sendFile(path.join(__dirname, 'public', 'apply.html')); });
  r.get('/apply-api/:token', (req, res) => {
    const d = byToken(req.params.token); if (!d) return res.status(404).json({ error: 'Link expired' });
    const l = db.prepare('SELECT * FROM leads WHERE id=?').get(d.lead_id) || {};
    const rep = db.prepare('SELECT name, email FROM users WHERE id=?').get(d.owner_id) || {};
    const a = appOf(d), pre = { legal_name: l.business, owner_name: l.name, owner_email: l.email, owner_cell: l.phone, state: l.state, amount_requested: d.amount_requested || '' };
    const safe = maskApp(a); for (const k of SENSITIVE) delete safe[k];
    res.json({ company: process.env.COMPANY_NAME || 'Brookestone Funding', rep: rep.name || '', app: { ...pre, ...safe }, signed: !!d.app_signed_at, needed: checklist(d).filter(x => !x.done).map(x => x.label),
      files: db.prepare("SELECT name, kind, created_at FROM deal_files WHERE deal_id=? AND uploaded_by IS NULL ORDER BY id").all(d.id) });
  });
  r.post('/apply-api/:token', express.json({ limit: '2mb' }), (req, res) => {
    if (limited(req)) return res.status(429).json({ error: 'Too many requests, try again in a few minutes' });
    const d = byToken(req.params.token); if (!d) return res.status(404).json({ error: 'Link expired' });
    const b = req.body || {}, a = appOf(d);
    const ALLOWED = ['legal_name', 'dba', 'ein', 'entity_type', 'start_date', 'industry', 'address', 'city', 'state', 'zip', 'business_phone', 'website', 'amount_requested', 'use_of_funds', 'monthly_revenue', 'existing_positions', 'existing_lenders',
      'owner_name', 'owner_title', 'ownership_pct', 'owner_email', 'owner_cell', 'owner_address', 'owner_city', 'owner_state', 'owner_zip', 'owner_dob', 'owner_ssn', 'fico_estimate', 'bank_name'];
    for (const k of ALLOWED) if (b[k] != null && String(b[k]).trim() !== '') a[k] = SENSITIVE.includes(k) ? enc(String(b[k]).trim().slice(0, 40)) : String(b[k]).trim().slice(0, 500);
    if (!b.signed_name || !/^data:image\/png;base64,/.test(b.signature || '') || !b.agree) return res.status(400).json({ error: 'Please type your name, sign, and check the authorization box' });
    for (const k of ['legal_name', 'owner_name', 'owner_ssn', 'owner_dob', 'monthly_revenue']) if (!a[k]) return res.status(400).json({ error: 'Please fill in all required fields' });
    a.signature = String(b.signature).slice(0, 400000); a.signed_name = String(b.signed_name).slice(0, 100); a.signed_at = now(); a.signed_ip = req.ip;
    const amt = num(a.amount_requested);
    db.prepare('UPDATE deals SET app=?, app_signed_at=?, amount_requested=COALESCE(?, amount_requested), updated_at=? WHERE id=?').run(JSON.stringify(a), now(), amt, now(), d.id);
    if (a.owner_email) db.prepare("UPDATE leads SET email=CASE WHEN email='' OR email IS NULL THEN ? ELSE email END WHERE id=?").run(a.owner_email, d.lead_id);
    event(d.id, null, 'app', 'Merchant signed the application');
    advance(getDeal(d.id), 'app_in', 'merchant signed');
    emitTo(d.owner_id, 'deal_alert', { dealId: d.id, text: `${a.legal_name || 'A merchant'} signed their application` });
    res.json({ ok: true });
  });
  r.post('/apply-api/:token/files', (req, res, next) => { if (limited(req, 40)) return res.status(429).json({ error: 'Too many uploads, try again later' }); next(); }, upload.array('files', 12), (req, res) => {
    const d = byToken(req.params.token);
    if (!d) { for (const f of req.files || []) fs.rm(f.path, () => {}); return res.status(404).json({ error: 'Link expired' }); }
    const kind = FILE_KINDS.includes(req.body.kind) ? req.body.kind : 'statement';
    for (const f of req.files || []) db.prepare('INSERT INTO deal_files(deal_id,kind,name,file,size,mime,created_at) VALUES(?,?,?,?,?,?,?)').run(d.id, kind, f.originalname.slice(0, 120), f.filename, f.size, f.mimetype, now());
    const n = (req.files || []).length;
    if (!n) return res.status(400).json({ error: 'Upload PDF or image files' });
    event(d.id, null, 'files', `Merchant uploaded ${n} file(s)`);
    const stmts = db.prepare("SELECT COUNT(*) n FROM deal_files WHERE deal_id=? AND kind='statement'").get(d.id).n;
    const fresh = getDeal(d.id);
    if (stmts >= Number(getSetting('statements_required', 3)) && fresh.app_signed_at) advance(fresh, 'docs_in', `${stmts} statements`);
    emitTo(d.owner_id, 'deal_alert', { dealId: d.id, text: `${fresh.title || 'Merchant'} uploaded ${n} file(s)` });
    touch(d.id);
    if (ctx.onFilesUploaded) ctx.onFilesUploaded(d.id, kind);
    res.json({ ok: true, count: n });
  });

  // ---------- deals (logged-in) ----------
  r.get('/api/deals', (req, res) => {
    const where = [], args = [];
    if (req.query.stage === 'open') where.push(`d.stage IN (${OPEN.map(() => '?').join(',')})`), args.push(...OPEN);
    else if (req.query.stage) where.push('d.stage=?'), args.push(req.query.stage);
    if (req.query.owner === 'me') where.push('d.owner_id=?'), args.push(req.user.id);
    else if (req.query.owner) where.push('d.owner_id=?'), args.push(Number(req.query.owner));
    if (req.query.lead) where.push('d.lead_id=?'), args.push(Number(req.query.lead));
    if (req.query.q) { const s = '%' + req.query.q + '%'; where.push('(d.title LIKE ? OR l.name LIKE ? OR l.business LIKE ? OR l.phone LIKE ?)'); args.push(s, s, s, s); }
    if (req.query.since) where.push('(d.stage NOT IN (\'funded\',\'lost\') OR d.updated_at>=?)'), args.push(Number(req.query.since));
    const rows = db.prepare(`SELECT d.*, l.name lead_name, l.business lead_business, l.phone lead_phone, l.state lead_state, u.name owner_name, ln.name lender_name,
        (SELECT COUNT(*) FROM deal_files f WHERE f.deal_id=d.id AND f.kind='statement') statements,
        (SELECT COUNT(*) FROM submissions s WHERE s.deal_id=d.id) subs,
        (SELECT COUNT(*) FROM submissions s WHERE s.deal_id=d.id AND s.status='approved') offers,
        (SELECT MAX(offer_amount) FROM submissions s WHERE s.deal_id=d.id AND s.status='approved') best_offer
      FROM deals d JOIN leads l ON l.id=d.lead_id LEFT JOIN users u ON u.id=d.owner_id LEFT JOIN lenders ln ON ln.id=d.lender_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.updated_at DESC LIMIT 1000`).all(...args);
    res.json({ stages: STAGES.map(s => ({ id: s, label: STAGE_LABEL[s] })), rows: rows.map(d => dealOut(d)) });
  });
  r.post('/api/deals', (req, res) => {
    const d = openDealFor(Number(req.body.lead_id), req.user.id);
    if (!d) return res.status(404).json({ error: 'Lead not found' });
    res.json({ id: d.id });
  });
  r.get('/api/deals/:id', (req, res) => {
    const d = getDeal(Number(req.params.id)); if (!d) return res.status(404).json({ error: 'Deal not found' });
    const lead = db.prepare('SELECT l.*, u.name owner_name FROM leads l LEFT JOIN users u ON u.id=l.owner_id WHERE l.id=?').get(d.lead_id);
    const files = db.prepare('SELECT f.id, f.kind, f.name, f.size, f.mime, f.created_at, f.uploaded_by, u.name uploader FROM deal_files f LEFT JOIN users u ON u.id=f.uploaded_by WHERE deal_id=? ORDER BY f.id').all(d.id);
    const subs = db.prepare('SELECT s.*, ln.name lender_name, u.name user_name FROM submissions s JOIN lenders ln ON ln.id=s.lender_id LEFT JOIN users u ON u.id=s.user_id WHERE deal_id=? ORDER BY s.sent_at DESC').all(d.id);
    const events = db.prepare('SELECT e.*, u.name user_name FROM deal_events e LEFT JOIN users u ON u.id=e.user_id WHERE deal_id=? ORDER BY created_at DESC LIMIT 200').all(d.id);
    const emails = db.prepare('SELECT e.*, ln.name lender_name FROM emails e LEFT JOIN lenders ln ON ln.id=e.lender_id WHERE deal_id=? ORDER BY created_at DESC LIMIT 100').all(d.id);
    const f = dealFacts(d);
    const lenders = db.prepare('SELECT * FROM lenders WHERE active=1 ORDER BY in_house DESC, name').all().map(L => ({ id: L.id, name: L.name, email: L.email, in_house: L.in_house, ...matchLender(L, f), submitted: subs.some(s => s.lender_id === L.id) }));
    const sig = appOf(d).signature;
    res.json({ deal: dealOut(d, { signature: sig || null }), lead: leadOut(lead), files, submissions: subs, events, emails, lenders, facts: f, checklist: checklist(d), email_enabled: mail.enabled(), stages: STAGES.map(s => ({ id: s, label: STAGE_LABEL[s] })) });
  });
  r.patch('/api/deals/:id', (req, res) => {
    const d = getDeal(Number(req.params.id)); if (!d) return res.status(404).json({ error: 'Deal not found' });
    const b = req.body, f = {};
    const nums = ['amount_requested', 'funded_amount', 'factor_rate', 'payback', 'term_days', 'payment_amount', 'collected', 'commission_pct', 'commission_amt', 'revenue_override'];
    for (const k of nums) if (k in b) f[k] = b[k] === '' || b[k] == null ? null : num(b[k]);
    if (['commission_pct', 'commission_amt', 'revenue_override'].some(k => k in f) && req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can change commission' });
    for (const k of ['title', 'notes', 'lost_reason']) if (k in b) f[k] = String(b[k] || '');
    if ('payment_freq' in b) f.payment_freq = b.payment_freq === 'weekly' ? 'weekly' : 'daily';
    if ('owner_id' in b) f.owner_id = b.owner_id ? Number(b.owner_id) : null;
    if ('lender_id' in b) f.lender_id = b.lender_id ? Number(b.lender_id) : null;
    if ('funded_at' in b) f.funded_at = b.funded_at ? Number(b.funded_at) : null;
    if (['closer_id', 'orig_split', 'closer_split'].some(k => k in b)) {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can change splits' });
      if ('closer_id' in b) f.closer_id = b.closer_id ? Number(b.closer_id) : null;
      for (const k of ['orig_split', 'closer_split']) if (k in b) f[k] = b[k] === '' || b[k] == null ? null : Math.max(0, Math.min(100, Number(b[k]) || 0));
    }
    if (f.funded_amount != null && f.factor_rate != null && !('payback' in b)) f.payback = Math.round(f.funded_amount * f.factor_rate * 100) / 100;
    if (b.app && typeof b.app === 'object') {
      const a = appOf(d);
      for (const [k, v] of Object.entries(b.app)) { if (k === 'signature') continue; if (SENSITIVE.includes(k)) { if (String(v).includes('•')) continue; a[k] = enc(String(v)); } else a[k] = String(v ?? ''); }
      f.app = JSON.stringify(a);
    }
    if (Object.keys(f).length) {
      f.updated_at = now();
      db.prepare(`UPDATE deals SET ${Object.keys(f).map(k => k + '=?').join(',')} WHERE id=?`).run(...Object.values(f), d.id);
      const changed = Object.keys(f).filter(k => !['updated_at', 'app'].includes(k));
      if (changed.length) event(d.id, req.user.id, 'edit', 'Updated ' + changed.map(k => k.replace(/_/g, ' ')).join(', '));
      if (f.app) event(d.id, req.user.id, 'edit', 'Edited application');
    }
    if (b.stage) setStage(getDeal(d.id), b.stage, req.user.id, b.stage === 'lost' && b.lost_reason ? b.lost_reason : '');
    if (ctx.money) ctx.money.sync(d.id);
    res.json({ deal: dealOut(getDeal(d.id)) });
  });
  r.delete('/api/deals/:id', adminOnly, (req, res) => {
    audit(req, 'deal.delete', 'deal', req.params.id, '');
    for (const f of db.prepare('SELECT file FROM deal_files WHERE deal_id=?').all(Number(req.params.id))) fs.rm(path.join(filesDir, f.file), () => {});
    db.prepare('DELETE FROM deals WHERE id=?').run(Number(req.params.id)); res.json({ ok: true });
  });
  r.post('/api/deals/:id/notes', (req, res) => {
    const body = String(req.body.body || '').trim(); if (!body) return res.status(400).json({ error: 'Empty note' });
    event(Number(req.params.id), req.user.id, 'note', body); touch(Number(req.params.id)); res.json({ ok: true });
  });
  r.post('/api/deals/:id/reveal', (req, res) => {
    const d = getDeal(Number(req.params.id)); if (!d) return res.status(404).json({ error: 'Deal not found' });
    if (req.user.role !== 'admin' && d.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the deal owner or an admin can view this' });
    const a = appOf(d), out = {}; for (const k of SENSITIVE) if (a[k]) out[k] = dec(a[k]);
    event(d.id, req.user.id, 'reveal', 'Viewed SSN / DOB'); audit(req, 'ssn.reveal', 'deal', d.id, ''); res.json(out);
  });
  // send the application/upload link
  r.post('/api/deals/:id/link', async (req, res) => {
    const d = getDeal(Number(req.params.id)); if (!d) return res.status(404).json({ error: 'Deal not found' });
    const link = `${PUBLIC_URL}/apply/${ensureToken(d)}`;
    const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(d.lead_id);
    const first = (lead.name || '').split(' ')[0] || 'there', rep = (req.user.name || '').split(' ')[0];
    const company = process.env.COMPANY_NAME || 'Brookestone Funding';
    try {
      if (req.body.via === 'sms') {
        const m = await sendSms(lead, `Hi ${first}, it's ${rep} with ${company}. Here's your secure application — takes 3 minutes, and you can upload your last 4 months of bank statements on the same page: ${link}`, req.user);
        if (m.status === 'failed') throw new Error('SMS failed: ' + m.error);
      } else if (req.body.via === 'email') {
        if (!lead.email) throw new Error('This lead has no email address');
        await ctx.sendLeadEmail(lead, req.user, { subject: `Your ${company} application`, text: `Hi ${first},\n\nHere's your secure funding application. It takes about 3 minutes, and you can upload your last 4 months of business bank statements on the same page:\n\n${link}\n\nAny questions, just reply here.\n\n${req.user.name}\n${company}`, dealId: d.id });
      }
    } catch (e) { return res.status(400).json({ error: e.message }); }
    if (req.body.via) { event(d.id, req.user.id, 'link', `Sent application link by ${req.body.via}`); if (d.stage === 'interested') setStage(getDeal(d.id), 'app_sent', req.user.id); }
    res.json({ link });
  });
  // documents
  r.post('/api/deals/:id/files', upload.array('files', 20), (req, res) => {
    const d = getDeal(Number(req.params.id)); if (!d) return res.status(404).json({ error: 'Deal not found' });
    const kind = FILE_KINDS.includes(req.body.kind) ? req.body.kind : 'other';
    for (const f of req.files || []) db.prepare('INSERT INTO deal_files(deal_id,kind,name,file,size,mime,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,?)').run(d.id, kind, f.originalname.slice(0, 120), f.filename, f.size, f.mimetype, req.user.id, now());
    event(d.id, req.user.id, 'files', `Uploaded ${(req.files || []).length} ${kind.replace('_', ' ')} file(s)`); touch(d.id);
    if (ctx.onFilesUploaded) ctx.onFilesUploaded(d.id, kind);
    const stmts = db.prepare("SELECT COUNT(*) n FROM deal_files WHERE deal_id=? AND kind='statement'").get(d.id).n;
    const fresh = getDeal(d.id); if (stmts >= Number(getSetting('statements_required', 3)) && fresh.app_signed_at) advance(fresh, 'docs_in', `${stmts} statements`);
    res.json({ ok: true });
  });
  r.get('/api/deals/:id/files/:fid', (req, res) => {
    const f = db.prepare('SELECT * FROM deal_files WHERE id=? AND deal_id=?').get(Number(req.params.fid), Number(req.params.id));
    if (!f) return res.status(404).send('Not found');
    res.download(path.join(filesDir, f.file), f.name);
  });
  r.delete('/api/deals/:id/files/:fid', (req, res) => {
    const f = db.prepare('SELECT * FROM deal_files WHERE id=? AND deal_id=?').get(Number(req.params.fid), Number(req.params.id));
    if (f) { db.prepare('DELETE FROM deal_files WHERE id=?').run(f.id); fs.rm(path.join(filesDir, f.file), () => {}); event(f.deal_id, req.user.id, 'files', 'Deleted ' + f.name); }
    res.json({ ok: true });
  });
  r.get('/api/deals/:id/application.pdf', async (req, res) => {
    const d = getDeal(Number(req.params.id)); if (!d) return res.status(404).send('Not found');
    if (req.user.role !== 'admin' && d.owner_id !== req.user.id) return res.status(403).send('Only the deal owner or an admin can download the full application');
    const pdf = await applicationPdf(decApp(appOf(d)), { dealId: d.id });
    res.type('application/pdf').set('Content-Disposition', `inline; filename="application-${d.id}.pdf"`).send(pdf);
  });

  // ---------- lender submissions ----------
  async function doSubmit(d, ids, note, user) {
    const a = decApp(appOf(d)), lead = db.prepare('SELECT * FROM leads WHERE id=?').get(d.lead_id), f = dealFacts(d);
    const files = db.prepare('SELECT * FROM deal_files WHERE deal_id=? ORDER BY kind, id').all(d.id);
    const attachments = files.map(x => ({ filename: x.name, path: path.join(filesDir, x.file) }));
    if (d.app_signed_at) attachments.unshift({ filename: `Application - ${a.legal_name || d.title}.pdf`, content: await applicationPdf(a, { dealId: d.id }) });
    const $ = n => n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US');
    const company = process.env.COMPANY_NAME || 'Brookestone Funding';
    const results = [];
    for (const lid of ids) {
      const L = db.prepare('SELECT * FROM lenders WHERE id=?').get(lid); if (!L) continue;
      const t = now();
      const sub = db.prepare('INSERT INTO submissions(deal_id,lender_id,user_id,status,notes,sent_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(d.id, L.id, user.id, 'submitted', String(note || ''), t, t);
      const sid = Number(sub.lastInsertRowid);
      if (L.in_house) { results.push({ lender: L.name, ok: true }); event(d.id, user.id, 'submit', `Sent to ${L.name} (in-house underwriting)`); continue; }
      if (!L.email) { db.prepare("UPDATE submissions SET error='Lender has no email' WHERE id=?").run(sid); results.push({ lender: L.name, ok: false, error: 'no email' }); continue; }
      const subject = `${L.subject_prefix ? L.subject_prefix + ' ' : ''}New submission: ${a.legal_name || d.title} — ${$(f.amount)} — ${f.state || ''} [PD-${d.id}-${sid}]`;
      const text = `Hi ${L.contact_name || L.name} team,

Please review the following file for funding.

Business: ${a.legal_name || d.title}${a.dba ? ' (DBA ' + a.dba + ')' : ''}
Industry: ${a.industry || '—'}   State: ${f.state || '—'}
Time in business: ${f.tib != null ? Math.floor(f.tib / 12) + ' yr ' + (f.tib % 12) + ' mo' : '—'}
Avg. monthly revenue: ${$(f.revenue)}
Requested: ${$(f.amount)}   Use of funds: ${a.use_of_funds || '—'}
Open positions: ${a.existing_positions || '—'} ${a.existing_lenders ? '(' + a.existing_lenders + ')' : ''}
Est. credit: ${a.fico_estimate || '—'}
${stmtSummary(d)}${note ? '\nNotes: ' + note + '\n' : ''}
Attached: ${attachments.map(x => x.filename).join(', ') || 'none'}

Please reply to this email with your decision or offer.

${user.name}
${company}`;
      try {
        const sent = await mail.send({ to: L.email, cc: L.cc || undefined, subject, text, attachments, fromName: `${user.name} | ${company}` });
        db.prepare('UPDATE submissions SET message_id=? WHERE id=?').run(sent.messageId, sid);
        db.prepare("INSERT INTO emails(deal_id,submission_id,lender_id,user_id,direction,subject,body,from_addr,to_addr,message_id,attachments,status,created_at) VALUES(?,?,?,?,'out',?,?,?,?,?,?,?,?)")
          .run(d.id, sid, L.id, user.id, subject, text, mail.fromAddr(), L.email, sent.messageId, JSON.stringify(attachments.map(x => x.filename)), 'sent', t);
        event(d.id, user.id, 'submit', `Submitted to ${L.name}`);
        results.push({ lender: L.name, ok: true });
      } catch (e) {
        db.prepare("UPDATE submissions SET error=?, status='withdrawn' WHERE id=?").run(e.message, sid);
        results.push({ lender: L.name, ok: false, error: e.message });
      }
    }
    if (results.some(x => x.ok)) advance(getDeal(d.id), 'submitted');
    return results;
  }
  r.post('/api/deals/:id/submit', async (req, res) => {
    const d = getDeal(Number(req.params.id)); if (!d) return res.status(404).json({ error: 'Deal not found' });
    const ids = (req.body.lender_ids || []).map(Number).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'Pick at least one lender' });
    if (!mail.enabled()) return res.status(400).json({ error: 'Email is not set up yet (SMTP settings in .env)' });
    if (ctx.pilot && !ctx.pilot.can(req.user, 'submit_deals')) return res.status(403).json({ error: "You don't have permission to submit deals" });
    res.json({ results: await doSubmit(d, ids, req.body.note, req.user) });
  });
  r.patch('/api/submissions/:id', (req, res) => {
    const s = db.prepare('SELECT * FROM submissions WHERE id=?').get(Number(req.params.id)); if (!s) return res.status(404).json({ error: 'Not found' });
    const b = req.body, f = { updated_at: now() };
    if (b.status && ['submitted', 'info_needed', 'approved', 'declined', 'funded', 'withdrawn'].includes(b.status)) f.status = b.status;
    for (const k of ['offer_amount', 'offer_factor', 'offer_term_days', 'offer_payment']) if (k in b) f[k] = num(b[k]);
    for (const k of ['offer_freq', 'decline_reason', 'notes']) if (k in b) f[k] = String(b[k] || '');
    db.prepare(`UPDATE submissions SET ${Object.keys(f).map(k => k + '=?').join(',')} WHERE id=?`).run(...Object.values(f), s.id);
    const L = db.prepare('SELECT name FROM lenders WHERE id=?').get(s.lender_id);
    if (f.status) event(s.deal_id, req.user.id, 'submission', `${L.name}: ${f.status.replace('_', ' ')}${f.offer_amount ? ' $' + f.offer_amount.toLocaleString('en-US') : ''}`);
    onSubmissionChange(s.deal_id, s.id);
    res.json({ ok: true });
  });
  function onSubmissionChange(dealId, subId) {
    const s = db.prepare('SELECT * FROM submissions WHERE id=?').get(subId), d = getDeal(dealId);
    if (s.status === 'approved') advance(d, 'offer', 'offer received');
    if (s.status === 'funded') {
      const f = { lender_id: s.lender_id, updated_at: now() };
      if (s.offer_amount && !d.funded_amount) f.funded_amount = s.offer_amount;
      if (s.offer_factor && !d.factor_rate) f.factor_rate = s.offer_factor;
      if (f.funded_amount && f.factor_rate && !d.payback) f.payback = Math.round(f.funded_amount * f.factor_rate * 100) / 100;
      if (s.offer_term_days && !d.term_days) f.term_days = s.offer_term_days;
      if (s.offer_payment && !d.payment_amount) f.payment_amount = s.offer_payment;
      if (s.offer_freq && !d.payment_amount) f.payment_freq = s.offer_freq === 'weekly' ? 'weekly' : 'daily';
      db.prepare(`UPDATE deals SET ${Object.keys(f).map(k => k + '=?').join(',')} WHERE id=?`).run(...Object.values(f), d.id);
      setStage(getDeal(d.id), 'funded', null, 'funded by lender');
    }
    emitAll('deal_update', { dealId, leadId: d.lead_id });
  }
  // AI reads a lender's reply
  async function readLenderReply(subId, text) {
    if (!process.env.ANTHROPIC_API_KEY) return;
    const s = db.prepare('SELECT s.*, ln.name lender_name FROM submissions s JOIN lenders ln ON ln.id=s.lender_id WHERE s.id=?').get(subId); if (!s) return;
    try {
      const j = await claude(`A funding company submitted a merchant cash advance deal to the lender "${s.lender_name}". Read the lender's reply email and return ONLY JSON:
{"status":"approved|declined|info_needed|other","offer_amount":number|null,"factor_rate":number|null,"term_days":number|null,"payment":number|null,"payment_freq":"daily|weekly|null","reason":"one short sentence: decline reason, what info they need, or offer summary"}
Convert terms in months to days (x30) and weeks to days (x7). Use null when not stated.

EMAIL:
${String(text).slice(0, 15000)}`);
      const f = { ai_note: j.reason || '', updated_at: now() };
      if (['approved', 'declined', 'info_needed'].includes(j.status) && !['funded', 'withdrawn'].includes(s.status)) f.status = j.status;
      if (j.offer_amount) f.offer_amount = j.offer_amount; if (j.factor_rate) f.offer_factor = j.factor_rate;
      if (j.term_days) f.offer_term_days = j.term_days; if (j.payment) f.offer_payment = j.payment;
      if (j.payment_freq && j.payment_freq !== 'null') f.offer_freq = j.payment_freq;
      if (j.status === 'declined' && j.reason) f.decline_reason = j.reason;
      db.prepare(`UPDATE submissions SET ${Object.keys(f).map(k => k + '=?').join(',')} WHERE id=?`).run(...Object.values(f), s.id);
      event(s.deal_id, null, 'submission', `${s.lender_name} replied — AI read it as: ${j.status}${j.offer_amount ? ' $' + Number(j.offer_amount).toLocaleString('en-US') : ''}. ${j.reason || ''}`);
      onSubmissionChange(s.deal_id, s.id);
      const d = getDeal(s.deal_id); emitTo(d.owner_id, 'deal_alert', { dealId: d.id, text: `${s.lender_name} replied on ${d.title}: ${j.status.replace('_', ' ')}` });
    } catch (e) { log('Lender reply AI error:', e.message); }
  }

  // ---------- lenders ----------
  const LENDER_FIELDS = ['name', 'contact_name', 'email', 'cc', 'phone', 'excluded_states', 'excluded_industries', 'notes'];
  const LENDER_NUMS = ['broker_pct', 'min_monthly_revenue', 'min_tib_months', 'min_fico', 'max_positions', 'min_amount', 'max_amount'];
  r.get('/api/lenders', (req, res) => {
    const since = now() - 90 * 864e5;
    res.json(db.prepare(`SELECT ln.*, (SELECT COUNT(*) FROM submissions s WHERE s.lender_id=ln.id AND s.sent_at>=?) subs90,
      (SELECT COUNT(*) FROM submissions s WHERE s.lender_id=ln.id AND s.sent_at>=? AND s.status IN ('approved','funded')) approvals90,
      (SELECT COUNT(*) FROM submissions s WHERE s.lender_id=ln.id AND s.status='funded') funded
      FROM lenders ln ORDER BY ln.active DESC, ln.in_house DESC, ln.name`).all(since, since));
  });
  const lenderFields = b => {
    const f = {};
    for (const k of LENDER_FIELDS) if (k in b) f[k] = String(b[k] || '').trim();
    for (const k of LENDER_NUMS) if (k in b) f[k] = num(b[k]);
    if ('active' in b) f.active = b.active ? 1 : 0; if ('in_house' in b) f.in_house = b.in_house ? 1 : 0;
    return f;
  };
  r.post('/api/lenders', adminOnly, (req, res) => {
    const f = lenderFields(req.body); if (!f.name) return res.status(400).json({ error: 'Lender name is required' });
    f.created_at = now();
    const x = db.prepare(`INSERT INTO lenders(${Object.keys(f).join(',')}) VALUES(${Object.keys(f).map(() => '?').join(',')})`).run(...Object.values(f));
    res.json({ id: x.lastInsertRowid });
  });
  r.patch('/api/lenders/:id', adminOnly, (req, res) => {
    const f = lenderFields(req.body); if (!Object.keys(f).length) return res.json({ ok: true });
    db.prepare(`UPDATE lenders SET ${Object.keys(f).map(k => k + '=?').join(',')} WHERE id=?`).run(...Object.values(f), Number(req.params.id));
    res.json({ ok: true });
  });
  r.delete('/api/lenders/:id', adminOnly, (req, res) => { db.prepare('UPDATE lenders SET active=0 WHERE id=?').run(Number(req.params.id)); res.json({ ok: true }); });

  // ---------- renewals ----------
  function checkRenewals() {
    const pctNeeded = Number(getSetting('renewal_pct', 50));
    for (const d of db.prepare("SELECT * FROM deals WHERE stage='funded' AND renewal_queued_at IS NULL AND payback>0").all()) {
      const p = paidIn(d); if (!p || p.pct < pctNeeded) continue;
      const t = now();
      db.prepare("UPDATE leads SET status='callback', callback_at=?, owner_id=COALESCE(?, owner_id), last_outcome='Renewal eligible', updated_at=? WHERE id=? AND status!='dnc'").run(t, d.owner_id, t, d.lead_id);
      db.prepare('INSERT INTO notes(lead_id,user_id,body,created_at) VALUES(?,?,?,?)').run(d.lead_id, null, `Renewal eligible — ${p.pct}% paid in on deal #${d.id}${p.estimated ? ' (estimated from payment schedule)' : ''}. Queued for a call.`, t);
      db.prepare('UPDATE deals SET renewal_queued_at=? WHERE id=?').run(t, d.id);
      event(d.id, null, 'renewal', `Renewal eligible at ${p.pct}% paid in — queued for ${d.owner_id ? 'the deal owner' : 'the team'}`);
      emitTo(d.owner_id, 'deal_alert', { dealId: d.id, text: `Renewal ready: ${d.title} is ${p.pct}% paid in` });
    }
  }
  setInterval(checkRenewals, 30 * 60000); setTimeout(checkRenewals, 5000);
  r.get('/api/renewals', (req, res) => {
    const rows = db.prepare(`SELECT d.*, l.name lead_name, l.business lead_business, l.phone lead_phone, u.name owner_name, ln.name lender_name FROM deals d JOIN leads l ON l.id=d.lead_id
      LEFT JOIN users u ON u.id=d.owner_id LEFT JOIN lenders ln ON ln.id=d.lender_id WHERE d.stage='funded' ${req.query.owner === 'me' ? 'AND d.owner_id=' + Number(req.user.id) : ''} ORDER BY d.funded_at DESC`).all();
    res.json({ threshold: Number(getSetting('renewal_pct', 50)), rows: rows.map(d => dealOut(d)).sort((a, b) => (b.paid_in?.pct || 0) - (a.paid_in?.pct || 0)) });
  });
  r.post('/api/renewals/check', (req, res) => { checkRenewals(); res.json({ ok: true }); });

  // ---------- commissions ----------
  r.get('/api/commissions', (req, res) => {
    const from = Number(req.query.from) || 0, to = Number(req.query.to) || now() + 1;
    const mine = req.user.role !== 'admin';
    const rows = db.prepare(`SELECT d.*, l.business lead_business, l.name lead_name, u.name owner_name, ln.name lender_name FROM deals d JOIN leads l ON l.id=d.lead_id
      LEFT JOIN users u ON u.id=d.owner_id LEFT JOIN lenders ln ON ln.id=d.lender_id
      WHERE d.stage='funded' AND d.funded_at>=? AND d.funded_at<? ${mine ? 'AND d.owner_id=?' : (req.query.user ? 'AND d.owner_id=?' : '')} ORDER BY d.funded_at DESC`)
      .all(...[from, to, ...(mine ? [req.user.id] : req.query.user ? [Number(req.query.user)] : [])]).map(d => dealOut(d));
    const byRep = {};
    for (const d of rows) {
      const k = d.owner_id || 0, o = byRep[k] = byRep[k] || { owner_id: d.owner_id, name: d.owner_name || 'Unassigned', deals: 0, funded: 0, earned: 0, paid: 0 };
      o.deals++; o.funded += d.funded_amount || 0; o.earned += d.commission_due || 0; if (d.commission_paid_at) o.paid += d.commission_due || 0;
    }
    res.json({ rows, reps: Object.values(byRep) });
  });
  r.post('/api/deals/:id/commission-paid', adminOnly, (req, res) => {
    db.prepare('UPDATE deals SET commission_paid_at=? WHERE id=?').run(req.body.paid === false ? null : now(), Number(req.params.id)); audit(req, 'commission.paid', 'deal', req.params.id, String(req.body.paid !== false));
    event(Number(req.params.id), req.user.id, 'commission', req.body.paid === false ? 'Commission marked unpaid' : 'Commission marked paid');
    res.json({ ok: true });
  });

  return { router: r, doSubmit, openDealFor, readLenderReply, event, STAGES, STAGE_LABEL, getDeal, setStage, advance, dealOut, revenue, commission, paidIn, appOf, decApp, ensureToken, dealFacts, matchLender, checklist, touch, upload, num };
};
