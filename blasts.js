// Bulk text blasts: schedule a message to a list; reps can blast their own leads or a sheet they upload
const express = require('express');
const { db, getSetting, setSetting, audit } = require('./db');
const tz = require('./tz');
const now = () => Date.now();
const DEFAULTS = { reps_can_send: true, rep_max: 1000, rate_per_min: 30, footer: 'Reply STOP to opt out.', skip_recent_hours: 24 };

db.exec(`
CREATE TABLE IF NOT EXISTS blasts (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, user_id INTEGER, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',            -- draft | scheduled | sending | paused | done | cancelled
  scheduled_at INTEGER, started_at INTEGER, finished_at INTEGER, rate_per_min INTEGER NOT NULL DEFAULT 30,
  source TEXT DEFAULT '', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blast_recipients (
  id INTEGER PRIMARY KEY, blast_id INTEGER NOT NULL REFERENCES blasts(id) ON DELETE CASCADE, lead_id INTEGER NOT NULL, phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',               -- queued | sent | failed | skipped
  reason TEXT DEFAULT '', message_id INTEGER, sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS blast_rec ON blast_recipients(blast_id, status);
CREATE INDEX IF NOT EXISTS blast_rec_lead ON blast_recipients(lead_id);
`);

module.exports = function blasts(ctx) {
  const { sendSms, fillTpl, normPhone, isDnc, insertLead, log, emitTo, emitAll } = ctx;
  const r = express.Router();
  const cfg = () => ({ ...DEFAULTS, ...(getSetting('blasts', {}) || {}) });
  const isAdmin = u => u.role === 'admin';
  const mine = (b, u) => isAdmin(u) || b.user_id === u.id;
  const guard = (req, res, next) => (cfg().reps_can_send || isAdmin(req.user)) ? next() : res.status(403).json({ error: 'Text blasts are limited to admins right now' });

  // ---------- audience ----------
  function audienceFromFilters(f, user) {
    const where = ["phone!=''"], args = [];
    if (f.list) { where.push('source=?'); args.push(String(f.list)); }
    if (f.status) { where.push('status=?'); args.push(String(f.status)); }
    if (f.state) { where.push('UPPER(state)=?'); args.push(String(f.state).toUpperCase()); }
    if (f.min_attempts) { where.push('attempts>=?'); args.push(Number(f.min_attempts) || 0); }
    if (f.not_reached) where.push("id NOT IN (SELECT lead_id FROM calls WHERE connected=1)");
    if (isAdmin(user)) { if (f.owner === 'me') { where.push('owner_id=?'); args.push(user.id); } else if (f.owner === 'none') where.push('owner_id IS NULL'); else if (f.owner) { where.push('owner_id=?'); args.push(Number(f.owner)); } }
    else { where.push('owner_id=?'); args.push(user.id); }                    // reps: only their own leads
    return db.prepare(`SELECT id, phone, status, tz, owner_id FROM leads WHERE ${where.join(' AND ')} ORDER BY id LIMIT 50000`).all(...args);
  }
  // sheet rows -> leads (existing leads are reused, new ones are created with this blast's list name)
  function audienceFromSheet(rows, source, user) {
    const out = [], skipped = []; const seen = new Set();
    for (const row of rows.slice(0, 50000)) {
      const phone = normPhone(row.phone); if (!phone) { skipped.push({ phone: String(row.phone || ''), reason: 'Invalid number' }); continue; }
      if (seen.has(phone)) continue; seen.add(phone);
      let lead = db.prepare('SELECT id, phone, status, tz, owner_id FROM leads WHERE phone=?').get(phone);
      if (!lead) {
        const id = insertLead({ ...row, phone, owner_id: user.id, source }, user.id, now());
        if (typeof id === 'number') lead = db.prepare('SELECT id, phone, status, tz, owner_id FROM leads WHERE id=?').get(id);
        else if (id === 'dnc') { skipped.push({ phone, reason: 'On DNC list' }); continue; }
        else continue;
      } else if (!isAdmin(user) && lead.owner_id && lead.owner_id !== user.id) { skipped.push({ phone, reason: 'Belongs to another rep' }); continue; }
      out.push(lead);
    }
    return { leads: out, skipped };
  }
  function classify(lead, skipHours) {
    if (lead.status === 'dnc' || isDnc(lead.phone)) return 'On DNC list';
    if (skipHours > 0 && db.prepare("SELECT 1 FROM messages WHERE lead_id=? AND direction='out' AND created_at>?").get(lead.id, now() - skipHours * 3600e3)) return `Already texted in the last ${skipHours}h`;
    return '';
  }

  r.get('/api/blasts/meta', (req, res) => {
    const c = cfg();
    res.json({ settings: c, can_send: c.reps_can_send || isAdmin(req.user), lists: db.prepare("SELECT source name, COUNT(*) n FROM leads WHERE source!='' GROUP BY source ORDER BY MAX(created_at) DESC LIMIT 100").all(),
      users: isAdmin(req.user) ? db.prepare("SELECT id,name FROM users WHERE active=1 AND role!='iso' ORDER BY name").all() : [], company: process.env.COMPANY_NAME || 'Brookestone Funding' });
  });
  r.put('/api/blasts/meta', (req, res) => {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admins only' });
    const b = req.body || {};
    setSetting('blasts', { reps_can_send: b.reps_can_send !== false, rep_max: Math.max(1, Math.min(50000, Number(b.rep_max) || 1000)), rate_per_min: Math.max(1, Math.min(300, Number(b.rate_per_min) || 30)),
      footer: String(b.footer == null ? DEFAULTS.footer : b.footer).slice(0, 80), skip_recent_hours: Math.max(0, Math.min(720, Number(b.skip_recent_hours) || 0)) });
    audit(req, 'settings.update', 'settings', 'blasts', ''); res.json({ ok: true });
  });
  r.post('/api/blasts/preview', guard, (req, res) => {
    const b = req.body || {}, skipH = cfg().skip_recent_hours; let leads, pre = [];
    if (Array.isArray(b.sheet)) {
      // preview must not create leads: classify by phone only
      leads = []; const seen = new Set();
      for (const row of b.sheet.slice(0, 50000)) { const p = normPhone(row.phone); if (!p) { pre.push('Invalid number'); continue; } if (seen.has(p)) continue; seen.add(p);
        const l = db.prepare('SELECT id, phone, status, tz, owner_id FROM leads WHERE phone=?').get(p) || { id: 0, phone: p, status: 'new', tz: '' };
        if (l.id && !isAdmin(req.user) && l.owner_id && l.owner_id !== req.user.id) { pre.push('Belongs to another rep'); continue; } leads.push(l); }
    } else leads = audienceFromFilters(b.filters || {}, req.user);
    const reasons = {}; let ok = 0, later = 0;
    for (const l of leads) { const why = classify(l, skipH); if (why) reasons[why.replace(/\d+h/, skipH + 'h')] = (reasons[why] || 0) + 1; else { ok++; if (!tz.okNow(l.tz)) later++; } }
    for (const w of pre) reasons[w] = (reasons[w] || 0) + 1;
    const rate = Math.min(cfg().rate_per_min, Number(b.rate_per_min) || cfg().rate_per_min);
    res.json({ total: leads.length + pre.length, will_send: ok, outside_hours_now: later, skipped: reasons, minutes: ok ? Math.ceil(ok / rate) : 0, rate });
  });

  // ---------- create / control ----------
  r.post('/api/blasts', guard, (req, res) => {
    const b = req.body || {}, c = cfg(), u = req.user;
    const name = String(b.name || '').trim().slice(0, 80), body = String(b.body || '').trim();
    if (!name) return res.status(400).json({ error: 'Give the blast a name' });
    if (!body) return res.status(400).json({ error: 'Write the message' });
    if (body.length > 640) return res.status(400).json({ error: 'Message is too long (640 characters max)' });
    let leads, extraSkipped = [];
    if (Array.isArray(b.sheet)) { const s = audienceFromSheet(b.sheet, name, u); leads = s.leads; extraSkipped = s.skipped; tz.backfill().catch(() => {}); } else leads = audienceFromFilters(b.filters || {}, u);
    if (!leads.length) return res.status(400).json({ error: 'No leads matched' });
    if (!isAdmin(u) && leads.length > c.rep_max) return res.status(400).json({ error: `Reps can send up to ${c.rep_max} texts per blast — this one has ${leads.length}` });
    const when = b.schedule_at ? Number(b.schedule_at) : now();
    if (b.schedule_at && (!when || when < now() - 60000 || when > now() + 90 * 864e5)) return res.status(400).json({ error: 'Pick a time in the future (within 90 days)' });
    const rate = Math.max(1, Math.min(c.rate_per_min, Number(b.rate_per_min) || c.rate_per_min));
    const id = db.transaction(() => {
      const bid = db.prepare('INSERT INTO blasts(name,user_id,body,status,scheduled_at,rate_per_min,source,created_at) VALUES(?,?,?,?,?,?,?,?)').run(name, u.id, body, b.draft ? 'draft' : 'scheduled', when, rate, Array.isArray(b.sheet) ? name : String((b.filters || {}).list || ''), now()).lastInsertRowid;
      const ins = db.prepare('INSERT INTO blast_recipients(blast_id,lead_id,phone,status,reason) VALUES(?,?,?,?,?)');
      for (const l of leads) { const why = classify(l, c.skip_recent_hours); ins.run(bid, l.id, l.phone, why ? 'skipped' : 'queued', why); }
      return bid;
    })();
    audit(req, 'blast.create', 'blast', id, `${name}: ${leads.length} recipients`);
    res.json({ ok: true, id, recipients: leads.length, skipped_upload: extraSkipped.length });
    setTimeout(tick, 200);
  });
  const load = (req, res) => { const b = db.prepare('SELECT * FROM blasts WHERE id=?').get(Number(req.params.id)); if (!b || !mine(b, req.user)) { res.status(404).json({ error: 'Blast not found' }); return null; } return b; };
  r.post('/api/blasts/:id/:action', (req, res) => {
    const a = req.params.action; if (!['pause', 'resume', 'cancel', 'start', 'delete'].includes(a)) return res.status(404).json({ error: 'Unknown action' });
    const b = load(req, res); if (!b) return;
    if (a === 'pause' && ['scheduled', 'sending'].includes(b.status)) db.prepare("UPDATE blasts SET status='paused' WHERE id=?").run(b.id);
    else if (a === 'resume' && ['paused', 'draft'].includes(b.status)) db.prepare("UPDATE blasts SET status='scheduled', scheduled_at=MAX(COALESCE(scheduled_at,0), ?) WHERE id=?").run(b.scheduled_at && b.scheduled_at > now() ? b.scheduled_at : now(), b.id);
    else if (a === 'start' && ['scheduled', 'draft', 'paused'].includes(b.status)) db.prepare("UPDATE blasts SET status='scheduled', scheduled_at=? WHERE id=?").run(now(), b.id);
    else if (a === 'cancel' && !['done', 'cancelled'].includes(b.status)) { db.prepare("UPDATE blasts SET status='cancelled', finished_at=? WHERE id=?").run(now(), b.id); db.prepare("UPDATE blast_recipients SET status='skipped', reason='Blast cancelled' WHERE blast_id=? AND status='queued'").run(b.id); }
    else if (a === 'delete' && !['sending'].includes(b.status)) db.prepare('DELETE FROM blasts WHERE id=?').run(b.id);
    else return res.status(400).json({ error: `Can't ${a} a blast that is ${b.status}` });
    audit(req, 'blast.' + a, 'blast', b.id, b.name); setTimeout(tick, 200); res.json({ ok: true });
  });

  // ---------- stats / lists ----------
  const stats = id => {
    const s = db.prepare(`SELECT COUNT(*) total, SUM(status='queued') queued, SUM(status='sent') sent, SUM(status='failed') failed, SUM(status='skipped') skipped FROM blast_recipients WHERE blast_id=?`).get(id);
    const x = db.prepare(`SELECT COUNT(DISTINCT br.lead_id) replies FROM blast_recipients br WHERE br.blast_id=? AND br.status='sent' AND EXISTS (SELECT 1 FROM messages m WHERE m.lead_id=br.lead_id AND m.direction='in' AND m.created_at>br.sent_at)`).get(id);
    const o = db.prepare(`SELECT COUNT(*) n FROM blast_recipients br JOIN leads l ON l.id=br.lead_id WHERE br.blast_id=? AND br.status='sent' AND l.status='dnc'`).get(id);
    const d = db.prepare(`SELECT SUM(m.status='delivered') delivered FROM blast_recipients br JOIN messages m ON m.id=br.message_id WHERE br.blast_id=?`).get(id);
    return { total: s.total || 0, queued: s.queued || 0, sent: s.sent || 0, failed: s.failed || 0, skipped: s.skipped || 0, replies: x.replies || 0, opt_outs: o.n || 0, delivered: d.delivered || 0 };
  };
  r.get('/api/blasts', (req, res) => {
    const rows = db.prepare(`SELECT b.*, u.name owner_name FROM blasts b LEFT JOIN users u ON u.id=b.user_id ${isAdmin(req.user) ? '' : 'WHERE b.user_id=' + Number(req.user.id)} ORDER BY b.id DESC LIMIT 200`).all();
    res.json(rows.map(b => ({ ...b, stats: stats(b.id) })));
  });
  r.get('/api/blasts/:id', (req, res) => {
    const b = load(req, res); if (!b) return;
    const f = ['queued', 'sent', 'failed', 'skipped'].includes(req.query.status) ? req.query.status : '';
    const rows = db.prepare(`SELECT br.*, l.name, l.business, m.status msg_status, m.error,
        EXISTS (SELECT 1 FROM messages x WHERE x.lead_id=br.lead_id AND x.direction='in' AND x.created_at>COALESCE(br.sent_at, 9e15)) replied
      FROM blast_recipients br JOIN leads l ON l.id=br.lead_id LEFT JOIN messages m ON m.id=br.message_id WHERE br.blast_id=? ${f ? 'AND br.status=?' : ''} ORDER BY br.id LIMIT 300`).all(...[b.id].concat(f ? [f] : []));
    res.json({ blast: { ...b, owner_name: (db.prepare('SELECT name FROM users WHERE id=?').get(b.user_id) || {}).name }, stats: stats(b.id), rows });
  });

  // ---------- sender ----------
  let busy = false;
  async function tick() {
    if (busy) return; busy = true;
    try {
      const t = now();
      db.prepare("UPDATE blasts SET status='sending', started_at=COALESCE(started_at, ?) WHERE status='scheduled' AND scheduled_at<=?").run(t, t);
      const active = db.prepare("SELECT * FROM blasts WHERE status='sending' ORDER BY id").all();
      for (const b of active) {
        const per = Math.max(1, Math.round(b.rate_per_min / 12));            // called every 5 seconds
        const user = db.prepare('SELECT id,name FROM users WHERE id=?').get(b.user_id) || null;
        const batch = db.prepare("SELECT br.*, l.status lead_status, l.tz FROM blast_recipients br JOIN leads l ON l.id=br.lead_id WHERE br.blast_id=? AND br.status='queued' ORDER BY br.id LIMIT 300").all(b.id);
        let sent = 0;
        for (const rcp of batch) {
          if (sent >= per) break;
          const cur = db.prepare('SELECT status FROM blasts WHERE id=?').get(b.id); if (!cur || cur.status !== 'sending') break;       // paused / cancelled mid-batch
          const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(rcp.lead_id);
          if (!lead) { db.prepare("UPDATE blast_recipients SET status='skipped', reason='Lead deleted' WHERE id=?").run(rcp.id); continue; }
          if (lead.status === 'dnc' || isDnc(lead.phone)) { db.prepare("UPDATE blast_recipients SET status='skipped', reason='On DNC list' WHERE id=?").run(rcp.id); continue; }
          if (!tz.okNow(lead.tz)) continue;                                      // outside their calling hours — try again later
          let body = fillTpl(b.body, lead, user && user.name); const foot = cfg().footer; if (foot && !/stop/i.test(body)) body += (/[.!?]$/.test(body.trim()) ? ' ' : '. ') + foot;
          sent++;
          try {
            const m = await sendSms(lead, body, user);
            db.prepare('UPDATE blast_recipients SET status=?, reason=?, message_id=?, sent_at=? WHERE id=?').run(m.status === 'failed' ? 'failed' : 'sent', m.status === 'failed' ? (m.error || 'Failed') : '', m.id, now(), rcp.id);
          } catch (e) { db.prepare("UPDATE blast_recipients SET status='failed', reason=?, sent_at=? WHERE id=?").run(String(e.message).slice(0, 200), now(), rcp.id); }
        }
        if (!db.prepare("SELECT 1 FROM blast_recipients WHERE blast_id=? AND status='queued'").get(b.id)) {
          db.prepare("UPDATE blasts SET status='done', finished_at=? WHERE id=? AND status='sending'").run(now(), b.id);
          const s = stats(b.id); if (b.user_id) emitTo(b.user_id, 'deal_alert', { dealId: null, text: `Text blast “${b.name}” finished: ${s.sent} sent, ${s.failed} failed, ${s.skipped} skipped` });
        }
      }
    } catch (e) { log('Blast error:', e.message); } finally { busy = false; }
  }
  setInterval(tick, Number(process.env.BLAST_TICK_SECONDS || 5) * 1000).unref();
  setTimeout(tick, 4000);
  return { router: r, tick };
};
module.exports.DEFAULTS = DEFAULTS;
