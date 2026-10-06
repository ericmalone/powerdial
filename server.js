// PowerDial CRM — Twilio power/parallel dialer + CRM
require('dotenv').config();
const express = require('express');
const http = require('http');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const twilio = require('twilio');
const { db, getSetting, setSetting, mediaDir, audit } = require('./db');
const { processCall, OBJECTION_CATEGORIES, claude } = require('./ai');
const live = require('./live');
const tz = require('./tz');
const mail = require('./mail');

const env = process.env;
const PORT = env.PORT || 3000;
const PUBLIC_URL = (env.PUBLIC_URL || '').replace(/\/$/, '');
const CALLER_ID = env.CALLER_ID;
const SMS_FROM = env.SMS_FROM || CALLER_ID;
const ABANDON_MESSAGE = env.ABANDON_MESSAGE ?? 'Sorry we missed you. We will call you back shortly. Goodbye.';
const RECORD_CALLS = env.RECORD_CALLS !== 'false';
const RECORDING_NOTICE = env.RECORDING_NOTICE ?? 'This call may be recorded.';
const INBOUND_GREETING = env.INBOUND_GREETING || `Thanks for calling ${live.COMPANY}. Everyone is on another call. Please leave your name and a good time to reach you after the tone.`;
const SESSION_DAYS = 14;

const required = ['TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY', 'TWILIO_API_SECRET', 'TWILIO_TWIML_APP_SID', 'CALLER_ID', 'PUBLIC_URL'];
const missing = required.filter(k => !env[k]);
if (missing.length) { console.error('Missing settings in .env: ' + missing.join(', ')); process.exit(1); }

const client = twilio(env.TWILIO_API_KEY, env.TWILIO_API_SECRET, { accountSid: env.TWILIO_ACCOUNT_SID });
const { VoiceResponse, MessagingResponse } = twilio.twiml;
const FINAL = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled']);
const OUTCOME = { busy: 'Busy', 'no-answer': 'No Answer', failed: 'Failed', canceled: 'Not reached', completed: 'Hung up' };
const DISPOS = {
  'Interested': 'done', 'App Sent': 'done', 'Callback': 'callback', 'Not Interested': 'done',
  'Voicemail': 'new', 'Gatekeeper': 'new', 'Wrong Number': 'done', 'DNC': 'dnc',
};
const now = () => Date.now();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const startOfDay = () => new Date().setHours(0, 0, 0, 0);

// ---------- passwords + first admin ----------
function hashPass(p) { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(p, salt, 64).toString('hex'); }
function checkPass(p, stored) {
  const [salt, h] = String(stored).split(':'); if (!salt || !h) return false;
  const x = crypto.scryptSync(p, salt, 64), y = Buffer.from(h, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
if (!db.prepare('SELECT COUNT(*) n FROM users').get().n) {
  if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
    db.prepare('INSERT INTO users(name,email,pass,role,created_at) VALUES(?,?,?,?,?)').run(env.ADMIN_NAME || 'Admin', env.ADMIN_EMAIL, hashPass(env.ADMIN_PASSWORD), 'admin', now());
    console.log('Created admin login:', env.ADMIN_EMAIL);
  } else console.warn('No users yet — set ADMIN_EMAIL and ADMIN_PASSWORD in .env and restart.');
}

// ---------- helpers ----------
function normPhone(p) {
  const raw = String(p || '').trim(), d = raw.replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  if (raw.startsWith('+') && d.length >= 8 && d.length <= 15) return '+' + d;
  return null;
}
const safeJSON = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
function leadOut(l) { if (!l) return l; const { locked_by, locked_until, ...rest } = l; return { ...rest, extra: safeJSON(l.extra, {}) }; }
function callOut(c) { if (!c) return c; const { recording_url, live_transcript, ...rest } = c; return { ...rest, has_recording: !!recording_url, ai: safeJSON(c.ai, null), transcript: c.transcript || live_transcript || null }; }
function update(table, id, fields) {
  const keys = Object.keys(fields); if (!keys.length) return;
  db.prepare(`UPDATE ${table} SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`).run(...keys.map(k => fields[k]), id);
}
const getLead = id => db.prepare('SELECT * FROM leads WHERE id=?').get(id);
const isDnc = phone => !!db.prepare('SELECT 1 FROM dnc WHERE phone=?').get(phone);
function addDnc(phone, reason) {
  db.prepare('INSERT OR IGNORE INTO dnc(phone,reason,created_at) VALUES(?,?,?)').run(phone, reason || '', now());
  db.prepare("UPDATE leads SET status='dnc', updated_at=? WHERE phone=?").run(now(), phone);
}
function fillTpl(txt, lead, repName) {
  const first = (lead.name || '').trim().split(/\s+/)[0] || 'there';
  return String(txt || '').replace(/\{first\}/g, first).replace(/\{name\}/g, lead.name || '').replace(/\{business\}/g, lead.business || 'your business')
    .replace(/\{state\}/g, lead.state || '').replace(/\{rep\}/g, (repName || '').split(' ')[0]).replace(/\{company\}/g, live.COMPANY);
}

let seqs, dealsMod; // set up after the app is created

// ---------- live events (Server-Sent Events) ----------
const sseClients = new Map(); // res -> userId
function emitTo(userId, type, data = {}) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [res, uid] of sseClients) if (userId == null || uid === userId) res.write(msg);
}
const emitAll = (type, data) => emitTo(null, type, data);

// ---------- per-rep dialer state ----------
const agents = new Map();   // userId -> { room, agentCallSid, inRoom, batch, phase, phaseSince }
const batches = new Map();  // batchId -> batch
const agent = uid => { if (!agents.has(uid)) agents.set(uid, { room: null, agentCallSid: null, inRoom: false, batch: null, phase: 'idle', phaseSince: now() }); return agents.get(uid); };

