// ISO / broker partners: own login, submit deals, track status and commissions
const express = require('express');
const { db, getSetting, audit } = require('./db');
const now = () => Date.now();
const FILE_MAX = 20;
const STATUS = { interested: 'Received', app_sent: 'Received', app_in: 'In review', docs_in: 'In review', submitted: 'In underwriting', offer: 'Offer made', contract: 'Contract out', funded: 'Funded', lost: 'Closed' };

module.exports = function iso(ctx) {
  const { emitTo, emitAll, normPhone, insertLead, PUBLIC_URL, adminOnly } = ctx;
  const r = express.Router();
  const D = () => ctx.deals;
  const isoOnly = (req, res, next) => req.user.role === 'iso' ? next() : res.status(403).json({ error: 'Partner accounts only' });
  const due = d => d.stage === 'funded' && d.funded_amount ? Math.round(d.funded_amount * (d.iso_pct || 0)) / 100 : null;
  const view = d => ({ id: d.id, business: d.lead_business || d.title, contact: d.lead_name, phone: d.lead_phone, state: d.lead_state, amount_requested: d.amount_requested, status: STATUS[d.stage] || d.stage, funded: d.stage === 'funded',
    funded_amount: d.stage === 'funded' ? d.funded_amount : null, commission_pct: d.iso_pct, commission: due(d), paid: !!d.iso_paid_at, paid_at: d.iso_paid_at, submitted_at: d.created_at, updated_at: d.updated_at,
    statements: d.stmt_count || 0, apply_link: d.upload_token ? `${PUBLIC_URL}/apply/${d.upload_token}` : null });
  const myDeals = id => db.prepare(`SELECT d.*, l.business lead_business, l.name lead_name, l.phone lead_phone, l.state lead_state, (SELECT COUNT(*) FROM deal_files f WHERE f.deal_id=d.id AND f.kind='statement') stmt_count
    FROM deals d JOIN leads l ON l.id=d.lead_id WHERE d.iso_id=? ORDER BY d.created_at DESC`).all(id);

  r.get('/api/iso/deals', isoOnly, (req, res) => {
    const rows = myDeals(req.user.id).map(view);
    const funded = rows.filter(x => x.funded);
    res.json({ rows, totals: { submitted: rows.length, funded: funded.length, volume: funded.reduce((a, x) => a + (x.funded_amount || 0), 0), earned: funded.reduce((a, x) => a + (x.commission || 0), 0), paid: funded.filter(x => x.paid).reduce((a, x) => a + (x.commission || 0), 0),
      pending: rows.filter(x => !x.funded && x.status !== 'Closed').length }, company: process.env.COMPANY_NAME || 'Brookestone Funding', pct: db.prepare('SELECT commission_pct FROM users WHERE id=?').get(req.user.id).commission_pct || 0 });
  });
  r.post('/api/iso/deals', isoOnly, D().upload.array('files', FILE_MAX), (req, res) => {
    const b = req.body || {}, phone = normPhone(b.phone);
    if (!String(b.business || '').trim()) return res.status(400).json({ error: 'Business name is required' });
    if (!phone) return res.status(400).json({ error: 'A valid merchant phone number is required' });
    const { all, online } = ctx.onlineReps();
    const pool = online.length ? online : all, since = new Date().setHours(0, 0, 0, 0);
    const owner = pool.length ? pool.map(u => [u.id, db.prepare('SELECT COUNT(*) n FROM deals WHERE owner_id=? AND created_at>?').get(u.id, since).n]).sort((a, b) => a[1] - b[1] || a[0] - b[0])[0][0] : null;
    const me = db.prepare('SELECT id,name,commission_pct FROM users WHERE id=?').get(req.user.id);
    const src = 'ISO: ' + me.name;
    const id = insertLead({ name: b.contact, business: b.business, phone, email: b.email, state: b.state, owner_id: owner, source: src, notes: `Submitted by partner ${me.name}${b.notes ? ': ' + b.notes : ''}` }, req.user.id, now());
    if (id === 'dupe') return res.status(409).json({ error: 'This merchant is already in our system, so we can\'t take the submission. Contact us if you believe it belongs to you.' });
    if (id === 'dnc') return res.status(400).json({ error: 'We are unable to accept this merchant.' });
    if (id === 'bad') return res.status(400).json({ error: 'A valid merchant phone number is required' });
    db.prepare("UPDATE leads SET hot=1, status='new', last_outcome='Partner submission' WHERE id=?").run(id);
    const d = D().openDealFor(id, owner);
    db.prepare('UPDATE deals SET iso_id=?, iso_pct=?, amount_requested=?, notes=?, owner_id=COALESCE(owner_id,?) WHERE id=?').run(me.id, me.commission_pct || 0, ctx.deals.num(b.amount), String(b.notes || '').slice(0, 1000), owner, d.id);
    for (const f of req.files || []) db.prepare('INSERT INTO deal_files(deal_id,kind,name,file,size,mime,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,?)').run(d.id, 'statement', f.originalname.slice(0, 120), f.filename, f.size, f.mimetype, req.user.id, now());
    D().event(d.id, req.user.id, 'iso', `Submitted by partner ${me.name}${(req.files || []).length ? ' with ' + req.files.length + ' file(s)' : ''}`);
    if ((req.files || []).length && ctx.onFilesUploaded) ctx.onFilesUploaded(d.id, 'statement');
    D().ensureToken(D().getDeal(d.id));
    const text = `New partner deal from ${me.name}: ${b.business}`;
    if (owner) { emitTo(owner, 'deal_alert', { dealId: d.id, text }); emitTo(owner, 'hot_lead', { leadId: id, text, hot: true }); }
    emitAll('deal_update', { dealId: d.id, leadId: id });
    res.json({ ok: true, deal: view({ ...D().getDeal(d.id), lead_business: b.business, lead_name: b.contact, lead_phone: phone, lead_state: b.state, stmt_count: (req.files || []).length }) });
  });
  r.post('/api/iso/deals/:id/files', isoOnly, D().upload.array('files', FILE_MAX), (req, res) => {
    const d = db.prepare('SELECT * FROM deals WHERE id=? AND iso_id=?').get(Number(req.params.id), req.user.id); if (!d) return res.status(404).json({ error: 'Deal not found' });
    for (const f of req.files || []) db.prepare('INSERT INTO deal_files(deal_id,kind,name,file,size,mime,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,?)').run(d.id, 'statement', f.originalname.slice(0, 120), f.filename, f.size, f.mimetype, req.user.id, now());
    D().event(d.id, req.user.id, 'iso', `Partner uploaded ${(req.files || []).length} more file(s)`); D().touch(d.id);
    if (ctx.onFilesUploaded) ctx.onFilesUploaded(d.id, 'statement');
    if (d.owner_id) emitTo(d.owner_id, 'deal_alert', { dealId: d.id, text: 'Partner added documents to ' + d.title });
    res.json({ ok: true });
  });

  // ---- admin side ----
  r.get('/api/isos', adminOnly, (req, res) => {
    const users = db.prepare("SELECT id,name,email,active,commission_pct FROM users WHERE role='iso' ORDER BY name").all();
    res.json(users.map(u => { const rows = myDeals(u.id), f = rows.filter(x => x.stage === 'funded'); const earned = f.reduce((a, x) => a + (due(x) || 0), 0), paid = f.filter(x => x.iso_paid_at).reduce((a, x) => a + (due(x) || 0), 0);
      return { ...u, submitted: rows.length, funded: f.length, volume: f.reduce((a, x) => a + (x.funded_amount || 0), 0), earned, paid, owed: earned - paid }; }));
  });
  r.get('/api/iso-payouts', adminOnly, (req, res) => {
    const rows = db.prepare(`SELECT d.*, l.business lead_business, u.name iso_name FROM deals d JOIN leads l ON l.id=d.lead_id JOIN users u ON u.id=d.iso_id WHERE d.stage='funded' ORDER BY d.funded_at DESC`).all();
    res.json(rows.map(d => ({ id: d.id, business: d.lead_business || d.title, iso_id: d.iso_id, iso_name: d.iso_name, funded_amount: d.funded_amount, iso_pct: d.iso_pct, due: due(d), paid_at: d.iso_paid_at, funded_at: d.funded_at })));
  });
  r.post('/api/deals/:id/iso-paid', adminOnly, (req, res) => {
    const id = Number(req.params.id); db.prepare('UPDATE deals SET iso_paid_at=? WHERE id=?').run(req.body.paid === false ? null : now(), id);
    D().event(id, req.user.id, 'commission', req.body.paid === false ? 'Partner commission marked unpaid' : 'Partner commission marked paid'); audit(req, 'iso.paid', 'deal', id, String(req.body.paid !== false)); res.json({ ok: true });
  });
  r.post('/api/deals/:id/iso', adminOnly, (req, res) => {
    const id = Number(req.params.id), iso = req.body.iso_id ? db.prepare("SELECT id,commission_pct FROM users WHERE id=? AND role='iso'").get(Number(req.body.iso_id)) : null;
    if (req.body.iso_id && !iso) return res.status(400).json({ error: 'Partner not found' });
    db.prepare('UPDATE deals SET iso_id=?, iso_pct=? WHERE id=?').run(iso ? iso.id : null, iso ? (req.body.iso_pct !== '' && req.body.iso_pct != null ? Number(req.body.iso_pct) : iso.commission_pct || 0) : null, id);
    D().event(id, req.user.id, 'iso', iso ? 'Partner assigned' : 'Partner removed'); res.json({ ok: true });
  });
  return { router: r };
};
