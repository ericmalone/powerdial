// PowerDial CRM — front end
// ============ helpers ============
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function load(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
function normPhone(p) {
  const raw = String(p || '').trim(), d = raw.replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  if (raw.startsWith('+') && d.length >= 8 && d.length <= 15) return '+' + d;
  return null;
}
const fmtPhone = e => { const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e || ''); return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (e || ''); };
function fmtDur(s) { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); }
const fmtTime = t => t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const fmtDay = t => new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: new Date(t).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
const fmtClock = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const toLocalInput = t => { if (!t) return ''; const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const leadName = l => l ? (l.name || l.business || fmtPhone(l.phone) || 'Unknown') : 'Unknown';
const first = l => (l?.name || '').trim().split(/\s+/)[0] || '';
let toastT;
function toast(msg, err) { const t = $('#toast'); t.textContent = msg; t.className = err ? 'err' : ''; t.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(() => t.style.display = 'none', err ? 7000 : 3000); }
async function api(path, body, method) {
  const opts = body !== undefined ? { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { method: method || 'GET' };
  const r = await fetch(path, opts);
  if (r.status === 401 && !path.includes('/login')) { showLogin(); throw new Error('Please log in'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Server error ' + r.status);
  return j;
}
function beep(f = 880) { try { const a = new AudioContext(), o = a.createOscillator(), g = a.createGain(); o.frequency.value = f; g.gain.value = .08; o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + .15); } catch {} }
function openModal(html, wide) { $('#modalBody').innerHTML = html; $('#modalBody').classList.toggle('wide', !!wide); $('#modal').classList.add('show'); }
function closeModal() { $('#modal').classList.remove('show'); }
const go = h => { location.hash = h; };

// ============ constants / state ============
const DEFAULT_SCRIPT = `# start: Opener
Hi, is this {first}?
-> Yes, it's them: intro
-> Gatekeeper answered: gatekeeper
-> Wrong number: wrong

# intro: Intro
{first}, this is {rep} with {company}. I'm reaching out because businesses like {business} often need fast working capital — inventory, payroll, expansion.

Quick question: if you had access to funding in the next 24–48 hours, what would you use it for?
-> They have a need: qualify
-> Already have funding: funded
-> Not interested: notint
-> Call me later: later

# qualify: Qualify
• How long have you been in business?
• Roughly what are your monthly deposits?
• Any open advances right now? With who, and what's the balance?
• How much are you looking for, and what's it for?
-> Qualifies: close
-> Doesn't qualify: dq

# close: Close
Great — I'll text you a one-page application right now. Send it back with your last 4 months of bank statements and we can usually have an offer the same day.

What's the best email for you?
(Disposition: App Sent or Interested)

# funded: Already funded
Totally get it — most of our clients came to us with a position open. Who are you with, and what's the balance? A lot of times we can consolidate or add a position that frees up cash flow.
-> Open to options: qualify
-> Still no: notint

# notint: Not interested
No problem — quick question before I let you go: if a slow month or a big opportunity came up, how would you cover it today? I'll text you my info so you have it.
-> Opened up: qualify
-> Still no: end

# later: Callback
No problem — when's a better time, today or tomorrow? I'll call you right then.
(Disposition: Callback, with the time they give)

# gatekeeper: Gatekeeper
Hi! I'm trying to reach the owner about the business funding they looked into. Is {first} around? When's the best time to catch them?
-> Put through to owner: intro
-> Not available: later

# wrong: Wrong number
Sorry about that — I'll update our records. Have a good day!
(Disposition: Wrong Number)

# dq: Doesn't qualify
Thanks for walking me through that. Right now we'd need a bit more time in business or monthly revenue — I'll check back in a few months.
(Disposition: Not Interested)

# end: Wrap up
Thanks for your time, {first}. Have a great day!`;
const DISPOS = [
  { code: 'Interested', key: '1', cls: 'good' }, { code: 'App Sent', key: '2', cls: 'good' },
  { code: 'Callback', key: '3', cls: 'warn' }, { code: 'Not Interested', key: '4', cls: '' },
  { code: 'Voicemail', key: '5', cls: '' }, { code: 'Gatekeeper', key: '6', cls: '' },
  { code: 'Wrong Number', key: '7', cls: 'bad' }, { code: 'DNC', key: '8', cls: 'bad' },
];
const FINAL = ['completed', 'busy', 'no-answer', 'failed', 'canceled'];
const LINE_LABEL = { queued: 'queued', initiated: 'dialing', ringing: 'ringing', 'in-progress': 'answered', answered: 'answered', machine: 'machine', abandoned: 'abandoned' };

const S = {
  me: null, config: {}, users: [], script: null, templates: [],
  prefs: Object.assign({ lines: 3, amd: true, vmDrop: false, list: '', auto: true, ringTimeout: 25, delay: 2, retryMins: 60, maxAttempts: 6, callerId: '', start: '09:00', end: '20:00' }, load('pd_prefs', {})),
  device: null, agentCall: null, inSession: false, muted: false, sessionStart: 0,
  phase: 'idle',            // idle | ready | dialing | connected | wrap
  batch: null,              // { id, lines:[{callId, lead}], status:{callId:...}, startedAt }
  active: null,             // { callId, lead, history }
  callNotes: '', callbackAt: '', connectedAt: 0, lastTalk: 0,
  stats: { dials: 0, connects: 0, talk: 0 },
  nextTimer: null, route: '', viewCtx: {}, unread: 0,
  liveSegs: [], interim: { rep: '', lead: '' }, coach: [], liveStats: null, rightTab: 'script', scriptNode: null, scriptPath: [],
  xfer: null, lists: [], lastPhase: null, monitor: null,
};
const savePrefs = () => store('pd_prefs', S.prefs);
const isAdmin = () => S.me?.role === 'admin';
const fill = (txt, l) => String(txt || '').replace(/\{first\}/g, l ? (first(l) || 'there') : '[first name]').replace(/\{name\}/g, l ? (l.name || '') : '[name]').replace(/\{business\}/g, l ? (l.business || 'your business') : '[business]').replace(/\{state\}/g, l?.state || '').replace(/\{rep\}/g, (S.me?.name || '').split(' ')[0]).replace(/\{company\}/g, S.config.company || 'our company');

// ============ auth / boot ============
function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); setTimeout(() => $('#lEmail').focus(), 50); }
async function doLogin(e) {
  e.preventDefault();
  try { await api('/api/login', { email: $('#lEmail').value, password: $('#lPass').value }); $('#lPass').value = ''; boot(); }
  catch (err) { toast(err.message, true); }
}
async function logout() { if (S.inSession) endSession(); await api('/api/logout', {}).catch(() => {}); location.hash = ''; location.reload(); }
let es;
async function boot() {
  let me;
  try { me = await api('/api/me'); } catch { return showLogin(); }
  S.me = me.user; S.config = me.config;
  if (S.me.role === 'iso') return bootIso();
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#meName').innerHTML = `${esc(S.me.name)} <span class="faint">· ${esc(S.me.role)}</span>`;
  document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', !isAdmin()));
  api('/api/users').then(u => { S.users = u.filter(x => x.role !== 'iso'); S.isos = u.filter(x => x.role === 'iso'); }).catch(() => {});
  api('/api/script').then(r => S.script = r.script || DEFAULT_SCRIPT).catch(() => S.script = DEFAULT_SCRIPT);
  api('/api/templates').then(t => S.templates = t).catch(() => {});
  loadLists();
  api('/api/settings').then(st => { S.playbook = st.playbook; S.teamSettings = st; }).catch(() => {});
  refreshUnread();
  if (!es) connectEvents();
  if (!location.hash || location.hash === '#/') location.hash = '#/dialer'; else route();
  renderChrome();
}
function loadLists() { return api('/api/lists').then(l => { S.lists = l; if (S.route === 'dialer') renderControls(); }).catch(() => {}); }
function refreshUnread() { api('/api/leads?limit=1').then(r => { S.unread = r.counts.unread || 0; const c = $('#unreadCnt'); c.textContent = S.unread; c.classList.toggle('hidden', !S.unread); }).catch(() => {}); }

// ============ router ============
const VIEWS = { needs: viewNeeds, tasks: viewTasks, submissions: viewSubmissions, offers: viewOffers, attribution: viewAttribution, pilot: viewPilot, payments: viewPayments, distributions: viewDistributions, advances: viewAdvances, blasts: viewBlasts, blast: viewBlast, search: viewSearch, dialer: viewDialer, floor: viewFloor, pipeline: viewPipeline, deal: viewDeal, lenders: viewLenders, sequences: viewSequences, commissions: viewCommissions, reports: viewReports, automation: viewAutomation, leads: viewLeads, lead: viewLead, inbox: viewInbox, calls: viewCalls, dashboard: viewDashboard, team: viewTeam, settings: viewSettings };
window.addEventListener('hashchange', route);
function route() {
  if (!S.me) return;
  const [, name = 'dialer', arg] = location.hash.split('/');
  S.route = name; S.viewCtx = { arg };
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('act', a.dataset.r === name || (name === 'lead' && a.dataset.r === 'leads') || (name === 'deal' && a.dataset.r === 'pipeline') || (name === 'blast' && a.dataset.r === 'blasts')));
  (VIEWS[name] || viewDialer)(arg);
  if (!VIEWS[name] || name === 'dialer') loadGoalBar();
}
const V = html => { $('#view').innerHTML = html; };

// ============ dialer core ============
async function toggleSession() { S.inSession ? endSession() : startSession(); }
async function startSession() {
  ['#hdrSession', '#btnSession'].forEach(s => { const b = $(s); if (b) { b.disabled = true; b.textContent = 'Connecting…'; } });
  try {
    const { token } = await api('/api/token');
    S.device = new Twilio.Device(token, { codecPreferences: ['opus', 'pcmu'], closeProtection: true, logLevel: 1 });
    S.device.on('error', e => toast('Twilio: ' + (e.message || e), true));
    S.device.on('tokenWillExpire', async () => { try { const r = await api('/api/token'); S.device.updateToken(r.token); } catch {} });
    const call = await S.device.connect({ params: { mode: 'join' } });
    S.agentCall = call;
    call.on('accept', () => {
      S.inSession = true; S.phase = 'ready'; S.sessionStart = Date.now(); S.stats = { dials: 0, connects: 0, talk: 0 };
      toast('Headset connected'); renderDialerAll();
      if (S.prefs.auto) dialNext();
    });
    call.on('disconnect', () => sessionEnded('Session ended'));
    call.on('cancel', () => sessionEnded('Session could not connect'));
    call.on('error', e => toast('Line error: ' + (e.message || e), true));
  } catch (e) {
    toast('Could not start session: ' + e.message, true);
    try { S.device && S.device.destroy(); } catch {}
    S.device = null; renderDialerAll();
  }
}
function endSession() {
  clearTimeout(S.nextTimer);
  if (S.phase === 'dialing') api('/api/cancel', {}).catch(() => {});
  try { S.agentCall && S.agentCall.disconnect(); } catch {}
  sessionEnded('Session ended');
}
function sessionEnded(msg) {
  if (!S.inSession && !S.agentCall) { renderDialerAll(); return; }
  clearTimeout(S.nextTimer);
  api('/api/agent-left', {}).catch(() => {});
  if (S.phase === 'connected') { S.lastTalk = (Date.now() - S.connectedAt) / 1000; S.stats.talk += S.lastTalk; S.phase = 'wrap'; }
  if (S.phase !== 'wrap') { S.phase = 'idle'; S.active = null; }
  S.inSession = false; S.agentCall = null; S.muted = false;
  try { S.device && S.device.destroy(); } catch {}
  S.device = null; toast(msg); renderDialerAll();
}
function inHours() {
  const n = new Date(), hm = String(n.getHours()).padStart(2, '0') + ':' + String(n.getMinutes()).padStart(2, '0');
  return hm >= (S.prefs.start || '00:00') && hm < (S.prefs.end || '23:59');
}
function scheduleNext(delay) {
  clearTimeout(S.nextTimer);
  if (!S.prefs.auto || !S.inSession || S.phase !== 'ready' || S.batch) return;
  S.nextTimer = setTimeout(() => dialNext(true), (delay ?? S.prefs.delay) * 1000);
}
async function dialNext(silent) {
  if (!S.inSession) return toast('Start a session first', true);
  if (S.phase !== 'ready' || S.batch) return;
  await startBatch({ lines: S.prefs.lines, amd: S.prefs.amd }, silent);
  loadLists();
}
async function callLead(leadId) {
  if (!S.inSession) return toast('Start a session first (top right)', true);
  if (S.phase !== 'ready' || S.batch) return toast('Finish the current call first', true);
  await startBatch({ leadId });
}
async function startBatch(opts, silent) {
  clearTimeout(S.nextTimer);
  S.phase = 'dialing'; S.batch = { id: null, lines: [], status: {}, outcome: {}, startedAt: Date.now() };
  renderDialerAll();
  try {
    const r = await api('/api/dial', { ...opts, list: S.prefs.list, vmDrop: S.prefs.vmDrop, ringTimeout: S.prefs.ringTimeout, retryMins: S.prefs.retryMins, maxAttempts: S.prefs.maxAttempts, callerId: S.prefs.callerId });
    if (r.empty) {
      S.batch = null; S.phase = 'ready'; renderDialerAll();
      if (!silent || r.reason) { if (r.reason !== S.lastEmptyReason || !silent) toast(r.reason || (opts.leadId ? 'That lead can’t be dialed right now (DNC or on another rep’s line)' : 'No dialable leads right now'), !!opts.leadId); }
      S.lastEmptyReason = r.reason;
      return;
    }
    S.lastEmptyReason = null;
    Object.assign(S.batch, { id: r.batchId, lines: r.lines });
    S.stats.dials += r.lines.length;
    if (S.route !== 'dialer' && !opts.leadId) {} // stay where the rep is
    renderDialerAll();
  } catch (e) { S.batch = null; S.phase = 'ready'; toast(e.message, true); renderDialerAll(); }
}
const cancelBatch = () => S.phase === 'dialing' && api('/api/cancel', {}).catch(e => toast(e.message, true));
const hangup = () => S.phase === 'connected' && api('/api/hangup', {}).catch(e => toast(e.message, true));
function toggleMute() { if (!S.agentCall) return; S.muted = !S.muted; S.agentCall.mute(S.muted); renderDialerAll(); }
async function dropVm() {
  if (S.phase !== 'connected') return;
  try { await api('/api/vm-drop', {}); } catch (e) { return toast(e.message, true); }
  S.stats.talk += (Date.now() - S.connectedAt) / 1000;
  toast('Voicemail dropped — moving on');
  S.active = null; S.callNotes = ''; S.callbackAt = ''; S.xfer = null;
  S.phase = S.inSession ? 'ready' : 'idle';
  renderDialerAll(); scheduleNext();
}
function transferModal() {
  if (S.phase !== 'connected') return;
  const team = S.users.filter(u => u.phone && u.id !== S.me.id);
  openModal(`<h3>Transfer call</h3>
    <div class="mf"><label>Transfer to</label><select id="xTo"><option value="">Type a number below…</option>${team.map(u => `<option value="${esc(u.phone)}">${esc(u.name)} — ${esc(fmtPhone(u.phone))}</option>`).join('')}</select></div>
    <div class="mf"><label>Or number</label><input id="xNum" placeholder="(212) 555-0100"></div>
    <div class="faint" style="font-size:12px;line-height:1.5">Warm: you stay on and introduce the merchant, then click Complete. Blind: the merchant is sent straight over and you're free.</div>
    <div class="mact"><button onclick="closeModal()">Cancel</button><button onclick="startTransfer('blind')">Blind transfer</button><button class="primary" onclick="startTransfer('warm')">Warm transfer</button></div>`);
}
async function startTransfer(mode) {
  const to = $('#xTo').value || $('#xNum').value;
  if (!normPhone(to)) return toast('Pick a teammate or enter a number', true);
  try {
    const r = await api('/api/transfer', { to, mode });
    closeModal();
    if (!r.done) { S.xfer = { to: normPhone(to), status: 'calling' }; renderActive(); }
  } catch (e) { toast(e.message, true); }
}
async function completeTransfer() { try { await api('/api/transfer/complete', {}); } catch (e) { toast(e.message, true); } }
async function cancelTransfer() { await api('/api/transfer/cancel', {}).catch(() => {}); S.xfer = null; renderActive(); }
function toggleAuto() { S.prefs.auto = !S.prefs.auto; savePrefs(); renderDialerAll(); if (S.prefs.auto) scheduleNext(0); else clearTimeout(S.nextTimer); }
function setPref(k, v) { S.prefs[k] = v; savePrefs(); renderDialerAll(); }