function hangupCall(sid) {
  return client.calls(sid).update({ status: 'canceled' }).catch(() => client.calls(sid).update({ status: 'completed' })).catch(() => {});
}
function cancelOthers(b, keepCallId) { for (const [cid, c] of b.calls) if (cid !== keepCallId && c.sid && !c.final && !c.vm) hangupCall(c.sid); }
function cancelBatch(b) {
  for (const c of b.calls.values()) if (c.sid && !c.final && !c.vm) hangupCall(c.sid);
  setTimeout(() => finishBatch(b, true), 8000);
}
function checkBatchDone(b) { if ([...b.calls.values()].every(c => c.final)) finishBatch(b, false); }
function finishBatch(b, forced) {
  if (!batches.has(b.id)) return;
  clearTimeout(b.watchdog);
  batches.delete(b.id);
  const a = agent(b.userId); if (a.batch === b) a.batch = null;
  const ids = [...b.calls.values()].map(c => c.leadId);
  if (ids.length) db.prepare(`UPDATE leads SET locked_by=NULL, locked_until=NULL WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  if (forced) for (const [cid, c] of b.calls) if (!c.final) update('calls', cid, { status: 'canceled', outcome: 'Timed out', ended_at: now() });
  emitTo(b.userId, 'batch_done', { batchId: b.id, connected: !!b.winner, forced });
}
function detach(b) { const c = b.calls.get(b.winner); if (c) c.final = true; b.detached = true; finishBatch(b, false); }
function winnerEnded(b, callId) {
  const c = b.calls.get(callId); if (!c || c.final) return;
  c.final = true;
  const row = db.prepare('SELECT answered_at, started_at FROM calls WHERE id=?').get(callId);
  const duration = Math.round((now() - (row.answered_at || row.started_at)) / 1000);
  update('calls', callId, { status: 'completed', ended_at: now(), duration });
  if (b.closer && !b.transferred) hangupCall(b.closer.sid);
  emitTo(b.userId, 'call_ended', { callId, leadId: c.leadId, duration });
  checkBatchDone(b);
}
function agentLeft(uid) {
  const a = agent(uid); if (!a.inRoom) return;
  a.inRoom = false; a.phase = 'idle'; a.phaseSince = now();
  log('Agent left', uid);
  emitTo(uid, 'agent', { inRoom: false });
  if (a.batch) { if (a.batch.winner) { const c = a.batch.calls.get(a.batch.winner); if (c && c.sid && !c.final) hangupCall(c.sid); } cancelBatch(a.batch); }
}
function startRecording(callSid, callId) {
  if (!RECORD_CALLS) return;
  setTimeout(() => client.calls(callSid).recordings.create({
    recordingChannels: 'dual', recordingStatusCallback: `${PUBLIC_URL}/twilio/recording?call=${callId}`, recordingStatusCallbackEvent: ['completed'],
  }).catch(e => log('Recording failed to start:', e.message)), 1200);
}
function addStream(vr, callId) {
  if (!live.enabled()) return;
  const s = vr.start().stream({ url: PUBLIC_URL.replace(/^http/, 'ws') + '/twilio/stream', track: 'both_tracks' });
  s.parameter({ name: 'callId', value: String(callId) });
  s.parameter({ name: 'key', value: live.streamKey(callId) });
}
const vmUrl = id => { const v = id && db.prepare('SELECT token FROM voicemails WHERE id=?').get(id); return v ? `${PUBLIC_URL}/media/vm/${v.token}` : null; };

// caller ID: single number, local presence (match area code) or rotation, with optional daily cap
function callerIdPicker() {
  const mode = getSetting('callerid_mode', 'single');
  const pool = db.prepare('SELECT phone FROM numbers WHERE active=1').all().map(r => r.phone);
  if (mode === 'single' || !pool.length) return () => CALLER_ID;
  const cap = Number(getSetting('number_daily_cap', 0)) || 0;
  const counts = Object.fromEntries(db.prepare('SELECT from_number, COUNT(*) n FROM calls WHERE started_at>=? GROUP BY from_number').all(startOfDay()).map(r => [r.from_number, r.n]));
  return leadPhone => {
    let c = pool.filter(p => !cap || (counts[p] || 0) < cap); if (!c.length) c = pool;
    if (mode === 'local' && leadPhone.startsWith('+1')) { const local = c.filter(p => p.slice(0, 5) === leadPhone.slice(0, 5)); if (local.length) c = local; }
    const pick = c.sort((a, b) => (counts[a] || 0) - (counts[b] || 0))[0];
    counts[pick] = (counts[pick] || 0) + 1;
    return pick;
  };
}

// ---------- SMS ----------
async function sendSms(lead, body, user, enrollmentId) {
  const t = now();
  let from = SMS_FROM;
  const last = db.prepare("SELECT from_number FROM calls WHERE lead_id=? AND direction='out' ORDER BY started_at DESC LIMIT 1").get(lead.id);
  if (last && db.prepare('SELECT 1 FROM numbers WHERE phone=? AND active=1').get(last.from_number)) from = last.from_number;
  const r = db.prepare('INSERT INTO messages(lead_id,user_id,direction,body,from_number,to_number,status,enrollment_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(lead.id, user ? user.id : null, 'out', body, from, lead.phone, 'sending', enrollmentId || null, t);
  const id = r.lastInsertRowid;
  db.prepare('UPDATE leads SET last_sms_at=?, unread_sms=0, updated_at=? WHERE id=?').run(t, t, lead.id);
  try {
    const params = { to: lead.phone, body, statusCallback: `${PUBLIC_URL}/twilio/sms-status?msg=${id}` };
    if (env.MESSAGING_SERVICE_SID) params.messagingServiceSid = env.MESSAGING_SERVICE_SID; else params.from = from;
    const m = await client.messages.create(params);
    update('messages', id, { sid: m.sid, status: m.status });
  } catch (e) { update('messages', id, { status: 'failed', error: (e.code ? '#' + e.code + ' ' : '') + e.message }); }
  const msg = { ...db.prepare('SELECT * FROM messages WHERE id=?').get(id), user_name: user ? user.name : 'Auto' + (enrollmentId ? ' (sequence)' : '') };
  emitAll('sms', { message: msg, lead: leadOut(getLead(lead.id)) });
  return msg;
}
async function sendLeadEmail(lead, user, { subject, text, dealId, enrollmentId }) {
  if (!lead.email) throw new Error('This lead has no email address');
  const t = now();
  const r = db.prepare("INSERT INTO emails(lead_id,deal_id,user_id,enrollment_id,direction,subject,body,from_addr,to_addr,status,created_at) VALUES(?,?,?,?,'out',?,?,?,?,?,?)")
    .run(lead.id, dealId || null, user ? user.id : null, enrollmentId || null, subject, text, mail.fromAddr() || '', lead.email, 'sending', t);
  const id = r.lastInsertRowid;
  try {
    const last = db.prepare("SELECT message_id FROM emails WHERE lead_id=? AND direction='in' ORDER BY created_at DESC LIMIT 1").get(lead.id);
    const sent = await mail.send({ to: lead.email, subject, text, fromName: user ? `${user.name} | ${live.COMPANY}` : live.COMPANY, inReplyTo: last && last.message_id });
    update('emails', id, { status: 'sent', message_id: sent.messageId });
  } catch (e) { update('emails', id, { status: 'failed', error: e.message }); throw e; }
  finally {
    db.prepare('UPDATE leads SET email_last_at=?, updated_at=? WHERE id=?').run(t, t, lead.id);
    emitAll('email', { email: { ...db.prepare('SELECT * FROM emails WHERE id=?').get(id), user_name: user ? user.name : 'Auto' }, leadId: lead.id });
  }
  return db.prepare('SELECT * FROM emails WHERE id=?').get(id);
}
function afterVmDrop(leadId, userId) {
  const autoSeq = getSetting('auto_sequences', {})['Voicemail dropped'];
  if (autoSeq && seqs && !db.prepare("SELECT 1 FROM enrollments WHERE lead_id=? AND status='active'").get(leadId)) seqs.enroll(leadId, Number(autoSeq), userId);
  const tpl = getSetting('vm_text_template', '');
  if (!tpl.trim()) return;
  const lead = getLead(leadId); if (!lead || lead.status === 'dnc' || isDnc(lead.phone)) return;
  if (db.prepare("SELECT 1 FROM messages WHERE lead_id=? AND direction='out' AND created_at>?").get(leadId, now() - 864e5)) return;
  const u = db.prepare('SELECT id,name FROM users WHERE id=?').get(userId);
  setTimeout(() => sendSms(lead, fillTpl(tpl, lead, u && u.name), u).catch(() => {}), 15000);
}

// ---------- app ----------
const app = express();
app.set('trust proxy', true);
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '25mb' }));
app.use(cookieParser());

function twilioOnly(req, res, next) {
  if (!env.TWILIO_AUTH_TOKEN) return next();
  const ok = twilio.validateRequest(env.TWILIO_AUTH_TOKEN, req.get('X-Twilio-Signature') || '', PUBLIC_URL + req.originalUrl, req.body || {});
  if (ok) return next();
  log('Rejected webhook with bad signature:', req.originalUrl);
  res.status(403).send('Invalid signature');
}
const twiml = (res, vr) => res.type('text/xml').send(vr.toString());

// public voicemail audio (Twilio fetches this to play voicemail drops)
app.get('/media/vm/:token', (req, res) => {
  const v = db.prepare('SELECT file FROM voicemails WHERE token=?').get(String(req.params.token));
  if (!v) return res.status(404).end();
  res.sendFile(path.join(mediaDir, v.file));
});

// ---------- Twilio: browser headset (TwiML App Voice URL) ----------
app.post('/twilio/voice', twilioOnly, (req, res) => {
  const vr = new VoiceResponse();
  const m = /^client:u(\d+)$/.exec(req.body.From || '');
  if (!m) { vr.say('This number is not set up to take calls.'); return twiml(res, vr); }
  const uid = Number(m[1]);
  const user = db.prepare('SELECT id,name,role,active FROM users WHERE id=?').get(uid);
  if (!user || !user.active) { vr.hangup(); return twiml(res, vr); }

  if (req.body.mode === 'join') {
    const a = agent(uid);
    a.room = 'pd-' + uid + '-' + crypto.randomBytes(5).toString('hex');
    a.agentCallSid = req.body.CallSid; a.inRoom = true; a.phase = 'ready'; a.phaseSince = now();
    vr.dial().conference({ startConferenceOnEnter: true, endConferenceOnExit: true, beep: false, waitUrl: '',
      statusCallback: `${PUBLIC_URL}/twilio/conference?user=${uid}`, statusCallbackEvent: ['leave'] }, a.room);
    log('Agent joined', uid);
    emitTo(uid, 'agent', { inRoom: true });
    return twiml(res, vr);
  }
  if (req.body.mode === 'record_vm') {
    vr.say('Record your voicemail after the beep. Press pound when you are done.');
    vr.record({ maxLength: 90, finishOnKey: '#', playBeep: true, trim: 'trim-silence', action: `${PUBLIC_URL}/twilio/vm-done`,
      recordingStatusCallback: `${PUBLIC_URL}/twilio/vm-recorded?user=${uid}&name=${encodeURIComponent(String(req.body.name || 'My voicemail').slice(0, 60))}`,
      recordingStatusCallbackEvent: ['completed'] });
    return twiml(res, vr);
  }
  if (req.body.mode === 'monitor') {
    if (user.role !== 'admin') { vr.say('Only admins can listen to calls.'); return twiml(res, vr); }
    const a = agents.get(Number(req.body.target));
    if (!a || !a.inRoom) { vr.say('That rep is not in a session right now.'); return twiml(res, vr); }
    const how = req.body.how;
    const opts = { startConferenceOnEnter: false, endConferenceOnExit: false, beep: false };
    if (how === 'listen') opts.muted = true;
    if (how === 'whisper') opts.coach = a.agentCallSid;
    vr.dial().conference(opts, a.room);
    log(`Admin ${uid} ${how} on rep ${req.body.target}`);
    return twiml(res, vr);
  }
  vr.say('Unsupported request.'); twiml(res, vr);
});
app.post('/twilio/vm-done', twilioOnly, (req, res) => { const vr = new VoiceResponse(); vr.say('Got it. Your voicemail will appear in your settings in a few seconds. Goodbye.'); vr.hangup(); twiml(res, vr); });
app.post('/twilio/vm-recorded', twilioOnly, async (req, res) => {
  res.sendStatus(204);
  if (req.body.RecordingStatus !== 'completed') return;
  const uid = Number(req.query.user);
  try {
    const auth = Buffer.from(`${env.TWILIO_API_KEY}:${env.TWILIO_API_SECRET}`).toString('base64');
    const r = await fetch(req.body.RecordingUrl + '.mp3', { headers: { Authorization: 'Basic ' + auth } });
    if (!r.ok) throw new Error('download ' + r.status);
    const token = crypto.randomBytes(16).toString('hex'), file = `vm-${token}.mp3`;
    fs.writeFileSync(path.join(mediaDir, file), Buffer.from(await r.arrayBuffer()));
    const ins = db.prepare('INSERT INTO voicemails(name,file,token,user_id,created_at) VALUES(?,?,?,?,?)').run(req.query.name || 'My voicemail', file, token, uid, now());
    const u = db.prepare('SELECT voicemail_id FROM users WHERE id=?').get(uid);
    if (u && !u.voicemail_id) update('users', uid, { voicemail_id: ins.lastInsertRowid });
    client.recordings(req.body.RecordingSid).remove().catch(() => {});
    emitTo(uid, 'vm_saved', { id: ins.lastInsertRowid });
  } catch (e) { log('Voicemail save failed:', e.message); emitTo(uid, 'vm_saved', { error: e.message }); }
});

// ---------- Twilio: outbound lead answered ----------
app.post('/twilio/answer', twilioOnly, (req, res) => {
  const vr = new VoiceResponse();
  const b = batches.get(req.query.batch), callId = Number(req.query.call);
  const answeredBy = req.body.AnsweredBy || 'unknown', callSid = req.body.CallSid;
  if (!b || !b.calls.has(callId)) { vr.hangup(); return twiml(res, vr); }
  const c = b.calls.get(callId), a = agent(b.userId);
  update('calls', callId, { answered_by: answeredBy, answered_at: now() });

  if (/^(machine|fax)/.test(answeredBy)) {
    if (b.vmUrl && /^machine_end/.test(answeredBy)) {
      vr.play(b.vmUrl); vr.hangup();
      update('calls', callId, { outcome: 'Voicemail dropped', vm_dropped: 1, disposition: 'Voicemail' });
      db.prepare("UPDATE leads SET last_outcome='Voicemail dropped', updated_at=? WHERE id=?").run(now(), c.leadId);
      c.vm = true; c.final = true;
      emitTo(b.userId, 'line', { batchId: b.id, callId, leadId: c.leadId, status: 'vm_drop', outcome: 'Voicemail dropped' });
      afterVmDrop(c.leadId, b.userId);
      twiml(res, vr);
      return setImmediate(() => checkBatchDone(b));
    }
    update('calls', callId, { outcome: 'Machine' });
    emitTo(b.userId, 'line', { batchId: b.id, callId, leadId: c.leadId, status: 'machine' });
    vr.hangup(); return twiml(res, vr);
  }
  if (b.winner || !a.inRoom) {
    update('calls', callId, { outcome: 'Abandoned' });
    emitTo(b.userId, 'line', { batchId: b.id, callId, leadId: c.leadId, status: 'abandoned' });
    if (ABANDON_MESSAGE) vr.say(ABANDON_MESSAGE);
    vr.hangup(); return twiml(res, vr);
  }
  b.winner = callId;
  update('calls', callId, { connected: 1, outcome: 'Connected' });
  log('CONNECTED rep', b.userId, 'lead', c.leadId);
  emitTo(b.userId, 'connected', { batchId: b.id, callId, leadId: c.leadId });
  cancelOthers(b, callId);
  addStream(vr, callId);
  if (RECORD_CALLS && RECORDING_NOTICE) vr.say(RECORDING_NOTICE);
  vr.dial().conference({ startConferenceOnEnter: true, endConferenceOnExit: false, beep: false }, a.room);
  twiml(res, vr);
  startRecording(callSid, callId);
});

// ---------- Twilio: inbound calls to your numbers (set as each number's Voice webhook) ----------
app.post('/twilio/inbound', twilioOnly, (req, res) => {
  const vr = new VoiceResponse();
  const from = normPhone(req.body.From) || req.body.From, t = now();
  let lead = db.prepare('SELECT * FROM leads WHERE phone=?').get(from);
  if (!lead) { const r = db.prepare('INSERT INTO leads(phone,source,created_at,updated_at) VALUES(?,?,?,?)').run(from, 'Inbound call', t, t); lead = getLead(r.lastInsertRowid); }
  const idle = uid => { const a = agents.get(uid); return a && a.inRoom && !a.batch && a.phase === 'ready'; };
  const uid = lead.owner_id && idle(lead.owner_id) ? lead.owner_id : [...agents.keys()].find(idle);
  const r = db.prepare("INSERT INTO calls(lead_id,user_id,direction,call_sid,from_number,to_number,status,outcome,started_at) VALUES(?,?,'in',?,?,?,?,?,?)")
    .run(lead.id, uid || null, req.body.CallSid, from, req.body.To, 'in-progress', 'Inbound', t);
  const callId = Number(r.lastInsertRowid);
  db.prepare('UPDATE leads SET updated_at=? WHERE id=?').run(t, lead.id);

  if (!uid) {
    if (env.INBOUND_FORWARD_TO) {
      update('calls', callId, { outcome: 'Forwarded' });
      vr.dial({ callerId: req.body.To }, env.INBOUND_FORWARD_TO);
    } else {
      update('calls', callId, { outcome: 'Missed — voicemail' });
      vr.say(INBOUND_GREETING);
      vr.record({ maxLength: 120, playBeep: true, recordingStatusCallback: `${PUBLIC_URL}/twilio/recording?call=${callId}&vm=1`, recordingStatusCallbackEvent: ['completed'] });
    }
    db.prepare("UPDATE leads SET last_outcome='Missed inbound call' WHERE id=?").run(lead.id);
    emitAll('missed_call', { callId, lead: leadOut(getLead(lead.id)) });
    return twiml(res, vr);
  }
  const a = agent(uid);
  const b = { id: crypto.randomBytes(6).toString('hex'), userId: uid, calls: new Map([[callId, { sid: req.body.CallSid, leadId: lead.id, final: false }]]), winner: callId, inbound: true };
  a.batch = b; batches.set(b.id, b);
  update('calls', callId, { connected: 1, answered_at: t });
  emitTo(uid, 'connected', { batchId: b.id, callId, leadId: lead.id, inbound: true, lead: leadOut(getLead(lead.id)) });
  addStream(vr, callId);
  if (RECORD_CALLS && RECORDING_NOTICE) vr.say(RECORDING_NOTICE);
  vr.dial().conference({ startConferenceOnEnter: true, endConferenceOnExit: false, beep: false,
    statusCallback: `${PUBLIC_URL}/twilio/conference?user=${uid}&call=${callId}`, statusCallbackEvent: ['leave'] }, a.room);
  twiml(res, vr);
  startRecording(req.body.CallSid, callId);
});

// ---------- Twilio: call status / conference / recordings ----------
app.post('/twilio/status', twilioOnly, (req, res) => {
  res.sendStatus(204);
  const callId = Number(req.query.call);
  const { CallStatus, ErrorCode, ErrorMessage } = req.body;
  const row = db.prepare('SELECT * FROM calls WHERE id=?').get(callId);
  if (!row) return;
  const b = batches.get(req.query.batch);
  const fields = { status: CallStatus };
  if (FINAL.has(CallStatus)) {
    fields.ended_at = row.ended_at || now();
    if (row.connected) fields.duration = Math.round((now() - (row.answered_at || row.started_at)) / 1000);
    else if (!row.outcome || row.outcome === 'Dialing') fields.outcome = OUTCOME[CallStatus] || CallStatus;
    if (ErrorCode) fields.error = `#${ErrorCode} ${ErrorMessage || ''}`.trim();
  }
  update('calls', callId, fields);
  const outcome = fields.outcome || row.outcome;
  if (FINAL.has(CallStatus) && !row.connected && !row.vm_dropped) db.prepare('UPDATE leads SET last_outcome=?, updated_at=? WHERE id=?').run(outcome, now(), row.lead_id);
  if (!b || !b.calls.has(callId)) return;
  emitTo(row.user_id, 'line', { batchId: req.query.batch, callId, leadId: row.lead_id, status: CallStatus, outcome, error: fields.error });
  const c = b.calls.get(callId);
  if (FINAL.has(CallStatus)) {
    if (b.winner === callId) winnerEnded(b, callId);
    else { c.final = true; checkBatchDone(b); }
  }
});
app.post('/twilio/conference', twilioOnly, (req, res) => {
  res.sendStatus(204);
  if (req.body.StatusCallbackEvent !== 'participant-leave') return;
  const uid = Number(req.query.user), a = agent(uid);
  if (req.query.call) {
    const callId = Number(req.query.call), b = a.batch;
    if (b && b.winner === callId && b.calls.get(callId)?.sid === req.body.CallSid && !b.detached) winnerEnded(b, callId);
  } else if (req.body.CallSid === a.agentCallSid) agentLeft(uid);
});
app.post('/twilio/recording', twilioOnly, (req, res) => {
  res.sendStatus(204);
  const callId = Number(req.query.call);
  if (req.body.RecordingStatus !== 'completed') return;
  update('calls', callId, { recording_sid: req.body.RecordingSid, recording_url: req.body.RecordingUrl, recording_duration: Number(req.body.RecordingDuration || 0) });
  if (req.query.vm) { const c = db.prepare('SELECT lead_id FROM calls WHERE id=?').get(callId); emitAll('missed_call', { callId, voicemail: true, lead: c && leadOut(getLead(c.lead_id)) }); return; }
  setTimeout(() => processCall(callId, notifyAI), 4000);
});
function notifyAI(call) {
  const c = db.prepare('SELECT id, lead_id, ai_status FROM calls WHERE id=?').get(call.id);
  if (c) emitAll('call_ai', { callId: c.id, leadId: c.lead_id, status: c.ai_status });
}
app.post('/twilio/xfer-status', twilioOnly, (req, res) => {
  res.sendStatus(204);
  emitTo(Number(req.query.user), 'xfer', { status: req.body.CallStatus });
});

