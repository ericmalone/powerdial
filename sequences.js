// Follow-up sequences: timed call / text / email steps per lead, stopped automatically on reply or outcome
const express = require('express');
const { db, getSetting } = require('./db');
const tz = require('./tz');

const now = () => Date.now();
const safeJSON = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

module.exports = function sequences(ctx) {
  const { sendSms, sendLeadEmail, fillTpl, emitTo, log, adminOnly } = ctx;
  const r = express.Router();

  // when the step (day N at hour H) is due, relative to the enrollment start
  function dueAt(startedAt, step) {
    const d = new Date(startedAt); d.setDate(d.getDate() + Number(step.day || 0));
    if (step.hour != null && step.hour !== '') d.setHours(Number(step.hour), 0, 0, 0);
    else if (Number(step.day || 0) === 0) return startedAt;
    return Math.max(d.getTime(), startedAt);
  }
  function enroll(leadId, seqId, userId) {
    const seq = db.prepare('SELECT * FROM sequences WHERE id=? AND active=1').get(seqId); if (!seq) return null;
    const steps = safeJSON(seq.steps, []); if (!steps.length) return null;
    db.prepare("UPDATE enrollments SET status='stopped', stop_reason='Re-enrolled' WHERE lead_id=? AND status='active'").run(leadId);
    const t = now();
    const x = db.prepare('INSERT INTO enrollments(lead_id,sequence_id,user_id,step,next_at,status,started_at) VALUES(?,?,?,?,?,?,?)').run(leadId, seqId, userId || null, 0, dueAt(t, steps[0]), 'active', t);
    return x.lastInsertRowid;
  }
  function stopFor(leadId, reason) {
    const n = db.prepare("UPDATE enrollments SET status='stopped', stop_reason=? WHERE lead_id=? AND status='active'").run(reason, leadId).changes;
    if (n) log(`Sequence stopped for lead ${leadId}: ${reason}`);
    return n;
  }

  let running = false;
  async function tick() {
    if (running) return; running = true;
    try {
      const due = db.prepare("SELECT e.*, s.steps, s.name seq_name FROM enrollments e JOIN sequences s ON s.id=e.sequence_id WHERE e.status='active' AND e.next_at<=? LIMIT 50").all(now());
      for (const e of due) {
        const steps = safeJSON(e.steps, []), step = steps[e.step];
        const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(e.lead_id);
        const user = e.user_id ? db.prepare('SELECT id, name FROM users WHERE id=?').get(e.user_id) : null;
        const stop = reason => db.prepare("UPDATE enrollments SET status='stopped', stop_reason=? WHERE id=?").run(reason, e.id);
        if (!lead || !step) { db.prepare("UPDATE enrollments SET status='done' WHERE id=?").run(e.id); continue; }
        if (lead.status === 'dnc' || db.prepare('SELECT 1 FROM dnc WHERE phone=?').get(lead.phone)) { stop('Lead is DNC'); continue; }
        if (lead.status === 'done') { stop('Lead closed'); continue; }
        if (step.type !== 'email' && !tz.okNow(lead.tz)) { db.prepare('UPDATE enrollments SET next_at=? WHERE id=?').run(tz.nextOkTime(lead.tz), e.id); continue; }
        try {
          const body = fillTpl(step.body || '', lead, user && user.name);
          if (step.type === 'sms') await sendSms(lead, body, user, e.id);
          else if (step.type === 'email') { if (lead.email) await sendLeadEmail(lead, user, { subject: fillTpl(step.subject || 'Following up', lead, user && user.name), text: body, enrollmentId: e.id }); }
          else if (step.type === 'call') {
            db.prepare("UPDATE leads SET status='callback', callback_at=?, owner_id=COALESCE(owner_id, ?), last_outcome=?, updated_at=? WHERE id=? AND status!='dnc'")
              .run(now(), e.user_id, `${e.seq_name}: call step`, now(), lead.id);
            if (e.user_id) emitTo(e.user_id, 'deal_alert', { text: `Sequence call due: ${lead.name || lead.business || lead.phone}` });
          }
        } catch (err) { log('Sequence step failed:', err.message); }
        const next = e.step + 1;
        if (next >= steps.length) db.prepare("UPDATE enrollments SET status='done', step=? WHERE id=?").run(next, e.id);
        else db.prepare('UPDATE enrollments SET step=?, next_at=? WHERE id=?').run(next, dueAt(e.started_at, steps[next]), e.id);
      }
    } finally { running = false; }
  }
  setInterval(tick, Number(process.env.SEQ_TICK_SECONDS || 60) * 1000); setTimeout(tick, 8000);

  // ---------- routes ----------
  const clean = steps => (Array.isArray(steps) ? steps : []).map(s => ({
    day: Math.max(0, Number(s.day) || 0), hour: s.hour === '' || s.hour == null ? null : Math.min(23, Math.max(0, Number(s.hour))),
    type: ['sms', 'email', 'call'].includes(s.type) ? s.type : 'sms', subject: String(s.subject || ''), body: String(s.body || ''),
  })).sort((a, b) => a.day - b.day || (a.hour ?? -1) - (b.hour ?? -1));
  r.get('/api/sequences', (req, res) => {
    res.json(db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM enrollments e WHERE e.sequence_id=s.id AND e.status='active') active_count,
      (SELECT COUNT(*) FROM enrollments e WHERE e.sequence_id=s.id) total_count FROM sequences s ORDER BY s.active DESC, s.name`).all().map(s => ({ ...s, steps: safeJSON(s.steps, []) })));
  });
  r.post('/api/sequences', adminOnly, (req, res) => {
    if (!req.body.name) return res.status(400).json({ error: 'Name required' });
    const x = db.prepare('INSERT INTO sequences(name,steps,created_at) VALUES(?,?,?)').run(String(req.body.name), JSON.stringify(clean(req.body.steps)), now());
    res.json({ id: x.lastInsertRowid });
  });
  r.put('/api/sequences/:id', adminOnly, (req, res) => {
    db.prepare('UPDATE sequences SET name=?, steps=?, active=? WHERE id=?').run(String(req.body.name || 'Sequence'), JSON.stringify(clean(req.body.steps)), req.body.active === false ? 0 : 1, Number(req.params.id));
    res.json({ ok: true });
  });
  r.delete('/api/sequences/:id', adminOnly, (req, res) => {
    db.prepare("UPDATE sequences SET active=0 WHERE id=?").run(Number(req.params.id));
    db.prepare("UPDATE enrollments SET status='stopped', stop_reason='Sequence turned off' WHERE sequence_id=? AND status='active'").run(Number(req.params.id));
    res.json({ ok: true });
  });
  r.post('/api/sequences/:id/enroll', (req, res) => {
    const ids = (req.body.lead_ids || []).map(Number).filter(Boolean);
    let n = 0; db.transaction(() => { for (const id of ids) if (enroll(id, Number(req.params.id), req.user.id)) n++; })();
    res.json({ enrolled: n });
  });
  r.get('/api/leads/:id/enrollments', (req, res) => {
    res.json(db.prepare('SELECT e.*, s.name seq_name, s.steps FROM enrollments e JOIN sequences s ON s.id=e.sequence_id WHERE lead_id=? ORDER BY started_at DESC LIMIT 10').all(Number(req.params.id))
      .map(e => ({ ...e, steps: safeJSON(e.steps, []) })));
  });
  r.post('/api/enrollments/:id/stop', (req, res) => { db.prepare("UPDATE enrollments SET status='stopped', stop_reason=? WHERE id=?").run('Stopped by ' + req.user.name, Number(req.params.id)); res.json({ ok: true }); });

  return { router: r, enroll, stopFor, tick };
};
