// Live call transcription (Twilio Media Streams → Deepgram) + real-time AI coaching (Claude)
const WebSocket = require('ws');
const crypto = require('crypto');
const { db, getSetting } = require('./db');

const env = process.env;
const COACH_MODEL = env.COACH_MODEL || 'claude-haiku-4-5-20251001';
const COMPANY = env.COMPANY_NAME || 'Brookestone Funding';
const DG_URL = env.DEEPGRAM_LIVE_URL || 'wss://api.deepgram.com/v1/listen?model=nova-3&encoding=mulaw&sample_rate=8000&channels=1&interim_results=true&endpointing=300&smart_format=true&punctuate=true';

const DEFAULT_PLAYBOOK = `Already have funding / existing advance: Totally get it — most of our clients came to us with a position open. Who are you with and what's the balance? A lot of times we can consolidate or give you a second position that frees up cash flow.
Rate too high / too expensive: Fair question. What would the money make you if you had it this week? If the return beats the cost, it's a tool, not an expense. Let me get you real numbers off your statements so you're comparing apples to apples.
Not interested: No problem — quick question before I let you go: if a slow month or a big opportunity came up, how would you cover it today? I'll send you my info so you have it.
Send me information: Happy to. So I send the right thing — roughly what are your monthly deposits and how long have you been open? Then I'll text you the one-page app.
Need to talk to my partner / spouse: Makes sense. When are you two together next? Let's set 10 minutes then so I can answer both of your questions at once.
Bad credit: Credit isn't the main factor for us — we look at your deposits and cash flow. If the business is doing steady revenue we can usually work something out.
How did you get my number: Your business info is in public filings — we reach out to established businesses that have used financing before. Is now a bad time?
Don't need money right now: Perfect time to get approved then — no cost to have an approval in your back pocket for when you do.
Too many positions / stacked: We see that a lot. We may be able to consolidate those into one lower daily payment so you keep more of your deposits.
How fast: Once we have the app and last 4 months of statements, approvals are usually same day and funding within 24-48 hours.`;

const streamKey = callId => crypto.createHmac('sha256', env.TWILIO_API_SECRET || 'x').update('stream:' + callId).digest('hex').slice(0, 32);
const enabled = () => !!env.DEEPGRAM_API_KEY && env.LIVE_TRANSCRIPTION !== 'false';
const live = new Map(); // callId -> state

function attach(server, emitTo, onSaved) {
  const wss = new WebSocket.Server({ server, path: '/twilio/stream' });
  wss.on('connection', ws => {
    let st = null; const dg = {};
    const finish = () => {
      if (!st || st.done) return;
      st.done = true;
      for (const c of Object.values(dg)) closeDg(c);
      setTimeout(() => { save(st); live.delete(st.callId); emitTo(st.userId, 'live_end', { callId: st.callId }); onSaved && onSaved(st.callId); }, 2000);
    };
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.event === 'start') {
        const p = m.start.customParameters || {}, callId = Number(p.callId);
        if (!callId || p.key !== streamKey(callId)) return ws.close();
        const row = db.prepare('SELECT c.user_id, c.lead_id, l.name, l.business FROM calls c JOIN leads l ON l.id=c.lead_id WHERE c.id=?').get(callId);
        if (!row) return ws.close();
        st = { callId, userId: row.user_id, lead: row, segs: [], talk: { rep: 0, lead: 0 }, lastCoach: 0, coaching: false, pending: false, repRun: null, cards: 0 };
        live.set(callId, st);
        dg.inbound = openDeepgram(st, 'lead', emitTo);   // what the lead says
        dg.outbound = openDeepgram(st, 'rep', emitTo);   // what Twilio plays to the lead = the rep
        emitTo(st.userId, 'live_start', { callId });
      } else if (m.event === 'media' && st) {
        const c = dg[m.media.track]; if (c) send(c, Buffer.from(m.media.payload, 'base64'));
      } else if (m.event === 'stop') finish();
    });
    ws.on('close', finish);
    ws.on('error', finish);
  });
}