// ---------- Twilio: SMS ----------
app.post('/twilio/sms', twilioOnly, (req, res) => {
  const from = normPhone(req.body.From) || req.body.From, body = req.body.Body || '', t = now();
  const media = []; for (let i = 0; i < Number(req.body.NumMedia || 0); i++) media.push(req.body['MediaUrl' + i]);
  let lead = db.prepare('SELECT * FROM leads WHERE phone=?').get(from);
  if (!lead) { const r = db.prepare('INSERT INTO leads(phone,source,created_at,updated_at) VALUES(?,?,?,?)').run(from, 'Inbound SMS', t, t); lead = getLead(r.lastInsertRowid); }
  const r = db.prepare('INSERT INTO messages(lead_id,direction,body,media,from_number,to_number,sid,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(lead.id, 'in', body, JSON.stringify(media), from, req.body.To, req.body.MessageSid, 'received', t);
  db.prepare('UPDATE leads SET unread_sms=unread_sms+1, last_sms_at=?, updated_at=? WHERE id=?').run(t, t, lead.id);
  if (/^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*$/i.test(body)) { addDnc(from, 'Texted STOP'); db.prepare("UPDATE leads SET disposition='DNC' WHERE id=?").run(lead.id); }
  seqs.stopFor(lead.id, 'Replied by text');
  emitAll('sms', { message: db.prepare('SELECT * FROM messages WHERE id=?').get(r.lastInsertRowid), lead: leadOut(getLead(lead.id)) });
  twiml(res, new MessagingResponse());
});
app.post('/twilio/sms-status', twilioOnly, (req, res) => {
  res.sendStatus(204);
  const id = Number(req.query.msg);
  update('messages', id, { status: req.body.MessageStatus || '', ...(req.body.ErrorCode ? { error: '#' + req.body.ErrorCode } : {}) });
  const m = db.prepare('SELECT * FROM messages WHERE id=?').get(id);
  if (m) emitAll('sms_status', { message: m });
});

// ---------- auth ----------
function currentUser(req) {
  const tok = req.cookies.pd_sess; if (!tok) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token=? AND expires>?').get(crypto.createHash('sha256').update(tok).digest('hex'), now());
  if (!s) return null;
  const u = db.prepare('SELECT id,name,email,role,active,phone,voicemail_id FROM users WHERE id=?').get(s.user_id);
  return u && u.active ? u : null;
}
app.post('/api/login', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(req.body.email || '').trim());
  if (!u || !u.active || !checkPass(String(req.body.password || ''), u.pass)) { audit({ ip: req.ip, user: { id: u ? u.id : null, name: u ? u.name : String(req.body.email || '').slice(0, 80) } }, 'login.failed', 'user', u ? u.id : '', ''); return setTimeout(() => res.status(401).json({ error: 'Wrong email or password' }), 600); }
  audit({ ip: req.ip, user: { id: u.id, name: u.name } }, 'login', 'user', u.id, '');
  const tok = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)').run(crypto.createHash('sha256').update(tok).digest('hex'), u.id, now() + SESSION_DAYS * 864e5);
  res.cookie('pd_sess', tok, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_DAYS * 864e5 });
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  const tok = req.cookies.pd_sess;
  if (tok) db.prepare('DELETE FROM sessions WHERE token=?').run(crypto.createHash('sha256').update(tok).digest('hex'));
  res.clearCookie('pd_sess'); res.json({ ok: true });
});

app.get('/vendor/twilio.min.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules/@twilio/voice-sdk/dist/twilio.min.js')));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res, next) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Please log in' });
  req.user = u;
  if (u.role === 'iso' && !/^\/(iso(\/|$)|me$|me\/password$|logout$)/.test(req.path)) return res.status(403).json({ error: 'Not available for partner accounts' });
  next();
});
const adminOnly = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' });

