// Weekly owner digest email, automatic backups, audit log viewer
const express = require('express');
const fs = require('fs'), path = require('path');
const { db, getSetting, setSetting, dir, audit } = require('./db');
const mail = require('./mail');
const now = () => Date.now();
const DAY = 864e5;
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const DIGEST_DEFAULTS = { enabled: false, day: 1, hour: 8, tz: 'America/New_York', recipients: '' };

module.exports = function ops(ctx) {
  const { adminOnly, log } = ctx;
  const r = express.Router();

  // ================= weekly digest =================
  const dcfg = () => ({ ...DIGEST_DEFAULTS, ...(getSetting('digest', {}) || {}) });
  const fmt = (v, f) => v == null ? '—' : f === 'money' ? '$' + Math.round(v).toLocaleString('en-US') : f === 'pct' ? (Math.round(v * 10) / 10) + '%' : f === 'dur' ? Math.round(v / 60) + 'm' : Math.round(v * 100) / 100 === Math.round(v) ? Math.round(v).toLocaleString('en-US') : String(Math.round(v * 100) / 100);
  const arrow = (v, p) => p == null || v == null || p === 0 ? '' : (v >= p ? '▲ ' : '▼ ') + Math.abs(Math.round((v - p) / p * 100)) + '%';
  function build() {
    const t = now(), from = t - 7 * DAY, tzOff = 0;
    const R = ctx.reports, base = { from, to: t, off: 0, offMs: 0, user: null, source: '' };
    const sections = [];
    const safe = (name, p) => { try { return R.build(name, p); } catch (e) { log('Digest section failed:', name, e.message); return null; } };
    const ov = safe('overview', base);
    if (ov) sections.push({ title: 'Last 7 days', kpis: ov.kpis.map(k => ({ label: k.label, value: fmt(k.value, k.fmt), change: arrow(k.value, k.prev) })) });
    const reps = safe('reps', base);
    if (reps && reps.tables[0]) sections.push({ title: 'Reps', cols: ['Rep', 'Dials', 'Talk', 'Funded $', 'Revenue'], rows: reps.tables[0].rows.slice().sort((a, b) => (b.funded_amt || 0) - (a.funded_amt || 0) || (b.dials || 0) - (a.dials || 0)).slice(0, 8)
      .map(x => [x.name || x.rep, fmt(x.dials, 'int'), x.talk != null ? fmt(x.talk, 'dur') : '—', fmt(x.funded_amt, 'money'), fmt(x.revenue, 'money')]) });
    const src = safe('sources', { ...base, from: 0 });
    if (src && src.tables[0]) sections.push({ title: 'Lead sources (all time)', cols: ['Source', 'Leads', 'Funded', 'Cost', 'Profit'], rows: src.tables[0].rows.filter(x => x.leads).sort((a, b) => (b.profit ?? -1e12) - (a.profit ?? -1e12)).slice(0, 6).map(x => [x.source || x.name, fmt(x.leads, 'int'), fmt(x.funded, 'int'), fmt(x.cost, 'money'), fmt(x.profit, 'money')]) });
    const pl = safe('pipeline', base);
    if (pl) sections.push({ title: 'Pipeline', kpis: pl.kpis.slice(0, 5).map(k => ({ label: k.label, value: fmt(k.value, k.fmt), change: '' })), note: pl.tables.find(x => x.id === 'stalled') && pl.tables.find(x => x.id === 'stalled').rows.length ? pl.tables.find(x => x.id === 'stalled').rows.length + ' deal(s) have gone cold (5+ days idle).' : '' });
    const pf = safe('portfolio', base);
    if (pf && pf.kpis.length) { const behind = (pf.tables.find(x => x.id === 'behind') || { rows: [] }).rows; sections.push({ title: 'Portfolio', kpis: pf.kpis.filter(k => ['Active deals', 'Collected so far', 'Still outstanding', 'Behind on payments', 'NSFs (last 30 days)'].includes(k.label)).map(k => ({ label: k.label, value: fmt(k.value, k.fmt), change: '' })), note: behind.length ? 'Behind: ' + behind.slice(0, 6).map(x => x.deal).join(', ') : '' }); }
    const flagged = db.prepare("SELECT COUNT(*) n FROM calls WHERE qa='flagged'").get().n;
    const owed = db.prepare("SELECT COALESCE(SUM(ROUND(funded_amount*COALESCE(iso_pct,0))/100.0),0) s FROM deals WHERE stage='funded' AND iso_id IS NOT NULL AND iso_paid_at IS NULL").get().s;
    const unpaid = db.prepare("SELECT COUNT(*) n FROM deals WHERE stage='funded' AND commission_paid_at IS NULL AND funded_amount>0").get().n;
    const todo = []; if (flagged) todo.push(flagged + ' call(s) flagged for review'); if (owed) todo.push(fmt(owed, 'money') + ' owed to partners'); if (unpaid) todo.push(unpaid + ' funded deal(s) with unpaid rep commission');
    if (todo.length) sections.push({ title: 'Needs your attention', note: todo.join(' · ') });
    return sections;
  }
  function render(sections) {
    const company = process.env.COMPANY_NAME || 'Brookestone Funding';
    const d = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    let html = `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:640px;margin:auto;color:#14181f"><h2 style="margin:0 0 4px">${esc(company)} — weekly summary</h2><div style="color:#5b6472;font-size:13px;margin-bottom:16px">Week ending ${d}</div>`;
    let text = `${company} — weekly summary (week ending ${d})\n`;
    for (const s of sections) {
      html += `<h3 style="margin:18px 0 6px;font-size:15px;border-bottom:1px solid #dfe3ea;padding-bottom:4px">${esc(s.title)}</h3>`; text += `\n${s.title.toUpperCase()}\n`;
      if (s.kpis) { html += '<table style="width:100%;border-collapse:collapse;font-size:14px">' + s.kpis.map(k => `<tr><td style="padding:3px 0;color:#5b6472">${esc(k.label)}</td><td style="text-align:right;font-weight:600">${esc(k.value)}</td><td style="text-align:right;width:70px;font-size:12px;color:${/▲/.test(k.change) ? '#0a7d4f' : '#c62828'}">${esc(k.change)}</td></tr>`).join('') + '</table>'; text += s.kpis.map(k => `  ${k.label}: ${k.value} ${k.change}`).join('\n') + '\n'; }
      if (s.cols) { html += `<table style="width:100%;border-collapse:collapse;font-size:13px"><tr>${s.cols.map((c, i) => `<th style="text-align:${i ? 'right' : 'left'};color:#5b6472;font-weight:500;padding:3px 0">${esc(c)}</th>`).join('')}</tr>` + s.rows.map(row => `<tr>${row.map((c, i) => `<td style="text-align:${i ? 'right' : 'left'};padding:3px 0;border-top:1px solid #eef0f4">${esc(c)}</td>`).join('')}</tr>`).join('') + '</table>'; text += s.rows.map(row => '  ' + row.join(' | ')).join('\n') + '\n'; }
      if (s.note) { html += `<div style="margin-top:6px;font-size:13px">${esc(s.note)}</div>`; text += '  ' + s.note + '\n'; }
    }
    return { html: html + '</div>', text, subject: `${company} weekly summary — ${d}` };
  }
  async function sendDigest(toOverride) {
    const c = dcfg(), to = toOverride || c.recipients || (db.prepare("SELECT email FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1").get() || {}).email;
    if (!to) throw new Error('No recipient — add an email address'); if (!mail.enabled()) throw new Error('Email is not set up yet (SMTP settings in .env)');
    const m = render(build()); await mail.send({ to, subject: m.subject, text: m.text, html: m.html, fromName: process.env.COMPANY_NAME || 'Brookestone Funding' });
    setSetting('digest_last', now()); return to;
  }
  const localParts = (tz, at = new Date()) => { try { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at).map(x => [x.type, x.value])); return { dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), hour: Number(p.hour) % 24, key: `${p.year}-${p.month}-${p.day}` }; } catch { return null; } };
  async function digestTick() {
    const c = dcfg(); if (!c.enabled) return;
    const lp = localParts(c.tz); if (!lp || lp.dow !== Number(c.day) || lp.hour < Number(c.hour)) return;
    if (getSetting('digest_day', '') === lp.key) return;
    setSetting('digest_day', lp.key);
    try { const to = await sendDigest(); log('Weekly digest sent to', to); } catch (e) { log('Digest failed:', e.message); }
  }
  setInterval(() => digestTick().catch(() => {}), 5 * 60000).unref();
  r.get('/api/digest', adminOnly, (req, res) => res.json({ settings: dcfg(), last: getSetting('digest_last', null), email_enabled: mail.enabled() }));
  r.put('/api/digest', adminOnly, (req, res) => {
    const b = req.body || {}, tz = String(b.tz || DIGEST_DEFAULTS.tz);
    if (!localParts(tz)) return res.status(400).json({ error: 'Time zone not recognized (example: America/New_York)' });
    const rec = String(b.recipients || '').split(/[,;\s]+/).filter(Boolean); if (rec.some(x => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))) return res.status(400).json({ error: 'Check the email addresses' });
    setSetting('digest', { enabled: !!b.enabled, day: Math.min(6, Math.max(0, Number(b.day) || 0)), hour: Math.min(23, Math.max(0, Number(b.hour) || 0)), tz, recipients: rec.join(', ') });
    audit(req, 'settings.update', 'settings', 'digest', ''); res.json({ ok: true });
  });
  r.post('/api/digest/send', adminOnly, async (req, res) => { try { res.json({ ok: true, to: await sendDigest(req.body.to || req.user.email) }); } catch (e) { res.status(400).json({ error: e.message }); } });
  r.get('/api/digest/preview', adminOnly, (req, res) => res.type('html').send(render(build()).html));

  // ================= backups =================
  const bdir = path.join(dir, 'backups'); fs.mkdirSync(bdir, { recursive: true });
  const KEEP = Number(process.env.BACKUP_KEEP || 14);
  const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
  const listBackups = () => fs.readdirSync(bdir).filter(f => /^powerdial-[\d-]+\.db$/.test(f)).map(f => { const st = fs.statSync(path.join(bdir, f)); return { name: f, size: st.size, at: st.mtimeMs }; }).sort((a, b) => b.at - a.at);
  async function backupNow(why) {
    const name = `powerdial-${stamp()}.db`, file = path.join(bdir, name);
    await db.backup(file);
    for (const b of listBackups().slice(KEEP)) fs.rmSync(path.join(bdir, b.name), { force: true });
    setSetting('backup_last', { at: now(), name, why }); return name;
  }
  async function backupTick() {
    try { const last = getSetting('backup_last', null), today = new Date().toDateString(); if (!last || new Date(last.at).toDateString() !== today) { if (new Date().getHours() >= Number(process.env.BACKUP_HOUR || 3) || !last) await backupNow('daily'); } } catch (e) { log('Backup failed:', e.message); }
  }
  setTimeout(() => backupTick(), 20000); setInterval(backupTick, 30 * 60000).unref();
  r.get('/api/backups', adminOnly, (req, res) => res.json({ rows: listBackups(), keep: KEEP, last: getSetting('backup_last', null) }));
  r.post('/api/backups', adminOnly, async (req, res) => { try { const name = await backupNow('manual'); audit(req, 'backup.create', 'backup', name, ''); res.json({ ok: true, name }); } catch (e) { res.status(500).json({ error: e.message }); } });
  r.get('/api/backups/:name', adminOnly, (req, res) => {
    const n = String(req.params.name); if (!/^powerdial-[\d-]+\.db$/.test(n) || !fs.existsSync(path.join(bdir, n))) return res.status(404).json({ error: 'Not found' });
    audit(req, 'backup.download', 'backup', n, ''); res.download(path.join(bdir, n), n);
  });

  // ================= audit log =================
  r.get('/api/audit', adminOnly, (req, res) => {
    const q = String(req.query.q || '').trim(), act = String(req.query.action || '').trim(), where = [], args = [];
    if (q) { where.push('(user_name LIKE ? OR detail LIKE ? OR entity_id LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (act) { where.push('action LIKE ?'); args.push(act + '%'); }
    const rows = db.prepare(`SELECT * FROM audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 300`).all(...args);
    res.json({ rows, actions: db.prepare('SELECT action, COUNT(*) n FROM audit GROUP BY action ORDER BY n DESC').all() });
  });
  return { router: r, backupNow, sendDigest, build };
};
module.exports.DIGEST_DEFAULTS = DIGEST_DEFAULTS;