async function saveDispo(code) {
  if (!S.active || !['connected', 'wrap'].includes(S.phase)) return;
  const notesEl = $('#callNotes'); if (notesEl) S.callNotes = notesEl.value;
  const cbEl = $('#cbAt'); if (cbEl) S.callbackAt = cbEl.value;
  if (code === 'Callback' && !S.callbackAt) { toast('Pick a callback date & time first', true); cbEl && cbEl.focus(); return; }
  let rot = null;
  try {
    const rr = await api('/api/calls/' + S.active.callId, { disposition: code, notes: S.callNotes, callback_at: S.callbackAt ? new Date(S.callbackAt).getTime() : null }, 'PATCH');
    rot = rr.rotated;
  } catch (e) { return toast(e.message, true); }
  if (S.phase === 'connected') {
    const talk = (Date.now() - S.connectedAt) / 1000; S.stats.talk += talk;
    api('/api/hangup', {}).catch(() => {});
  }
  toast(rot ? `Wrong number — switched to the alternate number ${fmtPhone(rot.phone)}` : 'Saved: ' + code);
  S.active = null; S.callNotes = ''; S.callbackAt = ''; S.lastTalk = 0;
  S.phase = S.inSession ? 'ready' : 'idle';
  renderDialerAll(); if (S.route === 'lead' || S.route === 'calls') route();
  scheduleNext();
}