app.get('/api/me', (req, res) => res.json({
  user: req.user,
  config: { callerId: CALLER_ID, smsFrom: SMS_FROM, recording: RECORD_CALLS, ai: !!(env.DEEPGRAM_API_KEY && env.ANTHROPIC_API_KEY), live: live.enabled(), coaching: live.enabled() && !!env.ANTHROPIC_API_KEY && env.LIVE_COACHING !== 'false', company: live.COMPANY, email: mail.enabled(), imap: !!env.IMAP_HOST },
}));
app.patch('/api/me', (req, res) => {
  const f = {};
  if ('voicemail_id' in req.body) f.voicemail_id = req.body.voicemail_id ? Number(req.body.voicemail_id) : null;
  if ('phone' in req.body) f.phone = req.body.phone ? (normPhone(req.body.phone) || '') : '';
  update('users', req.user.id, f); res.json({ ok: true });
});
app.post('/api/me/password', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!checkPass(String(req.body.current || ''), u.pass)) return res.status(400).json({ error: 'Current password is wrong' });
  if (String(req.body.password || '').length < 8) return res.status(400).json({ error: 'New password must be 8+ characters' });
  update('users', u.id, { pass: hashPass(req.body.password) }); res.json({ ok: true });
});
app.post('/api/presence', (req, res) => {
  const a = agent(req.user.id), p = String(req.body.phase || '');
  if (['idle', 'ready', 'dialing', 'connected', 'wrap'].includes(p) && p !== a.phase) { a.phase = p; a.phaseSince = now(); }
  res.json({ ok: true });
});

// ---------- users ----------
app.get('/api/users', (req, res) => res.json(db.prepare('SELECT id,name,email,role,active,phone,commission_pct,split_pct,closer_split_pct FROM users ORDER BY name').all()));
app.post('/api/users', adminOnly, (req, res) => {
  const { name, email, password, role, phone } = req.body;
  if (!name || !email || !password || password.length < 8) return res.status(400).json({ error: 'Name, email and a password of 8+ characters are required' });
  try {
    db.prepare('INSERT INTO users(name,email,pass,role,phone,created_at) VALUES(?,?,?,?,?,?)').run(name.trim(), email.trim(), hashPass(password), ['admin', 'iso'].includes(role) ? role : 'rep', normPhone(phone) || '', now());
    audit(req, 'user.create', 'user', email, `role ${role || 'rep'}`); res.json({ ok: true });
  } catch { res.status(400).json({ error: 'That email is already in use' }); }
});
app.patch('/api/users/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id), f = {};
  if (req.body.name) f.name = req.body.name.trim();
  if (req.body.role) f.role = ['admin', 'iso'].includes(req.body.role) ? req.body.role : 'rep';
  if (req.body.active != null) f.active = req.body.active ? 1 : 0;
  if ('phone' in req.body) f.phone = normPhone(req.body.phone) || '';
  if ('commission_pct' in req.body) f.commission_pct = Math.max(0, Number(req.body.commission_pct) || 0);
  for (const k of ['split_pct', 'closer_split_pct']) if (k in req.body) f[k] = req.body[k] === '' || req.body[k] == null ? null : Math.max(0, Math.min(100, Number(req.body[k]) || 0));
  if (req.body.password) { if (req.body.password.length < 8) return res.status(400).json({ error: 'Password must be 8+ characters' }); f.pass = hashPass(req.body.password); }
  if (id === req.user.id && (f.active === 0 || (f.role && f.role !== 'admin'))) return res.status(400).json({ error: "You can't remove your own admin access" });
  update('users', id, f); audit(req, 'user.update', 'user', id, Object.keys(f).map(k => k === 'pass' ? 'password reset' : k).join(', '));
  if (f.active === 0 || f.pass) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  res.json({ ok: true });
});

// ---------- team settings ----------
const SETTING_KEYS = { callerid_mode: 'single', number_daily_cap: 0, playbook: live.DEFAULT_PLAYBOOK, vm_text_template: '', script: null,
  call_window_start: '08:00', call_window_end: '21:00', enforce_call_window: true, renewal_pct: 50, statements_required: 3, auto_sequences: {}, required_docs: { id: false, voided_check: false }, smart_queue: true, contract_template: '', offers_show_lender: false, goals: { dials: 0, connects: 0, apps: 0, funded: 0 }, chase: require('./docs').CHASE_DEFAULTS,
  email_templates: [{ name: 'Application follow-up', subject: 'Your funding application', body: 'Hi {first},\n\nJust checking in on the application for {business}. Once we have it with your last 4 months of bank statements, we can usually get you an offer the same day.\n\n{rep}\n{company}' }] };
app.get('/api/settings', (req, res) => res.json(Object.fromEntries(Object.entries(SETTING_KEYS).map(([k, d]) => [k, getSetting(k, d)]))));
app.put('/api/settings', adminOnly, (req, res) => {
  for (const k of Object.keys(SETTING_KEYS)) if (k in req.body) {
    let v = req.body[k];
    if (k === 'callerid_mode' && !['single', 'local', 'rotate'].includes(v)) continue;
    if (k === 'number_daily_cap') v = Math.max(0, Number(v) || 0);
    if (['renewal_pct', 'statements_required'].includes(k)) v = Math.max(0, Number(v) || 0);
    if (k === 'enforce_call_window' || k === 'smart_queue' || k === 'offers_show_lender') v = !!v;
    if (k === 'contract_template') v = String(v || '').slice(0, 60000);
    if (k === 'goals') { const g = v || {}; v = Object.fromEntries(['dials', 'connects', 'apps', 'funded'].map(x => [x, Math.max(0, Number(g[x]) || 0)])); }
    if (k === 'required_docs') v = { id: !!(v && v.id), voided_check: !!(v && v.voided_check) };
    if (k === 'chase') {
      const c = v || {}, D = require('./docs').CHASE_DEFAULTS;
      v = { enabled: c.enabled !== false, sms: c.sms !== false, email: c.email !== false,
        hours: (Array.isArray(c.hours) ? c.hours : D.hours).map(Number).filter(n => n > 0 && n < 24 * 60).sort((a, b) => a - b).slice(0, 10),
        sms_tpl: String(c.sms_tpl || D.sms_tpl), email_subject: String(c.email_subject || D.email_subject), email_body: String(c.email_body || D.email_body) };
    }
    setSetting(k, v); audit(req, 'settings.update', 'settings', k, '');
  }
  res.json({ ok: true });
});
app.get('/api/script', (req, res) => res.json({ script: getSetting('script', null) }));
app.put('/api/script', adminOnly, (req, res) => { setSetting('script', String(req.body.script || '')); res.json({ ok: true }); });
app.get('/api/templates', (req, res) => res.json(getSetting('sms_templates', [
  'Hi {first}, this is {rep} with {company}. Tried you just now — is there a better time to talk about working capital for {business}?',
  'Hi {first}, here is the short application we discussed. Send it back with your last 4 months of bank statements and we can have an offer out quickly.',
  'Hi {first}, following up on funding for {business}. Still interested?',
])));
app.put('/api/templates', adminOnly, (req, res) => { setSetting('sms_templates', (req.body.templates || []).map(String).filter(Boolean)); res.json({ ok: true }); });

// ---------- caller ID numbers ----------
app.get('/api/numbers', adminOnly, (req, res) => {
  const since = now() - 7 * 864e5, today = startOfDay();
  const rows = db.prepare(`SELECT n.*,
      (SELECT COUNT(*) FROM calls c WHERE c.from_number=n.phone AND c.started_at>=?) dials7,
      (SELECT COUNT(*) FROM calls c WHERE c.from_number=n.phone AND c.started_at>=? AND c.connected=1) connects7,
      (SELECT COUNT(*) FROM calls c WHERE c.from_number=n.phone AND c.started_at>=?) today
    FROM numbers n ORDER BY n.phone`).all(since, since, today);
  res.json(rows);
});
app.post('/api/numbers', adminOnly, (req, res) => {
  const p = normPhone(req.body.phone); if (!p) return res.status(400).json({ error: 'Invalid phone number' });
  db.prepare('INSERT OR IGNORE INTO numbers(phone,label,created_at) VALUES(?,?,?)').run(p, String(req.body.label || ''), now());
  res.json({ ok: true });
});
app.post('/api/numbers/sync', adminOnly, async (req, res) => {
  try {
    const list = await client.incomingPhoneNumbers.list({ limit: 500 });
    let added = 0;
    for (const n of list) added += db.prepare('INSERT OR IGNORE INTO numbers(phone,label,created_at) VALUES(?,?,?)').run(n.phoneNumber, n.friendlyName || '', now()).changes;
    res.json({ found: list.length, added });
  } catch (e) { res.status(400).json({ error: 'Twilio: ' + e.message }); }
});
app.patch('/api/numbers/:id', adminOnly, (req, res) => {
  const f = {}; if ('active' in req.body) f.active = req.body.active ? 1 : 0; if ('label' in req.body) f.label = String(req.body.label);
  update('numbers', Number(req.params.id), f); res.json({ ok: true });
});
app.delete('/api/numbers/:id', adminOnly, (req, res) => { db.prepare('DELETE FROM numbers WHERE id=?').run(Number(req.params.id)); res.json({ ok: true }); });

