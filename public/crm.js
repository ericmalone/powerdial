// PowerDial CRM — deals pipeline, deal page, lenders, sequences, commissions
// (loaded before app.js; uses its helpers at run time)

const money = n => n == null || n === '' || isNaN(n) ? '—' : '$' + Math.round(Number(n)).toLocaleString('en-US');
const STAGE_LABELS = { interested: 'Interested', app_sent: 'App sent', app_in: 'App in', docs_in: 'Docs in', submitted: 'Submitted', offer: 'Offer', contract: 'Contract out', funded: 'Funded', lost: 'Lost' };
const STAGE_COLORS = { interested: 'var(--text2)', app_sent: 'var(--blue)', app_in: 'var(--blue)', docs_in: 'var(--purple)', submitted: 'var(--amber)', offer: 'var(--amber)', contract: 'var(--green)', funded: 'var(--green)', lost: 'var(--red)' };
const SUB_STATUS = { submitted: 'Submitted', info_needed: 'Needs info', approved: 'Approved', declined: 'Declined', funded: 'Funded', withdrawn: 'Withdrawn' };
const daysAgo = t => t ? Math.max(0, Math.floor((Date.now() - t) / 864e5)) : null;
function stageBadge(s) { return `<span class="badge" style="color:${STAGE_COLORS[s]};border-color:${STAGE_COLORS[s]}">${esc(STAGE_LABELS[s] || s)}</span>`; }

