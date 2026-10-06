// Post-call AI: transcript (live or from recording via Deepgram) → Claude notes + call score
const { db } = require('./db');

const env = process.env;
const MODEL = env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const MIN_SECONDS = Number(env.AI_MIN_SECONDS || 15);
const COMPANY = env.COMPANY_NAME || 'Brookestone Funding';
const OBJECTION_CATEGORIES = ['already_funded', 'rate_too_high', 'not_interested', 'bad_timing', 'send_info', 'need_partner', 'credit', 'too_many_positions', 'trust', 'other'];
const FILLERS = /\b(um+|uh+|you know|basically|literally|kind of|sort of|i mean)\b/gi;

function fmtTs(s) { s = Math.floor(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

async function fetchRecording(url) {
  const auth = Buffer.from(`${env.TWILIO_API_KEY}:${env.TWILIO_API_SECRET}`).toString('base64');
  const r = await fetch(url.replace(/\.(json|mp3|wav)$/, '') + '.mp3', { headers: { Authorization: 'Basic ' + auth } });
  if (!r.ok) throw new Error('Could not download recording from Twilio (' + r.status + ')');
  return Buffer.from(await r.arrayBuffer());
}

async function transcribe(audio) {
  const qs = 'model=nova-3&smart_format=true&punctuate=true&utterances=true&multichannel=true';
  const r = await fetch('https://api.deepgram.com/v1/listen?' + qs, {
    method: 'POST', headers: { Authorization: 'Token ' + env.DEEPGRAM_API_KEY, 'Content-Type': 'audio/mpeg' }, body: audio,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Deepgram: ' + (j.err_msg || j.message || r.status));
  const utts = (j.results && j.results.utterances) || [];
  if (utts.length) return utts.sort((a, b) => a.start - b.start).map(u => `[${fmtTs(u.start)}] Speaker ${u.channel === 0 ? 'A' : 'B'}: ${u.transcript}`).join('\n');
  const ch = (j.results && j.results.channels) || [];
  return ch.map((c, i) => `Speaker ${i === 0 ? 'A' : 'B'}: ${c.alternatives?.[0]?.transcript || ''}`).join('\n').trim();
}

async function claude(prompt, maxTokens = 2000) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Claude: ' + (j.error?.message || r.status));
  const m = (j.content || []).map(c => c.text || '').join('').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Claude returned no JSON');
  return JSON.parse(m[0]);
}

// like claude(), but with PDFs / images attached (bank statements)
async function claudeDocs(prompt, docs, maxTokens = 4000) {
  const content = docs.map(d => d.mime === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: d.base64 } }
    : { type: 'image', source: { type: 'base64', media_type: d.mime, data: d.base64 } });
  content.push({ type: 'text', text: prompt });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Claude: ' + (j.error?.message || r.status));
  const m = (j.content || []).map(c => c.text || '').join('').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Claude returned no JSON');
  return JSON.parse(m[0]);
}

async function summarize(transcript, lead, rep, labeled) {
  const prompt = `You are writing CRM notes and a coaching scorecard for a merchant cash advance (MCA) / small business funding sales call at ${COMPANY}.
${labeled ? 'Lines are labeled Rep and Lead.' : `One speaker (A or B) is the sales rep (${rep || 'the rep'}); the other is the merchant. Work out who is who.`}
Merchant on file: ${[lead.name, lead.business].filter(Boolean).join(', ') || 'unknown'}.

Return ONLY a JSON object, no markdown:
{
  "rep_speaker": ${labeled ? '"Rep"' : '"A" or "B"'},
  "summary": "2-4 sentence plain-English summary",
  "outcome": "interested | app_sent | callback | not_interested | wrong_number | gatekeeper | voicemail | dnc_requested | other",
  "next_steps": ["short action items for the rep"],
  "callback": "when the merchant asked to be called back, in their words, or null",
  "facts": {"monthly_revenue": null, "time_in_business": null, "amount_requested": null, "use_of_funds": null, "existing_advances": null, "credit": null, "industry": null, "decision_maker": null, "email": null},
  "objections": ["each objection the merchant raised, in a few words"],
  "objection_categories": [one or more of ${JSON.stringify(OBJECTION_CATEGORIES)}],
  "sentiment": "positive | neutral | negative",
  "score": 0-100 overall rep performance,
  "scorecard": {"opening": 0-10, "discovery": 0-10, "objection_handling": 0-10, "next_step": 0-10, "tone": 0-10},
  "coaching_tips": ["1-3 specific things the rep should do better next time"],
  "follow_up_sms": "a short friendly follow-up text the rep could send this merchant (under 300 characters, sign with the rep's first name), or null if a text would not make sense"
}
Use null / empty arrays for anything not covered. Do not invent facts.

TRANSCRIPT:
${transcript.slice(0, 120000)}`;
  return claude(prompt);
}

function relabel(transcript, repSpeaker) {
  if (!/^(A|B)$/.test(repSpeaker || '')) return transcript;
  const other = repSpeaker === 'A' ? 'B' : 'A';
  return transcript.replace(new RegExp(`Speaker ${repSpeaker}:`, 'g'), 'Rep:').replace(new RegExp(`Speaker ${other}:`, 'g'), 'Lead:');
}
function talkStats(transcript) {
  let rep = 0, lead = 0, fillers = 0;
  for (const line of transcript.split('\n')) {
    const m = /\b(Rep|Lead):\s(.*)$/.exec(line); if (!m) continue;
    const words = m[2].split(/\s+/).filter(Boolean).length;
    if (m[1] === 'Rep') { rep += words; fillers += (m[2].match(FILLERS) || []).length; } else lead += words;
  }
  return { ratio: rep + lead ? rep / (rep + lead) : null, fillers };
}

const running = new Set();
async function processCall(callId, onDone, force) {
  if (running.has(callId)) return;
  const call = db.prepare('SELECT c.*, u.name rep FROM calls c LEFT JOIN users u ON u.id=c.user_id WHERE c.id=?').get(callId);
  if (!call || !call.connected) return;
  if (!force && ['done', 'pending'].includes(call.ai_status)) return;
  if (call.vm_dropped) return;
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(call.lead_id) || {};
  const set = f => { const k = Object.keys(f); db.prepare(`UPDATE calls SET ${k.map(x => x + '=?').join(',')} WHERE id=?`).run(...k.map(x => f[x]), callId); };
  const done = () => onDone && onDone(call);
  const liveText = (call.live_transcript || '').trim();
  if (!env.ANTHROPIC_API_KEY || (!env.DEEPGRAM_API_KEY && !liveText)) { set({ ai_status: 'skipped', ai_error: 'AI keys not configured' }); return done(); }
  const seconds = call.recording_duration || call.duration || 0;
  if (seconds < MIN_SECONDS && liveText.split(/\s+/).length < 40) { set({ ai_status: 'skipped', ai_error: 'Call too short for notes' }); return done(); }
  if (!liveText && !call.recording_url) return; // wait for the recording

  running.add(callId);
  set({ ai_status: 'pending', ai_error: '' }); done();
  try {
    let transcript = liveText, labeled = !!liveText;
    if (!transcript) { transcript = await transcribe(await fetchRecording(call.recording_url)); }
    if (!transcript.trim()) throw new Error('Transcript was empty');
    const ai = await summarize(transcript, lead, call.rep, labeled);
    if (!labeled) transcript = relabel(transcript, ai.rep_speaker);
    const ts = talkStats(transcript);
    ai.talk_ratio = ts.ratio; ai.filler_words = ts.fillers;
    const score = Number.isFinite(Number(ai.score)) ? Math.max(0, Math.min(100, Math.round(Number(ai.score)))) : null;
    set({ transcript, ai: JSON.stringify(ai), ai_status: 'done', score, talk_ratio: ts.ratio ?? call.talk_ratio });
  } catch (e) {
    console.error('AI notes failed for call', callId, e.message);
    set({ ai_status: 'error', ai_error: String(e.message).slice(0, 300) });
  } finally { running.delete(callId); done(); }
}

module.exports = { processCall, OBJECTION_CATEGORIES, claude, claudeDocs };