// ---------- voicemail drops ----------
app.get('/api/voicemails', (req, res) => {
  res.json(db.prepare('SELECT v.id, v.name, v.token, v.user_id, v.created_at, u.name owner FROM voicemails v LEFT JOIN users u ON u.id=v.user_id WHERE v.user_id IS NULL OR v.user_id=? ORDER BY v.created_at DESC').all(req.user.id)
    .map(v => ({ ...v, url: '/media/vm/' + v.token, shared: v.user_id == null })));
});
app.post('/api/voicemails', (req, res) => {
  const { name, data, mime, shared } = req.body;
  const ext = /mpeg|mp3/.test(mime || '') ? 'mp3' : /wav/.test(mime || '') ? 'wav' : null;
  if (!ext) return res.status(400).json({ error: 'Upload an MP3 or WAV file' });
  const buf = Buffer.from(String(data || ''), 'base64');
  if (!buf.length || buf.length > 8 * 1024 * 1024) return res.status(400).json({ error: 'File must be under 8 MB' });
  const token = crypto.randomBytes(16).toString('hex'), file = `vm-${token}.${ext}`;
  fs.writeFileSync(path.join(mediaDir, file), buf);
  const r = db.prepare('INSERT INTO voicemails(name,file,token,user_id,created_at) VALUES(?,?,?,?,?)')
    .run(String(name || 'Voicemail').slice(0, 60), file, token, shared && req.user.role === 'admin' ? null : req.user.id, now());
  if (!req.user.voicemail_id) update('users', req.user.id, { voicemail_id: r.lastInsertRowid });
  res.json({ id: r.lastInsertRowid });
});
app.delete('/api/voicemails/:id', (req, res) => {
  const v = db.prepare('SELECT * FROM voicemails WHERE id=?').get(Number(req.params.id));
  if (!v) return res.json({ ok: true });
  if (v.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Not yours' });
  db.prepare('DELETE FROM voicemails WHERE id=?').run(v.id);
  db.prepare('UPDATE users SET voicemail_id=NULL WHERE voicemail_id=?').run(v.id);
  fs.rm(path.join(mediaDir, v.file), () => {});
  res.json({ ok: true });
});

// ---------- DNC ----------
app.get('/api/dnc', (req, res) => {
  const q = String(req.query.q || '').replace(/\D/g, '');
  const rows = q ? db.prepare('SELECT * FROM dnc WHERE phone LIKE ? ORDER BY created_at DESC LIMIT 200').all('%' + q + '%') : db.prepare('SELECT * FROM dnc ORDER BY created_at DESC LIMIT 200').all();
  res.json({ total: db.prepare('SELECT COUNT(*) n FROM dnc').get().n, rows });
});
app.post('/api/dnc', (req, res) => {
  let added = 0;
  db.transaction(() => { for (const p of (req.body.numbers || []).map(normPhone).filter(Boolean)) { if (!isDnc(p)) added++; addDnc(p, req.body.reason || 'Added by ' + req.user.name); } })();
  audit(req, 'dnc.add', 'dnc', '', added + ' numbers'); res.json({ added });
});
app.delete('/api/dnc/:phone', adminOnly, (req, res) => { db.prepare('DELETE FROM dnc WHERE phone=?').run(normPhone(req.params.phone)); audit(req, 'dnc.remove', 'dnc', req.params.phone, ''); res.json({ ok: true }); });

// ---------- leads ----------
function leadFilters(q, uid) {
  const where = [], args = [], t = now();
  if (q.status === 'dialable') {
    const max = Number(q.maxAttempts || 6), cutoff = t - Number(q.retryMins ?? 60) * 60000;
    where.push(`(locked_until IS NULL OR locked_until<?) AND (owner_id IS NULL OR owner_id=?) AND ((status='callback' AND callback_at<=?) OR (status='new' AND attempts<? AND (last_called IS NULL OR last_called<=?)))`);
    args.push(t, uid, t, max, cutoff);
  } else if (q.status === 'callback_due') { where.push(`status='callback' AND callback_at<=?`); args.push(t); }
  else if (q.status === 'unread') where.push('unread_sms>0');
  else if (q.status) { where.push('status=?'); args.push(q.status); }
  if (q.owner === 'me') { where.push('owner_id=?'); args.push(uid); }
  else if (q.owner === 'none') where.push('owner_id IS NULL');
  else if (q.owner) { where.push('owner_id=?'); args.push(Number(q.owner)); }
  if (q.list) { where.push('source=?'); args.push(q.list); }
  if (q.q) {
    const s = '%' + q.q.trim() + '%', d = q.q.replace(/\D/g, '');
    where.push(`(name LIKE ? OR business LIKE ? OR email LIKE ? OR state LIKE ?${d.length >= 3 ? ' OR phone LIKE ?' : ''})`);
    args.push(s, s, s, s); if (d.length >= 3) args.push('%' + d + '%');
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}
const SORTS = { recent: 'l.updated_at DESC', created: 'l.created_at DESC', name: "COALESCE(NULLIF(l.name,''),l.business) COLLATE NOCASE", last_called: 'l.last_called DESC NULLS LAST', callback: 'l.callback_at ASC NULLS LAST', attempts: 'l.attempts DESC', sms: 'l.last_sms_at DESC NULLS LAST' };
const leadQuery = sql => `SELECT l.*, u.name owner_name FROM (SELECT * FROM leads ${sql}) l LEFT JOIN users u ON u.id=l.owner_id`;
app.get('/api/leads', (req, res) => {
  const { sql, args } = leadFilters(req.query, req.user.id);
  const limit = Math.min(500, Number(req.query.limit) || 100), page = Math.max(0, Number(req.query.page) || 0);
  const rows = db.prepare(`${leadQuery(sql)} ORDER BY ${SORTS[req.query.sort] || 'l.id DESC'} LIMIT ? OFFSET ?`).all(...args, limit, page * limit);
  const total = db.prepare(`SELECT COUNT(*) n FROM leads ${sql}`).get(...args).n;
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM leads GROUP BY status').all().map(r => [r.status, r.n]));
  const dial = leadFilters({ status: 'dialable', maxAttempts: req.query.maxAttempts, retryMins: req.query.retryMins, list: req.query.dialList }, req.user.id);
  counts.dialable = db.prepare(`SELECT COUNT(*) n FROM leads ${dial.sql}`).get(...dial.args).n;
  counts.unread = db.prepare('SELECT COUNT(*) n FROM leads WHERE unread_sms>0').get().n;
  res.json({ rows: rows.map(leadOut), total, counts });
});
app.get('/api/lists', (req, res) => {
  res.json(db.prepare(`SELECT source name, COUNT(*) total, SUM(status='new') fresh, SUM(status='callback') callbacks FROM leads WHERE source!='' GROUP BY source ORDER BY MAX(created_at) DESC`).all());
});
const LEAD_FIELDS = ['name', 'business', 'email', 'state'];
function insertLead(l, userId, t) {
  const phone = normPhone(l.phone); if (!phone) return 'bad';
  const dnc = isDnc(phone);
  try {
    const r = db.prepare('INSERT INTO leads(name,business,phone,email,state,extra,owner_id,source,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(String(l.name || '').trim(), String(l.business || '').trim(), phone, String(l.email || '').trim(), String(l.state || '').trim(),
        JSON.stringify(l.extra || {}), l.owner_id || null, l.source || 'Import', dnc ? 'dnc' : 'new', t, t);
    if (l.notes && String(l.notes).trim()) db.prepare('INSERT INTO notes(lead_id,user_id,body,created_at) VALUES(?,?,?,?)').run(r.lastInsertRowid, userId, String(l.notes).trim(), t);
    if (Array.isArray(l.alt_phones) && ctx.intake) for (const ap of l.alt_phones.slice(0, 6)) ctx.intake.addAlt(r.lastInsertRowid, ap);
    return dnc ? 'dnc' : r.lastInsertRowid;
  } catch { return 'dupe'; }
}
app.post('/api/leads', (req, res) => {
  const r = insertLead({ ...req.body, source: 'Manual' }, req.user.id, now());
  tz.backfill().catch(() => {});
  if (r === 'bad') return res.status(400).json({ error: 'Enter a valid phone number' });
  if (r === 'dupe' || r === 'dnc') return res.json({ id: db.prepare('SELECT id FROM leads WHERE phone=?').get(normPhone(req.body.phone)).id, existing: r === 'dupe', dnc: r === 'dnc' });
  res.json({ id: r });
});
app.post('/api/leads/check', (req, res) => {
  // preview before importing: how many numbers are bad, already in the CRM (and from which list), or on the DNC list
  const phones = (Array.isArray(req.body.phones) ? req.body.phones : []).map(normPhone);
  const good = [...new Set(phones.filter(Boolean))];
  const existing = {}; let dupes = 0, dnc = 0;
  for (let i = 0; i < good.length; i += 500) {
    const chunk = good.slice(i, i + 500), ph = chunk.map(() => '?').join(',');
    for (const r of db.prepare(`SELECT source, COUNT(*) n FROM leads WHERE phone IN (${ph}) GROUP BY source`).all(...chunk)) { existing[r.source || '(no list)'] = r.n; dupes += r.n; }
    dnc += db.prepare(`SELECT COUNT(*) n FROM dnc WHERE phone IN (${ph})`).get(...chunk).n;
  }
  res.json({ total: phones.length, bad: phones.filter(p => !p).length, repeats_in_file: phones.filter(Boolean).length - good.length, dupes, dnc, existing });
});
app.post('/api/leads/import', (req, res) => {
  const leads = Array.isArray(req.body.leads) ? req.body.leads : [];
  const owner = req.body.owner_id ? Number(req.body.owner_id) : null;
  let added = 0, dupes = 0, bad = 0, dnc = 0; const t = now(), dupeSources = {};
  const source = String(req.body.source || 'Import').trim() || 'Import';
  db.transaction(() => {
    for (const l of leads) {
      const r = insertLead({ ...l, owner_id: owner, source }, req.user.id, t);
      if (r === 'bad') bad++; else if (r === 'dupe') {
        dupes++;
        const ex = db.prepare('SELECT source FROM leads WHERE phone=?').get(normPhone(l.phone));
        const k = (ex && ex.source) || '(no list)'; dupeSources[k] = (dupeSources[k] || 0) + 1;
      } else if (r === 'dnc') { dnc++; added++; } else added++;
    }
    // what the list cost (optional): adds to any cost already recorded for this list name
    const cost = Number(req.body.cost);
    if (req.user.role === 'admin' && Number.isFinite(cost) && cost > 0 && req.body.cost_first !== false) {
      db.prepare('INSERT INTO lead_sources(name,total_cost,vendor,created_at) VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET total_cost=excluded.total_cost, vendor=CASE WHEN excluded.vendor!=\'\' THEN excluded.vendor ELSE lead_sources.vendor END')
        .run(source, cost, String(req.body.vendor || '').trim(), t);
    }
  })();
  const batch = String(req.body.batch || '').trim().slice(0, 200);
  if (batch) {
    db.prepare("UPDATE leads SET batch=? WHERE source=? AND created_at>=? AND COALESCE(batch,'')=''").run(batch, source, t);
    const cost = Number(req.body.cost), ex = db.prepare('SELECT id FROM batches WHERE name=?').get(batch);
    if (ex) db.prepare('UPDATE batches SET count=COALESCE(count,0)+? WHERE id=?').run(added, ex.id);
    else db.prepare('INSERT INTO batches(name,source,vendor,price,count,created_at) VALUES(?,?,?,?,?,?)').run(batch, source, String(req.body.vendor || '').trim(), req.user.role === 'admin' && Number.isFinite(cost) && cost > 0 ? cost : null, added, t);
  }
  tz.backfill().catch(() => {});
  if (ctx.intake) ctx.intake.rescoreSoon(3000);
  audit(req, 'lead.import', 'lead', source, `${added} added, ${dupes} duplicates, ${dnc} DNC`);
  res.json({ added, dupes, bad, dnc, dupe_sources: dupeSources });
});
app.post('/api/leads/bulk', (req, res) => {
  const ids = (req.body.ids || []).map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'No leads selected' });
  const ph = ids.map(() => '?').join(','), { action, value } = req.body;
  if (action === 'assign') db.prepare(`UPDATE leads SET owner_id=?, updated_at=? WHERE id IN (${ph})`).run(value ? Number(value) : null, now(), ...ids);
  else if (action === 'status' && value === 'dnc') db.transaction(() => { for (const l of db.prepare(`SELECT phone FROM leads WHERE id IN (${ph})`).all(...ids)) addDnc(l.phone, 'Bulk by ' + req.user.name); })();
  else if (action === 'status' && ['new', 'done'].includes(value)) db.prepare(`UPDATE leads SET status=?, updated_at=? WHERE id IN (${ph}) AND status!='dnc'`).run(value, now(), ...ids);
  else if (action === 'reset') db.prepare(`UPDATE leads SET attempts=0, last_called=NULL, status=CASE WHEN status='dnc' THEN 'dnc' ELSE 'new' END, updated_at=? WHERE id IN (${ph})`).run(now(), ...ids);
  else if (action === 'list') db.prepare(`UPDATE leads SET source=?, updated_at=? WHERE id IN (${ph})`).run(String(value || ''), now(), ...ids);
  else if (action === 'delete') {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
    db.prepare(`DELETE FROM leads WHERE id IN (${ph})`).run(...ids);
  } else return res.status(400).json({ error: 'Unknown action' });
  audit(req, 'lead.bulk.' + action, 'lead', '', ids.length + ' leads' + (action === 'assign' || action === 'list' || action === 'status' ? ' → ' + String(value || '') : ''));
  res.json({ ok: true, count: ids.length });
});
app.get('/api/leads/export.csv', (req, res) => {
  const { sql, args } = leadFilters(req.query, req.user.id);
  const rows = db.prepare(`${leadQuery(sql)} ORDER BY l.id`).all(...args);
  audit(req, 'lead.export', 'lead', '', rows.length + ' leads exported');
  const extras = [...new Set(rows.flatMap(r => Object.keys(safeJSON(r.extra, {}))))];
  const cell = v => { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const d = t => t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) : '';
  const lines = [['Name', 'Business', 'Phone', 'Email', 'State', 'Status', 'Disposition', 'Last outcome', 'Attempts', 'Last called', 'Callback', 'Owner', 'List', ...extras].map(cell).join(',')];
  for (const r of rows) { const x = safeJSON(r.extra, {}); lines.push([r.name, r.business, r.phone, r.email, r.state, r.status, r.disposition, r.last_outcome, r.attempts, d(r.last_called), d(r.callback_at), r.owner_name, r.source, ...extras.map(k => x[k])].map(cell).join(',')); }
  res.type('text/csv').set('Content-Disposition', `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`).send(lines.join('\n'));
});
app.get('/api/leads/:id', (req, res) => {
  const id = Number(req.params.id);
  const lead = db.prepare('SELECT l.*, u.name owner_name FROM leads l LEFT JOIN users u ON u.id=l.owner_id WHERE l.id=?').get(id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const calls = db.prepare('SELECT c.*, u.name user_name FROM calls c LEFT JOIN users u ON u.id=c.user_id WHERE lead_id=? ORDER BY started_at DESC').all(id).map(callOut);
  const messages = db.prepare('SELECT m.*, u.name user_name FROM messages m LEFT JOIN users u ON u.id=m.user_id WHERE lead_id=? ORDER BY created_at').all(id);
  const notes = db.prepare('SELECT n.*, u.name user_name FROM notes n LEFT JOIN users u ON u.id=n.user_id WHERE lead_id=? ORDER BY created_at DESC').all(id);
  const emails = db.prepare('SELECT e.*, u.name user_name FROM emails e LEFT JOIN users u ON u.id=e.user_id WHERE lead_id=? ORDER BY created_at').all(id);
  const deals = db.prepare('SELECT id, stage, title, amount_requested, funded_amount, updated_at FROM deals WHERE lead_id=? ORDER BY id DESC').all(id);
  const enrollment = db.prepare("SELECT e.*, s.name seq_name, s.steps FROM enrollments e JOIN sequences s ON s.id=e.sequence_id WHERE lead_id=? AND e.status='active'").get(id);
  res.json({ lead: { ...leadOut(lead), on_dnc: isDnc(lead.phone), local_time: tz.localTime(lead.tz), callable_now: tz.okNow(lead.tz) }, calls, messages, notes, emails, deals, phones: ctx.intake.phonesOf(id),
    enrollment: enrollment ? { ...enrollment, steps: safeJSON(enrollment.steps, []) } : null });
});
app.patch('/api/leads/:id', (req, res) => {
  const id = Number(req.params.id), b = req.body, f = {};
  for (const k of LEAD_FIELDS) if (b[k] != null) f[k] = String(b[k]).trim();
  if (b.phone != null) { const p = normPhone(b.phone); if (!p) return res.status(400).json({ error: 'Invalid phone' }); f.phone = p; }
  if (b.status && ['new', 'callback', 'done', 'dnc'].includes(b.status)) f.status = b.status;
  if ('owner_id' in b) f.owner_id = b.owner_id ? Number(b.owner_id) : null;
  if ('callback_at' in b) f.callback_at = b.callback_at ? Number(b.callback_at) : null;
  if ('source' in b) f.source = String(b.source || '');
  f.updated_at = now();
  try { update('leads', id, f); } catch { return res.status(400).json({ error: 'That phone number belongs to another lead' }); }
  const l = getLead(id);
  if (f.status === 'dnc') addDnc(l.phone, 'Set by ' + req.user.name);
  else if (f.status && isDnc(l.phone)) db.prepare('DELETE FROM dnc WHERE phone=?').run(l.phone);
  res.json({ lead: leadOut(getLead(id)) });
});
app.delete('/api/leads/:id', adminOnly, (req, res) => { db.prepare('DELETE FROM leads WHERE id=?').run(Number(req.params.id)); audit(req, 'lead.delete', 'lead', req.params.id, ''); res.json({ ok: true }); });
app.post('/api/leads/:id/notes', (req, res) => {
  const body = String(req.body.body || '').trim(); if (!body) return res.status(400).json({ error: 'Note is empty' });
  db.prepare('INSERT INTO notes(lead_id,user_id,body,created_at) VALUES(?,?,?,?)').run(Number(req.params.id), req.user.id, body, now());
  db.prepare('UPDATE leads SET updated_at=? WHERE id=?').run(now(), Number(req.params.id));
  res.json({ ok: true });
});
app.delete('/api/notes/:id', (req, res) => {
  const n = db.prepare('SELECT * FROM notes WHERE id=?').get(Number(req.params.id));
  if (n && (n.user_id === req.user.id || req.user.role === 'admin')) db.prepare('DELETE FROM notes WHERE id=?').run(n.id);
  res.json({ ok: true });
});
app.post('/api/leads/:id/read', (req, res) => { db.prepare('UPDATE leads SET unread_sms=0 WHERE id=?').run(Number(req.params.id)); emitAll('sms_read', { leadId: Number(req.params.id) }); res.json({ ok: true }); });

// ---------- SMS ----------
app.post('/api/leads/:id/sms', async (req, res) => {
  const lead = getLead(Number(req.params.id)), body = String(req.body.body || '').trim();
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  if (!body) return res.status(400).json({ error: 'Message is empty' });
  if (lead.status === 'dnc' || isDnc(lead.phone)) return res.status(400).json({ error: 'This lead is on the DNC list' });
  const msg = await sendSms(lead, body, req.user);
  if (msg.status === 'failed') return res.status(400).json({ error: 'SMS failed: ' + msg.error, message: msg });
  res.json({ message: msg });
});
app.post('/api/leads/:id/email', async (req, res) => {
  const lead = getLead(Number(req.params.id));
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  if (!String(req.body.subject || '').trim() || !String(req.body.body || '').trim()) return res.status(400).json({ error: 'Subject and message are required' });
  try { const e = await sendLeadEmail(lead, req.user, { subject: String(req.body.subject), text: String(req.body.body), dealId: req.body.deal_id || null }); res.json({ email: e }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/inbox', (req, res) => {
  res.json(db.prepare(`SELECT l.id, l.name, l.business, l.phone, l.status, l.unread_sms, l.last_sms_at, u.name owner_name,
      (SELECT body FROM messages m WHERE m.lead_id=l.id ORDER BY created_at DESC LIMIT 1) last_body,
      (SELECT direction FROM messages m WHERE m.lead_id=l.id ORDER BY created_at DESC LIMIT 1) last_dir
    FROM leads l LEFT JOIN users u ON u.id=l.owner_id WHERE l.last_sms_at IS NOT NULL ${req.query.unread ? 'AND l.unread_sms>0' : ''}
    ORDER BY l.last_sms_at DESC LIMIT 300`).all());
});

// ---------- calls ----------
app.get('/api/calls', (req, res) => {
  const where = [], args = [];
  if (req.query.user === 'me') { where.push('c.user_id=?'); args.push(req.user.id); }
  else if (req.query.user) { where.push('c.user_id=?'); args.push(Number(req.query.user)); }
  if (req.query.connected) where.push('c.connected=1');
  if (req.query.direction) { where.push('c.direction=?'); args.push(req.query.direction); }
  if (req.query.from) { where.push('c.started_at>=?'); args.push(Number(req.query.from)); }
  if (req.query.to) { where.push('c.started_at<?'); args.push(Number(req.query.to)); }
  if (req.query.disposition) { where.push('c.disposition=?'); args.push(req.query.disposition); }
  if (req.query.objection) { where.push('c.ai LIKE ?'); args.push('%"' + req.query.objection + '"%'); }
  if (req.query.q) { const s = '%' + req.query.q + '%'; where.push('(l.name LIKE ? OR l.business LIKE ? OR l.phone LIKE ? OR c.notes LIKE ? OR c.ai LIKE ?)'); args.push(s, s, s, s, s); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const limit = Math.min(500, Number(req.query.limit) || 100), page = Math.max(0, Number(req.query.page) || 0);
  const rows = db.prepare(`SELECT c.*, u.name user_name, l.name lead_name, l.business lead_business, l.phone lead_phone FROM calls c
    JOIN leads l ON l.id=c.lead_id LEFT JOIN users u ON u.id=c.user_id ${w} ORDER BY c.started_at DESC LIMIT ? OFFSET ?`).all(...args, limit, page * limit);
  const total = db.prepare(`SELECT COUNT(*) n FROM calls c JOIN leads l ON l.id=c.lead_id ${w}`).get(...args).n;
  res.json({ rows: rows.map(callOut), total });
});
app.patch('/api/calls/:id', (req, res) => {
  const call = db.prepare('SELECT * FROM calls WHERE id=?').get(Number(req.params.id));
  if (!call) return res.status(404).json({ error: 'Call not found' });
  const f = {}; let rotated = null;
  if (req.body.notes != null) f.notes = String(req.body.notes);
  const dispo = req.body.disposition;
  if (dispo) {
    if (!(dispo in DISPOS)) return res.status(400).json({ error: 'Unknown disposition' });
    f.disposition = dispo;
    const lf = { status: DISPOS[dispo], disposition: dispo, last_outcome: dispo, updated_at: now() };
    if (dispo === 'Callback') {
      if (!req.body.callback_at) return res.status(400).json({ error: 'Pick a callback date & time' });
      lf.callback_at = Number(req.body.callback_at);
      const l = getLead(call.lead_id); if (l && !l.owner_id) lf.owner_id = req.user.id;
    }
    update('leads', call.lead_id, lf);
    if (dispo === 'DNC') addDnc(getLead(call.lead_id).phone, 'Disposition by ' + req.user.name);
    if (['Interested', 'App Sent', 'Not Interested', 'DNC', 'Wrong Number'].includes(dispo)) seqs.stopFor(call.lead_id, 'Disposition: ' + dispo);
    if (dispo === 'Wrong Number') rotated = ctx.intake.rotateWrong(call.lead_id);
    if (['Interested', 'App Sent'].includes(dispo)) {
      const d = dealsMod.openDealFor(call.lead_id, req.user.id);
      if (d && dispo === 'App Sent' && d.stage === 'interested') db.prepare("UPDATE deals SET stage='app_sent', updated_at=? WHERE id=?").run(now(), d.id);
      if (d && req.body.notes) dealsMod.event(d.id, req.user.id, 'note', 'Call notes: ' + req.body.notes);
    }
    const auto = getSetting('auto_sequences', {})[dispo];
    if (auto) seqs.enroll(call.lead_id, Number(auto), req.user.id);
  }
  update('calls', call.id, f);
  res.json({ call: callOut(db.prepare('SELECT * FROM calls WHERE id=?').get(call.id)), rotated });
});
app.get('/api/calls/:id/recording', async (req, res) => {
  const c = db.prepare('SELECT recording_url FROM calls WHERE id=?').get(Number(req.params.id));
  if (!c || !c.recording_url) return res.status(404).send('No recording');
  const auth = Buffer.from(`${env.TWILIO_API_KEY}:${env.TWILIO_API_SECRET}`).toString('base64');
  const r = await fetch(c.recording_url + '.mp3', { headers: { Authorization: 'Basic ' + auth } }).catch(() => null);
  if (!r || !r.ok) return res.status(502).send('Could not load recording from Twilio');
  res.type('audio/mpeg').set('Cache-Control', 'private, max-age=3600').send(Buffer.from(await r.arrayBuffer()));
});
app.post('/api/calls/:id/ai', (req, res) => { processCall(Number(req.params.id), notifyAI, true); res.json({ ok: true }); });

// ---------- stats / floor ----------
app.get('/api/stats', (req, res) => {
  const from = Number(req.query.from) || startOfDay(), to = Number(req.query.to) || now() + 1;
  const reps = db.prepare(`SELECT u.id, u.name,
      COUNT(c.id) dials, SUM(c.connected) connects, COALESCE(SUM(CASE WHEN c.connected=1 THEN c.duration END),0) talk,
      SUM(c.disposition IN ('Interested','App Sent')) interested, SUM(c.disposition='App Sent') apps, SUM(c.disposition='Callback') callbacks,
      SUM(c.vm_dropped) vms, ROUND(AVG(c.score)) score, ROUND(AVG(c.talk_ratio)*100) talk_ratio
    FROM users u LEFT JOIN calls c ON c.user_id=u.id AND c.started_at>=? AND c.started_at<? WHERE u.active=1 AND u.role!='iso' GROUP BY u.id ORDER BY dials DESC`).all(from, to);
  const dispositions = db.prepare(`SELECT disposition, COUNT(*) n FROM calls WHERE started_at>=? AND started_at<? AND disposition!='' GROUP BY disposition ORDER BY n DESC`).all(from, to);
  const sms = db.prepare('SELECT direction, COUNT(*) n FROM messages WHERE created_at>=? AND created_at<? GROUP BY direction').all(from, to);
  const objections = {};
  for (const r of db.prepare("SELECT id, lead_id, ai FROM calls WHERE started_at>=? AND started_at<? AND ai_status='done'").all(from, to)) {
    const ai = safeJSON(r.ai, {});
    (ai.objection_categories || []).forEach((cat, i) => {
      if (!OBJECTION_CATEGORIES.includes(cat)) cat = 'other';
      const o = objections[cat] = objections[cat] || { category: cat, n: 0, examples: [] };
      o.n++; const ex = (ai.objections || [])[i] || (ai.objections || [])[0];
      if (ex && o.examples.length < 4) o.examples.push({ text: ex, callId: r.id, leadId: r.lead_id });
    });
  }
  const hours = db.prepare(`SELECT CAST(strftime('%H', started_at/1000, 'unixepoch', 'localtime') AS INTEGER) h, COUNT(*) dials, SUM(connected) connects FROM calls WHERE started_at>=? AND started_at<? AND direction='out' GROUP BY h ORDER BY h`).all(from, to);
  res.json({ reps, dispositions, sms, objections: Object.values(objections).sort((a, b) => b.n - a.n), hours });
});
app.get('/api/floor', (req, res) => {
  const today = startOfDay();
  const online = new Set(sseClients.values());
  const rows = db.prepare(`SELECT u.id, u.name, u.role, COUNT(c.id) dials, COALESCE(SUM(c.connected),0) connects, COALESCE(SUM(CASE WHEN c.connected=1 THEN c.duration END),0) talk, SUM(c.disposition IN ('Interested','App Sent')) wins
    FROM users u LEFT JOIN calls c ON c.user_id=u.id AND c.started_at>=? WHERE u.active=1 AND u.role!='iso' GROUP BY u.id ORDER BY u.name`).all(today);
  res.json(rows.map(u => {
    const a = agents.get(u.id); let onCall = null;
    if (a && a.batch && a.batch.winner) {
      const c = db.prepare('SELECT c.id, c.answered_at, c.direction, l.id lead_id, l.name, l.business, l.phone FROM calls c JOIN leads l ON l.id=c.lead_id WHERE c.id=?').get(a.batch.winner);
      if (c) onCall = c;
    }
    return { ...u, online: online.has(u.id), inSession: !!(a && a.inRoom), phase: a && a.inRoom ? a.phase : 'offline', since: a ? a.phaseSince : null, onCall, dialingLines: a && a.batch && !a.batch.winner ? a.batch.calls.size : 0 };
  }));
});

// ---------- dialer ----------
app.get('/api/token', (req, res) => {
  const AccessToken = twilio.jwt.AccessToken;
  const token = new AccessToken(env.TWILIO_ACCOUNT_SID, env.TWILIO_API_KEY, env.TWILIO_API_SECRET, { identity: 'u' + req.user.id, ttl: 3600 });
  token.addGrant(new AccessToken.VoiceGrant({ outgoingApplicationSid: env.TWILIO_TWIML_APP_SID, incomingAllow: false }));
  res.json({ token: token.toJwt() });
});
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify({ inRoom: agent(req.user.id).inRoom })}\n\n`);
  sseClients.set(res, req.user.id);
  const ka = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
});
const enforceHours = () => getSetting('enforce_call_window', true) !== false;
const pickLeads = db.transaction((uid, n, maxAttempts, retryMins, leadId, list) => {
  const t = now();
  const okTz = enforceHours() ? tz.callableTzs() : null;
  const scrubCfg = ctx.scrub ? ctx.scrub.cfg() : {}, holdSql = scrubCfg.enabled && scrubCfg.hold ? 'AND scrub_at IS NOT NULL' : '';
  const tzSql = okTz ? (okTz.length ? `AND COALESCE(tz,'') IN (${okTz.map(() => '?').join(',')})` : 'AND 0') : '';
  let rows;
  if (leadId) rows = db.prepare(`SELECT * FROM leads WHERE id=? AND status!='dnc' AND phone NOT IN (SELECT phone FROM dnc) AND (locked_until IS NULL OR locked_until<? OR locked_by=?) ${tzSql}`).all(leadId, t, uid, ...(okTz || []));
  else rows = db.prepare(`SELECT * FROM leads WHERE (locked_until IS NULL OR locked_until<?) AND (owner_id IS NULL OR owner_id=?)
      AND ((status='callback' AND callback_at<=?) OR (status='new' AND attempts<? AND (last_called IS NULL OR last_called<=?)))
      ${list ? 'AND source=?' : ''} AND phone NOT IN (SELECT phone FROM dnc) ${tzSql} ${holdSql}
      ORDER BY ${getSetting('smart_queue', true) !== false ? "CASE WHEN hot=1 THEN 0 WHEN status='callback' THEN 1 ELSE 2 END, CASE WHEN status='callback' THEN callback_at END, COALESCE(score,0) DESC, (owner_id IS NULL), attempts, id" : "CASE WHEN status='callback' THEN 0 ELSE 1 END, callback_at, (owner_id IS NULL), attempts, id"} LIMIT ?`)
    .all(...[t, uid, t, maxAttempts, t - retryMins * 60000, ...(list ? [list] : []), ...(okTz || []), n]);
  for (const l of rows) db.prepare(`UPDATE leads SET hot=0, locked_by=?, locked_until=?, attempts=attempts+1, last_called=?, status=CASE WHEN status='callback' THEN 'new' ELSE status END, updated_at=? WHERE id=?`).run(uid, t + 5 * 60000, t, t, l.id);
  return rows;
});
app.post('/api/dial', async (req, res) => {
  const uid = req.user.id, a = agent(uid);
  if (!a.inRoom) return res.status(409).json({ error: 'Start your session first — your headset is not connected.' });
  if (a.batch) return res.status(409).json({ error: 'Still on the previous batch.' });
  const lines = Math.min(5, Math.max(1, Number(req.body.lines) || 1));
  const single = req.body.leadId ? Number(req.body.leadId) : null;
  const leads = pickLeads(uid, single ? 1 : lines, Number(req.body.maxAttempts) || 6, Number(req.body.retryMins ?? 60), single, single ? null : (req.body.list || null));
  if (!leads.length) {
    if (single) {
      const l = getLead(single);
      if (l && enforceHours() && !tz.okNow(l.tz)) return res.json({ empty: true, reason: `It's ${tz.localTime(l.tz) || 'outside calling hours'} for this lead — outside your calling window` });
    } else if (enforceHours()) {
      const any = db.prepare(`SELECT COUNT(*) n FROM leads WHERE (owner_id IS NULL OR owner_id=?) AND ((status='callback' AND callback_at<=?) OR (status='new' AND attempts<?))`).get(uid, now(), Number(req.body.maxAttempts) || 6).n;
      if (any) return res.json({ empty: true, reason: 'The leads left in your queue are outside calling hours in their time zones right now' });
    }
    return res.json({ empty: true });
  }

  const amd = single ? false : req.body.amd !== false;
  const vm = amd && req.body.vmDrop ? vmUrl(req.user.voicemail_id) : null;
  const timeout = Math.min(60, Math.max(10, parseInt(req.body.ringTimeout, 10) || 25));
  const override = normPhone(req.body.callerId), pick = callerIdPicker();
  const b = { id: crypto.randomBytes(6).toString('hex'), userId: uid, calls: new Map(), winner: null, vmUrl: vm };
  const t = now();
  for (const l of leads) {
    const from = override || pick(l.phone);
    const r = db.prepare('INSERT INTO calls(lead_id,user_id,batch_id,from_number,to_number,status,outcome,started_at) VALUES(?,?,?,?,?,?,?,?)').run(l.id, uid, b.id, from, l.phone, 'queued', 'Dialing', t);
    b.calls.set(Number(r.lastInsertRowid), { sid: null, leadId: l.id, final: false, from });
  }
  a.batch = b; batches.set(b.id, b);
  b.watchdog = setTimeout(() => { if (!b.winner) finishBatch(b, true); }, (timeout + (vm ? 150 : 90)) * 1000);
  res.json({ batchId: b.id, lines: [...b.calls].map(([callId, c]) => { const l = leads.find(x => x.id === c.leadId); return { callId, from: c.from, lead: { ...leadOut(l), local_time: tz.localTime(l.tz) } }; }) });
  log(`Rep ${uid} dialing ${leads.length} line(s)${vm ? ' with voicemail drop' : ''}`);

  await Promise.all([...b.calls].map(async ([callId, c]) => {
    const lead = leads.find(x => x.id === c.leadId), q = `batch=${b.id}&call=${callId}`;
    try {
      const params = { to: lead.phone, from: c.from, timeout, url: `${PUBLIC_URL}/twilio/answer?${q}`, statusCallback: `${PUBLIC_URL}/twilio/status?${q}`, statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'] };
      if (amd) { params.machineDetection = vm ? 'DetectMessageEnd' : 'Enable'; params.machineDetectionTimeout = vm ? 30 : 5; }
      const call = await client.calls.create(params);
      c.sid = call.sid; update('calls', callId, { call_sid: call.sid });
      if (b.winner && b.winner !== callId) hangupCall(call.sid);
    } catch (err) {
      c.final = true;
      const error = (err.code ? '#' + err.code + ' ' : '') + err.message;
      update('calls', callId, { status: 'failed', outcome: 'Failed', error, ended_at: now() });
      db.prepare("UPDATE leads SET last_outcome='Failed' WHERE id=?").run(lead.id);
      log('Dial failed', lead.phone, error);
      emitTo(uid, 'line', { batchId: b.id, callId, leadId: lead.id, status: 'failed', outcome: 'Failed', error });
    }
  }));
  checkBatchDone(b);
});
const winnerOf = uid => { const b = agent(uid).batch; if (!b || !b.winner || b.detached) return null; const c = b.calls.get(b.winner); return c && c.sid ? { b, c, callId: b.winner } : null; };
app.post('/api/hangup', async (req, res) => {
  const w = winnerOf(req.user.id);
  if (w) await client.calls(w.c.sid).update({ status: 'completed' }).catch(() => {});
  res.json({ ok: true });
});
app.post('/api/cancel', (req, res) => { const b = agent(req.user.id).batch; if (b && !b.winner) cancelBatch(b); res.json({ ok: true }); });
app.post('/api/agent-left', (req, res) => { agentLeft(req.user.id); res.json({ ok: true }); });