// ============ pipeline ============
async function viewPipeline(tab) {
  tab = tab || 'board';
  const q = S.pipeQ = S.pipeQ || { owner: isAdmin() ? '' : 'me', q: '' };
  V(`<div class="vtitle"><h1>Pipeline</h1>
      <div class="tabs" style="border:0;gap:4px"><button class="${tab === 'board' ? 'act' : ''}" onclick="go('#/pipeline/board')">Board</button><button class="${tab === 'renewals' ? 'act' : ''}" onclick="go('#/pipeline/renewals')">Renewals</button></div>
      <div class="row" style="margin-left:auto"><select id="pOwner"><option value="">Everyone</option><option value="me">Mine</option>${S.users.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select>
      ${tab === 'board' ? `<input id="pq" placeholder="Search deals…" value="${esc(q.q)}" style="width:200px">` : ''}</div></div>
    <div id="pipe"><div class="empty">Loading…</div></div>`);
  $('#pOwner').value = q.owner;
  $('#pOwner').onchange = e => { q.owner = e.target.value; tab === 'board' ? loadBoard() : loadRenewals(); };
  if (tab === 'board') { let t; $('#pq').oninput = e => { clearTimeout(t); t = setTimeout(() => { q.q = e.target.value; loadBoard(); }, 250); }; loadBoard(); }
  else loadRenewals();
}
async function loadBoard() {
  const q = S.pipeQ;
  const r = await api('/api/deals?' + new URLSearchParams({ owner: q.owner, q: q.q, since: Date.now() - 30 * 864e5 })).catch(e => { toast(e.message, true); return null; });
  if (!r || S.route !== 'pipeline') return;
  const cols = r.stages.filter(s => s.id !== 'lost');
  const by = {}; r.rows.forEach(d => (by[d.stage] = by[d.stage] || []).push(d));
  const total = st => (by[st] || []).reduce((a, d) => a + (Number(st === 'funded' ? d.funded_amount : d.amount_requested) || 0), 0);
  $('#pipe').innerHTML = `<div style="display:grid;grid-auto-flow:column;grid-auto-columns:minmax(180px,1fr);gap:10px;overflow-x:auto;padding-bottom:10px">${cols.map(c => `
    <div class="kcol" data-stage="${c.id}" ondragover="event.preventDefault();this.style.background='var(--panel2)'" ondragleave="this.style.background=''" ondrop="dropDeal(event,'${c.id}');this.style.background=''"
      style="background:var(--panel);border:1px solid var(--border2);border-radius:10px;min-height:60vh;display:flex;flex-direction:column">
      <div style="padding:10px 12px;border-bottom:1px solid var(--border)"><div class="row"><b style="color:${STAGE_COLORS[c.id]}">${esc(c.label)}</b><span class="mono faint" style="margin-left:auto">${(by[c.id] || []).length}</span></div>
        <div class="mono faint" style="font-size:11px">${money(total(c.id))}${c.id === 'funded' ? ' · last 30 days' : ''}</div></div>
      <div style="padding:8px;display:flex;flex-direction:column;gap:8px;overflow-y:auto">${(by[c.id] || []).map(dealCard).join('') || '<div class="faint" style="text-align:center;padding:16px;font-size:12px">Drop deals here</div>'}</div>
    </div>`).join('')}</div>`;
}
function dealCard(d) {
  const stale = daysAgo(d.updated_at);
  return `<div class="card" draggable="true" ondragstart="event.dataTransfer.setData('text/plain','${d.id}')" onclick="go('#/deal/${d.id}')" style="padding:10px 12px;cursor:pointer">
    <b style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(d.title || d.lead_business || d.lead_name)}</b>
    <div class="muted" style="font-size:12px">${esc(d.lead_name || '')}${d.lead_state ? ' · ' + esc(d.lead_state) : ''}</div>
    ${d.source ? `<div class="faint" style="font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(d.source)}</div>` : ''}
    <div class="row mono" style="margin-top:6px;font-size:11px;gap:8px;flex-wrap:wrap">
      <span>${money(d.stage === 'funded' ? d.funded_amount : d.amount_requested)}</span>
      ${d.statements ? `<span class="faint">📄${d.statements}</span>` : ''}
      ${d.subs ? `<span class="faint">→${d.subs}</span>` : ''}
      ${d.offers ? `<span style="color:var(--amber)">${d.offers} offer${d.offers > 1 ? 's' : ''}${d.best_offer ? ' ≤' + money(d.best_offer) : ''}</span>` : ''}
      ${d.app_complete ? '<span style="color:var(--green)">✓app</span>' : ''}
    </div>
    <div class="row faint" style="font-size:11px;margin-top:4px"><span class="grow">${esc(d.owner_name || 'Unassigned')}</span><span style="${stale > 3 && d.stage !== 'funded' ? 'color:var(--amber)' : ''}">${stale === 0 ? 'today' : stale + 'd'}</span></div>
  </div>`;
}
async function dropDeal(ev, stage) {
  ev.preventDefault();
  const id = ev.dataTransfer.getData('text/plain'); if (!id) return;
  let body = { stage };
  if (stage === 'lost') { const why = prompt('Why was this deal lost?'); if (why === null) return; body.lost_reason = why; }
  try { await api('/api/deals/' + id, body, 'PATCH'); loadBoard(); } catch (e) { toast(e.message, true); }
}
async function loadRenewals() {
  const r = await api('/api/renewals' + (S.pipeQ.owner === 'me' ? '?owner=me' : '')).catch(e => { toast(e.message, true); return null; });
  if (!r || S.route !== 'pipeline') return;
  const rows = S.pipeQ.owner && S.pipeQ.owner !== 'me' ? r.rows.filter(d => String(d.owner_id) === S.pipeQ.owner) : r.rows;
  $('#pipe').innerHTML = `<div class="muted" style="margin-bottom:10px">Merchants are queued for a renewal call automatically at <b>${r.threshold}%</b> paid in${isAdmin() ? ' (change under Team &amp; setup)' : ''}. Paid-in is estimated from the payment schedule unless you enter the collected amount.</div>
    <div class="tablewrap"><table><thead><tr><th>Merchant</th><th>Rep</th><th>Lender</th><th>Funded</th><th>Payback</th><th>Paid in</th><th>Funded on</th><th>Renewal</th></tr></thead><tbody>
    ${rows.map(d => `<tr class="click" onclick="go('#/deal/${d.id}')"><td><b>${esc(d.title || d.lead_business)}</b><div class="muted" style="font-size:12px">${esc(d.lead_name || '')}</div></td><td>${esc(d.owner_name || '')}</td><td>${esc(d.lender_name || 'In-house')}</td>
      <td class="mono">${money(d.funded_amount)}</td><td class="mono">${money(d.payback)}</td>
      <td style="min-width:160px">${d.paid_in ? `<div class="row" style="gap:8px"><div style="flex:1;height:8px;background:var(--panel3);border-radius:4px;overflow:hidden"><div style="height:100%;width:${d.paid_in.pct}%;background:${d.paid_in.pct >= r.threshold ? 'var(--green)' : 'var(--blue)'}"></div></div><span class="mono" style="font-size:11px">${d.paid_in.pct}%${d.paid_in.estimated ? '*' : ''}</span></div>` : '<span class="faint">add terms</span>'}</td>
      <td class="muted">${d.funded_at ? new Date(d.funded_at).toLocaleDateString() : ''}</td>
      <td>${d.renewal_queued_at ? `<span class="badge good">queued ${new Date(d.renewal_queued_at).toLocaleDateString()}</span>` : d.paid_in && d.paid_in.pct >= r.threshold ? '<span class="badge callback">eligible</span>' : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">No funded deals yet.</td></tr>'}
    </tbody></table></div>`;
}

// ============ deal page ============
async function viewDeal(id) {
  id = Number(id);
  V('<div class="empty">Loading…</div>');
  let r; try { r = await api('/api/deals/' + id); } catch (e) { return V(`<div class="empty">${esc(e.message)}</div>`); }
  if (S.route !== 'deal' || Number(S.viewCtx.arg) !== id) return;
  S.dealData = r;
  const d = r.deal, l = r.lead, a = d.app || {};
  const canSee = isAdmin() || d.owner_id === S.me.id;
  const fin = (k, label, type = 'number', step = 'any') => `<div class="mf"><label>${label}</label><input id="df_${k}" type="${type}" step="${step}" value="${esc(d[k] ?? '')}"></div>`;
  const stmts = r.files.filter(f => f.kind === 'statement').length;
  V(`<div class="vtitle"><a href="#/pipeline" class="muted">‹ Pipeline</a><h1>${esc(d.title || l.business || l.name)}</h1>${stageBadge(d.stage)}
      <a href="#/lead/${l.id}" class="muted">${esc(l.name || fmtPhone(l.phone))}</a>${d.source ? `<span class="badge">${esc(d.source)}</span>` : ''}
      <div class="row" style="margin-left:auto"><button onclick="callLead(${l.id})" ${S.inSession && S.phase === 'ready' ? '' : 'disabled'}>☎ Call</button>
      <select id="dStage" onchange="setDealStage(${d.id}, this.value)">${r.stages.map(s => `<option value="${s.id}" ${s.id === d.stage ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select></div></div>
    <div style="display:grid;grid-template-columns:1.25fr 1fr;gap:14px;align-items:start">
    <div>
      <div class="card" style="margin-bottom:14px"><div class="row"><h3 class="grow" style="margin:0">Application</h3>
          ${d.app_complete ? `<span class="badge good">Signed ${fmtTime(d.app_signed_at)}</span>` : '<span class="badge callback">Not signed yet</span>'}</div>
        <div class="row wrap" style="margin:12px 0">
          <button class="primary" onclick="sendAppLink(${d.id},'sms')">Text app link</button>
          <button onclick="sendAppLink(${d.id},'email')" ${l.email && S.config.email ? '' : 'disabled title="Needs lead email + email setup"'}>Email app link</button>
          <button onclick="sendAppLink(${d.id},'copy')">Copy link</button>
          ${d.app_complete && canSee ? `<a href="/api/deals/${d.id}/application.pdf" target="_blank"><button>Application PDF</button></a>` : ''}
          <button onclick="editAppModal()">Edit</button>
        </div>
        ${Object.keys(a).filter(k => !['signed_name', 'signed_at', 'signed_ip'].includes(k)).length ? `<div class="fields" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr))">${APP_FIELDS.filter(([k]) => a[k]).map(([k, lab]) => `<div class="f"><span>${esc(lab)}</span><div id="af_${k}">${esc(k === 'monthly_revenue' || k === 'amount_requested' ? money(String(a[k]).replace(/[$,]/g, '')) : a[k])}</div></div>`).join('')}</div>
          ${canSee && (a.owner_ssn || a.owner_dob) ? `<button class="sm" onclick="revealApp(${d.id})">Show SSN / DOB</button>` : ''}
          ${d.signature ? `<div style="margin-top:10px"><span class="faint" style="font-size:11px">SIGNATURE — ${esc(a.signed_name || '')}</span><div><img src="${d.signature}" style="max-height:60px;background:#fff;border-radius:4px;padding:4px;margin-top:4px"></div></div>` : ''}`
          : '<div class="faint">Send the merchant the link — they fill in the application, e-sign it and upload statements from their phone.</div>'}
        <div class="fields" style="margin-bottom:0">${[['Time in business', r.facts.tib != null ? Math.floor(r.facts.tib / 12) + 'y ' + (r.facts.tib % 12) + 'm' : null], ['Monthly revenue', r.facts.revenue != null ? money(r.facts.revenue) : null], ['Positions', r.facts.positions], ['Credit', r.facts.fico]].filter(x => x[1] != null).map(([k, v]) => `<div class="f"><span>${k}</span><div class="mono">${esc(v)}</div></div>`).join('')}</div>
      </div>

      <div class="card" style="margin-bottom:14px"><div class="row"><h3 class="grow" style="margin:0">Documents</h3><span class="muted">${stmts} statement${stmts === 1 ? '' : 's'}</span></div>
        <div style="margin-top:10px">${r.files.map(f => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--border)"><span class="badge">${esc(f.kind.replace('_', ' '))}</span>
          <a href="/api/deals/${d.id}/files/${f.id}" class="grow" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(f.name)}</a>
          <span class="faint" style="font-size:11px">${f.uploader ? esc(f.uploader) : 'merchant'} · ${fmtTime(f.created_at)}</span><button class="link" style="font-size:11px" onclick="delFile(${d.id},${f.id})">✕</button></div>`).join('') || '<div class="faint">No documents yet.</div>'}</div>
        <div class="row" style="margin-top:10px"><select id="fKind"><option value="statement">Bank statement</option><option value="application">Application</option><option value="id">Driver's license / ID</option><option value="voided_check">Voided check</option><option value="contract">Contract</option><option value="other">Other</option></select>
          <button onclick="$('#fUp').click()">Upload</button><input type="file" id="fUp" multiple class="hidden" onchange="uploadDealFiles(${d.id}, this)"></div></div>

      ${dealCardsA(r)}
      <div class="card" style="margin-bottom:14px"><h3>Submit to lenders</h3>
        ${r.lenders.length ? `<div class="faint" style="font-size:12px;margin-bottom:8px">Checked against each lender's requirements using the application. The application PDF and every document above are attached.</div>
          ${r.lenders.map(L => `<label class="row" style="padding:6px 0;border-bottom:1px solid var(--border);align-items:flex-start;cursor:pointer">
            <input type="checkbox" class="lsub" data-ok="${L.ok ? 1 : 0}" value="${L.id}" ${L.ok && !L.submitted ? 'checked' : ''} ${L.submitted ? 'disabled' : ''} style="margin-top:3px">
            <div class="grow"><b>${esc(L.name)}</b>${L.in_house ? ' <span class="badge">in-house</span>' : ''}${L.submitted ? ' <span class="badge good">sent</span>' : ''}
              <div style="font-size:12px">${L.ok ? '<span style="color:var(--green)">Meets requirements</span>' : `<span style="color:var(--red)">${esc(L.fail.join(' · '))}</span>`}${L.unknown.length ? ` <span class="faint">· unknown: ${esc(L.unknown.join(', '))}</span>` : ''}</div></div></label>`).join('')}
          <textarea id="subNote" rows="2" placeholder="Note to lenders (optional)" style="margin-top:10px"></textarea>
          <button class="primary" style="margin-top:8px" onclick="submitDeal(${d.id})" ${r.email_enabled ? '' : 'disabled title="Set up SMTP email in .env first"'}>Submit to selected</button>
          <button style="margin-top:8px" onclick="submitDeal(${d.id}, true)" ${r.email_enabled ? '' : 'disabled'} title="Checks every lender that meets requirements and sends in one click">Send to all matching (${r.lenders.filter(L => L.ok && !L.submitted).length})</button>
          ${!d.app_complete ? '<span class="faint" style="font-size:12px;margin-left:8px">Application not signed yet</span>' : ''}`
          : `<div class="faint">No lenders yet. ${isAdmin() ? '<a href="#/lenders">Add your partner lenders</a>.' : 'Ask an admin to add partner lenders.'}</div>`}
      </div>

      <div class="card" style="margin-bottom:14px"><h3>Submissions &amp; offers</h3>
        ${r.submissions.length ? r.submissions.map(s => `<div class="tl-item"><div class="tl-head"><b>${esc(s.lender_name)}</b>
            <select onchange="updSub(${s.id},{status:this.value})">${Object.entries(SUB_STATUS).map(([k, v]) => `<option value="${k}" ${k === s.status ? 'selected' : ''}>${v}</option>`).join('')}</select>
            <span class="when">${fmtTime(s.sent_at)}</span></div>
          ${s.error ? `<div style="color:var(--red);font-size:12px;margin-top:4px">${esc(s.error)}</div>` : ''}
          ${s.ai_note ? `<div class="ai" style="margin-top:8px;padding:8px 10px"><div class="lbl">AI read their reply</div>${esc(s.ai_note)}</div>` : ''}
          ${['approved', 'funded'].includes(s.status) || s.offer_amount ? `<div class="row wrap mono" style="margin-top:8px;gap:6px;font-size:12px">
            <label>Amount <input style="width:95px" value="${esc(s.offer_amount ?? '')}" onchange="updSub(${s.id},{offer_amount:this.value})"></label>
            <label>Factor <input style="width:60px" value="${esc(s.offer_factor ?? '')}" onchange="updSub(${s.id},{offer_factor:this.value})"></label>
            <label>Term (days) <input style="width:60px" value="${esc(s.offer_term_days ?? '')}" onchange="updSub(${s.id},{offer_term_days:this.value})"></label>
            <label>Payment <input style="width:80px" value="${esc(s.offer_payment ?? '')}" onchange="updSub(${s.id},{offer_payment:this.value})"></label>
            <select onchange="updSub(${s.id},{offer_freq:this.value})"><option value="daily" ${s.offer_freq !== 'weekly' ? 'selected' : ''}>daily</option><option value="weekly" ${s.offer_freq === 'weekly' ? 'selected' : ''}>weekly</option></select></div>` : ''}
          ${s.status === 'declined' && s.decline_reason ? `<div class="muted" style="font-size:12px;margin-top:6px">Reason: ${esc(s.decline_reason)}</div>` : ''}
        </div>`).join('') : '<div class="faint">Nothing submitted yet. Lender replies by email are read automatically and update the status and offer here.</div>'}
        ${r.emails.length ? `<details><summary>Lender emails (${r.emails.length})</summary>${r.emails.map(e => `<div class="tl-item" style="margin-top:6px"><div class="tl-head"><span class="badge">${e.direction === 'in' ? 'from' : 'to'} ${esc(e.lender_name || e.to_addr)}</span><span class="when">${fmtTime(e.created_at)}</span></div><div class="tl-body"><b>${esc(e.subject)}</b><div style="white-space:pre-wrap;font-size:12px;max-height:160px;overflow:auto">${esc(e.body)}</div></div></div>`).join('')}</details>` : ''}
      </div>
      ${dealCardsB(r)}
    </div>
    <div>
      <div class="card" style="margin-bottom:14px"><h3>Deal</h3><div class="grid2">
        <div class="mf"><label>Owner</label><select id="df_owner">${S.users.map(u => `<option value="${u.id}" ${u.id === d.owner_id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></div>
        ${fin('amount_requested', 'Amount requested')}</div>
        <div class="mf"><label>Notes</label><textarea id="df_notes" rows="2">${esc(d.notes)}</textarea></div>
        ${d.stage === 'lost' ? `<div class="muted">Lost: ${esc(d.lost_reason)}</div>` : ''}
        <button class="primary" onclick="saveDeal(${d.id})">Save</button></div>

      <div class="card" style="margin-bottom:14px"><h3>Funding &amp; renewal</h3><div class="grid2">
        <div class="mf"><label>Funded by</label><select id="df_lender"><option value="">In-house / not set</option>${r.lenders.map(L => `<option value="${L.id}" ${L.id === d.lender_id ? 'selected' : ''}>${esc(L.name)}</option>`).join('')}</select></div>
        <div class="mf"><label>Funded date</label><input id="df_funded_at" type="date" value="${d.funded_at ? new Date(d.funded_at - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10) : ''}"></div>
        ${fin('funded_amount', 'Funded amount')}${fin('factor_rate', 'Factor rate')}${fin('payback', 'Payback')}${fin('term_days', 'Term (days)', 'number', '1')}
        ${fin('payment_amount', 'Payment')}<div class="mf"><label>Frequency</label><select id="df_freq"><option value="daily">Daily</option><option value="weekly" ${d.payment_freq === 'weekly' ? 'selected' : ''}>Weekly</option></select></div>
        ${fin('collected', 'Collected so far (optional)')}</div>
        ${d.paid_in ? `<div class="row" style="gap:8px;margin:4px 0 12px"><div style="flex:1;height:10px;background:var(--panel3);border-radius:5px;overflow:hidden"><div style="height:100%;width:${d.paid_in.pct}%;background:var(--green)"></div></div><b class="mono">${d.paid_in.pct}% paid in</b></div>
          <div class="faint" style="font-size:12px;margin-bottom:10px">${money(d.paid_in.collected)} of ${money(d.payback)}${d.paid_in.estimated ? ' (estimated from schedule)' : ''}${d.renewal_queued_at ? ` · renewal queued ${new Date(d.renewal_queued_at).toLocaleDateString()}` : ''}</div>` : ''}
        ${isAdmin() ? `<div class="grid2"><div class="mf"><label>Company revenue on this deal (optional)</label><input id="df_revenue_override" type="number" step="any" value="${esc(d.revenue_override ?? '')}" placeholder="auto: ${d.revenue != null ? Math.round(d.revenue) : 'set lender broker %'}"></div></div>` : ''}
        <h3 style="margin-top:6px">Commission</h3><div class="grid2">
          <div class="mf"><label>Commission %</label><input id="df_commission_pct" type="number" step="any" value="${esc(d.commission_pct ?? '')}" placeholder="rep default" ${isAdmin() ? '' : 'disabled'}></div>
          <div class="mf"><label>Or fixed amount</label><input id="df_commission_amt" type="number" step="any" value="${esc(d.commission_amt ?? '')}" ${isAdmin() ? '' : 'disabled'}></div></div>
        ${d.commission_due != null ? `<div class="row" style="margin-bottom:10px"><span class="grow">Commission: <b class="mono">${money(d.commission_due)}</b></span>${d.commission_paid_at ? `<span class="badge good">paid ${new Date(d.commission_paid_at).toLocaleDateString()}</span>` : '<span class="badge">unpaid</span>'}
          ${isAdmin() ? `<button class="sm" onclick="markCommission(${d.id}, ${!d.commission_paid_at})">${d.commission_paid_at ? 'Mark unpaid' : 'Mark paid'}</button>` : ''}</div>` : ''}
        <button class="primary" onclick="saveDeal(${d.id})">Save</button></div>

      ${dealCardsC(r)}
      <div class="card"><h3>Activity</h3>
        <textarea id="dNote" rows="2" placeholder="Add a note…"></textarea><button class="sm" style="margin:6px 0 10px" onclick="addDealNote(${d.id})">Add note</button>
        ${r.events.map(e => `<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:12.5px"><div class="row"><span class="badge">${esc(e.kind)}</span><span class="muted">${esc(e.user_name || (e.kind === 'app' || e.kind === 'files' ? 'Merchant' : 'System'))}</span><span class="faint mono" style="margin-left:auto;font-size:10px">${fmtTime(e.created_at)}</span></div><div style="margin-top:3px;white-space:pre-wrap">${esc(e.body)}</div></div>`).join('')}
      </div>
    </div></div>`);
}
const APP_FIELDS = [['legal_name', 'Legal name'], ['dba', 'DBA'], ['ein', 'EIN'], ['entity_type', 'Entity'], ['start_date', 'Started'], ['industry', 'Industry'], ['address', 'Address'], ['city', 'City'], ['state', 'State'], ['zip', 'ZIP'],
  ['business_phone', 'Business phone'], ['website', 'Website'], ['amount_requested', 'Requested'], ['use_of_funds', 'Use of funds'], ['monthly_revenue', 'Monthly revenue'], ['existing_positions', 'Open positions'], ['existing_lenders', 'Current lenders'],
  ['owner_name', 'Owner'], ['owner_title', 'Title'], ['ownership_pct', 'Ownership %'], ['owner_email', 'Owner email'], ['owner_cell', 'Owner cell'], ['owner_address', 'Home address'], ['owner_city', 'Home city'], ['owner_state', 'Home state'], ['owner_zip', 'Home ZIP'],
  ['owner_dob', 'DOB'], ['owner_ssn', 'SSN'], ['fico_estimate', 'Est. credit'], ['bank_name', 'Bank']];
async function setDealStage(id, stage) {
  const body = { stage };
  if (stage === 'lost') { const why = prompt('Why was this deal lost?'); if (why === null) { route(); return; } body.lost_reason = why; }
  try { await api('/api/deals/' + id, body, 'PATCH'); toast('Moved to ' + STAGE_LABELS[stage]); route(); } catch (e) { toast(e.message, true); }
}
async function saveDeal(id) {
  const v = k => { const el = $('#df_' + k); return el ? el.value : undefined; };
  const body = { owner_id: v('owner'), amount_requested: v('amount_requested'), notes: v('notes'), lender_id: v('lender'),
    funded_amount: v('funded_amount'), factor_rate: v('factor_rate'), payback: v('payback'), term_days: v('term_days'), payment_amount: v('payment_amount'), payment_freq: v('freq'), collected: v('collected'),
    funded_at: v('funded_at') ? new Date(v('funded_at') + 'T12:00:00').getTime() : null };
  if (!body.payback && body.funded_amount && body.factor_rate) delete body.payback;
  if (isAdmin()) { body.commission_pct = v('commission_pct'); body.commission_amt = v('commission_amt'); body.revenue_override = v('revenue_override'); }
  try { await api('/api/deals/' + id, body, 'PATCH'); toast('Saved'); route(); } catch (e) { toast(e.message, true); }
}
async function sendAppLink(id, via) {
  try {
    const r = await api('/api/deals/' + id + '/link', { via: via === 'copy' ? null : via });
    if (via === 'copy') { try { await navigator.clipboard.writeText(r.link); toast('Link copied'); } catch { prompt('Copy this link:', r.link); } }
    else { toast('Application link sent by ' + (via === 'sms' ? 'text' : 'email')); route(); }
  } catch (e) { toast(e.message, true); }
}
async function revealApp(id) {
  try { const r = await api('/api/deals/' + id + '/reveal', {}); for (const [k, v] of Object.entries(r)) { const el = $('#af_' + k); if (el) el.textContent = v; } } catch (e) { toast(e.message, true); }
}
function editAppModal() {
  const a = S.dealData.deal.app || {};
  openModal(`<h3>Edit application</h3><div class="grid2">${APP_FIELDS.map(([k, lab]) => `<div class="mf"><label>${esc(lab)}</label><input id="ea_${k}" value="${esc(a[k] || '')}" ${['owner_ssn', 'owner_dob'].includes(k) ? 'placeholder="unchanged unless you type a new value"' : ''}></div>`).join('')}</div>
    <div class="mact"><button onclick="closeModal()">Cancel</button><button class="primary" onclick="saveApp()">Save</button></div>`);
}
async function saveApp() {
  const app = {}; for (const [k] of APP_FIELDS) { const v = $('#ea_' + k).value; if (v !== (S.dealData.deal.app[k] || '')) app[k] = v; }
  try { await api('/api/deals/' + S.dealData.deal.id, { app }, 'PATCH'); closeModal(); toast('Application updated'); route(); } catch (e) { toast(e.message, true); }
}
async function uploadDealFiles(id, input) {
  const fd = new FormData(); fd.append('kind', $('#fKind').value); for (const f of input.files) fd.append('files', f);
  const r = await fetch('/api/deals/' + id + '/files', { method: 'POST', body: fd });
  if (!r.ok) return toast((await r.json().catch(() => ({}))).error || 'Upload failed', true);
  toast('Uploaded'); route();
}
async function delFile(id, fid) { if (!confirm('Delete this file?')) return; await api(`/api/deals/${id}/files/${fid}`, undefined, 'DELETE'); route(); }
async function submitDeal(id, allMatching) {
  if (allMatching) document.querySelectorAll('.lsub').forEach(c => { c.checked = c.dataset.ok === '1' && !c.disabled; });
  const ids = [...document.querySelectorAll('.lsub:checked')].map(c => +c.value);
  if (!ids.length) return toast('Pick at least one lender', true);
  if (!confirm(`Send this file to ${ids.length} lender(s)?`)) return;
  try {
    const r = await api('/api/deals/' + id + '/submit', { lender_ids: ids, note: $('#subNote').value });
    const bad = r.results.filter(x => !x.ok);
    toast(`Submitted to ${r.results.length - bad.length} lender(s)` + (bad.length ? ` · failed: ${bad.map(x => x.lender + ' (' + x.error + ')').join(', ')}` : ''), !!bad.length);
    route();
  } catch (e) { toast(e.message, true); }
}
async function updSub(id, f) { try { await api('/api/submissions/' + id, f, 'PATCH'); if (f.status) route(); } catch (e) { toast(e.message, true); } }
async function addDealNote(id) { const b = $('#dNote').value.trim(); if (!b) return; await api('/api/deals/' + id + '/notes', { body: b }).catch(e => toast(e.message, true)); route(); }
async function markCommission(id, paid) { await api('/api/deals/' + id + '/commission-paid', { paid }).catch(e => toast(e.message, true)); route(); }
async function createDeal(leadId) { try { const r = await api('/api/deals', { lead_id: leadId }); go('#/deal/' + r.id); } catch (e) { toast(e.message, true); } }

// ============ lenders ============
async function viewLenders() {
  const rows = await api('/api/lenders').catch(() => []);
  if (S.route !== 'lenders') return;
  S.lenderRows = rows;
  V(`<div class="vtitle"><h1>Lenders</h1><span class="muted">Partners you submit deals to</span>${isAdmin() ? '<button class="primary" style="margin-left:auto" onclick="lenderModal()">+ Add lender</button>' : ''}</div>
    <div class="tablewrap"><table><thead><tr><th>Lender</th><th>Submissions email</th><th>Min revenue</th><th>Min TIB</th><th>Min credit</th><th>Max positions</th><th>Amount</th><th>Restrictions</th><th>90-day approvals</th><th>Funded</th>${isAdmin() ? '<th></th>' : ''}</tr></thead><tbody>
    ${rows.map(L => `<tr class="${isAdmin() ? 'click' : ''}" ${isAdmin() ? `onclick="lenderModal(${L.id})"` : ''} style="${L.active ? '' : 'opacity:.45'}"><td><b>${esc(L.name)}</b>${L.in_house ? ' <span class="badge">in-house</span>' : ''}${L.active ? '' : ' <span class="badge">inactive</span>'}<div class="muted" style="font-size:12px">${esc(L.contact_name)}</div></td>
      <td class="muted">${esc(L.email)}</td><td class="mono">${L.min_monthly_revenue ? money(L.min_monthly_revenue) : '—'}</td><td class="mono">${L.min_tib_months ? L.min_tib_months + ' mo' : '—'}</td><td class="mono">${L.min_fico || '—'}</td><td class="mono">${L.max_positions ?? '—'}</td>
      <td class="mono" style="font-size:11px">${L.min_amount || L.max_amount ? money(L.min_amount || 0) + '–' + (L.max_amount ? money(L.max_amount) : '∞') : '—'}</td>
      <td class="muted" style="font-size:11px;max-width:200px">${esc([L.excluded_states && 'No ' + L.excluded_states, L.excluded_industries && 'No ' + L.excluded_industries].filter(Boolean).join(' · '))}</td>
      <td class="mono">${L.subs90 ? Math.round(L.approvals90 / L.subs90 * 100) + '% of ' + L.subs90 : '—'}</td><td class="mono">${L.funded || 0}</td>${isAdmin() ? `<td><button class="sm" onclick="event.stopPropagation();funderModal(${L.id})">Criteria</button></td>` : ''}</tr>`).join('') || '<tr><td colspan="11" class="empty">No lenders yet.</td></tr>'}
    </tbody></table></div>`);
}
function lenderModal(id) {
  const L = (S.lenderRows || []).find(x => x.id === id) || { active: 1 };
  const f = (k, label, type = 'text', ph = '') => `<div class="mf"><label>${label}</label><input id="lf2_${k}" type="${type}" value="${esc(L[k] ?? '')}" placeholder="${ph}"></div>`;
  openModal(`<h3>${id ? 'Edit' : 'Add'} lender</h3><div class="grid2">
    ${f('name', 'Lender name *')}${f('contact_name', 'Contact name')}${f('email', 'Submissions email', 'email')}${f('cc', 'CC (comma separated)')}${f('phone', 'Phone')}
    <div class="mf"><label>Type</label><select id="lf2_in_house"><option value="0">Partner lender</option><option value="1" ${L.in_house ? 'selected' : ''}>In-house (your own book)</option></select></div>
    ${f('min_monthly_revenue', 'Min monthly revenue', 'number', 'e.g. 20000')}${f('min_tib_months', 'Min time in business (months)', 'number')}${f('min_fico', 'Min credit score', 'number')}${f('max_positions', 'Max open positions', 'number')}
    ${f('min_amount', 'Min amount', 'number')}${f('max_amount', 'Max amount', 'number')}${f('broker_pct', 'Commission they pay you (% of funded)', 'number', 'e.g. 8 — used for profit reports')}</div>
    ${f('excluded_states', 'States they don\'t fund', 'text', 'e.g. CA, NY, VA')}${f('excluded_industries', 'Industries they don\'t fund', 'text', 'e.g. trucking, cannabis, auto sales')}
    <div class="mf"><label>Notes</label><textarea id="lf2_notes" rows="2">${esc(L.notes || '')}</textarea></div>
    <div class="mact" style="justify-content:space-between">${id ? `<button class="${L.active ? 'danger' : ''}" onclick="saveLender(${id}, {active:${L.active ? 0 : 1}})">${L.active ? 'Deactivate' : 'Reactivate'}</button>` : '<span></span>'}
    <div class="row"><button onclick="closeModal()">Cancel</button><button class="primary" onclick="saveLender(${id || 0})">Save</button></div></div>`);
}
async function saveLender(id, override) {
  const body = override || Object.fromEntries(['name', 'contact_name', 'email', 'cc', 'phone', 'min_monthly_revenue', 'min_tib_months', 'min_fico', 'max_positions', 'min_amount', 'max_amount', 'broker_pct', 'excluded_states', 'excluded_industries', 'notes'].map(k => [k, $('#lf2_' + k).value]));
  if (!override) body.in_house = $('#lf2_in_house').value === '1';
  try { await api(id ? '/api/lenders/' + id : '/api/lenders', body, id ? 'PATCH' : 'POST'); closeModal(); viewLenders(); } catch (e) { toast(e.message, true); }
}

// ============ sequences ============
async function viewSequences() {
  const [rows, st] = await Promise.all([api('/api/sequences').catch(() => []), api('/api/settings').catch(() => ({}))]);
  if (S.route !== 'sequences') return;
  S.seqRows = rows;
  const auto = st.auto_sequences || {};
  const triggers = ['Voicemail dropped', 'Voicemail', 'Gatekeeper', 'Callback', 'Interested', 'App Sent', 'Not Interested', 'New intake lead'];
  V(`<div class="vtitle"><h1>Sequences</h1><span class="muted">Automatic follow-up: texts, emails and call reminders on a schedule</span>${isAdmin() ? '<button class="primary" style="margin-left:auto" onclick="seqModal()">+ New sequence</button>' : ''}</div>
    <div style="display:grid;grid-template-columns:2fr 1fr;gap:14px;align-items:start">
    <div>${rows.map(s => `<div class="card" style="margin-bottom:12px;${s.active ? '' : 'opacity:.5'}"><div class="row"><b class="grow" style="font-size:15px">${esc(s.name)}</b><span class="muted">${s.active_count} active · ${s.total_count} total</span>${isAdmin() ? `<button class="sm" onclick="seqModal(${s.id})">Edit</button>` : ''}</div>
      <div style="margin-top:8px">${s.steps.map((x, i) => `<div class="row" style="padding:4px 0;font-size:12.5px"><span class="mono faint" style="width:90px">Day ${x.day}${x.hour != null ? ' · ' + ((x.hour + 11) % 12 + 1) + (x.hour < 12 ? 'am' : 'pm') : ''}</span><span class="badge">${x.type === 'sms' ? 'text' : x.type}</span><span class="grow muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(x.type === 'email' ? x.subject + ' — ' + x.body : x.body || 'Call reminder')}</span></div>`).join('')}</div></div>`).join('') || '<div class="card empty">No sequences yet.</div>'}</div>
    <div class="card"><h3>Auto-enroll</h3><div class="faint" style="font-size:12px;margin-bottom:10px">Start a sequence automatically after these outcomes. A sequence stops on its own when the lead replies, is marked Interested / App Sent / Not Interested / DNC, or is closed.</div>
      ${triggers.map(t => `<div class="mf"><label>${esc(t)}</label><select class="autoSeq" data-t="${esc(t)}" ${isAdmin() ? '' : 'disabled'}><option value="">— none —</option>${rows.filter(s => s.active).map(s => `<option value="${s.id}" ${String(auto[t]) === String(s.id) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>`).join('')}
      ${isAdmin() ? '<button class="primary" onclick="saveAutoSeq()">Save</button>' : ''}</div></div>`);
}
async function saveAutoSeq() { const m = {}; document.querySelectorAll('.autoSeq').forEach(s => { if (s.value) m[s.dataset.t] = Number(s.value); }); try { await api('/api/settings', { auto_sequences: m }, 'PUT'); toast('Saved'); } catch (e) { toast(e.message, true); } }
function seqModal(id) {
  const s = (S.seqRows || []).find(x => x.id === id) || { name: '', steps: [{ day: 0, hour: null, type: 'sms', body: 'Hi {first}, it\'s {rep} with {company} — just tried calling about funding for {business}. Good time to talk?' }, { day: 2, hour: 10, type: 'call' }, { day: 3, hour: 11, type: 'email', subject: 'Funding for {business}', body: 'Hi {first},\n\nI tried reaching you about working capital for {business}. We can usually get an offer out the same day once we see your last 4 months of statements.\n\nWhen is a good time to talk?\n\n{rep}\n{company}' }] };
  S.seqEdit = JSON.parse(JSON.stringify(s));
  openModal(`<h3>${id ? 'Edit' : 'New'} sequence</h3><div class="mf"><label>Name</label><input id="sqName" value="${esc(s.name)}"></div>
    <div class="faint" style="font-size:11px;margin-bottom:8px">Day 0 = the day the lead is enrolled. Texts and calls wait for the lead's calling hours. Merge fields: {first} {business} {rep} {company}</div>
    <div id="sqSteps"></div><button class="sm" onclick="S.seqEdit.steps.push({day:(S.seqEdit.steps.at(-1)?.day||0)+1,hour:10,type:'sms',body:''});renderSeqSteps()">+ Add step</button>
    <div class="mact" style="justify-content:space-between">${id ? `<button class="danger" onclick="delSeq(${id})">Turn off</button>` : '<span></span>'}<div class="row"><button onclick="closeModal()">Cancel</button><button class="primary" onclick="saveSeq(${id || 0})">Save</button></div></div>`);
  $('#modalBody').style.width = '680px';
  renderSeqSteps();
}
function renderSeqSteps() {
  $('#sqSteps').innerHTML = S.seqEdit.steps.map((x, i) => `<div class="card" style="padding:10px;margin-bottom:8px"><div class="row wrap">
    <label class="row muted" style="gap:4px">Day <input type="number" min="0" style="width:60px" value="${x.day}" onchange="S.seqEdit.steps[${i}].day=+this.value"></label>
    <label class="row muted" style="gap:4px">at <select onchange="S.seqEdit.steps[${i}].hour=this.value===''?null:+this.value"><option value="">right away</option>${Array.from({ length: 14 }, (_, k) => k + 8).map(h => `<option value="${h}" ${x.hour === h ? 'selected' : ''}>${(h + 11) % 12 + 1}${h < 12 ? 'am' : 'pm'}</option>`).join('')}</select></label>
    <select onchange="S.seqEdit.steps[${i}].type=this.value;renderSeqSteps()"><option value="sms" ${x.type === 'sms' ? 'selected' : ''}>Text</option><option value="email" ${x.type === 'email' ? 'selected' : ''}>Email</option><option value="call" ${x.type === 'call' ? 'selected' : ''}>Call reminder</option></select>
    <button class="sm" style="margin-left:auto" onclick="S.seqEdit.steps.splice(${i},1);renderSeqSteps()">✕</button></div>
    ${x.type === 'email' ? `<input style="width:100%;margin-top:8px" placeholder="Subject" value="${esc(x.subject || '')}" oninput="S.seqEdit.steps[${i}].subject=this.value">` : ''}
    ${x.type !== 'call' ? `<textarea rows="${x.type === 'email' ? 4 : 2}" style="margin-top:8px" oninput="S.seqEdit.steps[${i}].body=this.value">${esc(x.body || '')}</textarea>` : '<div class="faint" style="font-size:12px;margin-top:6px">Puts the lead back in the rep\'s dial queue as a due callback.</div>'}</div>`).join('');
}
async function saveSeq(id) {
  const body = { name: $('#sqName').value || 'Sequence', steps: S.seqEdit.steps };
  try { await api(id ? '/api/sequences/' + id : '/api/sequences', body, id ? 'PUT' : 'POST'); closeModal(); viewSequences(); } catch (e) { toast(e.message, true); }
}
async function delSeq(id) { if (!confirm('Turn off this sequence and stop everyone in it?')) return; await api('/api/sequences/' + id, undefined, 'DELETE'); closeModal(); viewSequences(); }
async function enrollModal(leadIds) {
  const rows = (await api('/api/sequences').catch(() => [])).filter(s => s.active);
  if (!rows.length) return toast('Create a sequence first (Sequences page)', true);
  openModal(`<h3>Add ${leadIds.length} lead${leadIds.length > 1 ? 's' : ''} to a sequence</h3><div class="mf"><select id="enSeq">${rows.map(s => `<option value="${s.id}">${esc(s.name)} (${s.steps.length} steps)</option>`).join('')}</select></div>
    <div class="mact"><button onclick="closeModal()">Cancel</button><button class="primary" onclick="doEnroll([${leadIds.join(',')}])">Start</button></div>`);
}
async function doEnroll(ids) { try { const r = await api('/api/sequences/' + $('#enSeq').value + '/enroll', { lead_ids: ids }); closeModal(); toast(`Enrolled ${r.enrolled}`); if (S.route === 'lead') route(); } catch (e) { toast(e.message, true); } }
async function stopEnrollment(id) { await api('/api/enrollments/' + id + '/stop', {}).catch(() => {}); route(); }

// ============ commissions ============
async function viewCommissions() {
  const range = S.comRange || 'month';
  const from = range === 'month' ? new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime() : range === 'last' ? new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).getTime() : range === 'year' ? new Date(new Date().getFullYear(), 0, 1).getTime() : 0;
  const to = range === 'last' ? new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime() : '';
  const r = await api('/api/commissions?' + new URLSearchParams({ from, to })).catch(e => { toast(e.message, true); return null; });
  if (!r || S.route !== 'commissions') return;
  V(`<div class="vtitle"><h1>Commissions</h1><select id="cRange"><option value="month">This month</option><option value="last">Last month</option><option value="year">This year</option><option value="all">All time</option></select>
      ${isAdmin() ? '<span class="muted" style="margin-left:auto">Set each rep\'s default % under Team &amp; setup</span>' : ''}</div>
    <div class="kpis">${r.reps.map(p => `<div class="kpi"><b>${money(p.earned)}</b><span>${esc(p.name)} · ${p.deals} deal${p.deals === 1 ? '' : 's'} · ${money(p.funded)} funded · ${money(p.earned - p.paid)} unpaid</span></div>`).join('') || '<div class="kpi"><b>$0</b><span>No funded deals in this period</span></div>'}</div>
    <div class="tablewrap"><table><thead><tr><th>Funded</th><th>Merchant</th><th>Rep</th><th>Lender</th><th>Amount</th><th>Commission</th><th>Status</th></tr></thead><tbody>
    ${r.rows.map(d => `<tr><td class="muted">${d.funded_at ? new Date(d.funded_at).toLocaleDateString() : ''}</td><td><a href="#/deal/${d.id}">${esc(d.title || d.lead_business)}</a></td><td>${esc(d.owner_name || '')}</td><td>${esc(d.lender_name || 'In-house')}</td>
      <td class="mono">${money(d.funded_amount)}</td><td class="mono">${money(d.commission_due)}</td>
      <td>${d.commission_paid_at ? `<span class="badge good">paid</span>` : '<span class="badge">unpaid</span>'} ${isAdmin() ? `<button class="sm" onclick="markCommission(${d.id}, ${!d.commission_paid_at})">${d.commission_paid_at ? 'Undo' : 'Mark paid'}</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No funded deals in this period.</td></tr>'}
    </tbody></table></div>${isAdmin() ? '<div id="isoPayBox"></div>' : ''}`);
  if (isAdmin()) loadIsoPayouts();
  $('#cRange').value = range; $('#cRange').onchange = e => { S.comRange = e.target.value; viewCommissions(); };
}

// ============ email thread (lead page) ============
function mountEmails(lead, emails, el) {
  const tpls = (S.teamSettings && S.teamSettings.email_templates) || [];
  el.innerHTML = `<div class="thread"><div class="thread-head"><b class="grow">Email</b><span class="muted" style="font-size:12px">${esc(lead.email || 'no email on file')}</span></div>
    <div class="msgs" id="emailList">${emails.length ? emails.map(e => `<div class="msg ${e.direction}${e.status === 'failed' ? ' failed' : ''}" style="max-width:92%"><b>${esc(e.subject)}</b>
      <div style="margin-top:4px;font-size:12.5px">${esc(e.body.length > 800 ? e.body.slice(0, 800) + '…' : e.body)}</div><div class="meta">${e.direction === 'out' ? esc(e.user_name || 'Auto') + ' · ' : ''}${fmtTime(e.created_at)}${e.status === 'failed' ? ' · failed: ' + esc(e.error) : ''}</div></div>`).join('') : '<div class="faint" style="margin:auto">No emails yet</div>'}</div>
    <div class="composer">${!S.config.email ? '<div class="faint" style="font-size:12px">Email isn\'t set up yet — add SMTP settings to .env.</div>' : !lead.email ? '<div class="faint" style="font-size:12px">Add an email address to this lead first.</div>' : `
      ${tpls.length ? `<select onchange="useEmailTpl(this)"><option value="">Insert template…</option>${tpls.map((t, i) => `<option value="${i}">${esc(t.name)}</option>`).join('')}</select>` : ''}
      <input id="emSubj" placeholder="Subject"><textarea id="emBody" placeholder="Message…" style="min-height:90px"></textarea>
      <div class="row"><span class="grow"></span><button class="primary" onclick="sendEmailToLead(${lead.id})">Send email</button></div>`}</div></div>`;
  const box = $('#emailList'); box.scrollTop = box.scrollHeight;
}
function useEmailTpl(sel) { if (sel.value === '') return; const t = S.teamSettings.email_templates[+sel.value], l = S.thread?.lead; $('#emSubj').value = fill(t.subject, l); $('#emBody').value = fill(t.body, l); sel.value = ''; }
async function sendEmailToLead(id) {
  const subject = $('#emSubj').value.trim(), body = $('#emBody').value.trim(); if (!subject || !body) return toast('Add a subject and message', true);
  try { await api('/api/leads/' + id + '/email', { subject, body }); toast('Email sent'); refreshLeadSide(); } catch (e) { toast(e.message, true); }
}
