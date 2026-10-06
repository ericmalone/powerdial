// v4 pages and cards: statement reader, document reminders, offers, contract, payments, ISO, goals, intake, security, search
const fmtMoney = n => n == null || n === '' || isNaN(n) ? '—' : (n < 0 ? '−$' : '$') + Math.round(Math.abs(Number(n))).toLocaleString('en-US');

// ================= deal page cards =================
function dealCardsA(r) {
  const d = r.deal, open = !['funded', 'lost'].includes(d.stage);
  let h = '';
  if (open) {
    const miss = r.checklist.filter(x => !x.done).length;
    h += `<div class="card" style="margin-bottom:14px"><div class="row"><h3 class="grow" style="margin:0">Checklist &amp; reminders</h3>${miss ? `<span class="badge callback">${miss} missing</span>` : '<span class="badge good">Complete</span>'}</div>
      <div style="margin-top:10px">${r.checklist.map(x => `<div class="row" style="padding:5px 0"><span style="width:18px;color:${x.done ? 'var(--green)' : 'var(--text3)'}">${x.done ? '✓' : '○'}</span><span class="grow ${x.done ? 'muted' : ''}">${esc(x.label)}</span>${x.detail ? `<span class="faint mono" style="font-size:11px">${esc(x.detail)}</span>` : ''}</div>`).join('')}</div>
      ${d.has_link ? `<div class="row wrap" style="margin-top:10px;gap:8px"><span class="faint" style="font-size:12px;flex:1">${d.chase_off ? 'Automatic reminders are off.' : 'Merchant is reminded automatically until everything is in.'} ${d.chase_count ? `${d.chase_count} sent${d.last_chase_at ? ', last ' + fmtTime(d.last_chase_at) : ''}.` : ''}</span>
        <button class="sm" onclick="chaseNow(${d.id})" ${miss ? '' : 'disabled'}>Send reminder now</button><button class="sm" onclick="toggleChase(${d.id},${d.chase_off ? 0 : 1})">${d.chase_off ? 'Turn reminders on' : 'Turn reminders off'}</button></div>`
        : '<div class="faint" style="font-size:12px;margin-top:8px">Send the application link first. Reminders start after that.</div>'}</div>`;
  }
  h += stmtCard(r);
  return h;
}
function stmtCard(r) {
  const d = r.deal, x = d.stmt, n = r.files.filter(f => f.kind === 'statement').length;
  if (!x && !n && d.stmt_status !== 'running') return '';
  const head = `<div class="row"><h3 class="grow" style="margin:0">Bank statement reader</h3>${d.stmt_status === 'running' ? '<span class="badge aib">Reading…</span>' : x ? '<span class="badge aib">AI</span>' : ''}
    <button class="sm" onclick="analyzeDeal(${d.id})" ${d.stmt_status === 'running' || !n ? 'disabled' : ''}>${x ? 'Read again' : 'Read statements'}</button></div>`;
  if (!x) return `<div class="card" style="margin-bottom:14px">${head}<div class="faint" style="margin-top:8px;font-size:12px">${d.stmt_status === 'error' ? `<span style="color:var(--red)">${esc(d.stmt_error)}</span>` : d.stmt_status === 'running' ? 'This takes about a minute.' : 'Statements are read automatically after the merchant uploads them. Click to run it now.'}</div></div>`;
  const kp = (v, l, c) => `<div class="kpi" style="padding:8px 10px"><b style="font-size:16px;${c ? 'color:' + c : ''}">${v}</b><span>${l}</span></div>`;
  const trend = { up: ['▲ up', 'var(--green)'], down: ['▼ down', 'var(--red)'], flat: ['► flat', ''] }[x.revenue_trend] || ['—', ''];
  return `<div class="card" style="margin-bottom:14px">${head}
    ${x.summary ? `<div class="ai" style="margin:10px 0;padding:8px 10px"><div class="lbl">Summary</div>${esc(x.summary)}</div>` : ''}
    <div class="kpis" style="grid-template-columns:repeat(4,1fr);margin:8px 0">${kp(fmtMoney(x.avg_monthly_revenue), 'Avg monthly revenue')}${kp(fmtMoney(x.avg_daily_balance), 'Avg daily balance')}${kp(x.total_nsf, 'NSFs', x.total_nsf > 2 ? 'var(--red)' : '')}${kp(trend[0], 'Revenue trend', trend[1])}</div>
    ${x.flags.length ? `<div style="margin:8px 0">${x.flags.map(f => `<div style="color:var(--amber);font-size:12.5px;padding:2px 0">⚠ ${esc(f)}</div>`).join('')}</div>` : ''}
    <div class="tablewrap"><table><thead><tr><th>Month</th><th style="text-align:right">Deposits</th><th style="text-align:right">True revenue</th><th style="text-align:right">Avg balance</th><th style="text-align:right">Ending</th><th style="text-align:right">NSF</th><th style="text-align:right">Neg. days</th></tr></thead>
      <tbody>${x.statements.map(s => `<tr><td>${esc(s.month)}</td><td class="mono" style="text-align:right">${fmtMoney(s.total_deposits)}</td><td class="mono" style="text-align:right">${fmtMoney(s.true_revenue)}</td><td class="mono" style="text-align:right">${fmtMoney(s.avg_daily_balance)}</td><td class="mono" style="text-align:right">${fmtMoney(s.ending_balance)}</td><td class="mono" style="text-align:right;${s.nsf_count ? 'color:var(--red)' : ''}">${s.nsf_count}</td><td class="mono" style="text-align:right">${s.negative_days || 0}</td></tr>`).join('')}</tbody></table></div>
    ${x.existing_funders.length ? `<h3 style="margin-top:12px">Existing funders found (${x.existing_funders.length})</h3>${x.existing_funders.map(f => `<div class="row" style="padding:4px 0;border-bottom:1px solid var(--border)"><b class="grow">${esc(f.name)}</b><span class="mono">${fmtMoney(f.amount)} ${esc(f.frequency)}</span></div><div class="faint" style="font-size:11px">${esc(f.evidence)}</div>`).join('')}` : '<div class="faint" style="margin-top:10px;font-size:12px">No existing funder payments found.</div>'}
    <div class="faint" style="font-size:11px;margin-top:8px">${esc(x.bank_name)} ${x.account_last4 ? '··' + esc(x.account_last4) : ''} · read ${fmtTime(d.stmt_analyzed_at)} · check against the actual statements before relying on it</div></div>`;
}
async function chaseNow(id) { try { const r = await api(`/api/deals/${id}/chase`, {}); toast('Reminder sent by ' + r.via.join(' and ')); route(); } catch (e) { toast(e.message, true); } }
async function toggleChase(id, off) { try { await api(`/api/deals/${id}/chase-toggle`, { off: !!off }); route(); } catch (e) { toast(e.message, true); } }
async function analyzeDeal(id) { try { await api(`/api/deals/${id}/analyze`, {}); toast('Reading statements — this takes about a minute'); setTimeout(route, 1200); } catch (e) { toast(e.message, true); } }