app.post('/api/vm-drop', async (req, res) => {
  const w = winnerOf(req.user.id); if (!w) return res.status(400).json({ error: 'No live call' });
  const url = vmUrl(req.user.voicemail_id); if (!url) return res.status(400).json({ error: 'Pick or record a voicemail in My settings first' });
  const vr = new VoiceResponse(); vr.play(url); vr.hangup();
  try { await client.calls(w.c.sid).update({ twiml: vr.toString() }); } catch (e) { return res.status(400).json({ error: e.message }); }
  update('calls', w.callId, { vm_dropped: 1, outcome: 'Voicemail dropped', disposition: 'Voicemail' });
  update('leads', w.c.leadId, { status: 'new', disposition: 'Voicemail', last_outcome: 'Voicemail dropped', updated_at: now() });
  afterVmDrop(w.c.leadId, req.user.id);
  detach(w.b);
  res.json({ ok: true });
});
app.post('/api/transfer', async (req, res) => {
  const w = winnerOf(req.user.id); if (!w) return res.status(400).json({ error: 'No live call to transfer' });
  const to = normPhone(req.body.to); if (!to) return res.status(400).json({ error: 'Enter a valid number to transfer to' });
  const from = db.prepare('SELECT from_number FROM calls WHERE id=?').get(w.callId).from_number || CALLER_ID;
  try {
    if (req.body.mode === 'blind') {
      const vr = new VoiceResponse(); vr.dial({ callerId: from }, to);
      await client.calls(w.c.sid).update({ twiml: vr.toString() });
      update('calls', w.callId, { transferred_to: to });
      w.b.transferred = true; detach(w.b);
      emitTo(req.user.id, 'transferred', { callId: w.callId, to });
      return res.json({ ok: true, done: true });
    }
    const p = await client.conferences(agent(req.user.id).room).participants.create({
      from, to, beep: 'false', earlyMedia: true, endConferenceOnExit: false,
      statusCallback: `${PUBLIC_URL}/twilio/xfer-status?user=${req.user.id}`, statusCallbackEvent: ['ringing', 'answered', 'completed'],
    });
    w.b.closer = { sid: p.callSid, to };
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: 'Transfer failed: ' + e.message }); }
});
app.post('/api/transfer/complete', async (req, res) => {
  const w = winnerOf(req.user.id); if (!w || !w.b.closer) return res.status(400).json({ error: 'No transfer in progress' });
  const room = 'xfer-' + crypto.randomBytes(5).toString('hex');
  const vr = new VoiceResponse(); vr.dial().conference({ startConferenceOnEnter: true, endConferenceOnExit: true, beep: false }, room);
  try {
    await Promise.all([client.calls(w.c.sid).update({ twiml: vr.toString() }), client.calls(w.b.closer.sid).update({ twiml: vr.toString() })]);
  } catch (e) { return res.status(400).json({ error: 'Could not complete transfer: ' + e.message }); }
  update('calls', w.callId, { transferred_to: w.b.closer.to });
  w.b.transferred = true; detach(w.b);
  emitTo(req.user.id, 'transferred', { callId: w.callId, to: w.b.closer.to });
  res.json({ ok: true });
});
app.post('/api/transfer/cancel', async (req, res) => {
  const w = winnerOf(req.user.id);
  if (w && w.b.closer) { await hangupCall(w.b.closer.sid); w.b.closer = null; }
  res.json({ ok: true });
});

