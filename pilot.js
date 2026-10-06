// MCA Pilot parity layer.
//   Needs Action queue · 27-status pipeline · tasks · funder criteria matching + auto-submit ·
//   bank statements / positions per deal · workflows · passes · permissions · batches · global submissions & offers
const express = require('express');
const { db, getSetting, setSetting, audit } = require('./db');
const mail = require('./mail');

const DAY = 864e5, HOUR = 36e5, now = () => Date.now();
const safeJSON = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const num = v => { if (v === '' || v == null) return null; const n = Number(String(v).replace(/[$,%\s]/g, '')); return Number.isFinite(n) ? n : null; };
const round2 = n => Math.round(n * 100) / 100;
const csvCell = v => { v = String(v ?? ''); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };

function ensureCol(table, col, type) {
  try { if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); }
  catch (e) { console.error('ensureCol', table, col, e.message); }
}

// ---- the pipeline: [status, core stage, group] ----
const STATUSES = [
  ['New Application', 'interested', 'open'], ['Missing Documents', 'app_in', 'open'], ['Ready to Submit', 'docs_in', 'open'],
  ['Submitted', 'submitted', 'open'], ['Approved', 'offer', 'open'], ['Resubmitting', 'submitted', 'open'],
  ['Offer Pitched', 'offer', 'open'], ['Offer Selected', 'offer', 'open'], ['Repricing', 'offer', 'open'],
  ['Offer Accepted', 'contract', 'open'], ['Received DL/VC', 'contract', 'open'], ['Contracts Requested', 'contract', 'open'],
  ['Contracts Sent', 'contract', 'open'], ['Contracts Signed', 'contract', 'open'], ['Final Review', 'contract', 'open'],
  ['Funded', 'funded', 'funded'], ['Funded - Missed Payments', 'funded', 'funded'], ['Funded - Defaulted', 'funded', 'funded'],
  ['Funded - Up for Renewal', 'funded', 'funded'], ['Funded - Renewed', 'funded', 'funded'],
  ['Closed - Missing Documents', 'lost', 'closed'], ['Closed - Unable to Submit', 'lost', 'closed'], ['Closed - Declined', 'lost', 'closed'],
  ['Closed - Offer Rejected', 'lost', 'closed'], ['Closed - Killed by Funder', 'lost', 'closed'], ['Closed - Unresponsive', 'lost', 'closed'],
];
const STATUS_MAP = Object.fromEntries(STATUSES.map(([s, st, g]) => [s, { stage: st, group: g }]));

const PERMS = [
  ['submit_deals', 'Submit deals to funders'], ['request_funders', 'Request contracts / bumps from funders'], ['see_funders', 'See the Funders page'],
  ['see_submissions', 'See the Submissions page'], ['see_offers', 'See the Offers page'], ['see_tasks_all', 'See everyone\'s tasks'],
  ['see_attribution', 'See Attribution (sources and batches)'], ['see_splits', 'See outgoing splits on deals'], ['change_status', 'Change deal status'],
];
const PULLS = { daily: 21, weekly: 4, biweekly: 2, monthly: 1 };
const DEFAULT_CFG = {
  autosub: { enabled: false, max: 8 },
  passes: { enabled: false, days: 7, max_passes: 3, pool: [] },
  templates: {
    contracts: { subject: 'Contracts request: {company_name}', body: 'Hi {funder} team,\n\nThe merchant has accepted your offer on {company_name}. Please send over the contracts.\n\nThank you,\n{user_name}\n{company}' },
    bump: { subject: 'Bump request: {company_name}', body: 'Hi {funder} team,\n\nCould you take another look at {company_name}? The merchant is comparing offers and we would like to see if you can improve your terms.\n\nThank you,\n{user_name}\n{company}' },
    info: { subject: 'Update on {company_name}', body: 'Hi {funder} team,\n\nHere is the information you asked for on {company_name}.\n\n{note}\n\nThank you,\n{user_name}\n{company}' },
  },
};
const cfgGet = () => { const c = getSetting('pilot', {}) || {}; return { autosub: { ...DEFAULT_CFG.autosub, ...(c.autosub || {}) }, passes: { ...DEFAULT_CFG.passes, ...(c.passes || {}) }, templates: { ...DEFAULT_CFG.templates, ...(c.templates || {}) } }; };

const TRIGGERS = [
  ['deal_created', 'Deal created'], ['status_changed', 'Deal status changed'], ['offer_created', 'Offer received'],
  ['submission_errored', 'Submission failed'], ['all_declined', 'All funders declined'], ['task_created', 'Task created'],
  ['task_due', 'Task due'], ['renewal_due', 'Advance up for renewal'],
];
const ACTIONS = [['create_task', 'Create a task'], ['set_status', 'Change deal status'], ['add_note', 'Add a note to the deal'], ['notify', 'Notify the deal owner']];