function dealCardsB(r) { setTimeout(() => loadOffers(r.deal.id), 0); return `<div id="offersBox"></div>`; }
function dealCardsC(r) { setTimeout(() => { loadPilotBox(r); loadContract(r.deal.id); if (r.deal.stage === 'funded') loadPayments(r.deal.id); if (isAdmin()) renderIsoBox(r); if (r.deal.stage === 'funded') loadSplitBox(r); }, 0); return `<div id="pilotBox"></div><div id="contractBox"></div><div id="paymentsBox"></div><div id="splitBox"></div><div id="isoBox"></div>`; }
const PCT = n => n == null ? '—' : String(n);
async function loadOffers(id) {
  const box = $('#offersBox'); if (!box) return;
  const o = await api('/api/deals/' + id + '/offers').catch(() => null); if (!o || !o.rows.length || !$('#offersBox')) { box.innerHTML = ''; return; }
  const admin = isAdmin();
  box.innerHTML = `<div class="card" style="margin-bottom:14px"><div class="row"><h3 class="grow" style="margin:0">Compare offers</h3>${o.sent_at ? `<span class="faint" style="font-size:11px">shown to merchant ${fmtTime(o.sent_at)}</span>` : ''}</div>
    <div class="tablewrap" style="margin-top:8px"><table><thead><tr><th></th><th>Lender</th><th style="text-align:right">Amount</th><th style="text-align:right">Factor</th><th style="text-align:right">Repay</th><th style="text-align:right">Cost</th><th style="text-align:right">Payment</th><th style="text-align:right">Term</th>${admin ? '<th style="text-align:right">Our revenue</th>' : ''}<th></th></tr></thead><tbody>
    ${o.rows.map(x => `<tr ${x.chosen ? 'style="background:var(--panel2)"' : ''}><td><input type="checkbox" class="offPick" value="${x.sub_id}" ${x.published || o.rows.length === 1 ? 'checked' : ''}></td>
      <td><b>${esc(x.lender_name)}</b>${x.best_rate ? ' <span class="badge good">best rate</span>' : ''}${x.most_cash ? ' <span class="badge">most cash</span>' : ''}${x.label ? ` <span class="badge">shown as ${x.label}</span>` : ''}${x.chosen ? ' <span class="badge good">selected</span>' : ''}</td>
      <td class="mono" style="text-align:right">${fmtMoney(x.amount)}</td><td class="mono" style="text-align:right">${PCT(x.factor)}</td><td class="mono" style="text-align:right">${fmtMoney(x.payback)}</td><td class="mono" style="text-align:right">${fmtMoney(x.cost)}</td>
      <td class="mono" style="text-align:right">${fmtMoney(x.payment)}${x.payment_est ? '*' : ''}/${x.freq === 'weekly' ? 'wk' : 'day'}</td><td class="mono" style="text-align:right">${x.term_days ? x.term_days + 'd' : '—'}</td>
      ${admin ? `<td class="mono" style="text-align:right">${fmtMoney(x.our_revenue)}</td>` : ''}<td><button class="sm" onclick="useOffer(${id},${x.sub_id})">${x.chosen ? 'Re-apply' : 'Use this'}</button></td></tr>`).join('')}</tbody></table></div>
    <div class="faint" style="font-size:11px;margin:6px 0">* payment estimated from the repay amount and term. “Use this” fills the funding terms on the right and moves the deal to Offer.</div>
    <div class="row wrap" style="gap:6px"><b style="font-size:12px">Show checked offers to the merchant:</b><button class="sm primary" onclick="publishOffers(${id},'sms')">Text link</button><button class="sm" onclick="publishOffers(${id},'email')">Email link</button><button class="sm" onclick="publishOffers(${id},'')">Just get link</button></div>
    ${o.link && o.sent_at !== undefined && o.rows.some(x => x.published) ? `<div class="row" style="margin-top:8px"><input readonly class="mono" style="flex:1;font-size:11px" value="${esc(o.link)}" onclick="this.select()"><button class="sm" onclick="navigator.clipboard.writeText('${esc(o.link)}');toast('Copied')">Copy</button></div>` : ''}
    <div class="faint" style="font-size:11px;margin-top:6px">The merchant sees offers labeled A, B, C${o.show_lender ? ' with lender names' : ' without lender names'} (change in Automation → Offers &amp; contract).</div></div>`;
}
async function useOffer(id, sub) { try { await api('/api/deals/' + id + '/offers/accept', { sub_id: sub }); toast('Terms filled in'); route(); } catch (e) { toast(e.message, true); } }
async function publishOffers(id, via) {
  const ids = [...document.querySelectorAll('.offPick:checked')].map(c => +c.value); if (!ids.length) return toast('Check at least one offer', true);
  try { const r = await api('/api/deals/' + id + '/offers/publish', { sub_ids: ids, via }); toast(via ? 'Sent to merchant' : 'Link ready'); if (!via) { try { await navigator.clipboard.writeText(r.link); toast('Link copied'); } catch {} } loadOffers(id); } catch (e) { toast(e.message, true); }
}
async function loadContract(id) {
  const box = $('#contractBox'); if (!box) return;
  const c = await api('/api/deals/' + id + '/contract').catch(() => null); if (!c || !$('#contractBox')) return;
  const sgn = c.signed_at;
  box.innerHTML = `<div class="card" style="margin-bottom:14px"><h3>Funding contract</h3>
    ${sgn ? `<div class="row"><span class="badge good">Signed</span><span class="grow">by ${esc(c.signed_name || '')} · ${fmtTime(c.signed_at)}</span></div><div class="faint" style="font-size:12px;margin-top:6px">The signed PDF is saved under Documents.</div>`
      : c.sent_at ? `<div class="row"><span class="badge callback">Waiting for signature</span><span class="grow faint" style="font-size:12px">sent ${fmtTime(c.sent_at)}</span></div>`
      : '<div class="faint" style="font-size:12px;margin-bottom:6px">Fill in the funding terms above, then send the merchant the agreement to e-sign.</div>'}
    ${!c.template_ready ? `<div style="color:var(--amber);font-size:12px;margin:8px 0">No agreement text yet.${isAdmin() ? ' <a href="#/automation">Add it in Automation → Offers &amp; contract</a>.' : ' Ask an admin to add it.'}</div>` : ''}
    ${c.missing.length && !sgn ? `<div class="faint" style="font-size:12px;margin:6px 0">Still needed: ${esc(c.missing.join(', '))}</div>` : ''}
    <div class="row wrap" style="gap:6px;margin-top:8px">${!sgn ? `<button class="sm primary" onclick="sendContract(${id},'sms')">${c.sent_at ? 'Resend' : 'Send'} by text</button><button class="sm" onclick="sendContract(${id},'email')">By email</button><button class="sm" onclick="sendContract(${id},'')">Get link</button>` : `<button class="sm" onclick="if(confirm('Send a fresh copy for signature? This clears the existing signature.'))sendContract(${id},'sms',true)">Send new copy</button>`}
      <a class="sm button" href="/api/deals/${id}/contract.pdf" target="_blank" style="text-decoration:none"><button class="sm">View PDF</button></a></div>
    ${c.link && !sgn ? `<div class="row" style="margin-top:8px"><input readonly class="mono" style="flex:1;font-size:11px" value="${esc(c.link)}" onclick="this.select()"><button class="sm" onclick="navigator.clipboard.writeText('${esc(c.link)}');toast('Copied')">Copy</button></div>` : ''}</div>`;
}
async function sendContract(id, via, resend) {
  try { const r = await api('/api/deals/' + id + '/contract/send', { via, resend }); toast(via ? 'Contract sent' : 'Link ready'); if (!via) { try { await navigator.clipboard.writeText(r.link); toast('Link copied'); } catch {} } route(); } catch (e) { toast(e.message, true); }
}


// ================= Automation page (admin settings for the v4 features) =================
const AUTO_TABS = [['docs', 'Reminders & documents'], ['intake', 'Lead intake'], ['queue', 'Smart queue & goals'], ['contract', 'Offers & contract'], ['digest', 'Digest'], ['compliance', 'Compliance'], ['security', 'Security & backups']];
async function viewAutomation(tab) {
  if (!isAdmin()) return V('<div class="empty" style="padding:40px">Admins only.</div>');
  tab = AUTO_TABS.some(t => t[0] === tab) ? tab : 'docs';
  V(`<div class="vtitle"><h1>Automation</h1><span class="muted">Settings for reminders, lead intake, queue, contracts and compliance</span></div>
    <div class="rptabs">${AUTO_TABS.map(([k, l]) => `<a href="#/automation/${k}" class="${k === tab ? 'act' : ''}">${l}</a>`).join('')}</div><div id="autoBody" class="muted">Loading…</div>`);
  try { await AUTO_RENDER[tab](); } catch (e) { if ($('#autoBody')) $('#autoBody').innerHTML = `<div class="card" style="color:var(--red)">${esc(e.message)}</div>`; }
}
const AUTO_RENDER = {};
const mf = (label, inner, hint) => `<div class="mf"><label>${label}</label>${inner}${hint ? `<div class="faint" style="font-size:11px;margin-top:3px">${hint}</div>` : ''}</div>`;
async function saveSettings(obj, msg) { try { await api('/api/settings', obj, 'PUT'); toast(msg || 'Saved'); } catch (e) { toast(e.message, true); } }

AUTO_RENDER.docs = async () => {
  const st = await api('/api/settings'), c = st.chase, rd = st.required_docs;
  $('#autoBody').className = '';
  $('#autoBody').innerHTML = `<div style="display:grid;grid-template-columns:1fr 1.4fr;gap:14px;align-items:start">
    <div class="card"><h3>Documents every deal needs</h3>
      <div class="faint" style="font-size:12px;margin-bottom:10px">The signed application and bank statements below must be in before a deal moves to “Docs in”. Anything missing is chased automatically and shown on the merchant's page.</div>
      ${mf('Bank statements required', `<input type="number" id="adStmts" min="0" max="12" value="${esc(st.statements_required ?? 3)}">`)}
      <label class="row" style="margin:8px 0"><input type="checkbox" id="adId" ${rd.id ? 'checked' : ''}> Require driver's license / ID</label>
      <label class="row" style="margin:8px 0"><input type="checkbox" id="adVoid" ${rd.voided_check ? 'checked' : ''}> Require voided check</label>
      <button class="primary" onclick="saveSettings({statements_required:+$('#adStmts').value, required_docs:{id:$('#adId').checked, voided_check:$('#adVoid').checked}})">Save</button></div>
    <div class="card"><h3>Automatic reminders to the merchant</h3>
      <div class="faint" style="font-size:12px;margin-bottom:10px">After the application link goes out, the merchant gets a text and/or email until everything is in. Texts only go out inside calling hours in the merchant's time zone, and never while a rep is already talking or texting with them.</div>
      <div class="row wrap" style="gap:18px;margin-bottom:8px"><label class="row"><input type="checkbox" id="chOn" ${c.enabled ? 'checked' : ''}> Reminders on</label><label class="row"><input type="checkbox" id="chSms" ${c.sms ? 'checked' : ''}> Send text</label><label class="row"><input type="checkbox" id="chEm" ${c.email ? 'checked' : ''}> Send email</label></div>
      ${mf('Send reminders this many hours after the link was sent', `<input id="chHours" value="${esc(c.hours.join(', '))}">`, 'Example: 4, 24, 48, 96, 168 = after 4 hours, 1 day, 2 days, 4 days, 7 days. That is the total number of reminders.')}
      ${mf('Text message', `<textarea id="chSmsT" rows="3">${esc(c.sms_tpl)}</textarea>`)}
      ${mf('Email subject', `<input id="chSub" value="${esc(c.email_subject)}">`)}
      ${mf('Email body', `<textarea id="chBody" rows="6">${esc(c.email_body)}</textarea>`, 'Fields: {first} {business} {rep} {company} {link} {missing} {missing_list}')}
      <button class="primary" onclick="saveChase()">Save reminders</button></div></div>`;
};
function saveChase() {
  const hours = $('#chHours').value.split(/[,\s]+/).map(Number).filter(n => n > 0);
  saveSettings({ chase: { enabled: $('#chOn').checked, sms: $('#chSms').checked, email: $('#chEm').checked, hours, sms_tpl: $('#chSmsT').value, email_subject: $('#chSub').value, email_body: $('#chBody').value } });
}


// ================= hot lead alert (speed to lead) =================
function showHotLead(d) {
  beep(880); setTimeout(() => beep(1100), 160);
  let box = $('#hotBox'); if (!box) { box = document.createElement('div'); box.id = 'hotBox'; document.body.appendChild(box); }
  const el = document.createElement('div'); el.className = 'hotcard';
  el.innerHTML = `<div class="row"><b class="grow">${d.hot ? '🔥 ' : ''}${esc(d.text)}</b><button class="link" onclick="this.closest('.hotcard').remove()">✕</button></div>
    <div class="row" style="margin-top:8px"><button class="primary sm" onclick="hotCall(${d.leadId}, this)">${S.inSession && S.phase === 'ready' ? 'Call now' : 'Open lead'}</button><button class="sm" onclick="go('#/lead/${d.leadId}');this.closest('.hotcard').remove()">View</button></div>`;
  box.prepend(el); setTimeout(() => el.remove(), 5 * 60000);
}
function hotCall(id, btn) { btn.closest('.hotcard').remove(); if (S.inSession && S.phase === 'ready') callLead(id); else go('#/lead/' + id); }