// ---------- deals, lenders, sequences ----------
function onlineReps() {
  const ids = new Set(sseClients.values());
  const all = db.prepare("SELECT id,name,role FROM users WHERE active=1 AND role IN ('admin','rep') ORDER BY id").all();
  const online = all.filter(u => ids.has(u.id));
  return { all, online, inRoom: online.filter(u => agents.get(u.id) && agents.get(u.id).inRoom) };
}
const ctx = { emitTo, emitAll, sendSms, sendLeadEmail, fillTpl, PUBLIC_URL, leadOut, log, adminOnly, claude, OBJECTION_CATEGORIES, normPhone, isDnc, addDnc, insertLead, getLead, onlineReps, update, now };
dealsMod = require('./deals')(ctx);
ctx.deals = dealsMod;
const docsMod = require('./docs')(ctx);
seqs = require('./sequences')(ctx);
ctx.seqs = seqs;
app.use(dealsMod.router);
app.use(docsMod.router);
const intakeMod = require('./intake')(ctx);
ctx.money = require('./money')(ctx);
app.use(ctx.money.router);
ctx.blasts = require('./blasts')(ctx);
app.use(ctx.blasts.router);
ctx.pilot = require('./pilot')(ctx);
app.use(ctx.pilot.router);
ctx.payments = require('./payments')(ctx);
app.use(ctx.payments.router);
ctx.iso = require('./iso')(ctx);
app.use(ctx.iso.router);
ctx.offers = require('./offers')(ctx);
app.use(ctx.offers.router);
app.use(require('./goals')(ctx).router);
ctx.intake = intakeMod;
app.use(intakeMod.router);
app.use(seqs.router);
ctx.reports = require('./reports')(ctx);
app.use(ctx.reports.router);
ctx.qa = require('./qa')(ctx);
app.use(ctx.qa.router);
ctx.scrub = require('./scrub')(ctx);
app.use(ctx.scrub.router);
ctx.ops = require('./ops')(ctx);
app.use(ctx.ops.router);