function openDeepgram(st, who, emitTo) {
  const conn = { queue: [], open: false };
  const ws = new WebSocket(DG_URL, { headers: { Authorization: 'Token ' + env.DEEPGRAM_API_KEY } });
  conn.ws = ws;
  ws.on('open', () => {
    conn.open = true; conn.queue.forEach(b => ws.send(b)); conn.queue = [];
    conn.ka = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'KeepAlive' })), 8000);
  });
  ws.on('message', data => {
    let r; try { r = JSON.parse(data); } catch { return; }
    if (r.type !== 'Results') return;
    const text = r.channel?.alternatives?.[0]?.transcript || '';
    if (text) onText(st, who, text, r.is_final, r.start || 0, r.duration || 0, emitTo);
  });
  ws.on('error', e => console.error('Deepgram live error:', e.message));
  ws.on('close', () => clearInterval(conn.ka));
  return conn;
}
function send(c, buf) { if (c.open && c.ws.readyState === 1) c.ws.send(buf); else if (c.queue.length < 600) c.queue.push(buf); }
function closeDg(c) {
  clearInterval(c.ka);
  try { if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ type: 'CloseStream' })); } catch {}
  setTimeout(() => { try { c.ws.close(); } catch {} }, 1500);
}

function onText(st, who, text, isFinal, start, dur, emitTo) {
  emitTo(st.userId, 'live', { callId: st.callId, who, text, final: !!isFinal });
  if (!isFinal) return;
  st.segs.push({ who, text, t: start, d: dur });
  st.talk[who] += dur;
  if (who === 'rep') { if (!st.repRun || start - st.repRun.end > 2.5) st.repRun = { start, end: start + dur }; else st.repRun.end = start + dur; }
  else st.repRun = null;
  const total = st.talk.rep + st.talk.lead;
  emitTo(st.userId, 'live_stats', { callId: st.callId, repPct: total ? Math.round(st.talk.rep / total * 100) : 0, monologue: st.repRun ? Math.round(st.repRun.end - st.repRun.start) : 0 });
  if (who === 'lead' && text.trim().split(/\s+/).length >= 3) maybeCoach(st, emitTo);
}

async function maybeCoach(st, emitTo) {
  if (!env.ANTHROPIC_API_KEY || env.LIVE_COACHING === 'false' || st.done) return;
  if (st.coaching || Date.now() - st.lastCoach < 6000) {
    if (!st.pending) { st.pending = true; setTimeout(() => { st.pending = false; maybeCoach(st, emitTo); }, Math.max(1000, 6000 - (Date.now() - st.lastCoach))); }
    return;
  }
  st.coaching = true; st.lastCoach = Date.now();
  const convo = st.segs.slice(-24).sort((a, b) => a.t - b.t).map(s => (s.who === 'rep' ? 'REP: ' : 'MERCHANT: ') + s.text).join('\n');
  const prompt = `You are a live sales coach quietly helping a rep at ${COMPANY} (merchant cash advance / small business funding) during a phone call with a business owner${st.lead.business ? ' (' + st.lead.business + ')' : ''}.
Look at the latest thing the merchant said. Decide if the rep needs a prompt right now.
Return ONLY a JSON object: {"type":"objection|question|buying_signal|info|none","title":"3-6 word label","say":"what the rep could say next, max 35 words, natural spoken English"}
Use "none" if nothing new needs a response or the rep already handled it. Use the playbook when it fits. Never promise specific rates, amounts or approval.

PLAYBOOK:
${getSetting('playbook', DEFAULT_PLAYBOOK)}

CONVERSATION (latest last):
${convo}`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: COACH_MODEL, max_tokens: 250, messages: [{ role: 'user', content: prompt }] }),
    });
    const j = await r.json();
    const m = (j.content || []).map(c => c.text || '').join('').match(/\{[\s\S]*\}/);
    const card = m ? JSON.parse(m[0]) : null;
    if (card && card.type !== 'none' && card.say && !st.done) { st.cards++; emitTo(st.userId, 'coach', { callId: st.callId, ...card }); }
  } catch (e) { console.error('Coach error:', e.message); }
  finally { st.coaching = false; }
}

function fmtTs(s) { s = Math.floor(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function save(st) {
  if (!st.segs.length) return;
  const text = st.segs.slice().sort((a, b) => a.t - b.t).map(s => `[${fmtTs(s.t)}] ${s.who === 'rep' ? 'Rep' : 'Lead'}: ${s.text}`).join('\n');
  const total = st.talk.rep + st.talk.lead;
  db.prepare('UPDATE calls SET live_transcript=?, talk_ratio=? WHERE id=?').run(text, total ? st.talk.rep / total : null, st.callId);
}

module.exports = { attach, streamKey, enabled, DEFAULT_PLAYBOOK, COMPANY };