// ================= alternate phone numbers (lead profile) =================
function leadPhonesBlock(r) {
  const ph = r.phones || [];
  return `<div style="margin-top:14px;border-top:1px solid var(--border);padding-top:10px"><div class="row"><b class="grow" style="font-size:12px">Other phone numbers</b>${ph.length ? '' : '<span class="faint" style="font-size:11px">none</span>'}</div>
    ${ph.map(p => `<div class="row" style="padding:4px 0;${p.bad ? 'opacity:.55' : ''}"><span class="mono grow">${esc(fmtPhone(p.phone))}${p.label ? ` <span class="faint">${esc(p.label)}</span>` : ''}${p.bad ? ' <span class="badge dnc">bad</span>' : ''}</span>
      <button class="sm" onclick="usePhone(${p.id})">Use as main</button><button class="sm" onclick="badPhone(${p.id},${p.bad ? 0 : 1})">${p.bad ? 'Not bad' : 'Bad'}</button><button class="link" onclick="delPhone(${p.id})">✕</button></div>`).join('')}
    <div class="row" style="margin-top:6px"><input id="newAlt" placeholder="Add another number" style="flex:1"><button class="sm" onclick="addAlt(${r.lead.id})">Add</button></div>
    <div class="faint" style="font-size:11px;margin-top:4px">If a call is marked Wrong Number, the dialer switches to the next good number automatically.</div></div>`;
}
async function addAlt(id) { const v = $('#newAlt').value; if (!v.trim()) return; try { await api(`/api/leads/${id}/phones`, { phone: v }); route(); } catch (e) { toast(e.message, true); } }
async function usePhone(id) { try { const r = await api(`/api/phones/${id}/use`, {}); toast('Main number is now ' + fmtPhone(r.phone)); route(); } catch (e) { toast(e.message, true); } }
async function badPhone(id, bad) { await api('/api/phones/' + id, { bad }, 'PATCH'); route(); }
async function delPhone(id) { await api('/api/phones/' + id, undefined, 'DELETE'); route(); }