// inbound email: lender replies to submissions, or leads replying
mail.startImap(async m => {
  const fromAddr = (m.from?.value?.[0]?.address || '').toLowerCase();
  const subject = m.subject || '', text = (m.text || '').trim(), t = now();
  if (m.messageId && db.prepare('SELECT 1 FROM emails WHERE message_id=?').get(m.messageId)) return;
  let sub = null;
  const tag = /\[PD-(\d+)-(\d+)\]/.exec(subject);
  if (tag) sub = db.prepare('SELECT * FROM submissions WHERE id=? AND deal_id=?').get(Number(tag[2]), Number(tag[1]));
  if (!sub && m.inReplyTo) sub = db.prepare('SELECT * FROM submissions WHERE message_id=?').get(m.inReplyTo);
  const atts = JSON.stringify((m.attachments || []).map(a => a.filename).filter(Boolean));
  if (sub) {
    db.prepare("INSERT INTO emails(deal_id,submission_id,lender_id,direction,subject,body,from_addr,to_addr,message_id,in_reply_to,attachments,status,created_at) VALUES(?,?,?,'in',?,?,?,?,?,?,?,'received',?)")
      .run(sub.deal_id, sub.id, sub.lender_id, subject, text, fromAddr, mail.fromAddr(), m.messageId, m.inReplyTo || null, atts, t);
    dealsMod.event(sub.deal_id, null, 'email', `Email from lender: ${subject}`);
    return dealsMod.readLenderReply(sub.id, `Subject: ${subject}\n\n${text}`);
  }
  const lead = fromAddr && db.prepare('SELECT * FROM leads WHERE lower(email)=?').get(fromAddr);
  if (!lead) return;
  const r = db.prepare("INSERT INTO emails(lead_id,direction,subject,body,from_addr,to_addr,message_id,in_reply_to,attachments,status,created_at) VALUES(?,'in',?,?,?,?,?,?,?,'received',?)")
    .run(lead.id, subject, text, fromAddr, mail.fromAddr(), m.messageId, m.inReplyTo || null, atts, t);
  db.prepare('UPDATE leads SET email_last_at=?, updated_at=? WHERE id=?').run(t, t, lead.id);
  seqs.stopFor(lead.id, 'Replied by email');
  emitAll('email', { email: db.prepare('SELECT * FROM emails WHERE id=?').get(r.lastInsertRowid), leadId: lead.id, lead: leadOut(lead) });
}, log);

tz.backfill().catch(() => {});
setInterval(() => tz.backfill().catch(() => {}), 120000);

// ---------- start ----------
const server = http.createServer(app);
live.attach(server, emitTo, callId => processCall(callId, notifyAI));
server.listen(PORT, () => {
  console.log(`PowerDial CRM running → http://localhost:${PORT}`);
  console.log(`Twilio webhooks expected at ${PUBLIC_URL}/twilio/...`);
});