module.exports = function pilot(ctx) {
  const { adminOnly, log } = ctx;
  const D = () => ctx.deals;
  const r = express.Router();

  // ---------------- schema ----------------
  db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY, deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE, lender_id INTEGER, submission_id INTEGER,
    type TEXT NOT NULL DEFAULT 'general', description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open',
    assigned_to INTEGER, due_at INTEGER, pinned INTEGER NOT NULL DEFAULT 0, auto INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER, created_at INTEGER NOT NULL, done_at INTEGER);
  CREATE INDEX IF NOT EXISTS tasks_deal ON tasks(deal_id);
  CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, due_at);
  CREATE TABLE IF NOT EXISTS deal_statements (
    id INTEGER PRIMARY KEY, deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE, month TEXT NOT NULL, account TEXT DEFAULT '',
    revenue REAL, deposits REAL, neg_days REAL, low_days REAL, adb REAL, open_bal REAL, close_bal REAL, nsf REAL);
  CREATE INDEX IF NOT EXISTS stm_deal ON deal_statements(deal_id);
  CREATE TABLE IF NOT EXISTS deal_positions (
    id INTEGER PRIMARY KEY, deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE, funder TEXT NOT NULL DEFAULT '',
    payment REAL, frequency TEXT DEFAULT 'daily', status TEXT DEFAULT 'Active', funded_amount REAL, funded_date INTEGER);
  CREATE INDEX IF NOT EXISTS pos_deal ON deal_positions(deal_id);
  CREATE TABLE IF NOT EXISTS deal_status_log (
    id INTEGER PRIMARY KEY, deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE, prev TEXT, next TEXT, reason TEXT DEFAULT '',
    user_id INTEGER, auto INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS dsl_deal ON deal_status_log(deal_id, at);
  CREATE TABLE IF NOT EXISTS workflows (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, trigger TEXT NOT NULL, cond TEXT DEFAULT '{}', action TEXT NOT NULL, params TEXT DEFAULT '{}',
    active INTEGER NOT NULL DEFAULT 1, runs INTEGER NOT NULL DEFAULT 0, last_run INTEGER, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS wf_seen (kind TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(kind, key));
  CREATE TABLE IF NOT EXISTS batches (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, source TEXT DEFAULT '', vendor TEXT DEFAULT '', price REAL, count INTEGER,
    ext_id TEXT DEFAULT '', created_at INTEGER NOT NULL);
  `);
  for (const [t, c, ty] of [
    ['deals', 'pilot_status', 'TEXT'], ['deals', 'wf_status', 'TEXT'], ['deals', 'legal_structure', "TEXT DEFAULT ''"], ['deals', 'default_status', "TEXT DEFAULT ''"],
    ['deals', 'products', "TEXT DEFAULT ''"], ['deals', 'owners', 'TEXT'], ['deals', 'unsubscribe', 'INTEGER NOT NULL DEFAULT 0'],
    ['deals', 'skip_autosub', 'INTEGER NOT NULL DEFAULT 0'], ['deals', 'autosub_at', 'INTEGER'], ['deals', 'pass_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['deals', 'passed_at', 'INTEGER'], ['deals', 'channel', "TEXT DEFAULT ''"], ['deals', 'exclusion_tag', "TEXT DEFAULT ''"],
    ['leads', 'batch', "TEXT DEFAULT ''"], ['users', 'permissions', 'TEXT'], ['users', 'manager_id', 'INTEGER'], ['users', 'team', "TEXT DEFAULT ''"],
    ['submissions', 'tags', "TEXT DEFAULT ''"], ['submissions', 'product', "TEXT DEFAULT ''"],
    ['lenders', 'paper_grade', "TEXT DEFAULT ''"], ['lenders', 'tags', "TEXT DEFAULT ''"], ['lenders', 'products', "TEXT DEFAULT ''"],
    ['lenders', 'restricted_legal', "TEXT DEFAULT ''"], ['lenders', 'preferred_industries', "TEXT DEFAULT ''"], ['lenders', 'default_ok', "TEXT DEFAULT ''"],
    ['lenders', 'min_positions', 'INTEGER'], ['lenders', 'stmt_rules', 'TEXT'], ['lenders', 'max_term_days', 'INTEGER'],
    ['lenders', 'max_commission_pct', 'REAL'], ['lenders', 'rank', 'INTEGER'], ['lenders', 'subject_prefix', "TEXT DEFAULT ''"],
    ['lenders', 'contract_email', "TEXT DEFAULT ''"], ['lenders', 'bump_email', "TEXT DEFAULT ''"], ['lenders', 'signed_up', 'INTEGER NOT NULL DEFAULT 1'],
    ['lead_sources', 'contact', "TEXT DEFAULT ''"], ['lead_sources', 'phone', "TEXT DEFAULT ''"], ['lead_sources', 'email', "TEXT DEFAULT ''"], ['lead_sources', 'website', "TEXT DEFAULT ''"],
  ]) ensureCol(t, c, ty);

  const getDeal = id => D().getDeal(id);
  const canDeal = (u, d) => !!d && (u.role === 'admin' || d.owner_id === u.id);
  function can(user, key) {
    if (!user) return false; if (user.role === 'admin') return true;
    const p = safeJSON(user.permissions || db.prepare('SELECT permissions FROM users WHERE id=?').get(user.id)?.permissions, {});
    return p[key] !== false;
  }
  const company = () => process.env.COMPANY_NAME || 'Brookestone Funding';
  const tpl = (s, v) => String(s || '').replace(/\{(\w+)\}/g, (m, k) => v[k] != null ? v[k] : m);

  // ---------------- statuses ----------------
  function defaultStatus(d) {
    switch (d.stage) {
      case 'interested': case 'app_sent': return 'New Application';
      case 'app_in': return 'Missing Documents';
      case 'docs_in': return 'Ready to Submit';
      case 'submitted': return 'Submitted';
      case 'offer': return d.offers_sent_at ? 'Offer Pitched' : 'Approved';
      case 'contract': return d.contract_signed_at ? 'Contracts Signed' : d.contract_sent_at ? 'Contracts Sent' : 'Offer Accepted';
      case 'funded': return d.pay_status === 'default' ? 'Funded - Defaulted' : d.pay_status === 'behind' ? 'Funded - Missed Payments' : d.renewal_queued_at ? 'Funded - Up for Renewal' : 'Funded';
      case 'lost': { const m = STATUSES.find(s => s[0] === d.lost_reason && s[2] === 'closed'); return m ? m[0] : 'Closed - Declined'; }
      default: return 'New Application';
    }
  }
  function statusOf(d) {
    const m = d.pilot_status && STATUS_MAP[d.pilot_status];
    return m && m.stage === d.stage ? d.pilot_status : defaultStatus(d);
  }
  function setStatus(d, status, userId, reason, auto) {
    const m = STATUS_MAP[status]; if (!m) throw new Error('Unknown status');
    const prev = statusOf(d);
    if (prev === status) return;
    if (m.stage !== d.stage) D().setStage(d, m.stage, userId, status + (reason ? ' — ' + reason : ''));
    else D().event(d.id, userId, 'status', `${prev} → ${status}${reason ? ' (' + reason + ')' : ''}`);
    const sets = ['pilot_status=?', 'updated_at=?'], args = [status, now()];
    if (m.stage === 'lost') { sets.push('lost_reason=?'); args.push(status); }
    db.prepare(`UPDATE deals SET ${sets.join(',')} WHERE id=?`).run(...args, d.id);
    db.prepare('INSERT INTO deal_status_log(deal_id,prev,next,reason,user_id,auto,at) VALUES(?,?,?,?,?,?,?)').run(d.id, prev, status, reason || '', userId, auto ? 1 : 0, now());
  }

  // ---------------- tasks ----------------
  function addTask(t) {
    const x = db.prepare('INSERT INTO tasks(deal_id,lender_id,submission_id,type,description,status,assigned_to,due_at,pinned,auto,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(t.deal_id || null, t.lender_id || null, t.submission_id || null, t.type || 'general', String(t.description || '').slice(0, 2000), 'open', t.assigned_to || null, t.due_at || null, t.pinned ? 1 : 0, t.auto ? 1 : 0, t.created_by || null, now());
    return Number(x.lastInsertRowid);
  }
  const TASK_SQL = `SELECT t.*, d.title deal_title, l.business, l.name lname, ln.name lender_name, u.name assigned_name, cu.name created_name
    FROM tasks t LEFT JOIN deals d ON d.id=t.deal_id LEFT JOIN leads l ON l.id=d.lead_id LEFT JOIN lenders ln ON ln.id=t.lender_id
    LEFT JOIN users u ON u.id=t.assigned_to LEFT JOIN users cu ON cu.id=t.created_by`;
  r.get('/api/tasks', (req, res) => {
    const q = req.query, w = [], a = [];
    const mine = req.user.role !== 'admin' && !can(req.user, 'see_tasks_all');
    if (mine) { w.push('(t.assigned_to=? OR d.owner_id=?)'); a.push(req.user.id, req.user.id); }
    if (q.status) { w.push('t.status=?'); a.push(q.status); }
    if (q.type) { w.push('t.type=?'); a.push(q.type); }
    if (q.assigned) { w.push(q.assigned === 'none' ? 't.assigned_to IS NULL' : 't.assigned_to=?'); if (q.assigned !== 'none') a.push(Number(q.assigned)); }
    if (q.deal) { w.push('t.deal_id=?'); a.push(Number(q.deal)); }
    if (q.lender) { w.push('t.lender_id=?'); a.push(Number(q.lender)); }
    if (q.pinned) w.push('t.pinned=1');
    if (q.due === 'overdue') { w.push("t.status='open' AND t.due_at<?"); a.push(now()); }
    if (q.due === 'today') { const e = new Date(); e.setHours(23, 59, 59, 999); w.push("t.status='open' AND t.due_at<=?"); a.push(e.getTime()); }
    if (q.q) { w.push('(t.description LIKE ? OR d.title LIKE ? OR l.business LIKE ?)'); const s = `%${String(q.q).replace(/[%_]/g, '')}%`; a.push(s, s, s); }
    const where = w.length ? ' WHERE ' + w.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) n FROM tasks t LEFT JOIN deals d ON d.id=t.deal_id LEFT JOIN leads l ON l.id=d.lead_id${where}`).get(...a).n;
    const lim = Math.min(Number(q.limit) || 100, 500), off = Math.max(Number(q.offset) || 0, 0);
    const rows = db.prepare(`${TASK_SQL}${where} ORDER BY t.pinned DESC, (t.status='open') DESC, COALESCE(t.due_at, 9e15), t.id DESC LIMIT ? OFFSET ?`).all(...a, lim, off);
    const types = db.prepare('SELECT DISTINCT type FROM tasks ORDER BY type').all().map(x => x.type);
    res.json({ rows, total, types, open: db.prepare("SELECT COUNT(*) n FROM tasks WHERE status='open'").get().n });
  });
  r.post('/api/tasks', (req, res) => {
    const b = req.body || {}; if (!String(b.description || '').trim()) return res.status(400).json({ error: 'Describe the task' });
    let d = null; if (b.deal_id) { d = getDeal(Number(b.deal_id)); if (!canDeal(req.user, d)) return res.status(404).json({ error: 'Deal not found' }); }
    const id = addTask({ deal_id: d && d.id, lender_id: b.lender_id, type: String(b.type || 'general').slice(0, 30), description: b.description, assigned_to: num(b.assigned_to) || (d && d.owner_id) || req.user.id, due_at: num(b.due_at), pinned: b.pinned, created_by: req.user.id });
    if (d) D().event(d.id, req.user.id, 'task', 'Task: ' + String(b.description).slice(0, 120));
    res.json({ id });
  });
  r.patch('/api/tasks/:id', (req, res) => {
    const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(Number(req.params.id)); if (!t) return res.status(404).json({ error: 'Task not found' });
    const d = t.deal_id ? getDeal(t.deal_id) : null;
    if (req.user.role !== 'admin' && t.assigned_to !== req.user.id && !(d && d.owner_id === req.user.id) && t.created_by !== req.user.id) return res.status(403).json({ error: 'Not your task' });
    const b = req.body || {}, f = {};
    if ('description' in b) f.description = String(b.description).slice(0, 2000);
    if ('type' in b) f.type = String(b.type).slice(0, 30);
    if ('assigned_to' in b) f.assigned_to = num(b.assigned_to);
    if ('due_at' in b) f.due_at = num(b.due_at);
    if ('pinned' in b) f.pinned = b.pinned ? 1 : 0;
    if ('status' in b && ['open', 'done'].includes(b.status)) { f.status = b.status; f.done_at = b.status === 'done' ? now() : null; }
    if (Object.keys(f).length) db.prepare(`UPDATE tasks SET ${Object.keys(f).map(k => k + '=?').join(',')} WHERE id=?`).run(...Object.values(f), t.id);
    res.json({ ok: true });
  });
  r.delete('/api/tasks/:id', (req, res) => {
    const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(Number(req.params.id)); if (!t) return res.json({ ok: true });
    if (req.user.role !== 'admin' && t.created_by !== req.user.id) return res.status(403).json({ error: 'Only the creator or an admin can delete a task' });
    db.prepare('DELETE FROM tasks WHERE id=?').run(t.id); res.json({ ok: true });
  });

  // ---------------- statements / positions / metrics ----------------
  const avg = a => { a = a.filter(x => x != null); return a.length ? round2(a.reduce((s, x) => s + x, 0) / a.length) : null; };
  const minOf = a => { a = a.filter(x => x != null); return a.length ? Math.min(...a) : null; };
  const maxOf = a => { a = a.filter(x => x != null); return a.length ? Math.max(...a) : null; };
  function metrics(dealId) {
    const st = db.prepare('SELECT * FROM deal_statements WHERE deal_id=? ORDER BY month').all(dealId);
    const pos = db.prepare('SELECT * FROM deal_positions WHERE deal_id=?').all(dealId);
    const col = k => st.map(x => x[k]);
    const a = { deposits: avg(col('deposits')), revenue: avg(col('revenue')), neg_days: avg(col('neg_days')), low_days: avg(col('low_days')), nsf: avg(col('nsf')), adb: avg(col('adb')), open_bal: avg(col('open_bal')), close_bal: avg(col('close_bal')) };
    a.adb_ratio = a.adb != null && a.deposits ? round2(a.adb / a.deposits * 100) : null;
    const ratios = st.map(x => x.adb != null && x.deposits ? x.adb / x.deposits * 100 : null);
    const w = { deposits: minOf(col('deposits')), revenue: minOf(col('revenue')), neg_days: maxOf(col('neg_days')), low_days: maxOf(col('low_days')), nsf: maxOf(col('nsf')), adb: minOf(col('adb')), open_bal: minOf(col('open_bal')), close_bal: minOf(col('close_bal')), adb_ratio: minOf(ratios) };
    const active = pos.filter(p => !/paid|closed|renewed/i.test(p.status || ''));
    const pulls = round2(active.reduce((s, p) => s + (p.payment || 0) * (PULLS[String(p.frequency || 'daily').toLowerCase()] || 21), 0));
    return { months: st.length, avg: a, worst: w, positions: active.length, total_pulls: pulls, holdback_pct: a.deposits ? round2(pulls / a.deposits * 100) : null };
  }

  // ---------------- funder matching ----------------
  const list = s => String(s || '').split(/[,;\n]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
  function dealFacts(d) {
    const f = { ...D().dealFacts(d) }; const m = metrics(d.id);
    f.stmts = m; f.legal = String(d.legal_structure || '').toLowerCase(); f.default_status = String(d.default_status || '');
    f.products = list(d.products);
    f.revenue_used = m.avg.revenue ?? m.avg.deposits ?? f.revenue;
    f.open_positions = m.positions || (db.prepare('SELECT COUNT(*) n FROM deal_positions WHERE deal_id=?').get(d.id).n ? m.positions : f.positions);
    return f;
  }
  const STMT_LABEL = { deposits: 'Deposits', revenue: 'Revenue', neg_days: 'Negative days', low_days: 'Low-balance days', nsf: 'NSFs', adb: 'Avg daily balance', open_bal: 'Opening balance', close_bal: 'Closing balance', adb_ratio: 'ADB / deposits %' };
  const MAXKEYS = new Set(['neg_days', 'low_days', 'nsf']);
  function matchFunder(L, f) {
    const base = D().matchLender(L, { revenue: f.revenue_used, tib: f.tib, fico: f.fico, positions: f.open_positions, amount: f.amount, state: f.state, industry: f.industry });
    const fail = [...base.fail], unknown = [...base.unknown];
    const $ = n => '$' + Math.round(n).toLocaleString('en-US');
    if (L.min_positions != null) { if (f.open_positions == null) unknown.push('Positions'); else if (f.open_positions < L.min_positions) fail.push(`Needs at least ${L.min_positions} open position${L.min_positions === 1 ? '' : 's'}`); }
    const rl = list(L.restricted_legal); if (rl.length && f.legal && rl.includes(f.legal)) fail.push(`Doesn't fund ${f.legal}`);
    const dok = list(L.default_ok); if (dok.length) { if (!f.default_status) unknown.push('Default status'); else if (!dok.includes(f.default_status.toLowerCase())) fail.push(`Doesn't accept: ${f.default_status}`); }
    const prod = list(L.products); if (prod.length && f.products.length && !f.products.some(p => prod.includes(p))) fail.push('Products: they offer ' + L.products);
    const rules = safeJSON(L.stmt_rules, {});
    for (const [mode, src] of [['avg', f.stmts.avg], ['worst', f.stmts.worst]]) {
      for (const [k, lim] of Object.entries(rules[mode] || {})) {
        if (lim == null || lim === '') continue; const have = src[k];
        const isMax = MAXKEYS.has(k), lbl = (mode === 'worst' ? 'Worst month ' : 'Avg ') + (STMT_LABEL[k] || k).toLowerCase();
        if (have == null) { unknown.push(lbl); continue; }
        if (isMax ? have > lim : have < lim) fail.push(`${lbl} ${k.includes('days') || k === 'nsf' ? have : k === 'adb_ratio' ? have + '%' : $(have)} ${isMax ? '>' : '<'} ${k.includes('days') || k === 'nsf' ? lim : k === 'adb_ratio' ? lim + '%' : $(lim)}`);
      }
    }
    return { ok: !fail.length, fail, unknown };
  }
  function matchAll(d) {
    const f = dealFacts(d), subs = Object.fromEntries(db.prepare('SELECT lender_id, status FROM submissions WHERE deal_id=? ORDER BY id').all(d.id).map(s => [s.lender_id, s.status]));
    const ind = f.industry || '';
    const rows = db.prepare('SELECT * FROM lenders WHERE active=1 ORDER BY COALESCE(rank, 9999), name').all().map(L => {
      const m = matchFunder(L, f);
      return { id: L.id, name: L.name, in_house: !!L.in_house, email: !!L.email, rank: L.rank, grade: L.paper_grade, tags: L.tags, products: L.products, notes: L.notes,
        preferred: !!(ind && list(L.preferred_industries).some(x => ind.includes(x))), max_amount: L.max_amount, max_term_days: L.max_term_days, max_commission_pct: L.max_commission_pct,
        ...m, submitted: subs[L.id] || null };
    });
    return { facts: { revenue: f.revenue_used, tib: f.tib, fico: f.fico, positions: f.open_positions, amount: f.amount, state: f.state, industry: f.industry }, qualified: rows.filter(x => x.ok), unqualified: rows.filter(x => !x.ok) };
  }

  // ---------------- needs action ----------------
  const ACTION_TYPES = ['Chase signature', 'Chase funder for contracts', 'Finalize funding', 'Request contracts', 'Complete portal submission', 'Fix failed submission', 'Fulfill stip request', 'Collect DL/VC',
    'Follow up merchant on offer', 'Pitch offer', 'Follow up repricing', 'Resubmit or close out', 'Nudge ignored funders', 'Submit to new funders', 'Submit to funders', 'Chase missing docs', 'Prepare & submit',
    'Renewal follow-up', 'Close out or revive'];
  function needsAction(user) {
    const t = now(), need = Number(getSetting('statements_required', 3)), reqd = getSetting('required_docs', {}) || {};
    const own = user.role === 'admin' ? '' : ' AND d.owner_id=' + Number(user.id);
    const deals = db.prepare(`SELECT d.*, l.business, l.name lname, l.phone, l.email lemail, u.name owner_name FROM deals d JOIN leads l ON l.id=d.lead_id LEFT JOIN users u ON u.id=d.owner_id WHERE d.stage!='lost'${own}`).all();
    const sub = Object.fromEntries(db.prepare(`SELECT deal_id, COUNT(*) n, SUM(status='submitted') pending, SUM(status='info_needed') info, SUM(status='approved') approved, SUM(status='declined') declined,
      SUM(status='withdrawn' AND error!='') errs, MAX(sent_at) last_sent, MAX(CASE WHEN status='info_needed' THEN updated_at END) info_at, MAX(CASE WHEN status='approved' THEN updated_at END) appr_at,
      MAX(CASE WHEN status='withdrawn' AND error!='' THEN updated_at END) err_at, MAX(updated_at) last_upd FROM submissions GROUP BY deal_id`).all().map(x => [x.deal_id, x]));
    const files = {}; for (const x of db.prepare('SELECT deal_id, kind, COUNT(*) n FROM deal_files GROUP BY deal_id, kind').all()) (files[x.deal_id] = files[x.deal_id] || {})[x.kind] = x.n;
    const out = [];
    for (const d of deals) {
      const s = sub[d.id] || { n: 0 }, fl = files[d.id] || {}, status = statusOf(d); let act = null, since = d.updated_at;
      const set = (a, at) => { act = a; since = at || d.updated_at; };
      if (d.stage === 'funded') { if (d.renewal_queued_at && status !== 'Funded - Renewed') set('Renewal follow-up', d.renewal_queued_at); }
      else if (d.stage === 'interested') { /* dialer's job */ }
      else if (d.stage === 'app_sent') { if (t - d.updated_at > DAY) set('Complete portal submission'); }
      else if (d.stage === 'app_in') { if ((fl.statement || 0) < need) set('Chase missing docs'); else set('Prepare & submit'); }
      else if (d.stage === 'docs_in') { if (!s.n) set('Submit to funders'); else if (status === 'Resubmitting') set('Submit to new funders'); }
      else if (d.stage === 'submitted') {
        if (s.info) set('Fulfill stip request', s.info_at);
        else if (s.errs) set('Fix failed submission', s.err_at);
        else if (s.approved && !d.offers_sent_at) set('Pitch offer', s.appr_at);
        else if (status === 'Resubmitting') set('Submit to new funders');
        else if (s.n && !s.pending && s.declined === s.n) set('Resubmit or close out', s.last_upd);
        else if (s.pending && t - s.last_sent > 3 * DAY) set('Nudge ignored funders', s.last_sent);
      } else if (d.stage === 'offer') {
        if (status === 'Repricing') set('Follow up repricing');
        else if (!d.offers_sent_at) set('Pitch offer', s.appr_at);
        else if (!d.offer_chosen && t - d.offers_sent_at > 2 * DAY) set('Follow up merchant on offer', d.offers_sent_at);
        else if (d.offer_chosen) set('Request contracts', d.offer_chosen_at);
      } else if (d.stage === 'contract') {
        if (d.contract_signed_at) set('Finalize funding', d.contract_signed_at);
        else if (d.contract_sent_at) set('Chase signature', d.contract_sent_at);
        else if (status === 'Contracts Requested') { if (t - d.updated_at > 2 * DAY) set('Chase funder for contracts'); }
        else if (reqd.id && !(fl.id > 0)) set('Collect DL/VC');
        else set('Request contracts', d.updated_at);
      }
      if (!act && d.stage !== 'funded' && d.stage !== 'interested' && t - d.updated_at > 14 * DAY) set('Close out or revive');
      if (act) out.push({ deal_id: d.id, company: d.title || d.business || d.lname || d.phone, action: act, since, status, phone: d.phone, email: d.lemail, owner_id: d.owner_id, originator: d.owner_name || '', _d: d });
    }
    return out;
  }
  r.get('/api/needs-action', (req, res) => {
    let rows = needsAction(req.user); const counts = {}; for (const x of rows) counts[x.action] = (counts[x.action] || 0) + 1;
    const q = req.query;
    if (q.action) rows = rows.filter(x => x.action === q.action);
    if (q.owner) rows = rows.filter(x => String(x.owner_id || 'none') === q.owner);
    if (q.q) { const s = String(q.q).toLowerCase(); rows = rows.filter(x => String(x.company).toLowerCase().includes(s)); }
    rows.sort((a, b) => a.since - b.since);
    const total = rows.length, lim = Math.min(Number(q.limit) || 100, 1000), off = Math.max(Number(q.offset) || 0, 0);
    const page = rows.slice(off, off + lim).map(x => { let rev = null; try { rev = metrics(x.deal_id).avg.revenue ?? D().dealFacts(x._d).revenue; } catch { } const { _d, ...o } = x; return { ...o, revenue: rev }; });
    res.json({ rows: page, total, counts, actions: ACTION_TYPES, owners: db.prepare("SELECT id, name FROM users WHERE role IN ('admin','rep') ORDER BY name").all() });
  });
  r.get('/api/needs-action/count', (req, res) => res.json({ n: needsAction(req.user).length }));

  // ---------------- per-deal bundle ----------------
  const OWNER_FIELDS = ['legal_structure', 'default_status', 'products', 'channel', 'exclusion_tag'];
  function dealBundle(d, user) {
    const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(d.lead_id) || {};
    const funders = matchAll(d);
    return {
      id: d.id, status: statusOf(d), statuses: STATUSES.map(([s, st, g]) => ({ status: s, stage: st, group: g })),
      details: { legal_structure: d.legal_structure || '', default_status: d.default_status || '', products: d.products || '', unsubscribe: !!d.unsubscribe, skip_autosub: !!d.skip_autosub,
        owners: safeJSON(d.owners, []), source: lead.source || '', batch: lead.batch || '', channel: d.channel || '', exclusion_tag: d.exclusion_tag || '', closer_id: d.closer_id || null, pass_count: d.pass_count || 0 },
      statements: db.prepare('SELECT * FROM deal_statements WHERE deal_id=? ORDER BY month').all(d.id),
      positions: db.prepare('SELECT * FROM deal_positions WHERE deal_id=? ORDER BY id').all(d.id),
      metrics: metrics(d.id), facts: funders.facts, qualified: funders.qualified, unqualified: funders.unqualified,
      tasks: db.prepare(`${TASK_SQL} WHERE t.deal_id=? ORDER BY (t.status='open') DESC, COALESCE(t.due_at,9e15), t.id DESC`).all(d.id),
      history: [
        ...db.prepare('SELECT l.*, u.name user_name FROM deal_status_log l LEFT JOIN users u ON u.id=l.user_id WHERE l.deal_id=?').all(d.id).map(x => ({ at: x.at, type: 'status', prev: x.prev, next: x.next, reason: x.reason, by: x.user_name || (x.auto ? 'Workflow' : 'System') })),
        ...db.prepare("SELECT e.*, u.name user_name FROM deal_events e LEFT JOIN users u ON u.id=e.user_id WHERE e.deal_id=? AND e.kind='stage'").all(d.id).map(x => ({ at: x.created_at, type: 'stage', text: x.body, by: x.user_name || 'System' })),
      ].sort((a, b) => b.at - a.at),
      requests: { email: mail.enabled(), can_submit: can(user, 'submit_deals'), can_request: can(user, 'request_funders') },
    };
  }
  const dealOr404 = (req, res) => { const d = getDeal(Number(req.params.id)); if (!canDeal(req.user, d)) { res.status(404).json({ error: 'Deal not found' }); return null; } return d; };
  r.get('/api/pilot/deals/:id', (req, res) => { const d = dealOr404(req, res); if (d) res.json(dealBundle(d, req.user)); });
  r.post('/api/pilot/deals/:id/status', (req, res) => {
    const d = dealOr404(req, res); if (!d) return;
    if (!can(req.user, 'change_status')) return res.status(403).json({ error: "You don't have permission to change status" });
    try { setStatus(d, String(req.body.status || ''), req.user.id, String(req.body.reason || '').slice(0, 300)); } catch (e) { return res.status(400).json({ error: e.message }); }
    res.json({ ok: true, status: statusOf(getDeal(d.id)) });
  });
  r.patch('/api/pilot/deals/:id/details', (req, res) => {
    const d = dealOr404(req, res); if (!d) return; const b = req.body || {}, f = {};
    for (const k of OWNER_FIELDS) if (k in b) f[k] = String(b[k] || '').slice(0, 300);
    if ('unsubscribe' in b) { f.unsubscribe = b.unsubscribe ? 1 : 0; if (b.unsubscribe) f.chase_off = 1; }
    if ('skip_autosub' in b) f.skip_autosub = b.skip_autosub ? 1 : 0;
    if ('owners' in b) f.owners = JSON.stringify((Array.isArray(b.owners) ? b.owners : []).slice(0, 10).map(o => ({ name: String(o.name || '').slice(0, 100), pct: num(o.pct), email: String(o.email || '').slice(0, 120), phone: String(o.phone || '').slice(0, 30) })));
    if (Object.keys(f).length) { f.updated_at = now(); db.prepare(`UPDATE deals SET ${Object.keys(f).map(k => k + '=?').join(',')} WHERE id=?`).run(...Object.values(f), d.id); }
    if ('batch' in b) db.prepare('UPDATE leads SET batch=? WHERE id=?').run(String(b.batch || '').slice(0, 200), d.lead_id);
    if (f.closer_id !== undefined) { /* handled by deals PATCH */ }
    res.json({ ok: true });
  });
  // statements
  const STM = ['month', 'account', 'revenue', 'deposits', 'neg_days', 'low_days', 'adb', 'open_bal', 'close_bal', 'nsf'];
  r.post('/api/pilot/deals/:id/statements', (req, res) => {
    const d = dealOr404(req, res); if (!d) return; const b = req.body || {};
    if (!/^\d{4}-\d{2}$/.test(String(b.month || ''))) return res.status(400).json({ error: 'Month must look like 2026-03' });
    const v = STM.map(k => k === 'month' || k === 'account' ? String(b[k] || '').slice(0, 40) : num(b[k]));
    const ex = db.prepare('SELECT id FROM deal_statements WHERE deal_id=? AND month=? AND account=?').get(d.id, v[0], v[1]);
    if (ex) db.prepare(`UPDATE deal_statements SET ${STM.map(k => k + '=?').join(',')} WHERE id=?`).run(...v, ex.id);
    else db.prepare(`INSERT INTO deal_statements(deal_id,${STM.join(',')}) VALUES(?,${STM.map(() => '?').join(',')})`).run(d.id, ...v);
    res.json({ ok: true, metrics: metrics(d.id) });
  });
  r.delete('/api/pilot/deals/:id/statements/:sid', (req, res) => { const d = dealOr404(req, res); if (!d) return; db.prepare('DELETE FROM deal_statements WHERE id=? AND deal_id=?').run(Number(req.params.sid), d.id); res.json({ ok: true, metrics: metrics(d.id) }); });
  r.post('/api/pilot/deals/:id/statements/import-ai', (req, res) => {
    const d = dealOr404(req, res); if (!d) return; const x = safeJSON(d.stmt_analysis, null);
    if (!x || !(x.statements || []).length) return res.status(400).json({ error: 'Run "Read statements" on the deal first — nothing to import yet' });
    let n = 0, p = 0;
    db.transaction(() => {
      for (const s of x.statements) {
        if (!/^\d{4}-\d{2}$/.test(String(s.month || ''))) continue;
        const acct = x.account_last4 ? '…' + x.account_last4 : '';
        if (db.prepare('SELECT 1 FROM deal_statements WHERE deal_id=? AND month=? AND account=?').get(d.id, s.month, acct)) continue;
        db.prepare('INSERT INTO deal_statements(deal_id,month,account,revenue,deposits,neg_days,low_days,adb,open_bal,close_bal,nsf) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(d.id, s.month, acct, num(s.true_revenue), num(s.total_deposits), num(s.negative_days), null, num(s.avg_daily_balance), null, num(s.ending_balance), num(s.nsf_count)); n++;
      }
      for (const f of x.existing_funders || []) {
        if (!f.name || db.prepare('SELECT 1 FROM deal_positions WHERE deal_id=? AND lower(funder)=lower(?)').get(d.id, f.name)) continue;
        db.prepare('INSERT INTO deal_positions(deal_id,funder,payment,frequency,status) VALUES(?,?,?,?,?)').run(d.id, String(f.name).slice(0, 100), num(f.amount), ['daily', 'weekly', 'monthly'].includes(f.frequency) ? f.frequency : 'daily', 'Active'); p++;
      }
    })();
    res.json({ ok: true, statements: n, positions: p, metrics: metrics(d.id) });
  });
  r.post('/api/pilot/deals/:id/positions', (req, res) => {
    const d = dealOr404(req, res); if (!d) return; const b = req.body || {};
    if (!String(b.funder || '').trim()) return res.status(400).json({ error: 'Funder name is required' });
    const v = [String(b.funder).slice(0, 100), num(b.payment), ['daily', 'weekly', 'biweekly', 'monthly'].includes(b.frequency) ? b.frequency : 'daily', String(b.status || 'Active').slice(0, 30), num(b.funded_amount), num(b.funded_date)];
    if (b.id) db.prepare('UPDATE deal_positions SET funder=?,payment=?,frequency=?,status=?,funded_amount=?,funded_date=? WHERE id=? AND deal_id=?').run(...v, Number(b.id), d.id);
    else db.prepare('INSERT INTO deal_positions(funder,payment,frequency,status,funded_amount,funded_date,deal_id) VALUES(?,?,?,?,?,?,?)').run(...v, d.id);
    res.json({ ok: true, metrics: metrics(d.id) });
  });
  r.delete('/api/pilot/deals/:id/positions/:pid', (req, res) => { const d = dealOr404(req, res); if (!d) return; db.prepare('DELETE FROM deal_positions WHERE id=? AND deal_id=?').run(Number(req.params.pid), d.id); res.json({ ok: true, metrics: metrics(d.id) }); });

  // ---------------- submit helpers: auto-submit, funder requests ----------------
  function docsReady(d) {
    const need = Number(getSetting('statements_required', 3)), n = db.prepare("SELECT COUNT(*) n FROM deal_files WHERE deal_id=? AND kind='statement'").get(d.id).n;
    return !!d.app_signed_at && n >= need;
  }
  async function autoSubmit(d, user, dry) {
    if (!docsReady(d)) throw new Error('Docs aren\'t complete yet (signed application + required statements)');
    if (d.skip_autosub) throw new Error('Auto-submit is switched off for this deal');
    if (db.prepare('SELECT 1 FROM submissions WHERE deal_id=?').get(d.id)) throw new Error('This deal has already been submitted');
    const cfg = cfgGet().autosub, m = matchAll(d);
    const picks = m.qualified.filter(x => !x.in_house && x.email && !x.submitted).slice(0, Math.max(1, Math.min(Number(cfg.max) || 8, 30)));
    if (!picks.length) throw new Error('No funders qualify for this deal');
    if (dry) return { dry: true, funders: picks.map(x => x.name) };
    if (!mail.enabled()) throw new Error('Email is not set up yet (SMTP settings in .env)');
    db.prepare('UPDATE deals SET autosub_at=? WHERE id=?').run(now(), d.id);
    const owner = d.owner_id ? db.prepare('SELECT id, name FROM users WHERE id=?').get(d.owner_id) : null;
    const results = await D().doSubmit(d, picks.map(x => x.id), 'Auto-submitted', user || owner || { id: null, name: company() });
    return { results };
  }
  r.post('/api/pilot/deals/:id/autosub', async (req, res) => {
    const d = dealOr404(req, res); if (!d) return;
    if (!can(req.user, 'submit_deals')) return res.status(403).json({ error: "You don't have permission to submit deals" });
    try { res.json(await autoSubmit(d, req.user, !!req.body.dry)); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  r.post('/api/pilot/deals/:id/request', async (req, res) => {
    const d = dealOr404(req, res); if (!d) return; const b = req.body || {};
    if (!can(req.user, 'request_funders')) return res.status(403).json({ error: "You don't have permission to send funder requests" });
    if (!['contracts', 'bump', 'info'].includes(b.kind)) return res.status(400).json({ error: 'Unknown request type' });
    if (!mail.enabled()) return res.status(400).json({ error: 'Email is not set up yet (SMTP settings in .env)' });
    const L = db.prepare('SELECT * FROM lenders WHERE id=?').get(Number(b.lender_id)); if (!L) return res.status(404).json({ error: 'Funder not found' });
    const to = (b.kind === 'contracts' && L.contract_email) || (b.kind === 'bump' && L.bump_email) || L.email;
    if (!to) return res.status(400).json({ error: `${L.name} has no email on file` });
    const sub = db.prepare('SELECT id FROM submissions WHERE deal_id=? AND lender_id=? ORDER BY id DESC LIMIT 1').get(d.id, L.id);
    const T = cfgGet().templates[b.kind], title = d.title || 'merchant';
    const vars = { company_name: title, funder: L.contact_name || L.name, user_name: req.user.name, company: company(), note: String(b.note || '') };
    const subject = tpl(b.subject || T.subject, vars) + (sub ? ` [PD-${d.id}-${sub.id}]` : ''), text = tpl(b.body || T.body, vars);
    try {
      const sent = await mail.send({ to, cc: L.cc || undefined, subject, text, fromName: `${req.user.name} | ${company()}` });
      db.prepare("INSERT INTO emails(deal_id,submission_id,lender_id,user_id,direction,subject,body,from_addr,to_addr,message_id,status,created_at) VALUES(?,?,?,?,'out',?,?,?,?,?,?,?)")
        .run(d.id, sub ? sub.id : null, L.id, req.user.id, subject, text, mail.fromAddr(), to, sent.messageId, 'sent', now());
      D().event(d.id, req.user.id, 'request', `${b.kind === 'contracts' ? 'Requested contracts from' : b.kind === 'bump' ? 'Asked for a bump from' : 'Sent info to'} ${L.name}`);
      if (b.kind === 'contracts') { try { setStatus(getDeal(d.id), 'Contracts Requested', req.user.id); } catch { } }
      res.json({ ok: true, to });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------------- funders: criteria, metrics ----------------
  const L_TEXT = ['paper_grade', 'tags', 'products', 'restricted_legal', 'preferred_industries', 'default_ok', 'subject_prefix', 'contract_email', 'bump_email'];
  const L_NUM = ['min_positions', 'max_term_days', 'max_commission_pct', 'rank'];
  r.patch('/api/pilot/lenders/:id', adminOnly, (req, res) => {
    const id = Number(req.params.id), b = req.body || {}, f = {};
    if (!db.prepare('SELECT 1 FROM lenders WHERE id=?').get(id)) return res.status(404).json({ error: 'Funder not found' });
    for (const k of L_TEXT) if (k in b) f[k] = String(b[k] || '').trim().slice(0, 500);
    for (const k of L_NUM) if (k in b) f[k] = num(b[k]);
    if ('signed_up' in b) f.signed_up = b.signed_up ? 1 : 0;
    if ('stmt_rules' in b) {
      const clean = {}; for (const mode of ['avg', 'worst']) { clean[mode] = {}; for (const k of Object.keys(STMT_LABEL)) { const v = num((b.stmt_rules[mode] || {})[k]); if (v != null) clean[mode][k] = v; } }
      f.stmt_rules = JSON.stringify(clean);
    }
    if (Object.keys(f).length) db.prepare(`UPDATE lenders SET ${Object.keys(f).map(k => k + '=?').join(',')} WHERE id=?`).run(...Object.values(f), id);
    res.json({ ok: true });
  });
  r.get('/api/pilot/lenders/:id', (req, res) => {
    const id = Number(req.params.id), L = db.prepare('SELECT * FROM lenders WHERE id=?').get(id); if (!L) return res.status(404).json({ error: 'Funder not found' });
    const subs = db.prepare(`SELECT s.id, s.status, s.offer_amount, s.offer_factor, s.offer_term_days, s.decline_reason, s.ai_note, s.sent_at, s.updated_at, d.id deal_id, d.title FROM submissions s JOIN deals d ON d.id=s.deal_id WHERE s.lender_id=? ORDER BY s.id DESC LIMIT 100`).all(id);
    const agg = db.prepare(`SELECT COUNT(*) subs, SUM(status IN ('approved','funded')) approved, SUM(status='declined') declined, SUM(status='funded') funded,
      COALESCE(SUM(CASE WHEN status IN ('approved','funded') THEN offer_amount END),0) approved_amt FROM submissions WHERE lender_id=?`).get(id);
    const funded = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(funded_amount),0) amt FROM deals WHERE lender_id=? AND stage='funded'`).get(id);
    let earned = 0, owed = 0;
    try { earned = db.prepare(`SELECT COALESCE(SUM(p.amount),0) x FROM funder_payments p JOIN deals d ON d.id=p.deal_id WHERE d.lender_id=? AND p.status='received'`).get(id).x;
      owed = db.prepare(`SELECT COALESCE(SUM(p.amount),0) x FROM funder_payments p JOIN deals d ON d.id=p.deal_id WHERE d.lender_id=? AND p.status='outstanding'`).get(id).x; } catch { }
    res.json({ lender: { ...L, stmt_rules: safeJSON(L.stmt_rules, {}) }, metrics: { submissions: agg.subs, approved: agg.approved || 0, declined: agg.declined || 0, approval_rate: agg.subs ? Math.round((agg.approved || 0) / agg.subs * 100) : null,
      total_approved: agg.approved_amt, advances: funded.n, total_funded: funded.amt, total_earned: earned, outstanding: owed }, submissions: subs,
      tasks: db.prepare(`${TASK_SQL} WHERE t.lender_id=? ORDER BY t.id DESC LIMIT 50`).all(id) });
  });

  // ---------------- global submissions + offers ----------------
  r.get('/api/pilot/submissions', (req, res) => {
    if (!can(req.user, 'see_submissions')) return res.status(403).json({ error: 'Not allowed' });
    const q = req.query, w = [], a = [];
    if (req.user.role !== 'admin') { w.push('d.owner_id=?'); a.push(req.user.id); }
    if (q.status) { w.push('s.status=?'); a.push(q.status); }
    if (q.lender) { w.push('s.lender_id=?'); a.push(Number(q.lender)); }
    if (q.errors) w.push("s.error!=''");
    if (q.q) { w.push('(d.title LIKE ? OR l.business LIKE ?)'); const s = `%${String(q.q).replace(/[%_]/g, '')}%`; a.push(s, s); }
    const where = w.length ? ' WHERE ' + w.join(' AND ') : '', from = 'FROM submissions s JOIN deals d ON d.id=s.deal_id JOIN leads l ON l.id=d.lead_id JOIN lenders ln ON ln.id=s.lender_id LEFT JOIN users u ON u.id=s.user_id LEFT JOIN users o ON o.id=d.owner_id';
    const total = db.prepare(`SELECT COUNT(*) n ${from}${where}`).get(...a).n;
    const lim = Math.min(Number(q.limit) || 50, 500), off = Math.max(Number(q.offset) || 0, 0);
    const rows = db.prepare(`SELECT s.id, s.deal_id, COALESCE(NULLIF(d.title,''), l.business, l.name) deal, ln.name lender, s.lender_id, s.status, s.error, s.sent_at, s.updated_at, s.offer_amount,
      COALESCE(NULLIF(s.decline_reason,''), NULLIF(s.ai_note,''), s.notes) response, u.name submitted_by, o.name originator ${from}${where} ORDER BY s.id DESC LIMIT ? OFFSET ?`).all(...a, lim, off);
    const tally = db.prepare(`SELECT s.status, COUNT(*) n ${from}${where} GROUP BY s.status`).all(...a);
    res.json({ rows, total, tally, lenders: db.prepare('SELECT id, name FROM lenders ORDER BY name').all() });
  });
  r.get('/api/pilot/offers', (req, res) => {
    if (!can(req.user, 'see_offers')) return res.status(403).json({ error: 'Not allowed' });
    const q = req.query, w = ['s.offer_amount IS NOT NULL'], a = [];
    if (req.user.role !== 'admin') { w.push('d.owner_id=?'); a.push(req.user.id); }
    if (q.status) { w.push('s.status=?'); a.push(q.status); }
    if (q.lender) { w.push('s.lender_id=?'); a.push(Number(q.lender)); }
    if (q.tag) { w.push('s.tags LIKE ?'); a.push('%' + String(q.tag).replace(/[%_]/g, '') + '%'); }
    if (q.q) { w.push('(d.title LIKE ? OR l.business LIKE ?)'); const s = `%${String(q.q).replace(/[%_]/g, '')}%`; a.push(s, s); }
    const where = ' WHERE ' + w.join(' AND ');
    const rows = db.prepare(`SELECT s.id, s.deal_id, COALESCE(NULLIF(d.title,''), l.business, l.name) deal, ln.name lender, ln.broker_pct, s.status, s.offer_amount amount, s.offer_factor factor, s.offer_term_days term, s.offer_payment payment,
      s.offer_freq freq, s.tags, s.product, s.updated_at, o.name originator FROM submissions s JOIN deals d ON d.id=s.deal_id JOIN leads l ON l.id=d.lead_id JOIN lenders ln ON ln.id=s.lender_id LEFT JOIN users o ON o.id=d.owner_id${where} ORDER BY s.updated_at DESC LIMIT 500`).all(...a)
      .map(x => ({ ...x, payback: x.amount && x.factor ? round2(x.amount * x.factor) : null, commission: x.amount && x.broker_pct ? round2(x.amount * x.broker_pct / 100) : null, points: x.broker_pct || null }));
    res.json({ rows, lenders: db.prepare('SELECT id, name FROM lenders ORDER BY name').all() });
  });
  r.patch('/api/pilot/offers/:id', (req, res) => {
    const s = db.prepare('SELECT s.*, d.owner_id FROM submissions s JOIN deals d ON d.id=s.deal_id WHERE s.id=?').get(Number(req.params.id)); if (!s) return res.status(404).json({ error: 'Offer not found' });
    if (req.user.role !== 'admin' && s.owner_id !== req.user.id) return res.status(403).json({ error: 'Not your deal' });
    const f = {}; if ('tags' in req.body) f.tags = String(req.body.tags || '').slice(0, 200); if ('product' in req.body) f.product = String(req.body.product || '').slice(0, 60);
    if (Object.keys(f).length) db.prepare(`UPDATE submissions SET ${Object.keys(f).map(k => k + '=?').join(',')} WHERE id=?`).run(...Object.values(f), s.id);
    res.json({ ok: true });
  });

  // ---------------- batches + sources ----------------
  function batchRows() {
    const leads = Object.fromEntries(db.prepare("SELECT batch, COUNT(*) n, SUM(attempts>0) worked FROM leads WHERE batch!='' GROUP BY batch").all().map(x => [x.batch, x]));
    const deals = db.prepare("SELECT l.batch, d.* FROM deals d JOIN leads l ON l.id=d.lead_id WHERE l.batch!=''").all();
    const by = {}; for (const d of deals) { const o = by[d.batch] = by[d.batch] || { deals: 0, submitted: 0, funded: 0, funded_amt: 0, revenue: 0 }; o.deals++; if (!['interested', 'app_sent', 'app_in', 'docs_in'].includes(d.stage) && d.stage !== 'lost') o.submitted++; if (d.stage === 'funded') { o.funded++; o.funded_amt += d.funded_amount || 0; o.revenue += D().revenue(d) || 0; } }
    return db.prepare('SELECT * FROM batches ORDER BY created_at DESC, id DESC').all().map(b => {
      const L = leads[b.name] || { n: 0, worked: 0 }, x = by[b.name] || { deals: 0, submitted: 0, funded: 0, funded_amt: 0, revenue: 0 }, cnt = b.count || L.n || 0;
      return { ...b, leads: L.n, worked: L.worked || 0, deals: x.deals, submitted: x.submitted, funded: x.funded, funded_amt: round2(x.funded_amt), revenue: round2(x.revenue), per_lead: b.price && cnt ? round2(b.price / cnt) : null, profit: b.price != null ? round2(x.revenue - b.price) : null, roi: b.price ? Math.round((x.revenue - b.price) / b.price * 100) : null };
    });
  }
  r.get('/api/pilot/batches', adminOnly, (req, res) => res.json({ rows: batchRows(), sources: db.prepare('SELECT name FROM lead_sources UNION SELECT DISTINCT source FROM leads WHERE source!=\'\' ORDER BY 1').all().map(x => x.name) }));
  r.post('/api/pilot/batches', adminOnly, (req, res) => {
    const b = req.body || {}, name = String(b.name || '').trim().slice(0, 200); if (!name) return res.status(400).json({ error: 'Give the batch a name' });
    try { const x = db.prepare('INSERT INTO batches(name,source,vendor,price,count,ext_id,created_at) VALUES(?,?,?,?,?,?,?)').run(name, String(b.source || '').slice(0, 120), String(b.vendor || '').slice(0, 120), num(b.price), num(b.count), String(b.ext_id || '').slice(0, 60), now()); res.json({ id: Number(x.lastInsertRowid) }); }
    catch (e) { res.status(400).json({ error: /UNIQUE/.test(e.message) ? 'A batch with that name already exists' : e.message }); }
  });
  r.patch('/api/pilot/batches/:id', adminOnly, (req, res) => {
    const b = req.body || {}, f = {}; for (const k of ['source', 'vendor', 'ext_id']) if (k in b) f[k] = String(b[k] || '').slice(0, 120); for (const k of ['price', 'count']) if (k in b) f[k] = num(b[k]);
    if (Object.keys(f).length) db.prepare(`UPDATE batches SET ${Object.keys(f).map(k => k + '=?').join(',')} WHERE id=?`).run(...Object.values(f), Number(req.params.id));
    res.json({ ok: true });
  });
  r.delete('/api/pilot/batches/:id', adminOnly, (req, res) => { db.prepare('DELETE FROM batches WHERE id=?').run(Number(req.params.id)); res.json({ ok: true }); });
  r.patch('/api/pilot/sources', adminOnly, (req, res) => {
    const b = req.body || {}, name = String(b.name || '').trim(); if (!name) return res.status(400).json({ error: 'Source name needed' });
    db.prepare('INSERT OR IGNORE INTO lead_sources(name,created_at) VALUES(?,?)').run(name, now());
    const f = {}; for (const k of ['vendor', 'contact', 'phone', 'email', 'website', 'notes']) if (k in b) f[k] = String(b[k] || '').slice(0, 200);
    if ('total_cost' in b) f.total_cost = num(b.total_cost);
    if (Object.keys(f).length) db.prepare(`UPDATE lead_sources SET ${Object.keys(f).map(k => k + '=?').join(',')} WHERE name=?`).run(...Object.values(f), name);
    res.json({ ok: true });
  });
  r.get('/api/pilot/sources', adminOnly, (req, res) => {
    const meta = Object.fromEntries(db.prepare('SELECT * FROM lead_sources').all().map(x => [x.name, x]));
    const rows = db.prepare("SELECT source name, COUNT(*) leads, MAX(created_at) last_at FROM leads WHERE source!='' GROUP BY source").all();
    const names = new Set(rows.map(x => x.name)); for (const n of Object.keys(meta)) if (!names.has(n)) rows.push({ name: n, leads: 0, last_at: meta[n].created_at });
    res.json({ rows: rows.map(x => ({ ...x, ...(meta[x.name] || {}), name: x.name })).sort((a, b) => (b.last_at || 0) - (a.last_at || 0)) });
  });

  // ---------------- workflows ----------------
  r.get('/api/pilot/workflows', adminOnly, (req, res) => res.json({ rows: db.prepare('SELECT * FROM workflows ORDER BY id').all().map(w => ({ ...w, cond: safeJSON(w.cond, {}), params: safeJSON(w.params, {}) })), triggers: TRIGGERS, actions: ACTIONS, statuses: STATUSES.map(s => s[0]), users: db.prepare("SELECT id, name FROM users WHERE role IN ('admin','rep') ORDER BY name").all() }));
  const wfFields = b => {
    const trigger = TRIGGERS.some(t => t[0] === b.trigger) ? b.trigger : null, action = ACTIONS.some(t => t[0] === b.action) ? b.action : null;
    const p = b.params || {}, params = {};
    if (action === 'create_task') Object.assign(params, { description: String(p.description || '').slice(0, 500), type: String(p.type || 'workflow').slice(0, 30), assign: String(p.assign || 'owner'), due_days: num(p.due_days) ?? 1 });
    if (action === 'set_status') params.status = STATUS_MAP[p.status] ? p.status : null;
    if (action === 'add_note' || action === 'notify') params.text = String(p.text || '').slice(0, 500);
    return { name: String(b.name || '').trim().slice(0, 120), trigger, action, cond: JSON.stringify({ status: STATUS_MAP[(b.cond || {}).status] ? b.cond.status : undefined }), params: JSON.stringify(params), ok: !!(trigger && action && (action !== 'set_status' || params.status) && (action !== 'create_task' || params.description) && (!['add_note', 'notify'].includes(action) || params.text)) };
  };
  r.post('/api/pilot/workflows', adminOnly, (req, res) => {
    const w = wfFields(req.body || {}); if (!w.name) return res.status(400).json({ error: 'Give the workflow a name' }); if (!w.ok) return res.status(400).json({ error: 'Pick a trigger and an action, and fill in what it should do' });
    const x = db.prepare('INSERT INTO workflows(name,trigger,cond,action,params,active,created_at) VALUES(?,?,?,?,?,1,?)').run(w.name, w.trigger, w.cond, w.action, w.params, now()); res.json({ id: Number(x.lastInsertRowid) });
  });
  r.patch('/api/pilot/workflows/:id', adminOnly, (req, res) => {
    const id = Number(req.params.id);
    if ('active' in req.body && Object.keys(req.body).length === 1) { db.prepare('UPDATE workflows SET active=? WHERE id=?').run(req.body.active ? 1 : 0, id); return res.json({ ok: true }); }
    const w = wfFields(req.body || {}); if (!w.name || !w.ok) return res.status(400).json({ error: 'Name, trigger and action details are required' });
    db.prepare('UPDATE workflows SET name=?, trigger=?, cond=?, action=?, params=? WHERE id=?').run(w.name, w.trigger, w.cond, w.action, w.params, id); res.json({ ok: true });
  });
  r.delete('/api/pilot/workflows/:id', adminOnly, (req, res) => { db.prepare('DELETE FROM workflows WHERE id=?').run(Number(req.params.id)); res.json({ ok: true }); });

  function runWorkflows(trigger, d, extra = {}) {
    if (!d) return;
    for (const w of db.prepare('SELECT * FROM workflows WHERE active=1 AND trigger=?').all(trigger)) {
      try {
        const cond = safeJSON(w.cond, {}), p = safeJSON(w.params, {});
        if (cond.status && statusOf(d) !== cond.status) continue;
        const vars = { company_name: d.title || '', status: statusOf(d), ...extra };
        if (w.action === 'create_task') {
          const to = p.assign === 'owner' || !p.assign ? d.owner_id : Number(p.assign) || d.owner_id;
          const id = addTask({ deal_id: d.id, type: p.type || 'workflow', description: tpl(p.description, vars), assigned_to: to, due_at: now() + (p.due_days ?? 1) * DAY, auto: true, created_by: null });
          db.prepare('INSERT OR IGNORE INTO wf_seen(kind,key) VALUES(?,?)').run('task_created', String(id)); // don't re-trigger on our own task
        } else if (w.action === 'set_status' && p.status) setStatus(getDeal(d.id), p.status, -1, 'Workflow: ' + w.name, true);
        else if (w.action === 'add_note') D().event(d.id, -1, 'note', tpl(p.text, vars));
        else if (w.action === 'notify' && d.owner_id) ctx.emitTo(d.owner_id, 'notify', { text: tpl(p.text, vars), dealId: d.id });
        db.prepare('UPDATE workflows SET runs=runs+1, last_run=? WHERE id=?').run(now(), w.id);
      } catch (e) { log && log('workflow ' + w.id + ' failed: ' + e.message); }
    }
  }
  const seen = (kind, key) => db.prepare('INSERT OR IGNORE INTO wf_seen(kind,key) VALUES(?,?)').run(kind, String(key)).changes > 0;
  // fire "deal created" / "status changed" by comparing each deal's status with the last one we saw
  function sweepStatus() {
    const rows = db.prepare('SELECT id, stage, pilot_status, wf_status, offers_sent_at, contract_sent_at, contract_signed_at, pay_status, renewal_queued_at, lost_reason FROM deals').all();
    const first = !getSetting('pilot_wf_init', false);
    const upd = db.prepare('UPDATE deals SET wf_status=? WHERE id=?'), fire = [];
    db.transaction(() => {
      for (const d of rows) {
        const st = statusOf(d);
        if (d.wf_status === st) continue;
        upd.run(st, d.id);
        if (!first) fire.push([d.wf_status == null ? 'deal_created' : 'status_changed', d.id]);
      }
    })();
    if (first) setSetting('pilot_wf_init', true);
    for (const [trig, id] of fire) runWorkflows(trig, getDeal(id));
  }

  // ---------------- background sweeps ----------------
  function syncStipTasks() {
    for (const s of db.prepare("SELECT s.*, d.owner_id FROM submissions s JOIN deals d ON d.id=s.deal_id WHERE s.status='info_needed'").all()) {
      if (db.prepare("SELECT 1 FROM tasks WHERE submission_id=? AND type='stips'").get(s.id)) continue;
      const text = String(s.decline_reason || s.ai_note || s.notes || 'Funder asked for more information').slice(0, 600);
      const L = db.prepare('SELECT name FROM lenders WHERE id=?').get(s.lender_id);
      addTask({ deal_id: s.deal_id, lender_id: s.lender_id, submission_id: s.id, type: 'stips', description: `${L ? L.name : 'Funder'} needs: ${text}`, assigned_to: s.owner_id, due_at: now() + DAY, auto: true });
    }
    // close stip tasks once the funder has moved on
    db.prepare("UPDATE tasks SET status='done', done_at=? WHERE type='stips' AND status='open' AND submission_id IN (SELECT id FROM submissions WHERE status!='info_needed')").run(now());
  }
  function sweepTriggers() {
    if (!getSetting('pilot_trig_init', false)) { // first run: remember what already exists so old history never fires new workflows
      const mk = (k, rows) => { for (const x of rows) seen(k, x); };
      mk('offer_created', db.prepare("SELECT id FROM submissions WHERE offer_amount IS NOT NULL AND status IN ('approved','funded')").all().map(x => x.id));
      mk('submission_errored', db.prepare("SELECT id FROM submissions WHERE error!=''").all().map(x => x.id));
      mk('all_declined', db.prepare('SELECT deal_id FROM submissions GROUP BY deal_id HAVING SUM(status=\'declined\')=COUNT(*)').all().map(x => x.deal_id));
      mk('task_created', db.prepare('SELECT id FROM tasks').all().map(x => x.id)); mk('task_due', db.prepare("SELECT id FROM tasks WHERE status='open' AND due_at IS NOT NULL AND due_at<?").all(now()).map(x => x.id));
      mk('renewal_due', db.prepare('SELECT id FROM deals WHERE renewal_queued_at IS NOT NULL').all().map(x => x.id));
      setSetting('pilot_trig_init', true); return;
    }
    for (const s of db.prepare("SELECT id, deal_id FROM submissions WHERE offer_amount IS NOT NULL AND status IN ('approved','funded') ORDER BY id DESC LIMIT 200").all()) if (seen('offer_created', s.id)) runWorkflows('offer_created', getDeal(s.deal_id));
    for (const s of db.prepare("SELECT id, deal_id FROM submissions WHERE error!='' ORDER BY id DESC LIMIT 200").all()) if (seen('submission_errored', s.id)) runWorkflows('submission_errored', getDeal(s.deal_id));
    for (const x of db.prepare("SELECT deal_id FROM submissions GROUP BY deal_id HAVING COUNT(*)>0 AND SUM(status='declined')=COUNT(*) ORDER BY MAX(updated_at) DESC LIMIT 100").all()) if (seen('all_declined', x.deal_id)) runWorkflows('all_declined', getDeal(x.deal_id));
    for (const t of db.prepare("SELECT * FROM tasks WHERE deal_id IS NOT NULL ORDER BY id DESC LIMIT 200").all()) if (seen('task_created', t.id)) runWorkflows('task_created', getDeal(t.deal_id), { task: t.description });
    for (const t of db.prepare("SELECT * FROM tasks WHERE status='open' AND deal_id IS NOT NULL AND due_at IS NOT NULL AND due_at<?").all(now())) if (seen('task_due', t.id)) runWorkflows('task_due', getDeal(t.deal_id), { task: t.description });
    for (const d of db.prepare('SELECT id FROM deals WHERE renewal_queued_at IS NOT NULL ORDER BY renewal_queued_at DESC LIMIT 100').all()) if (seen('renewal_due', d.id)) runWorkflows('renewal_due', getDeal(d.id));
  }
  async function sweepAutosub() {
    const cfg = cfgGet().autosub; if (!cfg.enabled || !mail.enabled()) return;
    for (const d of db.prepare("SELECT * FROM deals WHERE stage='docs_in' AND autosub_at IS NULL AND skip_autosub=0 AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.deal_id=deals.id) LIMIT 3").all()) {
      try { await autoSubmit(d, null, false); } catch (e) { db.prepare('UPDATE deals SET autosub_at=? WHERE id=?').run(now(), d.id); D().event(d.id, null, 'autosub', 'Auto-submit skipped: ' + e.message); }
    }
  }
  function sweepPasses() {
    const cfg = cfgGet().passes; if (!cfg.enabled || !(cfg.pool || []).length) return;
    const pool = cfg.pool.map(Number).filter(Boolean); let cursor = Number(getSetting('pilot_pass_cursor', 0)) || 0;
    const cutoff = now() - Math.max(1, Number(cfg.days) || 7) * DAY;
    for (const d of db.prepare("SELECT * FROM deals WHERE stage IN ('interested','app_sent','app_in','docs_in') AND updated_at<? AND pass_count<? AND COALESCE(passed_at,0)<? LIMIT 25").all(cutoff, Math.max(1, Number(cfg.max_passes) || 3), cutoff)) {
      const choices = pool.filter(id => id !== d.owner_id); if (!choices.length) continue;
      const to = choices[cursor++ % choices.length], u = db.prepare('SELECT name FROM users WHERE id=? AND active=1').get(to); if (!u) continue;
      db.prepare('UPDATE deals SET owner_id=?, pass_count=pass_count+1, passed_at=?, updated_at=? WHERE id=?').run(to, now(), now(), d.id);
      db.prepare('UPDATE leads SET owner_id=? WHERE id=?').run(to, d.lead_id);
      D().event(d.id, null, 'pass', `Passed to ${u.name} (no activity for ${cfg.days} days)`); ctx.emitTo(to, 'notify', { text: `A deal was passed to you: ${d.title || ''}`, dealId: d.id });
    }
    setSetting('pilot_pass_cursor', cursor % 100000);
  }
  let busy = false;
  async function tick() {
    if (busy) return; busy = true;
    try { syncStipTasks(); sweepStatus(); sweepTriggers(); await sweepAutosub(); } catch (e) { console.error('pilot tick:', e.message); }
    busy = false;
  }
  const t1 = setInterval(tick, (Number(process.env.PILOT_TICK_SECONDS) || 30) * 1000), t2 = setInterval(() => { try { sweepPasses(); } catch (e) { console.error('passes:', e.message); } }, HOUR);
  if (t1.unref) { t1.unref(); t2.unref(); }
  setTimeout(tick, 8000).unref?.();

  // ---------------- config + permissions ----------------
  r.get('/api/pilot/config', (req, res) => res.json({ ...cfgGet(), statuses: STATUSES.map(([status, stage, group]) => ({ status, stage, group })), perms: PERMS, me: { denied: PERMS.filter(p => !can(req.user, p[0])).map(p => p[0]) },
    users: req.user.role === 'admin' ? db.prepare("SELECT id, name FROM users WHERE active=1 AND role IN ('admin','rep') ORDER BY name").all() : [] }));
  r.put('/api/pilot/config', adminOnly, (req, res) => {
    const b = req.body || {}, cur = cfgGet();
    if (b.autosub) cur.autosub = { enabled: !!b.autosub.enabled, max: Math.max(1, Math.min(30, Number(b.autosub.max) || 8)) };
    if (b.passes) cur.passes = { enabled: !!b.passes.enabled, days: Math.max(1, Math.min(90, Number(b.passes.days) || 7)), max_passes: Math.max(1, Math.min(20, Number(b.passes.max_passes) || 3)), pool: (b.passes.pool || []).map(Number).filter(Boolean) };
    if (b.templates) for (const k of ['contracts', 'bump', 'info']) if (b.templates[k]) cur.templates[k] = { subject: String(b.templates[k].subject || '').slice(0, 200), body: String(b.templates[k].body || '').slice(0, 4000) };
    setSetting('pilot', cur); audit(req, 'pilot.config', 'settings', '', 'updated'); res.json({ ok: true });
  });
  r.get('/api/pilot/permissions', adminOnly, (req, res) => res.json({ perms: PERMS, users: db.prepare("SELECT id, name, role, permissions, manager_id, team FROM users WHERE active=1 ORDER BY name").all().map(u => ({ ...u, permissions: safeJSON(u.permissions, {}) })) }));
  r.put('/api/pilot/permissions/:id', adminOnly, (req, res) => {
    const id = Number(req.params.id), b = req.body || {}, u = db.prepare('SELECT id FROM users WHERE id=?').get(id); if (!u) return res.status(404).json({ error: 'User not found' });
    if ('permissions' in b) { const p = {}; for (const [k] of PERMS) if ((b.permissions || {})[k] === false) p[k] = false; db.prepare('UPDATE users SET permissions=? WHERE id=?').run(JSON.stringify(p), id); }
    if ('manager_id' in b) db.prepare('UPDATE users SET manager_id=? WHERE id=?').run(b.manager_id && Number(b.manager_id) !== id ? Number(b.manager_id) : null, id);
    if ('team' in b) db.prepare('UPDATE users SET team=? WHERE id=?').run(String(b.team || '').slice(0, 60), id);
    audit(req, 'pilot.permissions', 'user', String(id), 'updated'); res.json({ ok: true });
  });

  // ---------------- export ----------------
  r.get('/api/pilot/export/:kind', adminOnly, (req, res) => {
    const k = req.params.kind; let head, rows;
    if (k === 'tasks') { head = ['ID', 'Deal', 'Funder', 'Type', 'Description', 'Status', 'Assigned to', 'Due', 'Created']; rows = db.prepare(TASK_SQL + ' ORDER BY t.id DESC LIMIT 20000').all().map(t => [t.id, t.deal_title || t.business, t.lender_name, t.type, t.description, t.status, t.assigned_name, t.due_at ? new Date(t.due_at).toISOString().slice(0, 16) : '', new Date(t.created_at).toISOString().slice(0, 16)]); }
    else if (k === 'submissions') { head = ['ID', 'Deal', 'Funder', 'Status', 'Response', 'Error', 'Submitted by', 'Originator', 'Submitted', 'Updated']; rows = db.prepare(`SELECT s.id, COALESCE(NULLIF(d.title,''), l.business) deal, ln.name lender, s.status, COALESCE(NULLIF(s.decline_reason,''), NULLIF(s.ai_note,''), s.notes) response, s.error, u.name by, o.name orig, s.sent_at, s.updated_at FROM submissions s JOIN deals d ON d.id=s.deal_id JOIN leads l ON l.id=d.lead_id JOIN lenders ln ON ln.id=s.lender_id LEFT JOIN users u ON u.id=s.user_id LEFT JOIN users o ON o.id=d.owner_id ORDER BY s.id DESC LIMIT 50000`).all().map(x => [x.id, x.deal, x.lender, x.status, x.response, x.error, x.by, x.orig, new Date(x.sent_at).toISOString().slice(0, 16), new Date(x.updated_at).toISOString().slice(0, 16)]); }
    else if (k === 'offers') { head = ['ID', 'Deal', 'Funder', 'Status', 'Amount', 'Factor', 'Term (days)', 'Payment', 'Payback', 'Tags']; rows = db.prepare(`SELECT s.id, COALESCE(NULLIF(d.title,''), l.business) deal, ln.name lender, s.status, s.offer_amount a, s.offer_factor f, s.offer_term_days t, s.offer_payment p, s.tags FROM submissions s JOIN deals d ON d.id=s.deal_id JOIN leads l ON l.id=d.lead_id JOIN lenders ln ON ln.id=s.lender_id WHERE s.offer_amount IS NOT NULL ORDER BY s.id DESC LIMIT 50000`).all().map(x => [x.id, x.deal, x.lender, x.status, x.a, x.f, x.t, x.p, x.a && x.f ? round2(x.a * x.f) : '', x.tags]); }
    else if (k === 'batches') { head = ['Batch', 'Source', 'Vendor', 'Price', 'Count', 'Price per lead', 'Leads', 'Deals', 'Funded', 'Revenue', 'Profit', 'ROI %']; rows = batchRows().map(b => [b.name, b.source, b.vendor, b.price, b.count, b.per_lead, b.leads, b.deals, b.funded, b.revenue, b.profit, b.roi]); }
    else return res.status(404).json({ error: 'Unknown export' });
    audit(req, 'pilot.export', k, '', rows.length + ' rows');
    res.type('text/csv').set('Content-Disposition', `attachment; filename="${k}-${new Date().toISOString().slice(0, 10)}.csv"`).send([head, ...rows].map(r2 => r2.map(csvCell).join(',')).join('\n'));
  });

  return { router: r, can, statusOf, setStatus, metrics, matchAll, needsAction, STATUSES, addTask, tick };
};