// ============ live events ============
function connectEvents() {
  es = new EventSource('/api/events');
  const on = (n, f) => es.addEventListener(n, e => f(JSON.parse(e.data)));
  es.onopen = () => setServer(true);
  es.onerror = () => setServer(false);
  on('line', d => {
    if (!S.batch) return;
    S.batch.status[d.callId] = d.status;
    if (d.outcome) S.batch.outcome[d.callId] = d.outcome;
    if (d.status === 'failed' && d.error) toast('Call failed: ' + d.error, true);
    renderLines();
  });
  on('notify', d => toast(d.text));
  on('connected', async d => {
    const line = S.batch?.lines.find(l => l.callId === d.callId);
    if (d.inbound) { S.batch = null; toast('Inbound call — ' + leadName(d.lead)); }
    S.active = { callId: d.callId, lead: d.lead || line?.lead || { id: d.leadId }, history: null, inbound: !!d.inbound };
    S.phase = 'connected'; S.connectedAt = Date.now(); S.stats.connects++; S.callNotes = ''; S.callbackAt = '';
    S.liveSegs = []; S.interim = { rep: '', lead: '' }; S.coach = []; S.liveStats = null; S.xfer = null;
    S.scriptNode = null; S.scriptPath = [];
    if (S.config.live) S.rightTab = 'live';
    if (S.batch) S.batch.status[d.callId] = 'live';
    clearTimeout(S.nextTimer); beep();
    if (S.route !== 'dialer') go('#/dialer'); else renderDialerAll();
    loadActiveHistory();
  });
  on('call_ended', d => {
    if (!S.active || d.callId !== S.active.callId || S.phase !== 'connected') return;
    S.lastTalk = d.duration || (Date.now() - S.connectedAt) / 1000;
    S.stats.talk += S.lastTalk; S.phase = 'wrap'; renderDialerAll();
  });
  on('batch_done', d => {
    if (!S.batch) return;
    S.batch = null;
    if (S.phase === 'dialing') { S.phase = 'ready'; if (d.forced) toast('Batch timed out — check Twilio call logs', true); }
    renderDialerAll();
    if (S.phase === 'ready') scheduleNext();
  });
  on('agent', d => { if (!d.inRoom && S.inSession) sessionEnded('Headset disconnected'); });
  on('live', d => {
    if (!S.active || d.callId !== S.active.callId) return;
    if (d.final) { S.liveSegs.push({ who: d.who, text: d.text }); S.interim[d.who] = ''; } else S.interim[d.who] = d.text;
    renderLive();
  });
  on('live_stats', d => { if (S.active && d.callId === S.active.callId) { S.liveStats = d; renderLiveStats(); } });
  on('coach', d => {
    if (!S.active || d.callId !== S.active.callId) return;
    S.coach.unshift({ ...d, at: Date.now() }); S.coach = S.coach.slice(0, 12);
    renderCoach(); renderLive();
  });
  on('transferred', d => {
    if (!S.active || d.callId !== S.active.callId) return;
    S.lastTalk = (Date.now() - S.connectedAt) / 1000; S.stats.talk += S.lastTalk;
    S.xfer = null; S.phase = 'wrap'; S.callNotes = (S.callNotes ? S.callNotes + '\n' : '') + 'Transferred to ' + fmtPhone(d.to);
    toast('Transferred to ' + fmtPhone(d.to)); renderDialerAll();
  });
  on('xfer', d => {
    if (!S.xfer) return;
    S.xfer.status = d.status;
    if (['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(d.status)) { toast('Transfer leg ended (' + d.status + ')', d.status !== 'completed'); S.xfer = null; }
    renderActive();
  });
  on('hot_lead', d => showHotLead(d));
  on('deal_alert', d => { beep(740); toast(d.text); if (S.route === 'deal' && Number(S.viewCtx.arg) === d.dealId) route(); });
  on('deal_update', d => { if (S.route === 'pipeline') { clearTimeout(S.pipeT); S.pipeT = setTimeout(() => S.route === 'pipeline' && route(), 600); } });
  on('email', d => {
    if (d.email.direction === 'in') { beep(660); toast('New email from ' + leadName(d.lead || { name: d.email.from_addr })); }
    if (S.route === 'lead' && Number(S.viewCtx.arg) === d.leadId) refreshLeadSide();
  });
  on('missed_call', d => { if (d.lead) toast((d.voicemail ? 'New voicemail from ' : 'Missed call from ') + leadName(d.lead)); });
  on('vm_saved', d => { toast(d.error ? 'Voicemail not saved: ' + d.error : 'Voicemail saved', !!d.error); if (S.route === 'settings') viewSettings(); });
  on('sms', d => {
    if (d.message.direction === 'in') { beep(660); toast('New text from ' + leadName(d.lead)); }
    refreshUnread();
    if (S.thread && S.thread.leadId === d.lead.id) appendMsg(d.message, true);
    if (S.route === 'inbox') refreshConvs();
  });
  on('sms_status', d => { if (S.thread && S.thread.leadId === d.message.lead_id) appendMsg(d.message, false); });
  on('sms_read', () => refreshUnread());
  on('call_ai', d => {
    if (S.route === 'lead' && Number(S.viewCtx.arg) === d.leadId) refreshLeadTimeline();
    if (S.active && S.active.lead.id === d.leadId) loadActiveHistory();
  });
}
function setServer(ok) { const p = $('#srvPill'); p.className = 'pill ' + (ok ? 'ok' : 'bad'); p.textContent = ok ? '● live' : '● reconnecting'; }
async function loadActiveHistory() {
  if (!S.active) return;
  const id = S.active.lead.id;
  try { const r = await api('/api/leads/' + id); if (S.active && S.active.lead.id === id) { S.active.lead = r.lead; S.active.history = r; renderDialerAll(); } } catch {}
}

// ============ chrome (header) ============
function renderChrome() {
  $('#liveDot').classList.toggle('live', S.inSession);
  const hs = $('#hdrSession'); hs.disabled = false;
  hs.textContent = S.inSession ? 'End session' : 'Start session'; hs.className = S.inSession ? 'danger' : 'primary';
  $('#stDials').textContent = S.stats.dials; $('#stConn').textContent = S.stats.connects;
  $('#stRate').textContent = S.stats.dials ? Math.round(S.stats.connects / S.stats.dials * 100) + '%' : '0%';
  const lb = $('#livebar');
  const show = S.route !== 'dialer' && ['dialing', 'connected', 'wrap'].includes(S.phase);
  lb.style.display = show ? 'flex' : 'none';
  lb.className = S.phase;
  if (show) lb.textContent = S.phase === 'connected' ? '● LIVE — ' + leadName(S.active?.lead) : S.phase === 'wrap' ? 'Wrap-up needed — ' + leadName(S.active?.lead) : 'Dialing…';
  tick();
}
function tick() {
  $('#stSess').textContent = S.inSession ? fmtDur((Date.now() - S.sessionStart) / 1000) : '0:00';
  const live = S.phase === 'connected' ? (Date.now() - S.connectedAt) / 1000 : 0;
  $('#stTalk').textContent = fmtDur(S.stats.talk + live);
  const t = $('#phaseTimer');
  if (t) t.textContent = S.phase === 'connected' ? fmtDur(live) : S.phase === 'dialing' && S.batch ? fmtDur((Date.now() - S.batch.startedAt) / 1000) : S.phase === 'wrap' ? fmtDur(S.lastTalk) : '';
}
setInterval(tick, 1000);
setInterval(() => { if (S.inSession && S.phase === 'ready' && !S.batch && S.prefs.auto) dialNext(true); }, 60000);

// ============ view: dialer ============
function renderDialerAll() {
  renderChrome();
  if (S.phase !== S.lastPhase) { S.lastPhase = S.phase; if (S.me) api('/api/presence', { phase: S.inSession ? S.phase : 'idle' }).catch(() => {}); }
  if (S.route === 'dialer') { renderControls(); renderBanner(); renderLines(); renderActive(); renderRight(); }
}
function viewDialer() {
  V(`<div class="dialer"><div>
    <div class="controls">
      <button id="btnSession" onclick="toggleSession()"></button><span class="sep"></span>
      <button id="btnNext" onclick="dialNext()" title="N">Dial next</button>
      <button id="btnAuto" onclick="toggleAuto()"></button>
      <button id="btnCancel" onclick="cancelBatch()">Stop dialing</button><span class="sep"></span>
      <button id="btnMute" onclick="toggleMute()" title="M">Mute</button>
      <button id="btnVm" onclick="dropVm()" title="V">Drop VM</button>
      <button id="btnXfer" onclick="transferModal()" title="T">Transfer</button>
      <button class="danger" id="btnHang" onclick="hangup()" title="H">Hang up</button>
    </div>
    <div class="controls">
      <label>List <select id="listSel" onchange="setPref('list',this.value)"></select></label>
      <label>Lines <select id="linesSel" onchange="setPref('lines',+this.value)">${[1, 2, 3, 4, 5].map(n => `<option>${n}</option>`).join('')}</select></label>
      <label><input type="checkbox" id="amdChk" onchange="setPref('amd',this.checked)"> Skip machines</label>
      <label title="Leave your recorded voicemail automatically when a machine answers"><input type="checkbox" id="vmChk" onchange="setPref('vmDrop',this.checked)"> Auto voicemail drop</label>
    </div>
    <div id="goalBar"></div>
    <div class="banner" id="banner"><div class="grow"><div class="ph" id="phase"></div><div class="sm" id="phaseSub"></div><div id="liveStats"></div></div><div class="tm" id="phaseTimer"></div></div>
    <div id="lines"></div>
    <div id="coachBox"></div>
    <div id="activeArea"></div>
  </div>
  <div class="card" style="position:sticky;top:0;padding:0;overflow:hidden">
    <div class="tabs"><button data-t="script" onclick="setTab('script')">Script</button><button data-t="live" onclick="setTab('live')">Live</button><button data-t="objections" onclick="setTab('objections')">Objections</button></div>
    <div id="rightPane" style="padding:14px;max-height:calc(100vh - 140px);overflow:auto"></div>
  </div></div>`);
  renderDialerAll();
}
function setTab(t) { S.rightTab = t; renderRight(); }
function renderControls() {
  const b = $('#btnSession'); if (!b) return;
  b.disabled = false; b.textContent = S.inSession ? 'End session' : 'Start session'; b.className = S.inSession ? 'danger' : 'primary';
  $('#btnNext').disabled = !(S.inSession && S.phase === 'ready' && !S.batch);
  $('#btnAuto').textContent = 'Auto-dial: ' + (S.prefs.auto ? 'on' : 'off'); $('#btnAuto').classList.toggle('on', S.prefs.auto);
  $('#btnCancel').disabled = S.phase !== 'dialing';
  $('#btnMute').disabled = !S.inSession; $('#btnMute').textContent = S.muted ? 'Unmute' : 'Mute'; $('#btnMute').classList.toggle('on', S.muted);
  $('#btnHang').disabled = $('#btnVm').disabled = $('#btnXfer').disabled = S.phase !== 'connected';
  $('#linesSel').value = S.prefs.lines; $('#amdChk').checked = S.prefs.amd; $('#vmChk').checked = S.prefs.vmDrop; $('#vmChk').disabled = !S.prefs.amd;
  const ls = $('#listSel');
  ls.innerHTML = `<option value="">All lists</option>` + S.lists.map(l => `<option value="${esc(l.name)}">${esc(l.name)} (${l.fresh || 0} new${l.callbacks ? ', ' + l.callbacks + ' cb' : ''})</option>`).join('');
  ls.value = S.prefs.list;
}
function renderBanner() {
  const b = $('#banner'); if (!b) return;
  const l = S.active?.lead, n = S.batch?.lines.length || '';
  const map = {
    idle: ['Offline', 'Start a session to connect your headset (allow microphone access).'],
    ready: [S.prefs.auto ? 'Ready' : 'Ready — manual', S.prefs.auto ? 'Auto-dial starts the next batch automatically.' : 'Press Dial next (N) or call any lead from its profile.'],
    dialing: [`Dialing ${n} line${n > 1 ? 's' : ''}…`, (S.prefs.amd ? (S.prefs.vmDrop ? 'Machines get your voicemail automatically. ' : 'Machines are skipped. ') : '') + 'First person to answer is connected to you.'],
    connected: [(S.active?.inbound ? 'INBOUND — ' : 'LIVE — ') + leadName(l), [l?.business && l?.name ? l.business : '', fmtPhone(l?.phone)].filter(Boolean).join(' · ')],
    wrap: ['Wrap-up', 'Call ended — add notes and pick a disposition.'],
  };
  b.className = 'banner ' + S.phase;
  $('#phase').textContent = map[S.phase][0]; $('#phaseSub').textContent = map[S.phase][1];
  renderLiveStats(); tick();
}
function renderLiveStats() {
  const el = $('#liveStats'); if (!el) return;
  const st = S.liveStats;
  if (!st || !['connected', 'wrap'].includes(S.phase)) { el.innerHTML = ''; return; }
  const warn = st.repPct > 65, mono = S.phase === 'connected' && st.monologue >= 45;
  el.innerHTML = `<div class="row" style="margin-top:8px;gap:10px;font-size:12px">
    <span class="muted">Talk ratio</span>
    <div style="flex:0 0 160px;height:8px;border-radius:4px;background:var(--blue);overflow:hidden"><div style="height:100%;width:${st.repPct}%;background:${warn ? 'var(--amber)' : 'var(--green)'}"></div></div>
    <span class="mono" style="color:${warn ? 'var(--amber)' : 'var(--text2)'}">You ${st.repPct}% · Them ${100 - st.repPct}%</span>
    ${mono ? `<span class="badge callback">You've talked ${st.monologue}s straight — ask a question</span>` : ''}</div>`;
}
function renderLines() {
  const el = $('#lines'); if (!el) return;
  const b = S.batch; if (!b || !b.lines.length) { el.innerHTML = ''; return; }
  el.innerHTML = b.lines.map(({ callId, lead, from }) => {
    const st = b.status[callId] || 'queued';
    const live = st === 'live' || (S.active && S.active.callId === callId && S.phase === 'connected');
    const label = live ? 'connected' : st === 'vm_drop' ? 'voicemail dropped' : FINAL.includes(st) ? (b.outcome[callId] || st) : (LINE_LABEL[st] || st);
    const cls = live ? 'live' : ['ringing', 'initiated', 'in-progress', 'answered'].includes(st) ? 'ringing' : st === 'failed' ? 'bad' : '';
    return `<div class="line ${cls}"><div class="nm">${esc(leadName(lead))}</div><div class="mono faint" style="font-size:11px">${esc(fmtPhone(lead.phone))}</div>
      <div class="st">${esc(label)}</div>${lead.local_time ? `<div class="faint mono" style="font-size:10px">${esc(lead.local_time)}</div>` : ''}${from && from !== S.config.callerId ? `<div class="faint mono" style="font-size:10px">from ${esc(fmtPhone(from))}</div>` : ''}</div>`;
  }).join('');
}
function renderCoach() {
  const el = $('#coachBox'); if (!el) return;
  const c = S.phase === 'connected' && S.coach[0];
  el.innerHTML = c ? `<div class="ai" style="margin:0 0 12px;border-color:rgba(188,140,255,.5)">
    <div class="row"><span class="lbl" style="margin:0">AI coach · ${esc(c.type.replace('_', ' '))}</span><b style="font-size:13px">${esc(c.title)}</b><span class="faint mono" style="margin-left:auto;font-size:10px">${fmtClock(c.at)}</span></div>
    <div style="font-size:15px;margin-top:6px;line-height:1.45">“${esc(c.say)}”</div></div>` : '';
}
function renderActive() {
  renderCoach();
  const el = $('#activeArea'); if (!el) return;
  if (!S.active) {
    el.innerHTML = `<div class="card"><div class="empty">${S.inSession ? 'Waiting for a live answer…' : 'No active call.'}<br><br><a href="#/leads">Browse leads</a></div></div>`;
    return;
  }
  const l = S.active.lead, h = S.active.history, canDispo = ['connected', 'wrap'].includes(S.phase);
  const f = (k, v) => v ? `<div class="f"><span>${esc(k)}</span><div>${esc(v)}</div></div>` : '';
  const prev = h ? h.calls.filter(c => c.id !== S.active.callId) : [];
  const xf = S.xfer;
  el.innerHTML = `
  ${xf ? `<div class="banner" style="border-color:var(--purple);margin-bottom:12px"><div><div class="ph" style="color:var(--purple);font-size:15px">Warm transfer → ${esc(fmtPhone(xf.to))}</div><div class="sm">${esc(xf.status === 'answered' || xf.status === 'in-progress' ? 'They’re on — introduce the merchant, then complete.' : 'Calling ' + (xf.status || '') + '…')}</div></div>
    <div class="row"><button onclick="cancelTransfer()">Cancel</button><button class="primary" onclick="completeTransfer()">Complete transfer</button></div></div>` : ''}
  <div class="card" style="margin-bottom:12px">
    <div class="row" style="align-items:flex-start">
      <div class="grow"><h2 style="font-size:20px">${esc(leadName(l))}</h2><div class="muted">${esc(l.name ? l.business : '')}</div></div>
      <span class="badge ${esc(l.status)}">${esc(l.status || '')}</span>
      ${h && h.deals && h.deals.length ? `<a href="#/deal/${h.deals[0].id}"><button class="sm">Deal: ${esc(STAGE_LABELS[h.deals[0].stage])}</button></a>` : ''}
      ${l.id ? `<a href="#/lead/${l.id}"><button class="sm">Open profile</button></a>` : ''}
    </div>
    <div class="fields">${f('Phone', fmtPhone(l.phone))}${f('Their time', l.local_time)}${f('Email', l.email)}${f('State', l.state)}${f('Attempts', l.attempts ? String(l.attempts) : '')}${f('Owner', l.owner_name)}${f('List', l.source)}
      ${Object.entries(l.extra || {}).map(([k, v]) => f(k, v)).join('')}</div>
    <textarea id="callNotes" rows="4" placeholder="Call notes…" oninput="S.callNotes=this.value">${esc(S.callNotes)}</textarea>
  </div>
  <div class="card" style="margin-bottom:12px">
    <div class="dispos">${DISPOS.map(d => `<button class="${d.cls}" ${canDispo ? '' : 'disabled'} onclick="saveDispo('${d.code}')"><kbd>${d.key}</kbd>${d.code}</button>`).join('')}</div>
    <div class="row" style="margin-top:10px"><span class="muted">Callback at</span><input type="datetime-local" id="cbAt" value="${esc(S.callbackAt)}" onchange="S.callbackAt=this.value">
      ${[['+1h', 1], ['+3h', 3], ['Tomorrow 10am', 'tm']].map(([t, v]) => `<button class="sm" onclick="quickCb('${v}')">${t}</button>`).join('')}</div>
  </div>
  <div class="card"><h3>History with this lead</h3>
    ${!h ? '<div class="faint">Loading…</div>' : (prev.length || h.notes.length || h.messages.length) ? `
      ${h.notes.slice(0, 3).map(n => `<div class="tl-item"><div class="tl-head"><span class="badge">Note</span><span class="muted">${esc(n.user_name || '')}</span><span class="when">${fmtTime(n.created_at)}</span></div><div class="tl-body">${esc(n.body)}</div></div>`).join('')}
      ${prev.slice(0, 5).map(callCard).join('')}
      ${h.messages.length ? `<div class="muted" style="margin-top:6px">${h.messages.length} text message(s) — <a href="#/lead/${l.id}">view thread</a></div>` : ''}`
      : '<div class="faint">First contact — no previous calls, notes or texts.</div>'}
  </div>`;
}
function quickCb(v) {
  const d = new Date();
  if (v === 'tm') { d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0); } else d.setHours(d.getHours() + Number(v));
  S.callbackAt = toLocalInput(d.getTime()); const el = $('#cbAt'); if (el) el.value = S.callbackAt;
}
function renderRight() {
  const pane = $('#rightPane'); if (!pane) return;
  document.querySelectorAll('.tabs button[data-t]').forEach(b => b.classList.toggle('act', b.dataset.t === S.rightTab));
  if (S.rightTab === 'script') renderScriptPane(pane);
  else if (S.rightTab === 'live') renderLive();
  else pane.innerHTML = `<div class="faint" style="font-size:11px;margin-bottom:10px">Quick answers for common objections. ${isAdmin() ? 'Edit them under Team &amp; setup.' : ''}</div>` +
    String(S.playbook || '').split('\n').filter(x => x.trim()).map(line => { const i = line.indexOf(':'); return `<div class="tl-item"><b>${esc(i > 0 ? line.slice(0, i) : 'Tip')}</b><div class="tl-body">${esc(fill(i > 0 ? line.slice(i + 1).trim() : line, S.active?.lead))}</div></div>`; }).join('');
}

// branching scripts: "# id: Title" starts a step, "-> Button label: target_id" adds a choice
function parseScript(txt) {
  const nodes = {}, order = []; let cur = null;
  for (const line of String(txt || '').split('\n')) {
    const h = /^#\s*([\w-]+)\s*:\s*(.*)$/.exec(line);
    if (h) { cur = { id: h[1], title: h[2].trim(), body: [], choices: [] }; nodes[cur.id] = cur; order.push(cur.id); continue; }
    const c = /^->\s*(.+?)\s*:\s*([\w-]+)\s*$/.exec(line);
    if (c && cur) { cur.choices.push({ label: c[1], to: c[2] }); continue; }
    if (!cur) { cur = { id: 'start', title: '', body: [], choices: [] }; nodes.start = cur; order.push('start'); }
    cur.body.push(line);
  }
  return { nodes, start: order[0] };
}
function renderScriptPane(pane) {
  const sc = parseScript(S.script || DEFAULT_SCRIPT);
  const id = S.scriptNode && sc.nodes[S.scriptNode] ? S.scriptNode : sc.start;
  const n = sc.nodes[id]; if (!n) { pane.innerHTML = '<div class="faint">No script yet.</div>'; return; }
  pane.innerHTML = `
    ${Object.keys(sc.nodes).length > 1 ? `<div class="row" style="margin-bottom:10px">${S.scriptPath.length ? '<button class="sm" onclick="scriptBack()">‹ Back</button>' : ''}<b class="grow">${esc(n.title)}</b><button class="sm" onclick="scriptGo(null)">Restart</button></div>` : ''}
    <div id="scriptView">${esc(fill(n.body.join('\n').trim(), S.active?.lead))}</div>
    ${n.choices.length ? `<div style="display:flex;flex-direction:column;gap:6px;margin-top:14px">${n.choices.map(c => `<button style="text-align:left" onclick="scriptGo('${esc(c.to)}')">→ ${esc(c.label)}</button>`).join('')}</div>` : ''}`;
}
function scriptGo(to) { if (to === null) { S.scriptNode = null; S.scriptPath = []; } else { S.scriptPath.push(S.scriptNode); S.scriptNode = to; } renderRight(); }
function scriptBack() { S.scriptNode = S.scriptPath.pop() || null; renderRight(); }
function renderLive() {
  const pane = $('#rightPane'); if (!pane || S.rightTab !== 'live') return;
  if (!S.config.live) { pane.innerHTML = '<div class="faint">Live transcription is off. Add a Deepgram key to turn it on.</div>'; return; }
  if (!S.active) { pane.innerHTML = '<div class="faint">The live transcript and AI coaching show up here during a call.</div>'; return; }
  const segs = S.liveSegs.slice(-60).map(x => `<div style="margin-bottom:6px"><b style="color:${x.who === 'rep' ? 'var(--green)' : 'var(--blue)'};font-size:11px" class="mono">${x.who === 'rep' ? 'YOU' : 'THEM'}</b> ${esc(x.text)}</div>`).join('');
  const interim = ['lead', 'rep'].filter(w => S.interim[w]).map(w => `<div class="faint" style="margin-bottom:6px"><b class="mono" style="font-size:11px">${w === 'rep' ? 'YOU' : 'THEM'}</b> ${esc(S.interim[w])}…</div>`).join('');
  pane.innerHTML = `${S.coach.length ? `<h3>Coach suggestions</h3>${S.coach.slice(0, 4).map(c => `<div class="ai" style="margin-top:6px"><div class="lbl">${esc(c.title)}</div>${esc(c.say)}</div>`).join('')}<h3 style="margin-top:14px">Transcript</h3>` : ''}
    <div id="liveScroll">${segs || interim ? segs + interim : '<div class="faint">Listening…</div>'}</div>`;
  pane.scrollTop = pane.scrollHeight;
}

// ============ shared: call card ============
function scoreColor(n) { return n >= 75 ? 'var(--green)' : n >= 50 ? 'var(--amber)' : 'var(--red)'; }
function callCard(c) {
  const ai = c.ai;
  let aiHtml = '';
  if (c.ai_status === 'done' && ai) {
    const facts = Object.entries(ai.facts || {}).filter(([, v]) => v);
    const sc = ai.scorecard || {};
    aiHtml = `<div class="ai"><div class="row"><div class="lbl" style="margin:0">AI call notes</div>
        ${c.score != null ? `<span class="mono" style="margin-left:auto;font-size:12px">Score <b style="color:${scoreColor(c.score)};font-size:15px">${c.score}</b>/100</span>` : ''}</div>
      <div style="margin-top:5px">${esc(ai.summary)}</div>
      ${ai.next_steps?.length ? `<div style="margin-top:8px"><b style="font-size:12px">Next steps</b><ul>${ai.next_steps.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      ${ai.objections?.length ? `<div style="margin-top:6px"><b style="font-size:12px">Objections</b><ul>${ai.objections.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      ${ai.callback ? `<div style="margin-top:6px"><b style="font-size:12px">Callback:</b> ${esc(ai.callback)}</div>` : ''}
      ${facts.length ? `<div class="facts">${facts.map(([k, v]) => `<div><span>${esc(k.replace(/_/g, ' '))}:</span> ${esc(v)}</div>`).join('')}</div>` : ''}
      ${Object.keys(sc).length || ai.coaching_tips?.length ? `<details><summary>Scorecard &amp; coaching</summary>
        <div class="facts">${Object.entries(sc).map(([k, v]) => `<div><span>${esc(k.replace(/_/g, ' '))}:</span> <b>${esc(v)}</b>/10</div>`).join('')}
        ${c.talk_ratio != null ? `<div><span>rep talk time:</span> <b>${Math.round(c.talk_ratio * 100)}%</b></div>` : ''}${ai.filler_words != null ? `<div><span>filler words:</span> <b>${ai.filler_words}</b></div>` : ''}${ai.sentiment ? `<div><span>sentiment:</span> ${esc(ai.sentiment)}</div>` : ''}</div>
        ${ai.coaching_tips?.length ? `<ul style="margin-top:6px">${ai.coaching_tips.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</details>` : ''}
      ${ai.follow_up_sms ? `<div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(188,140,255,.25)"><b style="font-size:12px">Suggested follow-up text</b><div style="margin-top:3px">${esc(ai.follow_up_sms)}</div>
        <button class="sm" style="margin-top:6px" onclick="useFollowUp(${c.id})">Use in text box</button></div>` : ''}
    </div>`;
  } else if (c.ai_status === 'pending') aiHtml = `<div class="ai"><div class="lbl">AI call notes</div><span class="muted">Transcribing and summarizing…</span></div>`;
  else if (c.ai_status === 'error') aiHtml = `<div class="ai"><div class="lbl">AI call notes</div><span style="color:var(--red)">${esc(c.ai_error)}</span> <button class="sm" onclick="retryAI(${c.id})">Retry</button></div>`;
  else if (c.ai_status === 'skipped' && c.connected && !c.vm_dropped) aiHtml = `<div class="faint" style="margin-top:6px;font-size:11px">No AI notes: ${esc(c.ai_error)}</div>`;
  else if (c.connected && !c.vm_dropped && S.config.ai && c.ended_at && Date.now() - c.ended_at < 5 * 60000) aiHtml = `<div class="faint" style="margin-top:6px;font-size:11px">AI notes on the way…</div>`;
  S.cardCalls = S.cardCalls || {}; S.cardCalls[c.id] = c;
  const dcls = c.disposition === 'Callback' ? 'callback' : c.disposition === 'DNC' ? 'dnc' : ['Interested', 'App Sent'].includes(c.disposition) ? 'good' : '';
  if (c.qa === 'flagged' && isAdmin()) aiHtml = qaBanner(c) + aiHtml;
  return `<div class="tl-item">
    <div class="tl-head">
      <span title="${c.direction === 'in' ? 'Inbound' : 'Outbound'}">${c.direction === 'in' ? '↙' : '↗'}</span><span class="badge ${c.connected ? 'good' : ''}">${esc(c.outcome || c.status)}</span>
      ${c.disposition && c.disposition !== c.outcome ? `<span class="badge ${dcls}">${esc(c.disposition)}</span>` : ''}
      ${c.transferred_to ? `<span class="badge aib">→ ${esc(fmtPhone(c.transferred_to))}</span>` : ''}
      ${c.duration ? `<span class="mono muted">${fmtDur(c.duration)}</span>` : ''}
      ${c.score != null ? `<span class="mono" style="color:${scoreColor(c.score)};font-size:11px">★ ${c.score}</span>` : ''}
      <span class="muted">${esc(c.user_name || '')}</span>
      ${c.lead_name !== undefined ? `<a href="#/lead/${c.lead_id}">${esc(c.lead_name || c.lead_business || fmtPhone(c.lead_phone))}</a>` : ''}
      <span class="when">${fmtTime(c.started_at)}</span>
    </div>
    ${c.notes ? `<div class="tl-body" style="white-space:pre-wrap">${esc(c.notes)}</div>` : ''}
    ${c.error ? `<div class="tl-body" style="color:var(--red);font-size:12px">${esc(c.error)}</div>` : ''}
    ${c.has_recording ? `<audio controls preload="none" src="/api/calls/${c.id}/recording"></audio>` : ''}
    ${aiHtml}
    ${c.transcript ? `<details><summary>Transcript</summary><div class="transcript">${esc(c.transcript)}</div></details>` : ''}
  </div>`;
}
function useFollowUp(id) {
  const c = S.cardCalls?.[id]; if (!c?.ai?.follow_up_sms) return;
  const ta = $('#smsText');
  if (!ta || !S.thread || S.thread.leadId !== c.lead_id) { S.pendingSms = c.ai.follow_up_sms; return go('#/lead/' + c.lead_id); }
  ta.value = c.ai.follow_up_sms; ta.oninput(); ta.focus();
}
async function retryAI(id) { try { await api('/api/calls/' + id + '/ai', {}); toast('Re-running AI notes…'); } catch (e) { toast(e.message, true); } }

// ============ view: leads ============
function viewLeads() {
  const q = S.leadsQ = S.leadsQ || { q: '', status: '', owner: '', list: '', sort: 'recent', page: 0 };
  V(`<div class="vtitle"><h1>Leads</h1><span class="muted" id="leadTotal"></span>
      <div class="row" style="margin-left:auto"><button onclick="importModal()">Import CSV</button><button onclick="addLeadModal()">+ Add lead</button><button onclick="exportLeads()">Export</button></div></div>
    <div class="row wrap" style="margin-bottom:10px">
      <input id="lq" placeholder="Search name, business, phone, email, state…" style="width:300px" value="${esc(q.q)}">
      <select id="lstatus"><option value="">All statuses</option><option value="dialable">Dialable now</option><option value="new">New / retry</option><option value="callback">Callbacks</option><option value="callback_due">Callbacks due</option><option value="done">Closed</option><option value="dnc">DNC</option><option value="unread">Unread texts</option></select>
      <select id="lowner"><option value="">All owners</option><option value="me">Mine</option><option value="none">Unassigned</option>${S.users.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select>
      <select id="llist"><option value="">All lists</option>${S.lists.map(l => `<option value="${esc(l.name)}">${esc(l.name)} (${l.total})</option>`).join('')}</select>
      <select id="lsort"><option value="recent">Recently updated</option><option value="created">Newest</option><option value="name">Name</option><option value="last_called">Last called</option><option value="callback">Callback time</option><option value="attempts">Most attempts</option><option value="sms">Latest text</option></select>
      <span class="muted" id="countsLine" style="margin-left:auto"></span>
    </div>
    <div id="bulkBar" class="row hidden" style="margin-bottom:10px;padding:8px 12px;border:1px solid var(--border2);border-radius:8px;background:var(--panel2)">
      <b id="selCount"></b>
      <select id="bulkOwner"><option value="">Assign to…</option><option value="0">Unassigned</option>${S.users.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select>
      <button class="sm" onclick="bulk('assign', $('#bulkOwner').value)">Assign</button>
      <button class="sm" onclick="const n=prompt('Move to list (name):');if(n!==null)bulk('list',n)">Move to list</button>
      <button class="sm" onclick="enrollModal(selected())">Add to sequence</button>
      <button class="sm" onclick="bulk('reset')">Reset attempts</button>
      <button class="sm" onclick="bulk('status','dnc')">Mark DNC</button>
      <button class="sm" onclick="bulk('status','done')">Mark closed</button>
      ${isAdmin() ? '<button class="sm danger" onclick="bulk(\'delete\')">Delete</button>' : ''}
    </div>
    <div class="tablewrap"><table><thead><tr><th><input type="checkbox" id="selAll"></th><th>Lead</th><th>Phone</th><th>State</th><th>Status</th><th>List</th><th>Owner</th><th>Tries</th><th>Last outcome</th><th>Last called</th><th>Callback</th></tr></thead><tbody id="leadRows"><tr><td colspan="11" class="empty">Loading…</td></tr></tbody></table></div>
    <div class="pager" id="pager"></div>`);
  $('#lstatus').value = q.status; $('#lowner').value = q.owner; $('#lsort').value = q.sort; $('#llist').value = q.list;
  let t; $('#lq').oninput = e => { clearTimeout(t); t = setTimeout(() => { q.q = e.target.value; q.page = 0; loadLeads(); }, 250); };
  ['lstatus', 'lowner', 'lsort', 'llist'].forEach(id => $('#' + id).onchange = e => { q[id.slice(1)] = e.target.value; q.page = 0; loadLeads(); });
  $('#selAll').onchange = e => { document.querySelectorAll('.lsel').forEach(c => c.checked = e.target.checked); selChanged(); };
  loadLeads();
}
function leadParams(extra = {}) { const q = S.leadsQ; return new URLSearchParams({ q: q.q, status: q.status, owner: q.owner, list: q.list, sort: q.sort, page: q.page, limit: 100, retryMins: S.prefs.retryMins, maxAttempts: S.prefs.maxAttempts, ...extra }).toString(); }
async function loadLeads() {
  const r = await api('/api/leads?' + leadParams()).catch(e => { toast(e.message, true); return null; });
  if (!r || S.route !== 'leads') return;
  const c = r.counts;
  $('#leadTotal').textContent = r.total.toLocaleString() + ' leads';
  $('#countsLine').textContent = `Dialable ${c.dialable || 0} · New ${c.new || 0} · Callbacks ${c.callback || 0} · Closed ${c.done || 0} · DNC ${c.dnc || 0}`;
  $('#leadRows').innerHTML = r.rows.length ? r.rows.map(l => `<tr class="click" onclick="if(event.target.type!=='checkbox')go('#/lead/${l.id}')">
    <td><input type="checkbox" class="lsel" value="${l.id}" onchange="selChanged()"></td>
    <td><b>${esc(leadName(l))}</b>${l.unread_sms ? ' <span class="badge dnc">' + l.unread_sms + ' new</span>' : ''}<div class="muted" style="font-size:12px">${esc(l.name ? l.business : '')}</div></td>
    <td class="mono">${esc(fmtPhone(l.phone))}</td><td>${esc(l.state)}</td>
    <td><span class="badge ${esc(l.status)}">${esc(l.status)}</span></td><td class="muted">${esc(l.source)}</td><td>${esc(l.owner_name || '')}</td>
    <td class="mono">${l.attempts || 0}</td><td>${esc(l.last_outcome)}</td><td class="muted">${fmtTime(l.last_called)}</td><td class="muted">${fmtTime(l.callback_at)}</td></tr>`).join('')
    : `<tr><td colspan="11" class="empty">No leads found.${r.total === 0 && !S.leadsQ.q ? ' <a href="javascript:importModal()">Import a CSV</a> to get started.' : ''}</td></tr>`;
  const q = S.leadsQ, pages = Math.ceil(r.total / 100);
  $('#pager').innerHTML = pages > 1 ? `<button class="sm" ${q.page ? '' : 'disabled'} onclick="S.leadsQ.page--;loadLeads()">‹ Prev</button><span>Page ${q.page + 1} of ${pages}</span><button class="sm" ${q.page + 1 < pages ? '' : 'disabled'} onclick="S.leadsQ.page++;loadLeads()">Next ›</button>` : '';
  selChanged();
}
function selected() { return [...document.querySelectorAll('.lsel:checked')].map(c => +c.value); }
function selChanged() { const n = selected().length; $('#bulkBar').classList.toggle('hidden', !n); $('#selCount').textContent = n + ' selected'; }
async function bulk(action, value) {
  const ids = selected(); if (!ids.length) return;
  if (action === 'assign' && value === '') return toast('Pick who to assign to', true);
  if (action === 'delete' && !confirm(`Delete ${ids.length} leads and all their calls, notes and texts?`)) return;
  try { await api('/api/leads/bulk', { ids, action, value: value === '0' ? null : value }); toast(`Updated ${ids.length} leads`); loadLeads(); } catch (e) { toast(e.message, true); }
}
function exportLeads() { location.href = '/api/leads/export.csv?' + leadParams(); }

// ============ import / add ============
function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  const firstLine = text.split('\n')[0], delim = firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : ',';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}
const IMP_FIELDS = [['ignore', "Don't import"], ['phone', 'Phone'], ['name', 'Name'], ['first', 'First name'], ['last', 'Last name'], ['biz', 'Business'], ['email', 'Email'], ['state', 'State'], ['notes', 'Notes'], ['extra', 'Keep as extra info']];
// guess what each column is from its header (or from the data, if there is no header row)
function detectMap(rows) {
  const head = rows[0].map(h => h.trim().toLowerCase()), n = head.length;
  const isHead = head.some(h => /phone|mobile|cell|tel|number|name|business|company|email/.test(h)) && !rows[0].some(v => normPhone(v));
  const map = new Array(n).fill(isHead ? 'extra' : 'ignore');
  if (!isHead) {
    const pi = rows[0].findIndex(v => normPhone(v)); if (pi >= 0) { map[pi] = 'phone'; if (pi > 0) map[0] = 'name'; if (pi > 1) map[1] = 'biz'; }
    return { map, hasHead: false };
  }
  const set = (re, f, only) => { head.forEach((h, i) => { if (re.test(h) && map[i] === 'extra' && (!only || !map.includes(f))) map[i] = f; }); };
  head.forEach((h, i) => { if (/phone|mobile|cell|tel|number/.test(h) && !/fax/.test(h)) map[i] = 'phone'; });
  set(/^(name|full ?name|contact|contact ?name|owner|owner ?name|principal|principal ?name)$/, 'name', true);
  set(/first/, 'first', true); set(/last/, 'last', true);
  set(/business|company|dba|legal|merchant|debtor|organization/, 'biz', true);
  set(/e-?mail/, 'email', true); set(/^(state|st|province)$/, 'state', true); set(/note/, 'notes', true);
  return { map, hasHead: true };
}
function rowsToLeads(rows, map, hasHead) {
  const head = rows[0].map(h => h.trim()), data = hasHead ? rows.slice(1) : rows, idx = f => map.map((m, i) => m === f ? i : -1).filter(i => i >= 0);
  const phoneCols = idx('phone'); if (!phoneCols.length) return [];
  const one = f => idx(f)[0] ?? -1;
  return data.map(r => {
    const get = i => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');
    let phone = null, phoneIdx = -1;
    for (const i of phoneCols) { phone = normPhone(r[i]); if (phone) { phoneIdx = i; break; } }
    const extra = {}, alt = [];
    map.forEach((m, i) => { if (m === 'extra' && get(i)) extra[head[i] || 'Column ' + (i + 1)] = get(i); });
    // the first valid phone is the main number; other phone columns become alternates the dialer can fall back to
    phoneCols.forEach(i => { if (i !== phoneIdx && get(i)) { const np = normPhone(get(i)); if (np && np !== phone) alt.push(np); else if (!np) extra[head[i] || 'Phone ' + (i + 1)] = get(i); } });
    if (!phone) return { bad: true, raw: get(phoneCols[0]) };
    return { name: get(one('name')) || [get(one('first')), get(one('last'))].filter(Boolean).join(' '), business: get(one('biz')), phone, email: get(one('email')), state: get(one('state')), notes: get(one('notes')), extra, alt_phones: [...new Set(alt)] };
  });
}
function importModal() {
  openModal(`<h3>Import leads</h3>
    <div class="mf"><label>CSV file — any columns. You'll check how they're read before anything is imported.</label><input type="file" id="impFile" accept=".csv,.txt,.tsv"></div>
    <div class="mf"><label>…or paste CSV</label><textarea id="impText" rows="5" placeholder="Name,Business,Phone,Email,State&#10;John Smith,Smith Plumbing LLC,(212) 555-0101,john@smith.com,NY"></textarea></div>
    <div class="grid2"><div class="mf"><label>List name (lead source)</label><input id="impSource" placeholder="e.g. TX UCC Oct" list="listNames"><datalist id="listNames">${S.lists.map(l => `<option value="${esc(l.name)}">`).join('')}</datalist></div>
    <div class="mf"><label>Assign to</label><select id="impOwner"><option value="">Shared pool (anyone can dial)</option>${S.users.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></div>
    ${isAdmin() ? `<div class="mf"><label>Vendor (optional)</label><input id="impVendor" placeholder="who you bought it from"></div>
    <div class="mf"><label>Total cost of this list $ (optional)</label><input id="impCost" type="number" min="0" step="any" placeholder="used for cost per lead and ROI reports"></div>
    <div class="mf"><label>Batch name (optional)</label><input id="impBatch" placeholder="e.g. Lead Tycoons 5/18 aged — tracks ROI per batch"></div>` : ''}</div>
    <div id="impMsg" class="muted"></div>
    <div class="mact"><button onclick="closeModal()">Cancel</button><button class="primary" id="impBtn" onclick="importReview()">Next: review</button></div>`);
}
let IMP = null;
async function importReview() {
  let text = $('#impText').value; const file = $('#impFile').files[0];
  if (file) text = await file.text();
  if (!text.trim()) return toast('Choose a file or paste CSV', true);
  const rows = parseCSV(text); if (!rows.length) return toast('That file looks empty', true);
  const name = $('#impSource').value.trim() || (file ? file.name.replace(/\.[^.]+$/, '') : 'Import');
  const { map, hasHead } = detectMap(rows);
  IMP = { rows, map, hasHead, name, owner: $('#impOwner').value || null, vendor: ($('#impVendor') || {}).value || '', cost: ($('#impCost') || {}).value || '', batch: ($('#impBatch') || {}).value || '', file: file ? file.name : '' };
  importStep2();
}
async function importStep2() {
  const I = IMP, head = I.rows[0], sample = I.rows.slice(I.hasHead ? 1 : 0, (I.hasHead ? 1 : 0) + 4);
  const hasPhone = I.map.includes('phone');
  openModal(`<h3>Check your columns</h3>
    <div class="faint" style="font-size:12px;margin-bottom:8px">${(I.rows.length - (I.hasHead ? 1 : 0)).toLocaleString()} rows · importing into <b>${esc(I.name)}</b>. Change a dropdown if a column was read wrong.</div>
    <div class="tablewrap" style="max-height:230px;overflow:auto;margin-bottom:10px"><table><thead><tr>${I.map.map((m, i) => `<th style="vertical-align:top"><div class="faint" style="font-size:10px;margin-bottom:3px">${esc(I.hasHead ? head[i] : 'Column ' + (i + 1))}</div>
      <select onchange="IMP.map[${i}]=this.value;importCheck()">${IMP_FIELDS.map(([v, l]) => `<option value="${v}" ${m === v ? 'selected' : ''}>${l}</option>`).join('')}</select></th>`).join('')}</tr></thead>
      <tbody>${sample.map(r => `<tr>${I.map.map((m, i) => `<td class="${m === 'ignore' ? 'faint' : ''}" style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r[i] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <div id="impCheck" class="card" style="margin-bottom:10px">${hasPhone ? 'Checking…' : '<span style="color:var(--red)">Choose which column is the phone number.</span>'}</div>
    <div class="mact"><button onclick="importModal()">Back</button><button class="primary" id="impBtn" onclick="doImport()" ${hasPhone ? '' : 'disabled'}>Import</button></div>`, true);
  if (hasPhone) importCheck();
}
let impChkT;
function importCheck() {
  clearTimeout(impChkT);
  const hasPhone = IMP.map.includes('phone'); const b = $('#impBtn'); if (b) b.disabled = !hasPhone;
  if (!hasPhone) { $('#impCheck').innerHTML = '<span style="color:var(--red)">Choose which column is the phone number.</span>'; return; }
  impChkT = setTimeout(async () => {
    const all = rowsToLeads(IMP.rows, IMP.map, IMP.hasHead); IMP.leads = all.filter(l => !l.bad); IMP.badRows = all.length - IMP.leads.length;
    const el = $('#impCheck'); if (!el) return;
    if (!IMP.leads.length) { el.innerHTML = '<span style="color:var(--red)">No valid phone numbers found in that column.</span>'; if ($('#impBtn')) $('#impBtn').disabled = true; return; }
    try {
      let tot = { dupes: 0, dnc: 0, repeats_in_file: 0, existing: {} };
      for (let i = 0; i < IMP.leads.length; i += 5000) {
        const r = await api('/api/leads/check', { phones: IMP.leads.slice(i, i + 5000).map(l => l.phone) });
        tot.dupes += r.dupes; tot.dnc += r.dnc; tot.repeats_in_file += r.repeats_in_file; for (const [k, v] of Object.entries(r.existing)) tot.existing[k] = (tot.existing[k] || 0) + v;
      }
      IMP.chk = tot;
      const fresh = Math.max(0, IMP.leads.length - tot.dupes - tot.repeats_in_file);
      el.innerHTML = `<div class="row" style="gap:18px;flex-wrap:wrap"><div><b class="mono" style="font-size:18px;color:var(--green)">${fresh.toLocaleString()}</b><div class="faint" style="font-size:11px">new leads to add</div></div>
        <div><b class="mono" style="font-size:18px">${tot.dupes.toLocaleString()}</b><div class="faint" style="font-size:11px">already in your CRM (skipped)</div></div>
        <div><b class="mono" style="font-size:18px">${tot.repeats_in_file.toLocaleString()}</b><div class="faint" style="font-size:11px">repeated in this file</div></div>
        <div><b class="mono" style="font-size:18px;${tot.dnc ? 'color:var(--amber)' : ''}">${tot.dnc.toLocaleString()}</b><div class="faint" style="font-size:11px">on your DNC list (saved, never dialed)</div></div>
        <div><b class="mono" style="font-size:18px;${IMP.badRows ? 'color:var(--red)' : ''}">${IMP.badRows.toLocaleString()}</b><div class="faint" style="font-size:11px">no valid phone (skipped)</div></div></div>
        ${Object.keys(tot.existing).length ? `<div class="faint" style="font-size:12px;margin-top:8px">Already-in-CRM leads came from: ${Object.entries(tot.existing).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${esc(k)} (${v.toLocaleString()})`).join(', ')}. They keep their original list.</div>` : ''}`;
      if ($('#impBtn')) { $('#impBtn').disabled = false; $('#impBtn').textContent = `Import ${fresh.toLocaleString()} ${fresh === 1 ? 'lead' : 'leads'}`; }
    } catch (e) { el.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>`; }
  }, 150);
}
async function doImport() {
  const I = IMP; if (!I || !I.leads || !I.leads.length) return toast('Nothing to import', true);
  $('#impBtn').disabled = true;
  const tot = { added: 0, dupes: 0, bad: I.badRows || 0, dnc: 0, dupe_sources: {} };
  for (let i = 0; i < I.leads.length; i += 2000) {
    $('#impBtn').textContent = `Importing ${Math.min(i + 2000, I.leads.length).toLocaleString()} of ${I.leads.length.toLocaleString()}…`;
    try {
      const r = await api('/api/leads/import', { leads: I.leads.slice(i, i + 2000), owner_id: I.owner, source: I.name, batch: I.batch || undefined, ...(i === 0 && I.cost ? { cost: I.cost, vendor: I.vendor } : {}) });
      tot.added += r.added; tot.dupes += r.dupes; tot.bad += r.bad; tot.dnc += r.dnc || 0;
      for (const [k, v] of Object.entries(r.dupe_sources || {})) tot.dupe_sources[k] = (tot.dupe_sources[k] || 0) + v;
    } catch (e) { toast(e.message, true); break; }
  }
  openModal(`<h3>Import finished</h3>
    <div class="row" style="gap:18px;flex-wrap:wrap;margin:10px 0"><div><b class="mono" style="font-size:22px;color:var(--green)">${tot.added.toLocaleString()}</b><div class="faint" style="font-size:11px">leads added to “${esc(I.name)}”</div></div>
      <div><b class="mono" style="font-size:22px">${tot.dupes.toLocaleString()}</b><div class="faint" style="font-size:11px">duplicates skipped</div></div>
      ${tot.dnc ? `<div><b class="mono" style="font-size:22px;color:var(--amber)">${tot.dnc.toLocaleString()}</b><div class="faint" style="font-size:11px">on DNC</div></div>` : ''}
      ${tot.bad ? `<div><b class="mono" style="font-size:22px;color:var(--red)">${tot.bad.toLocaleString()}</b><div class="faint" style="font-size:11px">bad numbers</div></div>` : ''}</div>
    ${Object.keys(tot.dupe_sources).length ? `<div class="faint" style="font-size:12px;margin-bottom:8px">Duplicates were already in: ${Object.entries(tot.dupe_sources).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)} (${v.toLocaleString()})`).join(', ')}</div>` : ''}
    ${I.cost ? `<div class="faint" style="font-size:12px">List cost saved: $${Number(I.cost).toLocaleString()}</div>` : ''}
    <div class="mact"><button class="primary" onclick="closeModal()">Done</button></div>`);
  IMP = null;
  loadLists().then(() => { if (S.route === 'leads') viewLeads(); });
}
function addLeadModal() {
  openModal(`<h3>Add lead</h3><div class="grid2">
    <div class="mf"><label>Name</label><input id="aName"></div><div class="mf"><label>Business</label><input id="aBiz"></div>
    <div class="mf"><label>Phone *</label><input id="aPhone"></div><div class="mf"><label>Email</label><input id="aEmail"></div>
    <div class="mf"><label>State</label><input id="aState"></div></div>
    <div class="mf"><label>Note</label><textarea id="aNotes" rows="3"></textarea></div>
    <div class="mact"><button onclick="closeModal()">Cancel</button><button onclick="addLead(false)">Save</button><button class="primary" onclick="addLead(true)">Save &amp; call</button></div>`);
  $('#aName').focus();
}
async function addLead(call) {
  if (!normPhone($('#aPhone').value)) return toast('Enter a valid phone number', true);
  try {
    const r = await api('/api/leads', { name: $('#aName').value, business: $('#aBiz').value, phone: $('#aPhone').value, email: $('#aEmail').value, state: $('#aState').value, notes: $('#aNotes').value });
    closeModal(); if (r.existing) toast('That number already exists — opened it');
    go('#/lead/' + r.id); if (call) callLead(r.id);
  } catch (e) { toast(e.message, true); }
}

// ============ view: lead profile ============
async function viewLead(id) {
  id = Number(id);
  V('<div class="empty">Loading…</div>');
  let r; try { r = await api('/api/leads/' + id); } catch (e) { return V(`<div class="empty">${esc(e.message)}</div>`); }
  if (S.route !== 'lead' || Number(S.viewCtx.arg) !== id) return;
  const l = r.lead;
  const f = (k, label, type = 'text') => `<label>${label}</label><input id="lf_${k}" type="${type}" value="${esc(l[k])}">`;
  V(`<div class="vtitle"><a href="#/leads" class="muted">‹ Leads</a><h1>${esc(leadName(l))}</h1><span class="badge ${esc(l.status)}">${esc(l.status)}</span>
      ${l.on_dnc ? '<span class="badge dnc">On DNC list</span>' : ''}${l.source ? `<span class="faint">${esc(l.source)}</span>` : ''}
      ${l.local_time ? `<span class="mono" style="font-size:12px;color:${l.callable_now ? 'var(--green)' : 'var(--amber)'}" title="${l.callable_now ? 'Inside calling hours' : 'Outside calling hours'}">🕒 ${esc(l.local_time)}</span>` : ''}
      <div class="row" style="margin-left:auto">
        ${r.deals.map(d => `<a href="#/deal/${d.id}"><button class="sm">Deal #${d.id} · ${esc(STAGE_LABELS[d.stage])}</button></a>`).join('')}
        ${r.deals.some(d => !['funded', 'lost'].includes(d.stage)) ? '' : `<button onclick="createDeal(${l.id})">+ Deal</button>`}
        <button onclick="enrollModal([${l.id}])">+ Sequence</button>
        <button class="primary" onclick="callLead(${l.id})" ${S.inSession && S.phase === 'ready' && l.status !== 'dnc' ? '' : 'disabled'} title="${S.inSession ? '' : 'Start a session to call'}">☎ Call</button></div></div>
    ${r.enrollment ? `<div class="banner" style="padding:10px 14px;margin-bottom:12px;border-color:var(--purple)"><div><b style="color:var(--purple)">In sequence: ${esc(r.enrollment.seq_name)}</b>
      <span class="muted" style="margin-left:8px">step ${r.enrollment.step + 1} of ${r.enrollment.steps.length} · next ${fmtTime(r.enrollment.next_at)} (${esc(r.enrollment.steps[r.enrollment.step]?.type === 'sms' ? 'text' : r.enrollment.steps[r.enrollment.step]?.type || '')})</span></div>
      <button class="sm" onclick="stopEnrollment(${r.enrollment.id})">Stop</button></div>` : ''}
    <div class="profile">
      <div class="card form">
        <h3>Contact</h3>
        ${f('name', 'Name')}${f('business', 'Business')}${f('phone', 'Phone')}${f('email', 'Email', 'email')}${f('state', 'State')}
        <label>List</label><input id="lf_source" value="${esc(l.source)}">
        <label>Status</label><select id="lf_status">${['new', 'callback', 'done', 'dnc'].map(s => `<option ${l.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <label>Owner</label><select id="lf_owner"><option value="">Shared pool</option>${S.users.map(u => `<option value="${u.id}" ${l.owner_id === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>
        <label>Callback</label><input id="lf_cb" type="datetime-local" value="${toLocalInput(l.callback_at)}">
        <div class="row" style="margin-top:12px"><button class="primary" onclick="saveLead(${l.id})">Save</button>${isAdmin() ? `<button class="danger" onclick="deleteLead(${l.id})" style="margin-left:auto">Delete</button>` : ''}</div>
        ${leadPhonesBlock(r)}
        <div class="fields" style="grid-template-columns:1fr">
          ${l.score != null && ['new', 'callback'].includes(l.status) ? `<div class="f"><span>Queue score</span><div><b class="mono" style="color:${scoreColor(l.score)}">${l.score}</b> <span class="faint" style="font-size:11px">${esc(l.score_why || '')}</span></div></div>` : ''}
          <div class="f"><span>Attempts</span><div>${l.attempts || 0} · last ${esc(l.last_outcome || '—')} ${l.last_called ? '· ' + fmtTime(l.last_called) : ''}</div></div>
          ${l.disposition ? `<div class="f"><span>Disposition</span><div>${esc(l.disposition)}</div></div>` : ''}
          ${Object.entries(l.extra || {}).map(([k, v]) => `<div class="f"><span>${esc(k)}</span><div>${esc(v)}</div></div>`).join('')}
          <div class="f"><span>Created</span><div>${fmtTime(l.created_at)}</div></div>
        </div>
      </div>
      <div>
        <div class="card" style="margin-bottom:12px">
          <textarea id="newNote" rows="3" placeholder="Add a note…"></textarea>
          <div class="row" style="margin-top:8px"><span class="muted grow" id="tlCounts"></span><button onclick="addNote(${l.id})">Add note</button></div>
        </div>
        <div id="timeline"></div>
      </div>
      <div><div class="tabs" style="margin-bottom:8px;border:0"><button id="tabTx" onclick="S.leadTab='sms';refreshLeadSide()">Texts${r.messages.length ? ' (' + r.messages.length + ')' : ''}</button><button id="tabEm" onclick="S.leadTab='email';refreshLeadSide()">Email${r.emails.length ? ' (' + r.emails.length + ')' : ''}</button></div>
        <div id="threadBox"></div></div>
    </div>`);
  renderTimeline(r);
  S.leadData = r;
  mountSide();
  if (l.unread_sms) api('/api/leads/' + l.id + '/read', {}).catch(() => {});
}
function renderTimeline(r) {
  const items = [...r.calls.map(c => ({ t: c.started_at, html: callCard(c) })),
    ...r.notes.map(n => ({ t: n.created_at, html: `<div class="tl-item"><div class="tl-head"><span>✎</span><span class="badge">Note</span><span class="muted">${esc(n.user_name || '')}</span><span class="when">${fmtTime(n.created_at)}</span>${n.user_id === S.me.id || isAdmin() ? `<button class="link" style="font-size:11px" onclick="delNote(${n.id})">delete</button>` : ''}</div><div class="tl-body" style="white-space:pre-wrap">${esc(n.body)}</div></div>` }))]
    .sort((a, b) => b.t - a.t);
  const connects = r.calls.filter(c => c.connected).length;
  $('#tlCounts').textContent = `${r.calls.length} dials · ${connects} conversations · ${r.notes.length} notes · ${r.messages.length} texts · ${(r.emails || []).length} emails`;
  $('#timeline').innerHTML = items.length ? items.map(i => i.html).join('') : '<div class="card empty">No activity yet.</div>';
}
function mountSide() {
  const r = S.leadData; if (!r) return;
  const tab = S.leadTab || 'sms';
  $('#tabTx')?.classList.toggle('act', tab === 'sms'); $('#tabEm')?.classList.toggle('act', tab === 'email');
  if (tab === 'email') { S.thread = { leadId: r.lead.id, lead: r.lead, ids: new Set() }; mountEmails(r.lead, r.emails, $('#threadBox')); }
  else mountThread(r.lead, r.messages, $('#threadBox'));
}
async function refreshLeadSide() {
  const id = Number(S.viewCtx.arg);
  try { const r = await api('/api/leads/' + id); if (S.route === 'lead' && Number(S.viewCtx.arg) === id) { S.leadData = r; mountSide(); } } catch {}
}
async function refreshLeadTimeline() {
  const id = Number(S.viewCtx.arg);
  try { const r = await api('/api/leads/' + id); if (S.route === 'lead' && Number(S.viewCtx.arg) === id) renderTimeline(r); } catch {}
}
async function saveLead(id) {
  const v = k => $('#lf_' + k).value;
  const cb = $('#lf_cb').value;
  try {
    await api('/api/leads/' + id, { name: v('name'), business: v('business'), phone: v('phone'), email: v('email'), state: v('state'), status: v('status'), owner_id: $('#lf_owner').value || null, source: $('#lf_source').value, callback_at: cb ? new Date(cb).getTime() : null }, 'PATCH');
    toast('Saved'); route();
  } catch (e) { toast(e.message, true); }
}
async function deleteLead(id) { if (!confirm('Delete this lead and all its calls, notes and texts?')) return; try { await api('/api/leads/' + id, undefined, 'DELETE'); go('#/leads'); } catch (e) { toast(e.message, true); } }
async function addNote(id) {
  const body = $('#newNote').value.trim(); if (!body) return;
  try { await api('/api/leads/' + id + '/notes', { body }); $('#newNote').value = ''; refreshLeadTimeline(); } catch (e) { toast(e.message, true); }
}
async function delNote(id) { if (!confirm('Delete note?')) return; await api('/api/notes/' + id, undefined, 'DELETE').catch(() => {}); refreshLeadTimeline(); }

// ============ shared: SMS thread ============
function mountThread(lead, messages, el) {
  S.thread = { leadId: lead.id, lead, ids: new Set() };
  el.innerHTML = `<div class="thread">
    <div class="thread-head"><b class="grow">Text messages</b><span class="mono muted">${esc(fmtPhone(lead.phone))}</span></div>
    <div class="msgs" id="msgs"></div>
    <div class="composer">
      ${S.templates.length ? `<select id="tplSel" onchange="useTpl(this)"><option value="">Insert template…</option>${S.templates.map((t, i) => `<option value="${i}">${esc(t.slice(0, 70))}</option>`).join('')}</select>` : ''}
      <textarea id="smsText" placeholder="${lead.status === 'dnc' ? 'Lead is DNC / opted out' : 'Type a text…  (Enter to send, Shift+Enter for new line)'}" ${lead.status === 'dnc' ? 'disabled' : ''}></textarea>
      <div class="row"><span class="faint grow" id="smsLen" style="font-size:11px"></span><button class="primary" onclick="sendSms()" ${lead.status === 'dnc' ? 'disabled' : ''}>Send</button></div>
    </div></div>`;
  const ta = $('#smsText');
  ta.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendSms(); } };
  ta.oninput = () => { const n = ta.value.length; $('#smsLen').textContent = n ? `${n} chars · ${Math.ceil(n / 153) || 1} segment(s)` : ''; };
  $('#msgs').innerHTML = messages.length ? '' : '<div class="faint" style="margin:auto">No texts yet</div>';
  messages.forEach(m => appendMsg(m, false, true));
  const box = $('#msgs'); box.scrollTop = box.scrollHeight;
  if (S.pendingSms && lead.status !== 'dnc') { ta.value = S.pendingSms; ta.oninput(); S.pendingSms = null; }
}
function msgHTML(m) {
  const st = m.direction === 'out' ? (m.status === 'failed' || m.status === 'undelivered' ? ` · <span style="color:var(--red)">${esc(m.status)} ${esc(m.error)}</span>` : ' · ' + esc(m.status)) : '';
  const media = JSON.parse(m.media || '[]').map(u => `<div><a href="${esc(u)}" target="_blank" rel="noopener">📎 attachment</a></div>`).join('');
  return `${esc(m.body)}${media}<div class="meta">${m.direction === 'out' && m.user_name ? esc(m.user_name) + ' · ' : ''}${fmtClock(m.created_at)}${st}</div>`;
}
function appendMsg(m, scroll, initial) {
  const box = $('#msgs'); if (!box || !S.thread || m.lead_id !== S.thread.leadId) return;
  const existing = box.querySelector(`[data-mid="${m.id}"]`);
  if (existing) { if (!m.user_name) m.user_name = existing.dataset.user; existing.innerHTML = msgHTML(m); existing.className = 'msg ' + m.direction + (['failed', 'undelivered'].includes(m.status) ? ' failed' : ''); return; }
  if (!initial && box.querySelector('.faint')) box.innerHTML = '';
  const day = fmtDay(m.created_at);
  if (S.thread.lastDay !== day) { S.thread.lastDay = day; box.insertAdjacentHTML('beforeend', `<div class="day">${esc(day)}</div>`); }
  box.insertAdjacentHTML('beforeend', `<div class="msg ${m.direction}${['failed', 'undelivered'].includes(m.status) ? ' failed' : ''}" data-mid="${m.id}" data-user="${esc(m.user_name || '')}">${msgHTML(m)}</div>`);
  if (scroll) box.scrollTop = box.scrollHeight;
  if (!initial && m.direction === 'in') api('/api/leads/' + m.lead_id + '/read', {}).catch(() => {});
}
function useTpl(sel) { if (sel.value === '') return; const ta = $('#smsText'); ta.value = fill(S.templates[+sel.value], S.thread.lead); sel.value = ''; ta.oninput(); ta.focus(); }
async function sendSms() {
  const ta = $('#smsText'), body = ta.value.trim(); if (!body || !S.thread) return;
  ta.disabled = true;
  try { const r = await api('/api/leads/' + S.thread.leadId + '/sms', { body }); ta.value = ''; ta.oninput(); appendMsg(r.message, true); }
  catch (e) { toast(e.message, true); }
  ta.disabled = false; ta.focus();
}

// ============ view: inbox ============
async function viewInbox(id) {
  V(`<div class="vtitle"><h1>Inbox</h1><label class="row muted" style="gap:6px"><input type="checkbox" id="unreadOnly" ${S.inboxUnread ? 'checked' : ''}> Unread only</label></div>
    <div class="inbox"><div class="convs" id="convs"><div class="empty">Loading…</div></div><div id="inboxThread"><div class="card empty">Select a conversation</div></div></div>`);
  $('#unreadOnly').onchange = e => { S.inboxUnread = e.target.checked; refreshConvs(); };
  S.thread = null;
  await refreshConvs();
  if (id) openConv(Number(id));
}
async function refreshConvs() {
  const rows = await api('/api/inbox' + (S.inboxUnread ? '?unread=1' : '')).catch(() => null);
  if (!rows || S.route !== 'inbox') return;
  const cur = Number(S.viewCtx.arg);
  $('#convs').innerHTML = rows.length ? rows.map(c => `<div class="conv ${c.unread_sms ? 'unread' : ''} ${c.id === cur ? 'act' : ''}" onclick="go('#/inbox/${c.id}')">
    <div class="top"><span class="nm">${esc(leadName(c))}</span><span class="faint mono" style="font-size:10px">${fmtTime(c.last_sms_at)}</span></div>
    <div class="pv">${c.unread_sms ? `<span class="badge dnc">${c.unread_sms}</span> ` : ''}${c.last_dir === 'out' ? 'You: ' : ''}${esc(c.last_body)}</div></div>`).join('')
    : '<div class="empty">No text conversations yet.</div>';
}
async function openConv(id) {
  const r = await api('/api/leads/' + id).catch(e => { toast(e.message, true); return null; });
  if (!r || S.route !== 'inbox') return;
  const box = $('#inboxThread');
  box.innerHTML = `<div class="row" style="margin-bottom:8px"><a href="#/lead/${id}"><b>${esc(leadName(r.lead))}</b></a><span class="muted">${esc(r.lead.name ? r.lead.business : '')}</span>
    <button class="sm" style="margin-left:auto" onclick="callLead(${id})" ${S.inSession && S.phase === 'ready' ? '' : 'disabled'}>☎ Call</button></div><div id="tbox"></div>`;
  mountThread(r.lead, r.messages, $('#tbox'));
  if (r.lead.unread_sms) { await api('/api/leads/' + id + '/read', {}).catch(() => {}); refreshConvs(); }
}

// ============ view: call history ============
function viewCalls() {
  const q = S.callsQ = S.callsQ || { range: 'today', user: isAdmin() ? '' : 'me', connected: false, q: '', page: 0 };
  V(`<div class="vtitle"><h1>Call history</h1><span class="muted" id="callTotal"></span></div>
    <div class="row wrap" style="margin-bottom:10px">
      <select id="crange"><option value="today">Today</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="all">All time</option></select>
      <select id="cuser"><option value="">All reps</option><option value="me">Me</option>${S.users.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select>
      <label class="row muted" style="gap:6px"><input type="checkbox" id="cconn"> Conversations only</label>
      <input id="cq" placeholder="Search lead, notes, AI summary…" style="width:280px" value="${esc(q.q)}">
    </div>
    <div class="tablewrap"><table><thead><tr><th>When</th><th>Rep</th><th>Lead</th><th>Outcome</th><th>Disposition</th><th>Talk</th><th>Notes / AI summary</th></tr></thead><tbody id="callRows"></tbody></table></div>
    <div class="pager" id="cpager"></div>`);
  $('#crange').value = q.range; $('#cuser').value = q.user; $('#cconn').checked = q.connected;
  $('#crange').onchange = e => { q.range = e.target.value; q.page = 0; loadCalls(); };
  $('#cuser').onchange = e => { q.user = e.target.value; q.page = 0; loadCalls(); };
  $('#cconn').onchange = e => { q.connected = e.target.checked; q.page = 0; loadCalls(); };
  let t; $('#cq').oninput = e => { clearTimeout(t); t = setTimeout(() => { q.q = e.target.value; q.page = 0; loadCalls(); }, 300); };
  loadCalls();
}
function rangeFrom(r) { if (r === 'all') return ''; if (r === 'today') return new Date().setHours(0, 0, 0, 0); return Date.now() - Number(r) * 864e5; }
async function loadCalls() {
  const q = S.callsQ;
  const p = new URLSearchParams({ user: q.user, q: q.q, page: q.page, limit: 100 });
  const from = rangeFrom(q.range); if (from) p.set('from', from);
  if (q.connected) p.set('connected', 1);
  const r = await api('/api/calls?' + p).catch(e => { toast(e.message, true); return null; });
  if (!r || S.route !== 'calls') return;
  S.callRows = r.rows;
  $('#callTotal').textContent = r.total.toLocaleString() + ' calls';
  $('#callRows').innerHTML = r.rows.length ? r.rows.map((c, i) => `<tr class="click" onclick="toggleCallRow(${i}, this)">
    <td class="muted" style="white-space:nowrap">${fmtTime(c.started_at)}</td><td>${esc(c.user_name || '')}</td>
    <td><a href="#/lead/${c.lead_id}" onclick="event.stopPropagation()">${esc(c.lead_name || c.lead_business || fmtPhone(c.lead_phone))}</a></td>
    <td><span class="badge ${c.connected ? 'good' : ''}">${esc(c.outcome || c.status)}</span></td>
    <td>${esc(c.disposition)}</td><td class="mono">${c.duration ? fmtDur(c.duration) : ''}</td>
    <td style="max-width:420px">${c.ai?.summary ? '<span class="badge aib">AI</span> ' + esc(c.ai.summary.slice(0, 140)) + (c.ai.summary.length > 140 ? '…' : '') : esc((c.notes || '').slice(0, 140))}</td></tr>`).join('')
    : '<tr><td colspan="7" class="empty">No calls in this range.</td></tr>';
  const pages = Math.ceil(r.total / 100);
  $('#cpager').innerHTML = pages > 1 ? `<button class="sm" ${q.page ? '' : 'disabled'} onclick="S.callsQ.page--;loadCalls()">‹ Prev</button><span>Page ${q.page + 1} of ${pages}</span><button class="sm" ${q.page + 1 < pages ? '' : 'disabled'} onclick="S.callsQ.page++;loadCalls()">Next ›</button>` : '';
}
function toggleCallRow(i, tr) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('detail')) { next.remove(); return; }
  tr.insertAdjacentHTML('afterend', `<tr class="detail"><td colspan="7" style="background:var(--bg)">${callCard(S.callRows[i])}</td></tr>`);
}

// ============ view: dashboard ============
const OBJ_LABEL = { already_funded: 'Already funded', rate_too_high: 'Rate / cost', not_interested: 'Not interested', bad_timing: 'Bad timing', send_info: 'Send me info', need_partner: 'Needs partner', credit: 'Credit', too_many_positions: 'Too many positions', trust: 'Trust / who are you', other: 'Other' };
async function viewDashboard() {
  const range = S.dashRange || 'today';
  V(`<div class="vtitle"><h1>Dashboard</h1><select id="drange"><option value="today">Today</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option></select></div>
    <div class="kpis" id="kpis"></div>
    <div style="display:grid;grid-template-columns:2fr 1fr;gap:14px;align-items:start">
      <div>
        <div class="tablewrap" style="margin-bottom:14px"><table><thead><tr><th>Rep</th><th>Dials</th><th>Convos</th><th>Rate</th><th>Talk</th><th>VMs</th><th>Interested</th><th>Apps</th><th>Callbacks</th><th>Avg score</th><th>Talk %</th></tr></thead><tbody id="repRows"></tbody></table></div>
        <div class="card" style="margin-bottom:14px"><h3>Objections heard</h3><div id="objList" class="muted">Loading…</div></div>
        <div class="card"><h3>Best hours to call (connect rate)</h3><div id="hours"></div></div>
      </div>
      <div><div class="card" style="margin-bottom:14px"><h3>My callbacks</h3><div id="myCbs" class="muted">Loading…</div></div>
        <div class="card" style="margin-bottom:14px"><h3>Dispositions</h3><div id="dispoList"></div></div>
        <div class="card"><h3>Texts</h3><div id="smsStats"></div></div></div>
    </div>`);
  $('#drange').value = range; $('#drange').onchange = e => { S.dashRange = e.target.value; viewDashboard(); };
  const [st, cbs] = await Promise.all([
    api('/api/stats?from=' + rangeFrom(range)).catch(() => null),
    api('/api/leads?status=callback&owner=me&sort=callback&limit=25').catch(() => null)]);
  if (S.route !== 'dashboard') return;
  if (st) {
    const tot = st.reps.reduce((a, r) => { for (const k of ['dials', 'connects', 'talk', 'interested', 'apps', 'callbacks', 'vms']) a[k] = (a[k] || 0) + (r[k] || 0); return a; }, {});
    const scored = st.reps.filter(r => r.score != null);
    const avgScore = scored.length ? Math.round(scored.reduce((a, r) => a + r.score, 0) / scored.length) : null;
    const k = (v, l) => `<div class="kpi"><b>${v}</b><span>${l}</span></div>`;
    $('#kpis').innerHTML = k(tot.dials || 0, 'Dials') + k(tot.connects || 0, 'Conversations') + k(tot.dials ? Math.round(tot.connects / tot.dials * 100) + '%' : '0%', 'Connect rate') + k(fmtDur(tot.talk), 'Talk time') + k(tot.vms || 0, 'Voicemails dropped') + k(tot.interested || 0, 'Interested') + k(tot.apps || 0, 'Apps sent') + k(avgScore ?? '—', 'Avg call score');
    $('#repRows').innerHTML = st.reps.map(r => `<tr><td><b>${esc(r.name)}</b></td><td class="mono">${r.dials || 0}</td><td class="mono">${r.connects || 0}</td><td class="mono">${r.dials ? Math.round((r.connects || 0) / r.dials * 100) : 0}%</td><td class="mono">${fmtDur(r.talk)}</td><td class="mono">${r.vms || 0}</td><td class="mono">${r.interested || 0}</td><td class="mono">${r.apps || 0}</td><td class="mono">${r.callbacks || 0}</td>
      <td class="mono" style="color:${r.score != null ? scoreColor(r.score) : 'inherit'}">${r.score ?? '—'}</td><td class="mono">${r.talk_ratio != null ? r.talk_ratio + '%' : '—'}</td></tr>`).join('');
    $('#dispoList').innerHTML = st.dispositions.length ? st.dispositions.map(d => `<div class="row" style="padding:4px 0"><span class="grow">${esc(d.disposition)}</span><b class="mono">${d.n}</b></div>`).join('') : '<span class="faint">None yet</span>';
    const sm = Object.fromEntries(st.sms.map(x => [x.direction, x.n]));
    $('#smsStats').innerHTML = `<div class="row" style="padding:4px 0"><span class="grow">Sent</span><b class="mono">${sm.out || 0}</b></div><div class="row" style="padding:4px 0"><span class="grow">Received</span><b class="mono">${sm.in || 0}</b></div>`;
    const maxO = Math.max(1, ...st.objections.map(o => o.n));
    $('#objList').innerHTML = st.objections.length ? st.objections.map(o => `<div style="padding:6px 0;border-bottom:1px solid var(--border)">
      <div class="row"><b class="grow">${esc(OBJ_LABEL[o.category] || o.category)}</b><span class="mono">${o.n}</span></div>
      <div style="height:5px;background:var(--panel3);border-radius:3px;margin:4px 0"><div style="height:100%;width:${o.n / maxO * 100}%;background:var(--purple);border-radius:3px"></div></div>
      <div class="faint" style="font-size:12px">${o.examples.map(e => `<a href="#/lead/${e.leadId}" style="color:var(--text2)">“${esc(e.text)}”</a>`).join(' · ')}</div></div>`).join('')
      : '<span class="faint">Objections show up here once calls have AI notes.</span>';
    const hrs = st.hours.filter(h => h.dials > 0), maxR = Math.max(0.01, ...hrs.map(h => h.connects / h.dials));
    $('#hours').innerHTML = hrs.length ? `<div style="display:flex;gap:6px;align-items:flex-end;height:120px">${hrs.map(h => { const r = h.connects / h.dials; return `<div style="flex:1;max-width:56px;display:flex;flex-direction:column;align-items:center;gap:3px" title="${h.dials} dials, ${h.connects} conversations"><span class="mono faint" style="font-size:10px">${Math.round(r * 100)}%</span><div style="width:100%;height:${Math.max(3, r / maxR * 80)}px;background:var(--green);border-radius:3px 3px 0 0;opacity:.8"></div><span class="mono faint" style="font-size:10px">${((h.h + 11) % 12) + 1}${h.h < 12 ? 'a' : 'p'}</span></div>`; }).join('')}</div>` : '<span class="faint">Not enough calls yet.</span>';
  }
  if (cbs) $('#myCbs').innerHTML = cbs.rows.length ? cbs.rows.map(l => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--border)"><a href="#/lead/${l.id}" class="grow">${esc(leadName(l))}</a><span style="${l.callback_at <= Date.now() ? 'color:var(--amber)' : 'color:var(--text2)'}">${fmtTime(l.callback_at)}</span></div>`).join('') : '<span class="faint">No callbacks scheduled.</span>';
}

// ============ view: sales floor ============
async function viewFloor() {
  V(`<div class="vtitle"><h1>Sales floor</h1><span class="muted">Live view of every rep${isAdmin() ? ' · listen, whisper or barge into live calls' : ''}</span></div>
    <div id="monBar"></div>
    <div id="lbBox"></div>
    <div id="floor" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px"><div class="empty">Loading…</div></div>`);
  renderMonBar(); renderLeaderboard(S.lbPeriod || 'today');
  clearInterval(S.floorT);
  const load = async () => {
    if (S.route !== 'floor') return clearInterval(S.floorT);
    const reps = await api('/api/floor').catch(() => null); if (!reps || S.route !== 'floor') return;
    const order = { connected: 0, wrap: 1, dialing: 2, ready: 3, idle: 4, offline: 5 };
    $('#floor').innerHTML = reps.sort((a, b) => (order[a.onCall ? 'connected' : a.phase] ?? 9) - (order[b.onCall ? 'connected' : b.phase] ?? 9)).map(r => {
      const ph = r.onCall ? 'connected' : r.phase;
      const color = { connected: 'var(--green)', wrap: 'var(--blue)', dialing: 'var(--amber)', ready: 'var(--text)', idle: 'var(--text3)', offline: 'var(--text3)' }[ph];
      const label = { connected: 'On a call', wrap: 'Wrap-up', dialing: `Dialing ${r.dialingLines || ''} lines`, ready: 'Ready', idle: r.online ? 'Online, not dialing' : 'Offline', offline: r.online ? 'Online, not dialing' : 'Offline' }[ph];
      const since = r.onCall ? r.onCall.answered_at : r.since;
      return `<div class="card" style="border-color:${ph === 'connected' ? 'var(--green)' : 'var(--border2)'}">
        <div class="row"><span class="dot ${r.inSession ? 'live' : ''}" style="background:${color}"></span><b class="grow">${esc(r.name)}</b><span class="mono faint" style="font-size:11px">${r.inSession && since ? fmtDur((Date.now() - since) / 1000) : ''}</span></div>
        <div style="color:${color};margin-top:4px">${esc(label)}</div>
        ${r.onCall ? `<div style="margin-top:6px"><a href="#/lead/${r.onCall.lead_id}">${esc(r.onCall.name || r.onCall.business || fmtPhone(r.onCall.phone))}</a>${r.onCall.direction === 'in' ? ' <span class="badge">inbound</span>' : ''}</div>` : ''}
        <div class="row mono muted" style="margin-top:10px;font-size:11px;gap:12px"><span>${r.dials} dials</span><span>${r.connects} convos</span><span>${fmtDur(r.talk)} talk</span><span>${r.wins || 0} wins</span></div>
        ${isAdmin() && r.inSession && r.id !== S.me.id ? `<div class="row" style="margin-top:10px"><button class="sm" onclick="startMonitor(${r.id},'listen')">🎧 Listen</button><button class="sm" onclick="startMonitor(${r.id},'whisper')">Whisper</button><button class="sm" onclick="startMonitor(${r.id},'barge')">Barge</button></div>` : ''}
      </div>`;
    }).join('');
  };
  load(); S.floorT = setInterval(load, 3000);
}
async function startMonitor(uid, how) {
  if (S.inSession) return toast('End your own dialing session first', true);
  if (S.monitor) await stopMonitor();
  try {
    const { token } = await api('/api/token');
    const dev = new Twilio.Device(token, { codecPreferences: ['opus', 'pcmu'], logLevel: 1 });
    const call = await dev.connect({ params: { mode: 'monitor', target: String(uid), how } });
    const name = S.users.find(u => u.id === uid)?.name || 'rep';
    S.monitor = { dev, call, how, name };
    call.on('disconnect', () => { try { dev.destroy(); } catch {} S.monitor = null; renderMonBar(); });
    renderMonBar();
  } catch (e) { toast('Could not connect: ' + e.message, true); }
}
async function stopMonitor() { if (!S.monitor) return; try { S.monitor.call.disconnect(); S.monitor.dev.destroy(); } catch {} S.monitor = null; renderMonBar(); }
function renderMonBar() {
  const el = $('#monBar'); if (!el) return;
  const m = S.monitor;
  el.innerHTML = m ? `<div class="banner connected" style="margin-bottom:12px"><div><div class="ph">${m.how === 'listen' ? '🎧 Listening to' : m.how === 'whisper' ? 'Whispering to' : 'Barged into'} ${esc(m.name)}</div>
    <div class="sm">${m.how === 'listen' ? 'Nobody can hear you.' : m.how === 'whisper' ? 'Only the rep can hear you.' : 'Everyone on the call can hear you.'}</div></div><button class="danger" onclick="stopMonitor()">Leave</button></div>` : '';
}

// ============ view: team & setup (admin) ============
async function viewTeam() {
  if (!isAdmin()) return V('<div class="empty">Admins only</div>');
  const [users, tpls, st, nums, dnc] = await Promise.all([api('/api/users'), api('/api/templates'), api('/api/settings'), api('/api/numbers').catch(() => []), api('/api/dnc')]);
  S.users = users.filter(x => x.role !== 'iso'); S.isos = users.filter(x => x.role === 'iso'); S.teamSettings = st; S.playbook = st.playbook;
  const origin = location.origin;
  const avgRate = (() => { const d = nums.reduce((a, n) => a + n.dials7, 0), c = nums.reduce((a, n) => a + n.connects7, 0); return d ? c / d : 0; })();
  V(`<div class="vtitle"><h1>Team &amp; setup</h1></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start">
    <div>
      <div class="tablewrap" style="margin-bottom:14px"><table><thead><tr><th>Name</th><th>Email</th><th>Transfer #</th><th>Comm. %</th><th>Role</th><th></th></tr></thead><tbody>
        ${users.map(u => `<tr><td><b>${esc(u.name)}</b>${u.active ? '' : ' <span class="badge">disabled</span>'}</td><td class="muted">${esc(u.email)}</td>
        <td><button class="link" onclick="setUserPhone(${u.id})">${u.phone ? esc(fmtPhone(u.phone)) : 'add'}</button></td><td><button class="link" onclick="setUserComm(${u.id}, ${u.commission_pct || 0})">${u.commission_pct ? u.commission_pct + '%' : 'set'}</button> <button class="link" title="Split of the funder payment: as originator / as closer" onclick="setUserSplit(${u.id}, ${u.split_pct ?? "''"}, ${u.closer_split_pct ?? "''"})">split ${u.split_pct ?? '—'}/${u.closer_split_pct ?? '—'}</button></td><td>${u.role === 'iso' ? 'partner' : esc(u.role)}</td>
        <td style="white-space:nowrap"><button class="sm" onclick="resetPw(${u.id})">Password</button> ${u.role === 'iso' ? '' : `<button class="sm" onclick="setUser(${u.id},{role:'${u.role === 'admin' ? 'rep' : 'admin'}'})">Make ${u.role === 'admin' ? 'rep' : 'admin'}</button>`} <button class="sm ${u.active ? 'danger' : ''}" onclick="setUser(${u.id},{active:${u.active ? 0 : 1}})">${u.active ? 'Disable' : 'Enable'}</button></td></tr>`).join('')}
      </tbody></table></div>
      <div class="card" style="margin-bottom:14px"><h3>Add a rep</h3>
        <div class="grid2"><div class="mf"><label>Name</label><input id="nuName"></div><div class="mf"><label>Email (login)</label><input id="nuEmail" type="email"></div>
        <div class="mf"><label>Temporary password (8+ chars)</label><input id="nuPass"></div><div class="mf"><label>Role</label><select id="nuRole"><option value="rep">Rep</option><option value="admin">Admin</option><option value="iso">Partner (ISO / broker)</option></select></div>
        <div class="mf"><label>Cell for warm transfers (optional)</label><input id="nuPhone"></div></div>
        <button class="primary" onclick="addUser()">Add user</button></div>

      <div class="card" style="margin-bottom:14px"><h3>Caller ID &amp; local presence</h3>
        <div class="grid2">
          <div class="mf"><label>Which number leads see</label><select id="cidMode">
            <option value="single">One number (${esc(fmtPhone(S.config.callerId))})</option>
            <option value="local">Local presence — match the lead's area code</option>
            <option value="rotate">Rotate through all numbers</option></select></div>
          <div class="mf"><label>Max dials per number per day (0 = no limit)</label><input type="number" id="cidCap" min="0" value="${st.number_daily_cap || 0}"></div>
        </div>
        <button class="primary" onclick="saveTeamSettings({callerid_mode:$('#cidMode').value, number_daily_cap:+$('#cidCap').value})">Save</button>
        <div class="row" style="margin:14px 0 8px"><b class="grow">Number pool (${nums.length})</b><button class="sm" onclick="syncNumbers()">Import from Twilio</button><button class="sm" onclick="addNumber()">+ Add</button></div>
        ${nums.length ? `<table><thead><tr><th>Number</th><th>Today</th><th>7-day dials</th><th>Connect rate</th><th></th></tr></thead><tbody>${nums.map(n => {
          const rate = n.dials7 ? n.connects7 / n.dials7 : null, bad = rate != null && n.dials7 >= 50 && avgRate && rate < avgRate * 0.5;
          return `<tr><td class="mono">${esc(fmtPhone(n.phone))}<div class="faint" style="font-size:11px">${esc(n.label)}</div></td><td class="mono">${n.today}</td><td class="mono">${n.dials7}</td>
            <td class="mono" style="color:${bad ? 'var(--red)' : 'inherit'}">${rate == null ? '—' : Math.round(rate * 100) + '%'}${bad ? ' <span class="badge dnc" title="Much lower connect rate than your other numbers — may be flagged as spam">check</span>' : ''}</td>
            <td style="white-space:nowrap"><button class="sm" onclick="numSet(${n.id},{active:${n.active ? 0 : 1}})">${n.active ? 'Pause' : 'Use'}</button> <button class="sm" onclick="numDel(${n.id})">✕</button></td></tr>`; }).join('')}</tbody></table>`
          : '<div class="faint">Add the Twilio numbers you own to rotate caller ID or match the lead’s area code.</div>'}
      </div>

      <div class="card" style="margin-bottom:14px"><h3>DNC list (${dnc.total.toLocaleString()} numbers)</h3>
        <div class="faint" style="font-size:12px;margin-bottom:6px">These numbers are never dialed or texted. STOP replies and DNC dispositions are added automatically. Paste numbers below to add more.</div>
        <textarea id="dncText" rows="3" placeholder="One number per line, or paste a column from a spreadsheet"></textarea>
        <div class="row" style="margin-top:8px"><button class="primary" onclick="addDncList()">Add to DNC</button><input id="dncQ" placeholder="Search…" style="margin-left:auto;width:140px" oninput="searchDnc(this.value)"></div>
        <div id="dncRows" style="margin-top:8px;max-height:180px;overflow:auto">${dncRows(dnc.rows)}</div></div>

      <div class="card"><h3>Twilio setup check</h3><div style="line-height:1.8">
        <div>TwiML App → Voice URL: <code class="mono">${esc(origin)}/twilio/voice</code></div>
        <div>Each number → Voice "A call comes in": <code class="mono">${esc(origin)}/twilio/inbound</code></div>
        <div>Each number → Messaging: <code class="mono">${esc(origin)}/twilio/sms</code></div>
        <div>Recording: ${S.config.recording ? '<span class="badge good">on</span>' : '<span class="badge">off</span>'} · AI notes: ${S.config.ai ? '<span class="badge aib">on</span>' : '<span class="badge">needs keys</span>'} · Live transcript: ${S.config.live ? '<span class="badge aib">on</span>' : '<span class="badge">needs Deepgram key</span>'} · Live coaching: ${S.config.coaching ? '<span class="badge aib">on</span>' : '<span class="badge">off</span>'}</div>
        <div class="faint" style="font-size:11px">If you opened this page on localhost, swap the address above for your public URL.</div></div></div>
    </div>
    <div>
      <div class="card" style="margin-bottom:14px"><h3>Calling hours &amp; deals</h3>
        <div class="faint" style="font-size:12px;margin-bottom:8px">Leads are only dialed and auto-texted inside this window in <b>their own</b> time zone (taken from their phone number).</div>
        <div class="grid2"><div class="mf"><label>Window start (lead's time)</label><input type="time" id="cwStart" value="${esc(st.call_window_start || '08:00')}"></div>
          <div class="mf"><label>Window end (lead's time)</label><input type="time" id="cwEnd" value="${esc(st.call_window_end || '21:00')}"></div>
          <div class="mf"><label>Enforce</label><select id="cwOn"><option value="1">Yes — block calls outside the window</option><option value="0" ${st.enforce_call_window === false ? 'selected' : ''}>No</option></select></div>
          <div class="mf"><label>Renewal at % paid in</label><input type="number" id="rnPct" value="${esc(st.renewal_pct ?? 50)}"></div>
          <div class="mf"><label>Statements needed for "Docs in"</label><input type="number" id="stReq" value="${esc(st.statements_required ?? 3)}"></div></div>
        <button class="primary" onclick="saveTeamSettings({call_window_start:$('#cwStart').value, call_window_end:$('#cwEnd').value, enforce_call_window:$('#cwOn').value==='1', renewal_pct:+$('#rnPct').value, statements_required:+$('#stReq').value})">Save</button></div>
      <div class="card" style="margin-bottom:14px"><h3>Email templates</h3>
        <div class="faint" style="font-size:11px;margin-bottom:6px">Separate templates with a line containing only <code>---</code>. First line = name, second line = subject, the rest = message.</div>
        <textarea id="emTpl" rows="8" style="font-size:12px">${esc((st.email_templates || []).map(t => t.name + '\n' + t.subject + '\n' + t.body).join('\n---\n'))}</textarea>
        <button class="primary" style="margin-top:8px" onclick="saveEmailTpls()">Save templates</button></div>
      <div class="card" style="margin-bottom:14px"><h3>Call script</h3>
        <div class="faint" style="font-size:11px;margin-bottom:6px;line-height:1.6">Branching: start a step with <code>#&nbsp;id: Title</code>, add buttons with <code>-&gt; Button label: id</code>. Merge fields: {first} {name} {business} {state} {rep} {company}. Plain text works too.</div>
        <textarea id="scriptEd" rows="18" class="mono" style="font-size:11.5px">${esc(S.script || DEFAULT_SCRIPT)}</textarea>
        <button class="primary" style="margin-top:8px" onclick="saveScript()">Save script</button></div>
      <div class="card" style="margin-bottom:14px"><h3>Objection playbook</h3>
        <div class="faint" style="font-size:11px;margin-bottom:6px">One per line: <code>Objection: what to say</code>. Reps see these in the dialer, and the live AI coach uses them.</div>
        <textarea id="pbEd" rows="10" style="font-size:12px">${esc(st.playbook || '')}</textarea>
        <button class="primary" style="margin-top:8px" onclick="saveTeamSettings({playbook:$('#pbEd').value}).then(()=>S.playbook=$('#pbEd').value)">Save playbook</button></div>
      <div class="card" style="margin-bottom:14px"><h3>SMS templates</h3>
        <div class="faint" style="font-size:11px;margin-bottom:6px">One template per line. Same merge fields as the script.</div>
        <textarea id="tplEd" rows="6">${esc(tpls.join('\n'))}</textarea>
        <button class="primary" style="margin-top:8px" onclick="saveTpls()">Save templates</button></div>
      <div class="card"><h3>Auto-text after voicemail drop</h3>
        <div class="faint" style="font-size:11px;margin-bottom:6px">Sent about 15 seconds after a voicemail is dropped (at most once a day per lead). Leave blank to turn off. Only use this for leads who agreed to receive texts.</div>
        <textarea id="vmTxt" rows="3" placeholder="Hi {first}, it's {rep} with {company} — just left you a voicemail about funding for {business}. Text me back here when you have a sec.">${esc(st.vm_text_template || '')}</textarea>
        <button class="primary" style="margin-top:8px" onclick="saveTeamSettings({vm_text_template:$('#vmTxt').value})">Save</button></div>
    </div></div>`);
  $('#cidMode').value = st.callerid_mode || 'single';
}
const dncRows = rows => rows.map(r => `<div class="row" style="padding:3px 0;font-size:12px"><span class="mono grow">${esc(fmtPhone(r.phone))}</span><span class="faint">${esc(r.reason)}</span><button class="link" style="font-size:11px" onclick="delDnc('${esc(r.phone)}')">remove</button></div>`).join('') || '<span class="faint">Empty</span>';
let dncT; function searchDnc(q) { clearTimeout(dncT); dncT = setTimeout(async () => { const r = await api('/api/dnc?q=' + encodeURIComponent(q)).catch(() => null); if (r) $('#dncRows').innerHTML = dncRows(r.rows); }, 250); }
async function addDncList() { const numbers = $('#dncText').value.split(/[\n,;]+/).map(x => x.trim()).filter(Boolean); if (!numbers.length) return; try { const r = await api('/api/dnc', { numbers }); toast(`Added ${r.added} numbers to DNC`); viewTeam(); } catch (e) { toast(e.message, true); } }
async function delDnc(p) { if (!confirm('Remove ' + fmtPhone(p) + ' from the DNC list?')) return; await api('/api/dnc/' + encodeURIComponent(p), undefined, 'DELETE').catch(e => toast(e.message, true)); viewTeam(); }
function saveEmailTpls() {
  const t = $('#emTpl').value.split(/\n---\n/).map(b => { const [name, subject, ...rest] = b.trim().split('\n'); return { name: (name || '').trim(), subject: (subject || '').trim(), body: rest.join('\n').trim() }; }).filter(x => x.name && x.subject);
  saveTeamSettings({ email_templates: t });
}
async function saveTeamSettings(f) { try { await api('/api/settings', f, 'PUT'); Object.assign(S.teamSettings || {}, f); toast('Saved'); } catch (e) { toast(e.message, true); } }
async function syncNumbers() { try { const r = await api('/api/numbers/sync', {}); toast(`Found ${r.found} numbers, added ${r.added}`); viewTeam(); } catch (e) { toast(e.message, true); } }
async function addNumber() { const p = prompt('Twilio number you own (e.g. +12125550100):'); if (!p) return; try { await api('/api/numbers', { phone: p }); viewTeam(); } catch (e) { toast(e.message, true); } }
async function numSet(id, f) { await api('/api/numbers/' + id, f, 'PATCH').catch(e => toast(e.message, true)); viewTeam(); }
async function numDel(id) { if (!confirm('Remove this number from the pool?')) return; await api('/api/numbers/' + id, undefined, 'DELETE').catch(() => {}); viewTeam(); }
async function setUserSplit(id, o, c) { const a = prompt('Share of each funder payment this person gets when THEY originate the deal (%):', o); if (a === null) return; const b = prompt('Share they get when they CLOSE someone else’s deal (%):', c); if (b === null) return; if (isNaN(Number(a)) || isNaN(Number(b))) return toast('Enter numbers', true); setUser(id, { split_pct: a === '' ? '' : Number(a), closer_split_pct: b === '' ? '' : Number(b) }); }
async function setUserComm(id, cur) { const p = prompt('Default commission % on funded amount (e.g. 3):', cur || ''); if (p === null) return; if (isNaN(Number(p))) return toast('Enter a number', true); setUser(id, { commission_pct: Number(p) }); }
async function setUserPhone(id) { const p = prompt('Cell number for warm transfers (blank to remove):'); if (p === null) return; if (p && !normPhone(p)) return toast('Invalid number', true); setUser(id, { phone: p }); }
async function addUser() {
  try { await api('/api/users', { name: $('#nuName').value, email: $('#nuEmail').value, password: $('#nuPass').value, role: $('#nuRole').value, phone: $('#nuPhone').value }); toast('User added — send them the URL, email and password'); viewTeam(); }
  catch (e) { toast(e.message, true); }
}
async function setUser(id, f) { try { await api('/api/users/' + id, f, 'PATCH'); viewTeam(); } catch (e) { toast(e.message, true); } }
async function resetPw(id) { const p = prompt('New password (8+ characters):'); if (p) setUser(id, { password: p }).then(() => toast('Password changed')); }
async function saveScript() { try { await api('/api/script', { script: $('#scriptEd').value }, 'PUT'); S.script = $('#scriptEd').value; toast('Script saved'); } catch (e) { toast(e.message, true); } }
async function saveTpls() { const t = $('#tplEd').value.split('\n').map(x => x.trim()).filter(Boolean); try { await api('/api/templates', { templates: t }, 'PUT'); S.templates = t; toast('Templates saved'); } catch (e) { toast(e.message, true); } }

// ============ view: my settings ============
async function viewSettings() {
  const p = S.prefs;
  const [vms, me] = await Promise.all([api('/api/voicemails').catch(() => []), api('/api/me').catch(() => null)]);
  if (me) S.me = me.user;
  if (S.route !== 'settings') return;
  V(`<div class="vtitle"><h1>My settings</h1></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;max-width:1000px;align-items:start">
      <div>
      <div class="card" style="margin-bottom:14px"><h3>Dialer</h3><div class="grid2">
        <div class="mf"><label>Lines to dial at once</label><select id="sLines">${[1, 2, 3, 4, 5].map(n => `<option ${p.lines === n ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div class="mf"><label>Ring timeout (sec)</label><input type="number" id="sRing" value="${p.ringTimeout}" min="10" max="60"></div>
        <div class="mf"><label>Pause between batches (sec)</label><input type="number" id="sDelay" value="${p.delay}" min="0"></div>
        <div class="mf"><label>Retry no-answers after (min)</label><input type="number" id="sRetry" value="${p.retryMins}" min="0"></div>
        <div class="mf"><label>Max attempts per lead</label><input type="number" id="sMax" value="${p.maxAttempts}" min="1"></div>
        <div class="mf"><label>Skip answering machines</label><select id="sAmd"><option value="1" ${p.amd ? 'selected' : ''}>Yes</option><option value="0" ${p.amd ? '' : 'selected'}>No</option></select></div>
</div>
        <div class="faint" style="font-size:12px;margin-bottom:10px">Calling hours follow each lead's own time zone (set by an admin under Team &amp; setup).</div>
        <div class="mf"><label>Caller ID override (blank = team setting)</label><input id="sCaller" value="${esc(p.callerId)}" placeholder="+12125551234"></div>
        <button class="primary" onclick="savePrefsForm()">Save</button></div>
      <div class="card"><h3>Change password</h3>
        <div class="mf"><label>Current password</label><input type="password" id="pwCur"></div>
        <div class="mf"><label>New password (8+ chars)</label><input type="password" id="pwNew"></div>
        <button onclick="changePw()">Change password</button>
        <h3 style="margin-top:20px">Keyboard shortcuts (dialer)</h3>
        <div class="muted" style="line-height:1.8">N dial next · H hang up · M mute · V drop voicemail · T transfer<br>1–8 dispositions</div></div>
      </div>
      <div>
      <div class="card" style="margin-bottom:14px"><h3>Voicemail drop</h3>
        <div class="faint" style="font-size:12px;margin-bottom:10px;line-height:1.5">Record a voicemail once. Turn on "Auto voicemail drop" in the dialer to leave it on every machine automatically, or press V / Drop VM when you hear a greeting.</div>
        ${vms.length ? vms.map(v => `<div class="row" style="padding:8px 0;border-bottom:1px solid var(--border)">
            <input type="radio" name="myvm" ${S.me.voicemail_id === v.id ? 'checked' : ''} onchange="setMyVm(${v.id})">
            <div class="grow"><b>${esc(v.name)}</b> ${v.shared ? '<span class="badge">team</span>' : ''}<audio controls preload="none" src="${esc(v.url)}" style="height:30px;margin-top:4px"></audio></div>
            ${!v.shared || isAdmin() ? `<button class="sm" onclick="delVm(${v.id})">✕</button>` : ''}</div>`).join('') : '<div class="faint">No voicemails yet.</div>'}
        <div class="mf" style="margin-top:12px"><label>Name</label><input id="vmName" placeholder="e.g. Standard VM"></div>
        <div class="row wrap">
          <button class="primary" onclick="recordVm()" id="recBtn">🎙 Record with my headset</button>
          <label class="row" style="gap:6px"><button onclick="$('#vmFile').click()">Upload MP3/WAV</button><input type="file" id="vmFile" accept=".mp3,.wav,audio/mpeg,audio/wav" class="hidden" onchange="uploadVm(this)"></label>
          ${isAdmin() ? '<label class="row muted" style="gap:6px"><input type="checkbox" id="vmShared"> Share with team</label>' : ''}
        </div>
        <div id="recBar"></div></div>
      <div class="card"><h3>My transfer number</h3>
        <div class="faint" style="font-size:12px;margin-bottom:6px">Teammates can warm-transfer merchants to this phone.</div>
        <div class="row"><input id="myPhone" value="${esc(fmtPhone(S.me.phone))}" placeholder="(212) 555-0100"><button onclick="saveMyPhone()">Save</button></div></div>
      </div>
    </div>`);
}
async function setMyVm(id) { await api('/api/me', { voicemail_id: id }, 'PATCH').catch(e => toast(e.message, true)); S.me.voicemail_id = id; toast('Voicemail selected'); }
async function delVm(id) { if (!confirm('Delete this voicemail?')) return; await api('/api/voicemails/' + id, undefined, 'DELETE').catch(e => toast(e.message, true)); viewSettings(); }
async function saveMyPhone() { const v = $('#myPhone').value; if (v && !normPhone(v)) return toast('Invalid number', true); await api('/api/me', { phone: v }, 'PATCH').catch(e => toast(e.message, true)); toast('Saved'); }
function uploadVm(input) {
  const f = input.files[0]; if (!f) return;
  if (f.size > 8 * 1024 * 1024) return toast('File must be under 8 MB', true);
  const r = new FileReader();
  r.onload = async () => {
    try {
      await api('/api/voicemails', { name: $('#vmName').value || f.name.replace(/\.\w+$/, ''), data: String(r.result).split(',')[1], mime: f.type || (f.name.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg'), shared: $('#vmShared')?.checked });
      toast('Voicemail uploaded'); viewSettings();
    } catch (e) { toast(e.message, true); }
  };
  r.readAsDataURL(f);
}
async function recordVm() {
  if (S.inSession) return toast('End your dialing session first', true);
  try {
    const { token } = await api('/api/token');
    const dev = new Twilio.Device(token, { codecPreferences: ['opus', 'pcmu'], logLevel: 1 });
    const call = await dev.connect({ params: { mode: 'record_vm', name: $('#vmName').value || 'My voicemail' } });
    S.recVm = { dev, call };
    $('#recBar').innerHTML = `<div class="banner connected" style="margin-top:12px"><div><div class="ph" style="font-size:15px">● Recording</div><div class="sm">Wait for the beep, speak your voicemail, then click Done.</div></div><button class="primary" onclick="finishRecVm()">Done</button></div>`;
    call.on('disconnect', () => { try { dev.destroy(); } catch {} S.recVm = null; const el = $('#recBar'); if (el) el.innerHTML = '<div class="faint" style="margin-top:8px">Saving…</div>'; });
  } catch (e) { toast('Could not start recording: ' + e.message, true); }
}
function finishRecVm() { if (!S.recVm) return; S.recVm.call.sendDigits('#'); setTimeout(() => { try { S.recVm && S.recVm.call.disconnect(); } catch {} }, 4000); }
function savePrefsForm() {
  const p = S.prefs, c = $('#sCaller').value.trim();
  if (c && !normPhone(c)) return toast('Caller ID must be a valid phone number', true);
  Object.assign(p, { lines: +$('#sLines').value, ringTimeout: Math.min(60, Math.max(10, +$('#sRing').value || 25)), delay: Math.max(0, +$('#sDelay').value || 0),
    retryMins: Math.max(0, +$('#sRetry').value || 0), maxAttempts: Math.max(1, +$('#sMax').value || 6), amd: $('#sAmd').value === '1',
    callerId: c ? normPhone(c) : '' });
  savePrefs(); toast('Saved');
}
async function changePw() { try { await api('/api/me/password', { current: $('#pwCur').value, password: $('#pwNew').value }); toast('Password changed'); $('#pwCur').value = $('#pwNew').value = ''; } catch (e) { toast(e.message, true); } }

// ============ keyboard ============
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
  if (S.route !== 'dialer' || e.target.matches('input,textarea,select') || e.metaKey || e.ctrlKey || e.altKey || $('#modal').classList.contains('show')) return;
  const k = e.key.toLowerCase(), d = DISPOS.find(x => x.key === k);
  if (d) { e.preventDefault(); saveDispo(d.code); }
  else if (k === 'n') dialNext(); else if (k === 'h') hangup(); else if (k === 'm') toggleMute(); else if (k === 'v') dropVm(); else if (k === 't') transferModal();
});
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
window.addEventListener('beforeunload', e => { if (S.inSession) { e.preventDefault(); e.returnValue = ''; } });

boot();