// ================= Automation: lead intake =================
AUTO_RENDER.intake = async () => {
  const d = await api('/api/intake'); S.intakeData = d;
  const status = { added: ['New lead', 'good'], duplicate: ['Came back', 'callback'], rejected: ['Rejected', 'dnc'], dnc: ['On DNC', 'dnc'] };
  $('#autoBody').className = '';
  $('#autoBody').innerHTML = `<div style="display:grid;grid-template-columns:1.3fr 1fr;gap:14px;align-items:start"><div>
    <div class="card" style="margin-bottom:14px"><div class="row"><h3 class="grow" style="margin:0">Lead intake addresses</h3><button class="primary sm" onclick="intakeModal()">+ New address</button></div>
      <div class="faint" style="font-size:12px;margin:8px 0">Each address is a private web link. Point your website forms, ad lead forms, Zapier or Instantly replies at it. New leads land in the CRM with the source you choose, get assigned to an available rep, and pop up on that rep's screen so they can call within a minute.</div>
      ${d.keys.map(k => `<div style="padding:10px 0;border-top:1px solid var(--border);${k.active ? '' : 'opacity:.5'}"><div class="row"><b class="grow">${esc(k.name)}</b><span class="badge">${esc(k.source)}</span><span class="faint mono" style="font-size:11px">${k.received} received${k.last_at ? ' · last ' + fmtTime(k.last_at) : ''}</span></div>
        <div class="row" style="margin-top:6px"><input readonly class="mono" style="flex:1;font-size:11px" value="${esc(k.url)}" onclick="this.select()"><button class="sm" onclick="navigator.clipboard.writeText('${esc(k.url)}');toast('Copied')">Copy</button></div>
        <div class="faint" style="font-size:11px;margin-top:4px">${k.hot ? 'Hot lead: jumps to the top of the queue · ' : ''}${k.assign === 'round_robin' ? 'Assigned to the next available rep' : k.assign === 'none' ? 'Not assigned' : 'Assigned to ' + esc((d.users.find(u => 'user:' + u.id === k.assign) || {}).name || 'one rep')}${k.auto_text ? ' · Instant text on' : ''}</div>
        <div class="row" style="margin-top:6px"><button class="sm" onclick="intakeModal(${k.id})">Edit</button><button class="sm" onclick="intakeRotate(${k.id})">New link</button><button class="sm" onclick="intakeActive(${k.id},${k.active ? 0 : 1})">${k.active ? 'Turn off' : 'Turn on'}</button></div></div>`).join('') || '<div class="empty">No intake addresses yet.</div>'}</div>
    <div class="card"><h3>Recent leads received</h3><div class="tablewrap" style="max-height:340px;overflow:auto"><table><thead><tr><th>When</th><th>Address</th><th>Result</th><th>Lead</th><th>Assigned</th></tr></thead><tbody>
      ${d.log.map(g => `<tr title="${esc(g.payload)}"><td class="mono" style="font-size:11px">${fmtTime(g.received_at)}</td><td>${esc(g.key_name || '')}</td><td><span class="badge ${(status[g.status] || [])[1] || ''}">${esc((status[g.status] || [g.status])[0])}</span>${g.reason ? `<div class="faint" style="font-size:11px">${esc(g.reason)}</div>` : ''}</td>
        <td>${g.lead_id ? `<a href="#/lead/${g.lead_id}">${esc(g.lead_business || g.lead_name || 'Lead')}</a>` : ''}</td><td>${esc(g.assigned_name || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nothing received yet.</td></tr>'}</tbody></table></div></div></div>
    <div class="card"><h3>How to connect</h3><div style="font-size:12.5px;line-height:1.6">
      <b>Any form or tool (Zapier, Make, GoHighLevel, Facebook lead ads):</b> send a POST request to your address with the lead's details. Fields are recognized by name: <code>phone</code>, <code>name</code> (or <code>first_name</code> + <code>last_name</code>), <code>business</code> (or <code>company</code>), <code>email</code>, <code>state</code>, <code>message</code>. Anything else is saved on the lead.
      <pre class="mono" style="white-space:pre-wrap;background:var(--bg);padding:8px;border-radius:6px;font-size:11px;margin:8px 0">curl -X POST '&lt;your address&gt;' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Sam Lee","company":"Lee Auto","phone":"2125550123","email":"sam@lee.com","message":"Need $50k"}'</pre>
      <b>Website form:</b> set the form's action to your address with method POST. Add a hidden field <code>redirect</code> with your thank-you page.
      <pre class="mono" style="white-space:pre-wrap;background:var(--bg);padding:8px;border-radius:6px;font-size:11px;margin:8px 0">&lt;form method="POST" action="&lt;your address&gt;"&gt;
  &lt;input name="name"&gt; &lt;input name="phone"&gt; &lt;input name="company"&gt;
  &lt;input type="hidden" name="redirect" value="https://yoursite.com/thanks"&gt;
&lt;/form&gt;</pre>
      <b>Instantly:</b> in Instantly, add a webhook for “reply received” (or “lead interested”) pointing at your address. A lead is created only when the payload includes a phone number; replies without one are listed above as Rejected so you can follow up by email.
      <div class="faint" style="margin-top:8px">Leads you receive this way should have asked to be contacted. Only turn on instant texting for forms where the person agreed to receive texts.</div></div></div></div>`;
};
function intakeModal(id) {
  const k = id ? S.intakeData.keys.find(x => x.id === id) : { name: '', source: '', hot: 1, auto_text: 0, assign: 'round_robin', text_template: 'Hi {first}, this is {rep} with {company}. Thanks for reaching out about funding for {business} — I will give you a call in a minute.' };
  openModal(`<h3>${id ? 'Edit' : 'New'} intake address</h3>
    ${mf('Name', `<input id="ikName" value="${esc(k.name)}" placeholder="e.g. Website application form">`)}
    ${mf('Lead source name', `<input id="ikSource" value="${esc(k.source)}" placeholder="e.g. Web form" list="listNames">`, 'Shows up in reports as this lead source.')}
    ${mf('Assign new leads to', `<select id="ikAssign"><option value="round_robin" ${k.assign === 'round_robin' ? 'selected' : ''}>Next available rep (rotating)</option><option value="none" ${k.assign === 'none' ? 'selected' : ''}>Nobody (shared pool)</option>${S.intakeData.users.map(u => `<option value="user:${u.id}" ${k.assign === 'user:' + u.id ? 'selected' : ''}>${esc(u.name)} only</option>`).join('')}</select>`)}
    <label class="row" style="margin:8px 0"><input type="checkbox" id="ikHot" ${k.hot ? 'checked' : ''}> Hot lead — put at the top of the queue and alert the rep</label>
    <label class="row" style="margin:8px 0"><input type="checkbox" id="ikText" ${k.auto_text ? 'checked' : ''}> Send an instant text (inside calling hours only)</label>
    ${mf('Text message', `<textarea id="ikTpl" rows="3">${esc(k.text_template)}</textarea>`, 'Fields: {first} {business} {rep} {company}')}
    <div class="mact"><button onclick="closeModal()">Cancel</button><button class="primary" onclick="saveIntake(${id || 0})">Save</button></div>`);
}
async function saveIntake(id) {
  const body = { name: $('#ikName').value, source: $('#ikSource').value, assign: $('#ikAssign').value, hot: $('#ikHot').checked, auto_text: $('#ikText').checked, text_template: $('#ikTpl').value };
  try { await api(id ? '/api/intake/' + id : '/api/intake', body, id ? 'PATCH' : 'POST'); closeModal(); viewAutomation('intake'); loadLists(); } catch (e) { toast(e.message, true); }
}
async function intakeRotate(id) { if (!confirm('Make a new link? The old link stops working immediately.')) return; await api('/api/intake/' + id, { rotate: true }, 'PATCH'); viewAutomation('intake'); }
async function intakeActive(id, on) { await api('/api/intake/' + id, { active: !!on }, 'PATCH'); viewAutomation('intake'); }

// ================= Automation: smart queue (+ goals, added below) =================
AUTO_RENDER.queue = async () => {
  const [st, pv] = await Promise.all([api('/api/settings'), api('/api/queue/preview')]);
  $('#autoBody').className = '';
  $('#autoBody').innerHTML = `<div style="display:grid;grid-template-columns:1fr 1.5fr;gap:14px;align-items:start"><div>
    <div class="card" style="margin-bottom:14px"><h3>Smart queue</h3>
      <div class="faint" style="font-size:12px;margin-bottom:10px">Instead of dialing leads in the order they were imported, the dialer works the leads most likely to turn into a deal first. Each lead gets a score from 1–100 based on how its list and state have converted for you, how many times it has been dialed, and whether the merchant texted or emailed back. Due callbacks and new inbound leads still go first.</div>
      <label class="row" style="margin:8px 0"><input type="checkbox" id="sqOn" ${st.smart_queue !== false ? 'checked' : ''}> Use the smart queue</label>
      <div class="row"><button class="primary" onclick="saveSettings({smart_queue:$('#sqOn').checked})">Save</button><button onclick="rescoreNow()">Recalculate scores now</button></div>
      <div class="faint" style="font-size:11px;margin-top:8px">Scores refresh every 15 minutes and after each import. The more calls you make, the better they get.</div></div>
    <div id="goalsBox"></div></div>
    <div class="card"><h3>Next 25 leads the dialer will pick</h3><div class="tablewrap" style="max-height:520px;overflow:auto"><table><thead><tr><th>Lead</th><th>List</th><th>St</th><th style="text-align:right">Score</th><th>Why</th></tr></thead><tbody>
      ${pv.rows.map(l => `<tr><td><a href="#/lead/${l.id}">${esc(l.business || l.name || 'Lead')}</a>${l.hot ? ' 🔥' : ''}${l.status === 'callback' ? ' <span class="badge callback">callback</span>' : ''}</td><td class="muted">${esc(l.source)}</td><td>${esc(l.state)}</td><td class="mono" style="text-align:right;color:${l.score != null ? scoreColor(l.score) : 'inherit'}">${l.score ?? '—'}</td><td class="faint" style="font-size:11px;white-space:normal">${esc(l.score_why || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No leads waiting.</td></tr>'}</tbody></table></div></div></div>`;
  if (typeof renderGoalsBox === 'function') renderGoalsBox();
};
async function rescoreNow() { const r = await api('/api/queue/rescore', {}); toast(`Updated ${r.updated} scores`); viewAutomation('queue'); }


// ================= Leaderboard & goals =================
const nf = n => Math.round(n || 0).toLocaleString('en-US');
function scoreColor(n) { return n >= 70 ? 'var(--green)' : n >= 40 ? 'var(--amber)' : 'var(--text3)'; }
function progress(v, g, color) { const pct = g ? Math.min(100, Math.round(v / g * 100)) : 0; return `<div style="height:6px;background:var(--panel3);border-radius:3px;overflow:hidden;margin-top:3px"><div style="height:100%;width:${pct}%;background:${color || (pct >= 100 ? 'var(--green)' : 'var(--blue)')}"></div></div>`; }
async function loadGoalBar() {
  const box = $('#goalBar'); if (!box) return;
  const g = await api('/api/my-goals').catch(() => null); if (!g || !g.goals || !$('#goalBar')) return;
  const items = [['Dials', g.dials, g.goals.dials], ['Connects', g.connects, g.goals.connects], ['Apps sent', g.apps, g.goals.apps]].filter(x => x[2] > 0);
  if (!items.length && !g.goals.funded) { box.innerHTML = ''; return; }
  const fmo = g.goals.funded > 0 ? ['Funded this month', g.month_funded, g.goals.funded, true] : null;
  box.innerHTML = `<div class="card" style="padding:10px 14px;margin-bottom:10px"><div class="row" style="gap:18px;align-items:flex-start">${items.concat(fmo ? [fmo] : []).map(x => `<div style="flex:1"><div class="row"><span class="faint" style="font-size:11px;flex:1">${x[0]}</span><b class="mono" style="font-size:12px">${x[3] ? '$' + nf(x[1]) : nf(x[1])} / ${x[3] ? '$' + nf(x[2]) : nf(x[2])}</b></div>${progress(x[1], x[2])}</div>`).join('')}
    <div style="text-align:right"><div class="faint" style="font-size:11px">Today's rank</div><b>#${g.rank} <span class="faint" style="font-weight:400">of ${g.of}</span></b></div></div></div>`;
}
async function renderLeaderboard(period) {
  S.lbPeriod = period; const box = $('#lbBox'); if (!box) return;
  const d = await api('/api/leaderboard?period=' + period).catch(() => null); if (!d || !$('#lbBox')) return;
  const rows = d.rows.slice().sort((a, b) => b.funded_amt - a.funded_amt || b.apps - a.apps || b.dials - a.dials);
  const daily = period === 'today';
  const cell = (v, g) => `<td class="mono" style="text-align:right;min-width:90px">${nf(v)}${daily && g ? ` <span class="faint">/ ${nf(g)}</span>${progress(v, g)}` : ''}</td>`;
  box.innerHTML = `<div class="card" style="margin-bottom:14px"><div class="row"><h3 class="grow" style="margin:0">Leaderboard</h3>${['today', 'week', 'month'].map(p => `<button class="sm ${p === period ? 'primary' : ''}" onclick="renderLeaderboard('${p}')">${{ today: 'Today', week: 'This week', month: 'This month' }[p]}</button>`).join('')}</div>
    <div class="tablewrap" style="margin-top:8px"><table><thead><tr><th>#</th><th>Rep</th><th style="text-align:right">Dials</th><th style="text-align:right">Connects</th><th style="text-align:right">Talk</th><th style="text-align:right">Apps sent</th><th style="text-align:right">Funded deals</th><th style="text-align:right">Funded $</th></tr></thead><tbody>
    ${rows.map((x, i) => `<tr ${x.id === d.me ? 'style="background:var(--panel2)"' : ''}><td>${i === 0 && (x.funded_amt || x.apps || x.dials) ? '🏆' : i + 1}</td><td><b>${esc(x.name)}</b></td>${cell(x.dials, x.goals.dials)}${cell(x.connects, x.goals.connects)}<td class="mono" style="text-align:right">${Math.round(x.talk / 60)}m</td>${cell(x.apps, x.goals.apps)}<td class="mono" style="text-align:right">${x.funded_n}</td><td class="mono" style="text-align:right">${fmtMoney(x.funded_amt)}${!daily && period === 'month' && x.goals.funded ? `<span class="faint"> / ${fmtMoney(x.goals.funded)}</span>${progress(x.funded_amt, x.goals.funded)}` : ''}</td></tr>`).join('')}</tbody></table></div></div>`;
}
async function renderGoalsBox() {
  const box = $('#goalsBox'); if (!box) return;
  const [st, lb] = await Promise.all([api('/api/settings'), api('/api/leaderboard?period=today')]);
  const g = st.goals || {};
  box.innerHTML = `<div class="card"><h3>Daily goals</h3><div class="faint" style="font-size:12px;margin-bottom:10px">Reps see their progress on the dialer and the floor leaderboard. Funded is a monthly dollar goal. Leave a person's own goal blank to use the team default.</div>
    <table style="width:100%"><thead><tr><th></th><th>Dials / day</th><th>Connects / day</th><th>Apps sent / day</th><th>Funded $ / month</th></tr></thead><tbody>
    <tr><td><b>Team default</b></td>${['dials', 'connects', 'apps', 'funded'].map(k => `<td><input type="number" min="0" id="gd_${k}" value="${g[k] || ''}" style="width:90px"></td>`).join('')}</tr>
    ${lb.rows.map(u => `<tr><td>${esc(u.name)}</td>${['dials', 'connects', 'apps', 'funded'].map(k => `<td><input type="number" min="0" class="gu_${u.id}" data-k="${k}" value="${u.own_goals[k] ?? ''}" placeholder="${g[k] || ''}" style="width:90px"></td>`).join('')}</tr>`).join('')}</tbody></table>
    <button class="primary" style="margin-top:10px" onclick="saveGoals()">Save goals</button></div>`;
}
async function saveGoals() {
  try {
    await api('/api/settings', { goals: Object.fromEntries(['dials', 'connects', 'apps', 'funded'].map(k => [k, $('#gd_' + k).value])) }, 'PUT');
    const lb = await api('/api/leaderboard?period=today');
    for (const u of lb.rows) { const b = {}; document.querySelectorAll('.gu_' + u.id).forEach(i => { b[i.dataset.k] = i.value; }); await api('/api/users/' + u.id + '/goals', b, 'PATCH'); }
    toast('Saved');
  } catch (e) { toast(e.message, true); }
}

// ================= Automation: offers & contract =================
AUTO_RENDER.contract = async () => {
  const st = await api('/api/settings');
  $('#autoBody').className = '';
  $('#autoBody').innerHTML = `<div style="display:grid;grid-template-columns:1.4fr 1fr;gap:14px;align-items:start"><div class="card"><h3>Funding agreement text</h3>
    <div class="faint" style="font-size:12px;margin-bottom:8px">Paste the agreement your attorney approved. When you send a contract, these fields are filled in from the deal: <code>{business}</code> <code>{owner}</code> <code>{company}</code> <code>{date}</code> <code>{purchase_price}</code> <code>{purchased_amount}</code> <code>{factor}</code> <code>{term_days}</code> <code>{payment}</code> <code>{frequency}</code> <code>{deal_id}</code>. A summary of the key terms is shown above the text automatically.</div>
    <textarea id="ctTpl" rows="22" style="font-family:ui-monospace,monospace;font-size:12px" placeholder="Paste your agreement here…">${esc(st.contract_template || '')}</textarea>
    <button class="primary" style="margin-top:8px" onclick="saveSettings({contract_template:$('#ctTpl').value})">Save agreement</button>
    ${st.contract_template ? '' : '<div style="color:var(--amber);font-size:12px;margin-top:8px">Nothing saved yet — contracts cannot be sent until you add your agreement text.</div>'}</div>
    <div><div class="card"><h3>Offers shown to merchants</h3><label class="row" style="margin:8px 0"><input type="checkbox" id="ofLn" ${st.offers_show_lender ? 'checked' : ''}> Show lender names on the merchant offer page</label>
      <div class="faint" style="font-size:12px;margin-bottom:8px">When off, offers are labeled A, B, C. Some states require certain disclosures on offers — check with your attorney.</div><button class="primary" onclick="saveSettings({offers_show_lender:$('#ofLn').checked})">Save</button></div>
    <div class="card" style="margin-top:14px"><h3>How it works</h3><div style="font-size:12.5px;line-height:1.6">1. Lenders reply with offers — they appear in <b>Compare offers</b> on the deal.<br>2. Check the offers to show, then text or email the merchant a page where they pick one.<br>3. Their pick fills in the funding terms and alerts the rep.<br>4. Send the contract; the merchant signs on their phone. The signed PDF (with name, time and IP) is saved on the deal.</div></div></div></div>`;
};


// ================= Payments on a funded deal =================
const PAY_BADGE = { current: ['On track', 'good'], behind: ['Behind', 'dnc'], paid_off: ['Paid in full', 'good'], no_data: ['No payments entered', ''] };
async function loadPayments(id) {
  const box = $('#paymentsBox'); if (!box) return;
  const p = await api('/api/deals/' + id + '/payments').catch(() => null); if (!p || !$('#paymentsBox')) return;
  const b = PAY_BADGE[p.status] || ['', ''];
  box.innerHTML = `<div class="card" style="margin-bottom:14px"><div class="row"><h3 class="grow" style="margin:0">Payments</h3><span class="badge ${b[1]}">${b[0]}</span></div>
    <div class="fields" style="margin:8px 0">${[['Collected', fmtMoney(p.received)], ['Expected by now', p.expected != null ? fmtMoney(p.expected) : '—'], ['Still owed', fmtMoney(p.outstanding)], ['Missed payments', p.missed != null && p.rows.length ? p.missed : '—'], ['NSFs (30 days)', p.nsf_30], ['Last payment', p.last_payment_on ? new Date(p.last_payment_on).toLocaleDateString() : '—']].map(([k, v]) => `<div><label>${k}</label><div class="mono">${v}</div></div>`).join('')}</div>
    <div class="row wrap" style="gap:6px"><input type="date" id="payDate" value="${new Date().toISOString().slice(0, 10)}" style="width:140px"><input type="number" id="payAmt" step="any" placeholder="Amount" style="width:100px">
      <select id="payKind"><option value="payment">Payment</option><option value="nsf">NSF / returned</option><option value="adjust">Adjustment</option></select><input id="payNote" placeholder="Note" style="flex:1;min-width:80px"><button class="sm primary" onclick="addPayment(${id})">Add</button></div>
    <details style="margin-top:8px"><summary class="faint" style="font-size:12px;cursor:pointer">Paste payments from your bank / processor (CSV)</summary><textarea id="payCsv" rows="4" placeholder="date,amount,type\n2026-10-01,500,ACH\n2026-10-02,500,NSF" style="margin-top:6px"></textarea><button class="sm" onclick="importPayments(${id})">Import</button></details>
    ${p.rows.length ? `<div class="tablewrap" style="max-height:220px;overflow:auto;margin-top:8px"><table><tbody>${p.rows.slice(0, 40).map(x => `<tr><td class="muted">${new Date(x.paid_on).toLocaleDateString()}</td><td><span class="badge ${x.kind === 'nsf' ? 'dnc' : ''}">${x.kind === 'nsf' ? 'NSF' : x.kind}</span></td><td class="mono" style="text-align:right">${fmtMoney(x.amount)}</td><td class="faint" style="font-size:11px">${esc(x.note || '')}</td><td><button class="link" onclick="delPayment(${x.id},${id})">✕</button></td></tr>`).join('')}</tbody></table></div>` : ''}
    <div class="faint" style="font-size:11px;margin-top:6px">Once payments are entered they replace the schedule estimate everywhere (renewals, reports). You're alerted when a merchant falls ${p.limit} or more payments behind.</div></div>`;
}
async function addPayment(id) { try { await api('/api/deals/' + id + '/payments', { paid_on: $('#payDate').value, amount: $('#payAmt').value, kind: $('#payKind').value, note: $('#payNote').value }); toast('Added'); route(); } catch (e) { toast(e.message, true); } }
async function delPayment(pid, id) { if (!confirm('Remove this entry?')) return; await api('/api/payments/' + pid, null, 'DELETE'); route(); }
async function importPayments(id) { try { const r = await api('/api/deals/' + id + '/payments/import', { text: $('#payCsv').value }); toast(`Added ${r.added}${r.skipped ? ', skipped ' + r.skipped + ' duplicates/blank' : ''}`); route(); } catch (e) { toast(e.message, true); } }

// partner assignment on a deal (admin)
function renderIsoBox(r) {
  const box = $('#isoBox'); if (!box) return; const d = r.deal;
  if (!(S.isos || []).length && !d.iso_id) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="card" style="margin-bottom:14px"><h3>Partner (ISO / broker)</h3><div class="row wrap" style="gap:6px">
    <select id="isoSel"><option value="">None</option>${(S.isos || []).map(u => `<option value="${u.id}" ${u.id === d.iso_id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>
    <label class="row" style="gap:4px">Commission % <input id="isoPct" type="number" step="any" style="width:70px" value="${d.iso_pct ?? ''}"></label><button class="sm primary" onclick="saveIso(${d.id})">Save</button></div>
    ${d.iso_due != null ? `<div class="row" style="margin-top:8px"><span class="grow">Partner commission: <b class="mono">${fmtMoney(d.iso_due)}</b></span>${d.iso_paid_at ? `<span class="badge good">paid ${new Date(d.iso_paid_at).toLocaleDateString()}</span>` : ''}<button class="sm" onclick="isoPaid(${d.id},${!d.iso_paid_at})">${d.iso_paid_at ? 'Mark unpaid' : 'Mark paid'}</button></div>` : ''}</div>`;
}
async function saveIso(id) { try { await api('/api/deals/' + id + '/iso', { iso_id: $('#isoSel').value, iso_pct: $('#isoPct').value }); toast('Saved'); route(); } catch (e) { toast(e.message, true); } }
async function isoPaid(id, paid) { await api('/api/deals/' + id + '/iso-paid', { paid }); route(); }

async function loadIsoPayouts() {
  const box = $('#isoPayBox'); if (!box) return;
  const [rows, isos] = await Promise.all([api('/api/iso-payouts').catch(() => []), api('/api/isos').catch(() => [])]); if (!$('#isoPayBox') || (!rows.length && !isos.length)) return;
  box.innerHTML = `<h3 style="margin:18px 0 8px">Partner (ISO) commissions</h3>
    <div class="kpis">${isos.map(u => `<div class="kpi"><b>${fmtMoney(u.owed)}</b><span>${esc(u.name)} · owed · ${u.submitted} submitted · ${u.funded} funded · ${fmtMoney(u.volume)}</span></div>`).join('')}</div>
    <div class="tablewrap"><table><thead><tr><th>Funded</th><th>Merchant</th><th>Partner</th><th style="text-align:right">Funded $</th><th style="text-align:right">%</th><th style="text-align:right">Commission</th><th>Status</th></tr></thead><tbody>
    ${rows.map(x => `<tr><td class="muted">${x.funded_at ? new Date(x.funded_at).toLocaleDateString() : ''}</td><td><a href="#/deal/${x.id}">${esc(x.business)}</a></td><td>${esc(x.iso_name)}</td><td class="mono" style="text-align:right">${fmtMoney(x.funded_amount)}</td><td class="mono" style="text-align:right">${x.iso_pct ?? 0}%</td><td class="mono" style="text-align:right">${fmtMoney(x.due)}</td>
      <td>${x.paid_at ? '<span class="badge good">paid</span>' : '<span class="badge">unpaid</span>'} <button class="sm" onclick="isoPaid(${x.id},${!x.paid_at}).then(loadIsoPayouts)">${x.paid_at ? 'Unpay' : 'Mark paid'}</button></td></tr>`).join('') || '<tr><td colspan="7" class="empty">No funded partner deals yet.</td></tr>'}</tbody></table></div>`;
}


// ================= Automation: weekly digest =================
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
AUTO_RENDER.digest = async () => {
  const d = await api('/api/digest'), c = d.settings;
  $('#autoBody').className = '';
  $('#autoBody').innerHTML = `<div style="display:grid;grid-template-columns:1fr 1.2fr;gap:14px;align-items:start"><div class="card"><h3>Weekly summary email</h3>
    <div class="faint" style="font-size:12px;margin-bottom:10px">Every week you get one email with the numbers that matter: dials, conversations, apps, funded dollars and revenue vs the week before, how each rep did, which lead sources are making money, pipeline, payments and anything that needs your attention.${d.email_enabled ? '' : ' <b style="color:var(--amber)">Email is not set up yet — add SMTP settings to .env.</b>'}</div>
    <label class="row" style="margin:8px 0"><input type="checkbox" id="dgOn" ${c.enabled ? 'checked' : ''}> Send it every week</label>
    <div class="grid2">${mf('Day', `<select id="dgDay">${DAYS.map((x, i) => `<option value="${i}" ${i === c.day ? 'selected' : ''}>${x}</option>`).join('')}</select>`)}${mf('Time (24h hour)', `<input id="dgHour" type="number" min="0" max="23" value="${c.hour}">`)}</div>
    ${mf('Time zone', `<input id="dgTz" value="${esc(c.tz)}">`, 'Example: America/New_York, America/Chicago, America/Los_Angeles')}
    ${mf('Send to', `<input id="dgTo" value="${esc(c.recipients)}" placeholder="blank = the first admin's email">`, 'Separate several addresses with commas.')}
    <div class="row"><button class="primary" onclick="saveDigest()">Save</button><button onclick="sendDigestNow()">Send one now</button></div>
    ${d.last ? `<div class="faint" style="font-size:11px;margin-top:8px">Last sent ${fmtTime(d.last)}</div>` : ''}</div>
    <div class="card"><h3>Preview (last 7 days)</h3><iframe src="/api/digest/preview" style="width:100%;height:620px;border:1px solid var(--border);border-radius:8px;background:#fff"></iframe></div></div>`;
};
async function saveDigest() { try { await api('/api/digest', { enabled: $('#dgOn').checked, day: +$('#dgDay').value, hour: +$('#dgHour').value, tz: $('#dgTz').value, recipients: $('#dgTo').value }, 'PUT'); toast('Saved'); } catch (e) { toast(e.message, true); } }
async function sendDigestNow() { try { const r = await api('/api/digest/send', {}); toast('Sent to ' + r.to); } catch (e) { toast(e.message, true); } }

// ================= Automation: compliance (call QA + DNC / litigator scrub) =================
function qaBanner(c) {
  let f = []; try { f = [].concat(typeof c.qa_flags === 'string' ? JSON.parse(c.qa_flags) : c.qa_flags || []).filter(Boolean); } catch {}
  return `<div style="border:1px solid var(--red);background:rgba(220,60,60,.08);border-radius:8px;padding:8px 10px;margin:6px 0;font-size:12.5px"><b style="color:var(--red)">⚑ Flagged for review</b>${f.map(x => `<div style="margin-top:4px"><b>${esc(x.text)}</b>${x.quote ? ` <span class="faint">“${esc(x.quote)}”</span>` : ''}</div>`).join('')}
    <div class="row" style="margin-top:6px"><button class="sm" onclick="qaDismiss(${c.id})">Reviewed — OK</button></div></div>`;
}
async function qaDismiss(id) { await api('/api/calls/' + id + '/qa', { action: 'dismiss' }); toast('Marked reviewed'); route(); }
AUTO_RENDER.compliance = async () => {
  const [q, sc] = await Promise.all([api('/api/qa'), api('/api/scrub')]);
  const s = q.settings, p = sc.settings;
  $('#autoBody').className = '';
  $('#autoBody').innerHTML = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start"><div>
    <div class="card" style="margin-bottom:14px"><h3>Call quality checks</h3>
      <div class="faint" style="font-size:12px;margin-bottom:8px">Every conversation is checked after the call. Calls that break your rules are flagged so you can listen and coach. Checked: the words below, plus an AI read for misleading promises, pressure, ignoring “stop calling me”, and rude language.</div>
      <label class="row" style="margin:6px 0"><input type="checkbox" id="qaOn" ${s.enabled ? 'checked' : ''}> Check calls</label><label class="row" style="margin:6px 0"><input type="checkbox" id="qaAi" ${s.ai ? 'checked' : ''}> Also use AI review</label>
      ${mf('Reps must never say (one per line)', `<textarea id="qaBad" rows="5">${esc((s.prohibited || []).join('\n'))}</textarea>`)}
      ${mf('Reps must always say (one per line, optional)', `<textarea id="qaReq" rows="2">${esc((s.required || []).join('\n'))}</textarea>`)}
      <label class="row" style="margin:6px 0"><input type="checkbox" id="qaDis" ${s.require_disclosure ? 'checked' : ''}> Flag calls where the recording notice isn't heard</label>
      ${mf('Recording notice words', `<input id="qaPh" value="${esc(s.disclosure_phrase || 'recorded')}">`)}
      <div class="row"><button class="primary" onclick="saveQa()">Save</button><button onclick="api('/api/qa/run',{}).then(()=>toast('Re-checking last 30 days'))">Re-check recent calls</button></div></div>
    <div class="card"><h3>Flagged calls (${q.counts.flagged || 0} to review)</h3>
      ${q.rows.map(x => `<div style="padding:8px 0;border-top:1px solid var(--border)"><div class="row"><a href="#/lead/${x.lead_id}" class="grow"><b>${esc(x.business || x.lead_name || 'Lead')}</b></a><span class="faint" style="font-size:11px">${esc(x.rep || '')} · ${fmtTime(x.started_at)}</span>${x.qa === 'reviewed' ? '<span class="badge good">reviewed</span>' : ''}</div>
        ${x.flags.map(f => `<div style="font-size:12px;margin-top:3px">${f.severity === 'high' ? '🔴' : '🟡'} ${esc(f.text)}${f.quote ? ` <span class="faint">“${esc(f.quote)}”</span>` : ''}</div>`).join('')}
        ${x.qa === 'flagged' ? `<button class="sm" style="margin-top:5px" onclick="qaDismissA(${x.id})">Reviewed — OK</button>` : ''}</div>`).join('') || '<div class="faint">Nothing flagged. 🎉</div>'}</div></div>
    <div>
    <div class="card" style="margin-bottom:14px"><h3>Do-not-call &amp; litigator lists</h3>
      <div class="faint" style="font-size:12px;margin-bottom:8px">Upload any list of numbers you must never contact — a litigator list, a state DNC download, your own. Matching leads are blocked immediately, and new imports and inbound leads are checked against everything here. ${sc.total.toLocaleString()} numbers blocked so far.</div>
      ${sc.by_reason.map(x => `<div class="row" style="font-size:12.5px;padding:3px 0"><span class="grow">${esc(x.reason || '(no label)')}</span><b class="mono">${x.n.toLocaleString()}</b>${x.reason ? `<button class="link" onclick="scrubRemove('${esc(x.reason).replace(/'/g, '')}')">remove list</button>` : ''}</div>`).join('')}
      <div style="margin-top:10px">${mf('List name', `<input id="scName" placeholder="e.g. Litigator list, NY state DNC">`)}${mf('Numbers (paste, or choose a .csv/.txt file)', `<textarea id="scText" rows="4" placeholder="One per line or separated by commas"></textarea>`)}
        <div class="row"><input type="file" id="scFile" accept=".csv,.txt" onchange="scrubFile(this)" style="flex:1"><button onclick="scrubUpload(true)">Check first</button><button class="primary" onclick="scrubUpload(false)">Block these numbers</button></div><div id="scMsg" class="faint" style="font-size:12px;margin-top:6px"></div></div></div>
    <div class="card"><h3>Check numbers with a scrub service</h3>
      <div class="faint" style="font-size:12px;margin-bottom:8px">If you subscribe to a litigator / DNC scrubbing service that has a web lookup, enter its address and every new lead is checked automatically (about ${p.rps} per second). Use <code>{phone}</code> for the 10-digit number and <code>{key}</code> for your key. Your provider's documentation says what its response looks like when a number is blocked.</div>
      <label class="row" style="margin:6px 0"><input type="checkbox" id="spOn" ${p.enabled ? 'checked' : ''}> Check new leads automatically</label>
      ${mf('Lookup address', `<input id="spUrl" value="${esc(p.provider_url)}" placeholder="https://api.example.com/check/{phone}?key={key}">`)}
      <div class="grid2">${mf('Your key', `<input id="spKey" type="password" value="${esc(p.api_key)}" placeholder="${p.api_key ? 'saved' : ''}">`)}${mf('Per second', `<input id="spRps" type="number" min="1" max="20" value="${p.rps}">`)}</div>
      <div class="grid2">${mf('Block the number when the answer…', `<select id="spMode"><option value="flag_if_contains" ${p.mode === 'flag_if_contains' ? 'selected' : ''}>contains this text</option><option value="flag_unless_contains" ${p.mode === 'flag_unless_contains' ? 'selected' : ''}>does NOT contain this text</option></select>`)}${mf('Text', `<input id="spMatch" value="${esc(p.match_text)}" placeholder="e.g. litigator">`)}</div>
      <label class="row" style="margin:6px 0"><input type="checkbox" id="spHold" ${p.hold ? 'checked' : ''}> Don't dial a new lead until it has been checked</label>
      <div class="row"><button class="primary" onclick="saveScrub()">Save</button><button onclick="api('/api/scrub/run',{}).then(()=>toast('Re-checking all open leads')).catch(e=>toast(e.message,true))">Re-check all open leads</button></div>
      <div class="faint" style="font-size:11px;margin-top:8px">${sc.checked} checked · ${sc.flagged} blocked since the server started · ${sc.pending} waiting${sc.last_error ? ` · <span style="color:var(--red)">last error: ${esc(sc.last_error)}</span>` : ''}</div></div></div></div>`;
};
async function saveQa() { try { await api('/api/qa/settings', { enabled: $('#qaOn').checked, ai: $('#qaAi').checked, prohibited: $('#qaBad').value, required: $('#qaReq').value, require_disclosure: $('#qaDis').checked, disclosure_phrase: $('#qaPh').value }, 'PUT'); toast('Saved'); } catch (e) { toast(e.message, true); } }
async function qaDismissA(id) { await api('/api/calls/' + id + '/qa', { action: 'dismiss' }); viewAutomation('compliance'); }
function scrubFile(inp) { const f = inp.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { $('#scText').value = String(r.result).slice(0, 20e6); }; r.readAsText(f); }
async function scrubUpload(dry) {
  try {
    const r = await api('/api/scrub/upload', { label: $('#scName').value, text: $('#scText').value, dry });
    if (dry) $('#scMsg').textContent = `${r.numbers.toLocaleString()} numbers · ${r.already_blocked.toLocaleString()} already blocked · ${r.matching_leads.toLocaleString()} of your leads would be blocked.`;
    else { toast(`Blocked ${r.numbers.toLocaleString()} numbers (${r.leads_blocked.toLocaleString()} leads)`); viewAutomation('compliance'); }
  } catch (e) { toast(e.message, true); }
}
async function scrubRemove(label) { if (!confirm(`Remove the list "${label}" from your do-not-call list? Leads already blocked stay blocked until you change them.`)) return; await api('/api/scrub/remove', { label }); viewAutomation('compliance'); }
async function saveScrub() {
  try { await api('/api/scrub', { enabled: $('#spOn').checked, provider_url: $('#spUrl').value, api_key: $('#spKey').value, rps: +$('#spRps').value, mode: $('#spMode').value, match_text: $('#spMatch').value, hold: $('#spHold').checked }, 'PUT'); toast('Saved'); viewAutomation('compliance'); } catch (e) { toast(e.message, true); }
}

// ================= Automation: security & backups (+ audit log) =================
AUTO_RENDER.security = async () => {
  const [b, a] = await Promise.all([api('/api/backups'), api('/api/audit')]);
  $('#autoBody').className = '';
  $('#autoBody').innerHTML = `<div style="display:grid;grid-template-columns:1fr 1.4fr;gap:14px;align-items:start"><div class="card"><h3>Backups</h3>
    <div class="faint" style="font-size:12px;margin-bottom:8px">A copy of your whole database is saved automatically every night and the last ${b.keep} are kept. Uploaded documents are stored separately in your data folder — back that folder up too if you can. Sensitive fields (SSN, date of birth) are encrypted; keep your encryption key safe, a backup can't be read without it.</div>
    <button class="primary" onclick="backupNow()">Back up now</button>
    <div style="margin-top:10px">${b.rows.map(x => `<div class="row" style="padding:5px 0;border-top:1px solid var(--border);font-size:12.5px"><span class="grow mono">${esc(x.name)}</span><span class="faint">${(x.size / 1048576).toFixed(1)} MB</span><a href="/api/backups/${esc(x.name)}"><button class="sm">Download</button></a></div>`).join('') || '<div class="faint">No backups yet.</div>'}</div></div>
    <div class="card"><h3>Activity log</h3><div class="faint" style="font-size:12px;margin-bottom:8px">Who logged in, viewed an SSN, exported or deleted leads, changed settings or users, imported lists, and marked commissions paid.</div>
      <div class="row" style="margin-bottom:8px"><input id="auQ" placeholder="Search person or detail…" style="flex:1" onkeydown="if(event.key==='Enter')auditSearch()"><select id="auAct" onchange="auditSearch()"><option value="">All actions</option>${a.actions.map(x => `<option value="${esc(x.action)}">${esc(x.action)} (${x.n})</option>`).join('')}</select><button class="sm" onclick="auditSearch()">Go</button></div>
      <div id="auRows">${auditRows(a.rows)}</div></div></div>`;
};
const auditRows = rows => `<div class="tablewrap" style="max-height:520px;overflow:auto"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th><th>IP</th></tr></thead><tbody>${rows.map(x => `<tr><td class="mono" style="font-size:11px;white-space:nowrap">${fmtTime(x.at)}</td><td>${esc(x.user_name || '—')}</td><td><span class="badge ${/failed|delete|reveal|export/.test(x.action) ? 'dnc' : ''}">${esc(x.action)}</span></td><td class="faint" style="font-size:11.5px;white-space:normal">${esc((x.entity ? x.entity + (x.entity_id ? ' #' + x.entity_id : '') + ' · ' : '') + (x.detail || ''))}</td><td class="mono faint" style="font-size:11px">${esc(x.ip || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nothing yet.</td></tr>'}</tbody></table></div>`;
async function auditSearch() { const a = await api('/api/audit?' + new URLSearchParams({ q: $('#auQ').value, action: $('#auAct').value })); $('#auRows').innerHTML = auditRows(a.rows); }
async function backupNow() { try { await api('/api/backups', {}); toast('Backup saved'); viewAutomation('security'); } catch (e) { toast(e.message, true); } }

// ================= Search across all call transcripts =================
async function viewSearch() {
  const q = S.searchQ || '';
  V(`<div class="vtitle"><h1>Search calls</h1><span class="muted">Find any word or phrase said on any call — “already have an advance”, “espresso machine”, a competitor's name…</span></div>
    <div class="row" style="margin-bottom:12px"><input id="srQ" value="${esc(q)}" placeholder="What are you looking for?" style="flex:1;font-size:15px;padding:10px" onkeydown="if(event.key==='Enter')runSearch()"><button class="primary" onclick="runSearch()">Search</button></div><div id="srRes"></div>`);
  $('#srQ').focus(); if (q) runSearch();
}
async function runSearch() {
  const q = $('#srQ').value.trim(); S.searchQ = q; if (!q) return;
  const r = await api('/api/search/calls?q=' + encodeURIComponent(q)).catch(e => { toast(e.message, true); return null; }); if (!r || !$('#srRes')) return;
  const hi = t => esc(t).replace(/\[\[/g, '<mark>').replace(/\]\]/g, '</mark>');
  $('#srRes').innerHTML = r.rows.length ? `<div class="faint" style="margin-bottom:8px">${r.rows.length} call${r.rows.length === 1 ? '' : 's'}</div>` + r.rows.map(x => `<div class="card" style="margin-bottom:10px;padding:12px 14px"><div class="row"><a href="#/lead/${x.lead_id}" class="grow"><b>${esc(x.business || x.lead_name || 'Lead')}</b></a><span class="faint" style="font-size:12px">${esc(x.rep || '')} · ${fmtTime(x.started_at)} · ${fmtDur(x.duration)}</span>${x.disposition ? `<span class="badge">${esc(x.disposition)}</span>` : ''}${x.qa === 'flagged' ? '<span class="badge dnc">flagged</span>' : ''}</div><div style="margin-top:6px;font-size:13px;line-height:1.5">${hi(x.snip)}</div></div>`).join('')
    : '<div class="empty">No calls mention that.</div>';
}


// ================= Text blasts =================
const BL_BADGE = { draft: ['Draft', ''], scheduled: ['Scheduled', 'callback'], sending: ['Sending', 'good'], paused: ['Paused', ''], done: ['Done', 'good'], cancelled: ['Cancelled', 'dnc'] };
const segs = t => { const n = t.length, uni = /[^\x00-\x7F]/.test(t); const one = uni ? 70 : 160, multi = uni ? 67 : 153; return n <= one ? 1 : Math.ceil(n / multi); };
async function viewBlasts() {
  const [rows, meta] = await Promise.all([api('/api/blasts').catch(() => []), api('/api/blasts/meta').catch(() => ({ can_send: false, settings: {} }))]); if (S.route !== 'blasts') return;
  S.blMeta = meta;
  V(`<div class="vtitle"><h1>Text blasts</h1><span class="muted">Schedule one message to a whole list. Replies land in your Inbox.</span><span style="margin-left:auto" class="row">${isAdmin() ? '<button onclick="blastSettings()">Settings</button>' : ''}${meta.can_send ? '<button class="primary" onclick="blastModal()">+ New blast</button>' : ''}</span></div>
    ${meta.can_send ? '' : '<div class="card" style="margin-bottom:12px">Text blasts are limited to admins right now.</div>'}
    <div class="tablewrap"><table><thead><tr><th>Name</th>${isAdmin() ? '<th>By</th>' : ''}<th>Status</th><th>When</th><th style="text-align:right">Recipients</th><th style="text-align:right">Sent</th><th style="text-align:right">Replies</th><th style="text-align:right">Opt-outs</th><th style="text-align:right">Failed</th><th style="width:140px">Progress</th></tr></thead><tbody>
    ${rows.map(b => { const s = b.stats, done = s.sent + s.failed + s.skipped, pct = s.total ? Math.round(done / s.total * 100) : 0, st = BL_BADGE[b.status] || [b.status, ''];
      return `<tr style="cursor:pointer" onclick="go('#/blast/${b.id}')"><td><b>${esc(b.name)}</b></td>${isAdmin() ? `<td class="muted">${esc(b.owner_name || '')}</td>` : ''}<td><span class="badge ${st[1]}">${st[0]}</span></td><td class="muted">${b.status === 'scheduled' && b.scheduled_at > Date.now() ? fmtTime(b.scheduled_at) : b.finished_at ? fmtTime(b.finished_at) : b.started_at ? fmtTime(b.started_at) : ''}</td>
        <td class="mono" style="text-align:right">${s.total}</td><td class="mono" style="text-align:right">${s.sent}</td><td class="mono" style="text-align:right">${s.replies}${s.sent ? ` <span class="faint">(${Math.round(s.replies / s.sent * 100)}%)</span>` : ''}</td><td class="mono" style="text-align:right">${s.opt_outs}</td><td class="mono" style="text-align:right">${s.failed}</td>
        <td>${progress(done, s.total)}</td></tr>`; }).join('') || '<tr><td colspan="10" class="empty">No blasts yet. Click “New blast” to send your first.</td></tr>'}</tbody></table></div>`);
  clearInterval(S.blT); S.blT = setInterval(() => { if (S.route === 'blasts') viewBlasts(); else clearInterval(S.blT); }, 8000);
}
function blastSettings() {
  const c = S.blMeta.settings;
  openModal(`<h3>Text blast settings</h3>
    <label class="row" style="margin:8px 0"><input type="checkbox" id="bsReps" ${c.reps_can_send ? 'checked' : ''}> Reps can send blasts (only to their own leads or a sheet they upload)</label>
    <div class="grid2">${mf('Most texts a rep can send in one blast', `<input id="bsMax" type="number" min="1" value="${c.rep_max}">`)}${mf('Speed (texts per minute, all blasts)', `<input id="bsRate" type="number" min="1" max="300" value="${c.rate_per_min}">`, 'Keep within what your Twilio number / campaign registration allows.')}</div>
    ${mf('Added to the end of every blast text', `<input id="bsFoot" value="${esc(c.footer)}">`, 'Leave blank to add nothing. Not added if the message already says STOP.')}
    ${mf('Skip anyone already texted in the last (hours)', `<input id="bsSkip" type="number" min="0" value="${c.skip_recent_hours}">`, 'Stops the same person getting two texts in a day. 0 turns it off.')}
    <div class="mact"><button onclick="closeModal()">Cancel</button><button class="primary" onclick="saveBlastSettings()">Save</button></div>`);
}
async function saveBlastSettings() { try { await api('/api/blasts/meta', { reps_can_send: $('#bsReps').checked, rep_max: +$('#bsMax').value, rate_per_min: +$('#bsRate').value, footer: $('#bsFoot').value, skip_recent_hours: +$('#bsSkip').value }, 'PUT'); closeModal(); toast('Saved'); viewBlasts(); } catch (e) { toast(e.message, true); } }

function blastModal() {
  const m = S.blMeta, c = m.settings; S.blSheet = null;
  const nm = 'Blast ' + new Date().toLocaleDateString([], { month: 'short', day: 'numeric' });
  openModal(`<h3>New text blast</h3>
    ${mf('Name', `<input id="blName" value="${nm}">`)}
    <div class="row" style="gap:6px;margin-bottom:8px"><button class="sm primary" id="blTabLeads" onclick="blTab('leads')">Leads already in the CRM</button><button class="sm" id="blTabSheet" onclick="blTab('sheet')">Upload a sheet</button></div>
    <div id="blLeads"><div class="grid2">${mf('List', `<select id="blList"><option value="">All lists</option>${m.lists.map(l => `<option value="${esc(l.name)}">${esc(l.name)} (${l.n})</option>`).join('')}</select>`)}
      ${mf('Lead status', `<select id="blStatus"><option value="">Any (not DNC)</option><option value="new">New / not yet reached</option><option value="callback">Callbacks</option><option value="done">Closed / not interested</option></select>`)}
      ${mf('State (optional)', `<input id="blState" maxlength="2" placeholder="NY">`)}
      ${isAdmin() ? mf('Owner', `<select id="blOwner"><option value="">Anyone</option><option value="me">Mine</option><option value="none">Unassigned</option>${m.users.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select>`) : mf('', '<div class="faint" style="padding-top:18px">Your own leads only</div>')}</div>
      <label class="row" style="margin:4px 0"><input type="checkbox" id="blNR"> Only people we never spoke to</label></div>
    <div id="blSheet" class="hidden"><div class="mf"><label>CSV or spreadsheet export (any columns — we find the phone numbers)</label><input type="file" id="blFile" accept=".csv,.txt,.tsv" onchange="blFile(this)"></div>
      <div class="mf"><label>…or paste</label><textarea id="blPaste" rows="3" placeholder="Name,Business,Phone&#10;John Smith,Smith Plumbing,(212) 555-0101" oninput="blParse($('#blPaste').value)"></textarea></div><div id="blSheetMsg" class="faint" style="font-size:12px"></div>
      <div class="faint" style="font-size:11px">People in your sheet are added to the CRM under this blast's name, so replies show up in your Inbox.</div></div>
    <div class="mf" style="margin-top:10px"><label>Message</label><textarea id="blBody" rows="4" maxlength="640" oninput="blCount()" placeholder="Hi {first}, it's {rep} with {company}. Quick question — are you still looking for working capital for {business}?"></textarea>
      <div class="faint" style="font-size:11px;margin-top:3px"><span id="blCnt">0 characters · 1 text</span> · Fields: {first} {business} {rep} {company} ${c.footer ? `· “${esc(c.footer)}” is added at the end` : ''}</div>
      <div id="blPrev" class="faint" style="font-size:12px;margin-top:4px;padding:6px 8px;background:var(--panel2);border-radius:6px;display:none"></div></div>
    <div class="grid2">${mf('Send', `<select id="blWhen" onchange="$('#blAt').classList.toggle('hidden', this.value!=='later')"><option value="now">As soon as I click Send</option><option value="later">Schedule for later</option></select>`)}${mf('', `<input id="blAt" type="datetime-local" class="hidden" style="margin-top:18px">`)}</div>
    <div class="row" style="margin:6px 0"><button class="sm" onclick="blPreview()">Check who will get it</button><span id="blPre" class="faint" style="font-size:12px"></span></div>
    <div class="faint" style="font-size:11px">Texts only go out inside your calling hours for each person's time zone (${esc(S.teamSettings?.call_window_start || '08:00')}–${esc(S.teamSettings?.call_window_end || '21:00')}); anyone outside them waits until they're back in. Do-not-call numbers and anyone who replied STOP are always skipped.</div>
    <div class="mact"><button onclick="closeModal()">Cancel</button><button onclick="blCreate(true)">Save as draft</button><button class="primary" id="blGo" onclick="blCreate(false)">Send blast</button></div>`, true);
  blCount();
}
function blTab(t) { $('#blLeads').classList.toggle('hidden', t !== 'leads'); $('#blSheet').classList.toggle('hidden', t !== 'sheet'); $('#blTabLeads').classList.toggle('primary', t === 'leads'); $('#blTabSheet').classList.toggle('primary', t === 'sheet'); S.blTab = t; $('#blPre').textContent = ''; }
function blCount() {
  const t = $('#blBody').value, foot = (S.blMeta.settings.footer || ''), full = t + (foot && t && !/stop/i.test(t) ? (/[.!?]$/.test(t.trim()) ? ' ' : '. ') + foot : '');
  $('#blCnt').textContent = `${full.length} characters · ${segs(full)} text${segs(full) > 1 ? 's' : ''} each`;
  const p = $('#blPrev'); if (t.trim()) { p.style.display = 'block'; p.textContent = 'Preview: ' + fillTplPreview(full); } else p.style.display = 'none';
}
const fillTplPreview = t => t.replace(/\{first\}/g, 'John').replace(/\{name\}/g, 'John Smith').replace(/\{business\}/g, 'Smith Plumbing').replace(/\{rep\}/g, (S.me.name || '').split(' ')[0]).replace(/\{company\}/g, S.blMeta.company).replace(/\{state\}/g, 'NY');
function blFile(inp) { const f = inp.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => blParse(String(r.result)); r.readAsText(f); }
function blParse(text) {
  S.blSheet = null; const msg = $('#blSheetMsg'); if (!text.trim()) { msg.textContent = ''; return; }
  const rows = parseCSV(text); if (!rows.length) { msg.textContent = 'Nothing found'; return; }
  const { map, hasHead } = detectMap(rows), leads = rowsToLeads(rows, map, hasHead), good = leads.filter(l => !l.bad);
  if (!map.includes('phone')) { msg.innerHTML = '<span style="color:var(--red)">No phone column found.</span>'; return; }
  S.blSheet = good; msg.textContent = `${good.length.toLocaleString()} numbers found${leads.length - good.length ? `, ${leads.length - good.length} rows skipped (no valid number)` : ''}.`;
}
const blAudience = () => S.blTab === 'sheet' ? { sheet: S.blSheet } : { filters: { list: $('#blList').value, status: $('#blStatus').value, state: $('#blState').value, owner: $('#blOwner') ? $('#blOwner').value : '', not_reached: $('#blNR').checked } };
async function blPreview() {
  if (S.blTab === 'sheet' && !S.blSheet) return toast('Add your sheet first', true);
  try {
    const r = await api('/api/blasts/preview', blAudience());
    const sk = Object.entries(r.skipped).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ');
    $('#blPre').innerHTML = `<b>${r.will_send.toLocaleString()}</b> will get it${r.minutes ? ` (about ${r.minutes < 90 ? r.minutes + ' min' : Math.round(r.minutes / 60 * 10) / 10 + ' hours'} at ${r.rate}/min)` : ''}${r.outside_hours_now ? ` · ${r.outside_hours_now} are outside calling hours right now and will wait` : ''}${sk ? ` · skipped: ${sk}` : ''}`;
  } catch (e) { toast(e.message, true); }
}
async function blCreate(draft) {
  if (S.blTab === 'sheet' && !S.blSheet) return toast('Add your sheet first', true);
  const body = { name: $('#blName').value, body: $('#blBody').value, ...blAudience(), draft };
  if (!draft && $('#blWhen').value === 'later') { const t = new Date($('#blAt').value).getTime(); if (!t) return toast('Pick the date and time', true); body.schedule_at = t; }
  if (!draft) { const r = await api('/api/blasts/preview', blAudience()).catch(() => null); if (r && !confirm(`Send to ${r.will_send.toLocaleString()} people${body.schedule_at ? ' at ' + new Date(body.schedule_at).toLocaleString() : ' now'}?`)) return; }
  const b = $('#blGo'); b.disabled = true;
  try { const r = await api('/api/blasts', body); closeModal(); toast(draft ? 'Saved as a draft' : 'Blast queued'); go('#/blast/' + r.id); } catch (e) { toast(e.message, true); b.disabled = false; }
}
async function viewBlast(id) {
  const d = await api('/api/blasts/' + id + (S.blFilter ? '?status=' + S.blFilter : '')).catch(e => { toast(e.message, true); return null; }); if (!d || S.route !== 'blast') return;
  const b = d.blast, s = d.stats, st = BL_BADGE[b.status] || [b.status, ''], done = s.sent + s.failed + s.skipped;
  const kpi = (l, v, sub) => `<div class="kpi"><b>${v}</b><span>${l}${sub ? ' · ' + sub : ''}</span></div>`;
  V(`<div class="vtitle"><a href="#/blasts" class="muted">‹ Text blasts</a><h1>${esc(b.name)}</h1><span class="badge ${st[1]}">${st[0]}</span>${b.status === 'scheduled' && b.scheduled_at > Date.now() ? `<span class="muted">starts ${fmtTime(b.scheduled_at)}</span>` : ''}
      <span style="margin-left:auto" class="row">${['sending', 'scheduled'].includes(b.status) ? `<button onclick="blAct(${b.id},'pause')">Pause</button>` : ''}${['paused', 'draft'].includes(b.status) ? `<button class="primary" onclick="blAct(${b.id},'start')">${b.status === 'draft' ? 'Send now' : 'Resume'}</button>` : ''}${b.status === 'scheduled' && b.scheduled_at > Date.now() ? `<button onclick="blAct(${b.id},'start')">Send now</button>` : ''}${!['done', 'cancelled'].includes(b.status) ? `<button class="danger" onclick="if(confirm('Cancel this blast? Texts not yet sent will not go out.'))blAct(${b.id},'cancel')">Cancel</button>` : ''}${b.status !== 'sending' ? `<button class="sm" onclick="if(confirm('Delete this blast record?'))blAct(${b.id},'delete',true)">Delete</button>` : ''}</span></div>
    <div class="card" style="margin-bottom:12px"><div class="faint" style="font-size:11px">MESSAGE · by ${esc(b.owner_name || '')}</div><div style="margin-top:4px;white-space:pre-wrap">${esc(b.body)}</div>${progress(done, s.total)}
      <div class="faint" style="font-size:12px;margin-top:4px">${done} of ${s.total} handled${s.queued && b.status === 'sending' ? ` · ${s.queued} waiting (${b.rate_per_min}/min, and only inside calling hours)` : ''}</div></div>
    <div class="kpis">${kpi('Sent', s.sent)}${kpi('Delivered', s.delivered)}${kpi('Replies', s.replies, s.sent ? Math.round(s.replies / s.sent * 100) + '%' : '')}${kpi('Opt-outs', s.opt_outs)}${kpi('Failed', s.failed)}${kpi('Skipped', s.skipped)}</div>
    <div class="row" style="margin:12px 0 6px;gap:6px">${[['', 'All'], ['sent', 'Sent'], ['queued', 'Waiting'], ['failed', 'Failed'], ['skipped', 'Skipped']].map(([k, l]) => `<button class="sm ${(S.blFilter || '') === k ? 'primary' : ''}" onclick="S.blFilter='${k}';viewBlast(${b.id})">${l}</button>`).join('')}${s.replies ? `<a href="#/inbox" style="margin-left:auto">Open Inbox for replies →</a>` : ''}</div>
    <div class="tablewrap"><table><thead><tr><th>Lead</th><th>Phone</th><th>Status</th><th>Detail</th><th>Sent</th><th></th></tr></thead><tbody>${d.rows.map(x => `<tr><td><a href="#/lead/${x.lead_id}">${esc(x.business || x.name || 'Lead')}</a></td><td class="mono">${esc(fmtPhone(x.phone))}</td>
      <td><span class="badge ${x.status === 'sent' ? 'good' : x.status === 'failed' ? 'dnc' : ''}">${x.status}</span>${x.msg_status === 'delivered' ? ' <span class="faint" style="font-size:11px">delivered</span>' : ''}</td><td class="faint" style="font-size:11.5px">${esc(x.reason || x.error || '')}</td><td class="muted">${x.sent_at ? fmtTime(x.sent_at) : ''}</td><td>${x.replied ? '<span class="badge callback">replied</span>' : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">None</td></tr>'}</tbody></table></div>${s.total > 300 ? '<div class="faint" style="margin-top:6px">Showing the first 300.</div>' : ''}`);
  clearInterval(S.blT); if (['sending', 'scheduled'].includes(b.status)) S.blT = setInterval(() => { if (S.route === 'blast') viewBlast(id); else clearInterval(S.blT); }, 5000);
}
async function blAct(id, a, leave) { try { await api(`/api/blasts/${id}/${a}`, {}); toast('Done'); leave ? go('#/blasts') : viewBlast(id); } catch (e) { toast(e.message, true); } }
