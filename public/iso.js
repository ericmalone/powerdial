// Partner (ISO / broker) portal — a separate, simple view for partner accounts
const isoMoney = n => n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US');
function bootIso() {
  $('#login').classList.add('hidden'); $('#app').classList.add('hidden');
  let el = document.getElementById('isoApp');
  if (!el) { el = document.createElement('div'); el.id = 'isoApp'; document.body.appendChild(el); }
  el.style.cssText = 'max-width:1000px;margin:0 auto;padding:18px 16px 60px';
  renderIso();
}
const ISO_BADGE = { Received: '', 'In review': 'callback', 'In underwriting': 'callback', 'Offer made': 'good', 'Contract out': 'good', Funded: 'good', Closed: 'dnc' };
async function renderIso() {
  const el = $('#isoApp'); const d = await api('/api/iso/deals').catch(e => { toast(e.message, true); return null; }); if (!d) return;
  const t = d.totals;
  const kpi = (l, v) => `<div class="card" style="flex:1;min-width:130px;padding:12px 14px"><div class="faint" style="font-size:11px">${l}</div><div style="font-size:22px;font-weight:700">${v}</div></div>`;
  el.innerHTML = `<div class="row" style="margin-bottom:14px"><div class="logo grow" style="width:auto"><span class="dot live"></span>${esc(d.company)} · Partner portal</div><span class="muted">${esc(S.me.name)}</span><button class="sm" onclick="logout()">Log out</button></div>
    <div class="row wrap" style="gap:10px;margin-bottom:14px">${kpi('Submitted', t.submitted)}${kpi('In progress', t.pending)}${kpi('Funded', t.funded)}${kpi('Funded volume', isoMoney(t.volume))}${kpi('Commission earned', isoMoney(t.earned))}${kpi('Paid to you', isoMoney(t.paid))}${kpi('Still owed', isoMoney(t.earned - t.paid))}</div>
    <div class="card" style="margin-bottom:14px"><h3>Submit a deal</h3><div class="faint" style="font-size:12px;margin-bottom:10px">Your commission on funded deals: <b>${d.pct}%</b> of the funded amount. Add bank statements now, or send the merchant the application link after you submit.</div>
      <div class="grid2"><div class="mf"><label>Business name *</label><input id="isoBiz"></div><div class="mf"><label>Contact name</label><input id="isoName"></div>
      <div class="mf"><label>Merchant phone *</label><input id="isoPhone" type="tel"></div><div class="mf"><label>Email</label><input id="isoEmail" type="email"></div>
      <div class="mf"><label>State</label><input id="isoState" maxlength="2" placeholder="NY"></div><div class="mf"><label>Amount requested</label><input id="isoAmt" type="number" min="0"></div></div>
      <div class="mf"><label>Notes</label><textarea id="isoNotes" rows="2"></textarea></div>
      <div class="mf"><label>Bank statements / documents (PDF or images)</label><input id="isoFiles" type="file" multiple accept=".pdf,image/*"></div>
      <button class="primary" id="isoGo" onclick="isoSubmit()">Submit deal</button><span id="isoMsg" style="margin-left:10px"></span></div>
    <div class="card"><h3>Your deals</h3><div class="tablewrap"><table><thead><tr><th>Submitted</th><th>Business</th><th>Contact</th><th>Status</th><th style="text-align:right">Requested</th><th style="text-align:right">Funded</th><th style="text-align:right">Your commission</th><th>Docs</th><th></th></tr></thead><tbody>
      ${d.rows.map(x => `<tr><td class="muted">${new Date(x.submitted_at).toLocaleDateString()}</td><td><b>${esc(x.business)}</b></td><td class="muted">${esc(x.contact || '')}</td><td><span class="badge ${ISO_BADGE[x.status] || ''}">${esc(x.status)}</span></td>
        <td class="mono" style="text-align:right">${isoMoney(x.amount_requested)}</td><td class="mono" style="text-align:right">${isoMoney(x.funded_amount)}</td>
        <td class="mono" style="text-align:right">${x.commission != null ? isoMoney(x.commission) + (x.paid ? ' <span class="badge good">paid</span>' : ' <span class="badge callback">due</span>') : '—'}</td><td>${x.statements}</td>
        <td style="white-space:nowrap"><button class="sm" onclick="isoAddFiles(${x.id})">Add documents</button> ${x.apply_link ? `<button class="sm" onclick="navigator.clipboard.writeText('${esc(x.apply_link)}');toast('Application link copied')">Copy merchant link</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">No deals yet — submit your first one above.</td></tr>'}</tbody></table></div></div>`;
}
async function isoSubmit() {
  const fd = new FormData();
  for (const [k, id] of [['business', 'isoBiz'], ['contact', 'isoName'], ['phone', 'isoPhone'], ['email', 'isoEmail'], ['state', 'isoState'], ['amount', 'isoAmt'], ['notes', 'isoNotes']]) fd.append(k, $('#' + id).value);
  for (const f of $('#isoFiles').files) fd.append('files', f);
  const b = $('#isoGo'); b.disabled = true; b.textContent = 'Submitting…';
  try {
    const r = await fetch('/api/iso/deals', { method: 'POST', body: fd }); const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Could not submit');
    toast('Deal submitted — thank you'); await renderIso();
    if (j.deal && j.deal.apply_link) { try { await navigator.clipboard.writeText(j.deal.apply_link); toast('Merchant application link copied'); } catch {} }
  } catch (e) { toast(e.message, true); b.disabled = false; b.textContent = 'Submit deal'; }
}
function isoAddFiles(id) {
  const inp = document.createElement('input'); inp.type = 'file'; inp.multiple = true; inp.accept = '.pdf,image/*';
  inp.onchange = async () => {
    const fd = new FormData(); for (const f of inp.files) fd.append('files', f);
    const r = await fetch('/api/iso/deals/' + id + '/files', { method: 'POST', body: fd }); const j = await r.json().catch(() => ({}));
    if (!r.ok) return toast(j.error || 'Upload failed', true); toast('Documents added'); renderIso();
  }; inp.click();
}
