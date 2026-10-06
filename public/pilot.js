// MCA Pilot parity screens: Needs action, Tasks, Submissions, Offers, Attribution (sources + batches), Pilot setup,
// plus the deal-page underwriting box and the funder criteria modal.
const pl = { na: { action: '', owner: '', q: '', off: 0 }, tk: { status: 'open', type: '', assigned: '', due: '', q: '', off: 0 }, sb: { status: '', lender: '', errors: '', q: '', off: 0 }, of: { status: '', lender: '', tag: '', q: '' }, tab: 'underwrite', setupTab: 'workflows' };
const PL_LEGAL = ['LLC', 'Corporation', 'S-Corp', 'Sole Proprietorship', 'Partnership', 'Non-Profit'];
const PL_DEFAULT = ['Clean File', 'Open Default', 'Satisfied Default'];
const PL_PRODUCTS = ['Working Capital', 'Consolidation', 'Line of Credit', 'Reverse Consolidation'];
const PL_METRICS = [['deposits', 'Deposits', 'min'], ['revenue', 'Revenue', 'min'], ['neg_days', 'Negative days', 'max'], ['low_days', 'Low-balance days (<$500)', 'max'], ['nsf', 'NSFs', 'max'], ['adb', 'Avg daily balance', 'min'], ['open_bal', 'Opening balance', 'min'], ['close_bal', 'Closing balance', 'min'], ['adb_ratio', 'ADB / deposits %', 'min']];
const plMoney = v => v == null || v === '' ? '—' : (v < 0 ? '−$' : '$') + Math.round(Math.abs(v)).toLocaleString('en-US');
const plNum = v => v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
const plAgo = t => { if (!t) return '—'; const m = Math.round((Date.now() - t) / 6e4); return m < 1 ? 'now' : m < 60 ? m + 'm' : m < 2880 ? Math.round(m / 60) + 'h' : Math.round(m / 1440) + 'd'; };
const plDay = t => t ? new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const plDue = t => { if (!t) return '—'; const d = Math.round((new Date(t).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 864e5); return d < 0 ? `<span style="color:var(--red)">${-d}d overdue</span>` : d === 0 ? '<b>Today</b>' : d === 1 ? 'Tomorrow' : plDay(t); };
const plQS = o => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== '' && v != null && v !== false) p.set(k, v); return p.toString(); };
const plSel = (id, opts, cur, all, onch) => `<select id="${id}" onchange="${onch}">${all != null ? `<option value="">${all}</option>` : ''}${opts.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select>`;
const plIn = (id, label, val, type = 'text', ph = '', extra = '') => `<div class="mf"><label>${label}</label><input id="${id}" type="${type}" ${type === 'number' ? 'step="any"' : ''} value="${esc(val ?? '')}" placeholder="${esc(ph)}" ${extra}></div>`;
const plPager = (n, off, per, fn) => n > per ? `<div class="row" style="justify-content:center;gap:10px;margin:12px 0"><button class="sm" ${off ? '' : 'disabled'} onclick="${fn}(${Math.max(0, off - per)})">‹ Prev</button><span class="muted">${off + 1}–${Math.min(n, off + per)} of ${n.toLocaleString()}</span><button class="sm" ${off + per < n ? '' : 'disabled'} onclick="${fn}(${off + per})">Next ›</button></div>` : '';
let plT; const plDebounce = fn => { clearTimeout(plT); plT = setTimeout(fn, 350); };
const plRefocus = (id, v) => setTimeout(() => { const i = $('#' + id); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); } }, 60);

// ---------- nav badge ----------
function plNavCount() { api('/api/needs-action/count').then(r => { const c = $('#naCnt'); if (c) { c.textContent = r.n > 999 ? '999+' : r.n; c.classList.toggle('hidden', !r.n); } }).catch(() => {}); }
setInterval(() => { if (S.me) plNavCount(); }, 90000); setTimeout(() => { if (S.me) plNavCount(); }, 3500);

// ================= Needs action =================
async function viewNeeds() {
  const f = pl.na, r = await api('/api/needs-action?' + plQS({ action: f.action, owner: f.owner, q: f.q, limit: 100, offset: f.off })).catch(e => { toast(e.message, true); return null; });
  if (!r || S.route !== 'needs') return;
  const top = Object.entries(r.counts).sort((a, b) => b[1] - a[1]);
  V(`<div class="vtitle"><h1>Needs action</h1><span class="muted">Every deal that's waiting on you, oldest first</span></div>
    <div class="row wrap" style="gap:6px;margin-bottom:12px">${top.map(([a, n]) => `<button class="sm ${f.action === a ? 'primary' : ''}" onclick="naSet('action','${esc(a).replace(/'/g, "\\'")}')">${esc(a)} <b>${n}</b></button>`).join('') || '<span class="muted">Nothing needs action right now.</span>'}${f.action ? '<button class="sm" onclick="naSet(\'action\',\'\')">Clear</button>' : ''}</div>
    <div class="row wrap" style="gap:8px;margin-bottom:10px"><input id="naq" placeholder="Search company…" value="${esc(f.q)}" oninput="naSearch(this.value)" style="width:220px">
      ${isAdmin() ? plSel('nao', r.owners.map(u => [u.id, u.name]), f.owner, 'All originators', "naSet('owner',this.value)") : ''}<span class="muted" style="margin-left:auto">${r.total.toLocaleString()} deals</span></div>
    <div class="tablewrap"><table><thead><tr><th>Company</th><th>Action</th><th>Waiting</th><th>Status</th><th style="text-align:right">Monthly rev</th><th>Phone</th><th>Email</th><th>Originator</th></tr></thead><tbody>
    ${r.rows.map(x => `<tr class="click" onclick="go('#/deal/${x.deal_id}')"><td><b>${esc(x.company)}</b></td><td><span class="badge ${/stip|Fix|Chase|Nudge/.test(x.action) ? 'callback' : 'new'}">${esc(x.action)}</span></td><td class="mono">${plAgo(x.since)}</td><td class="muted">${esc(x.status)}</td>
      <td class="mono" style="text-align:right">${plMoney(x.revenue)}</td><td class="mono">${esc(x.phone ? fmtPhone(x.phone) : '')}</td><td class="muted">${esc(x.email || '')}</td><td>${esc(x.originator)}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">Nothing here. Nice.</td></tr>'}</tbody></table></div>${plPager(r.total, f.off, 100, 'naPage')}`);
  const c = $('#naCnt'); if (c) { const n = Object.values(r.counts).reduce((a, b) => a + b, 0); c.textContent = n; c.classList.toggle('hidden', !n); }
}
function naSet(k, v) { pl.na[k] = v; pl.na.off = 0; viewNeeds(); }
function naSearch(v) { plDebounce(() => { pl.na.q = v; pl.na.off = 0; viewNeeds().then(() => plRefocus('naq', v)); }); }
function naPage(o) { pl.na.off = o; viewNeeds(); }

// ================= Tasks =================
async function viewTasks() {
  const f = pl.tk, r = await api('/api/tasks?' + plQS({ ...f, limit: 100, offset: f.off })).catch(e => { toast(e.message, true); return null; });
  if (!r || S.route !== 'tasks') return;
  V(`<div class="vtitle"><h1>Tasks</h1><span class="muted">${r.open.toLocaleString()} open</span><div class="row" style="margin-left:auto;gap:8px">${isAdmin() ? '<a class="sm button" href="/api/pilot/export/tasks">Export CSV</a>' : ''}<button class="primary sm" onclick="taskModal()">+ New task</button></div></div>
    <div class="row wrap" style="gap:8px;margin-bottom:10px"><input id="tkq" placeholder="Search…" value="${esc(f.q)}" oninput="tkSearch(this.value)" style="width:200px">
      ${plSel('tks', [['open', 'Open'], ['done', 'Done']], f.status, 'Any status', "tkSet('status',this.value)")}${plSel('tkt', r.types, f.type, 'Any type', "tkSet('type',this.value)")}
      ${plSel('tkd', [['overdue', 'Overdue'], ['today', 'Due today']], f.due, 'Any due date', "tkSet('due',this.value)")}
      ${isAdmin() ? plSel('tka', [['none', 'Unassigned'], ...(S.users || []).map(u => [u.id, u.name])], f.assigned, 'Anyone', "tkSet('assigned',this.value)") : ''}</div>
    <div class="tablewrap"><table><thead><tr><th style="width:30px"></th><th>Deal</th><th>Funder</th><th>Type</th><th>Description</th><th>Assigned</th><th>Due</th><th></th></tr></thead><tbody>
    ${r.rows.map(t => `<tr style="${t.status === 'done' ? 'opacity:.5' : ''}"><td><input type="checkbox" ${t.status === 'done' ? 'checked' : ''} onchange="tkDone(${t.id},this.checked)"></td>
      <td>${t.deal_id ? `<a href="#/deal/${t.deal_id}">${esc(t.deal_title || t.business || 'Deal ' + t.deal_id)}</a>` : '<span class="faint">—</span>'}</td><td>${esc(t.lender_name || '')}</td><td><span class="badge">${esc(t.type)}</span>${t.auto ? ' <span class="faint" style="font-size:10px">auto</span>' : ''}</td>
      <td style="max-width:420px">${esc(t.description)}</td><td>${esc(t.assigned_name || '—')}</td><td>${t.status === 'done' ? '—' : plDue(t.due_at)}</td>
      <td style="white-space:nowrap"><button class="sm" title="Pin" onclick="tkPin(${t.id},${t.pinned ? 0 : 1})">${t.pinned ? '📌' : '📍'}</button></td></tr>`).join('') || '<tr><td colspan="8" class="empty">No tasks.</td></tr>'}</tbody></table></div>${plPager(r.total, f.off, 100, 'tkPage')}`);
}
function tkSet(k, v) { pl.tk[k] = v; pl.tk.off = 0; viewTasks(); }
function tkSearch(v) { plDebounce(() => { pl.tk.q = v; pl.tk.off = 0; viewTasks().then(() => plRefocus('tkq', v)); }); }
function tkPage(o) { pl.tk.off = o; viewTasks(); }
async function tkDone(id, on) { try { await api('/api/tasks/' + id, { status: on ? 'done' : 'open' }, 'PATCH'); plNavCount(); if (S.route === 'tasks') viewTasks(); else plReloadDealBox(); } catch (e) { toast(e.message, true); } }
async function tkPin(id, on) { try { await api('/api/tasks/' + id, { pinned: on }, 'PATCH'); viewTasks(); } catch (e) { toast(e.message, true); } }
function taskModal(dealId) {
  openModal(`<h3>New task</h3>${plIn('tn_desc', 'What needs doing?', '', 'text', 'e.g. Call merchant about the voided check')}<div class="grid2">${plIn('tn_due', 'Due', '', 'date')}
    <div class="mf"><label>Type</label><input id="tn_type" value="general" list="tnTypes"><datalist id="tnTypes"><option>general</option><option>call</option><option>stips</option><option>docs</option><option>follow-up</option></datalist></div></div>
    ${isAdmin() ? `<div class="mf"><label>Assign to</label>${plSel('tn_who', (S.users || []).map(u => [u.id, u.name]), S.me.id, null, '')}</div>` : ''}
    <div class="mact"><button onclick="closeModal()">Cancel</button><button class="primary" onclick="taskSave(${dealId || 0})">Save</button></div>`);
}
async function taskSave(dealId) {
  const due = $('#tn_due').value; const body = { description: $('#tn_desc').value, type: $('#tn_type').value, due_at: due ? new Date(due + 'T17:00').getTime() : null, deal_id: dealId || null };
  if ($('#tn_who')) body.assigned_to = $('#tn_who').value;
  try { await api('/api/tasks', body); closeModal(); plNavCount(); S.route === 'tasks' ? viewTasks() : plReloadDealBox(); } catch (e) { toast(e.message, true); }
}

// ================= Submissions =================
async function viewSubmissions() {
  const f = pl.sb, r = await api('/api/pilot/submissions?' + plQS({ ...f, limit: 50, offset: f.off })).catch(e => { toast(e.message, true); return null; });
  if (!r || S.route !== 'submissions') return;
  const tl = Object.fromEntries(r.tally.map(x => [x.status, x.n]));
  V(`<div class="vtitle"><h1>Submissions</h1><span class="muted">${r.total.toLocaleString()} total</span>${isAdmin() ? '<a class="sm button" style="margin-left:auto" href="/api/pilot/export/submissions">Export CSV</a>' : ''}</div>
    <div class="kpis">${['submitted', 'info_needed', 'approved', 'declined', 'funded', 'withdrawn'].map(s => `<div class="kpi" style="cursor:pointer" onclick="sbSet('status','${f.status === s ? '' : s}')"><b>${(tl[s] || 0).toLocaleString()}</b><span>${s.replace('_', ' ')}${f.status === s ? ' ✓' : ''}</span></div>`).join('')}</div>
    <div class="row wrap" style="gap:8px;margin-bottom:10px"><input id="sbq" placeholder="Search merchant…" value="${esc(f.q)}" oninput="sbSearch(this.value)" style="width:200px">${plSel('sbl', r.lenders.map(l => [l.id, l.name]), f.lender, 'All funders', "sbSet('lender',this.value)")}
      <label class="row" style="gap:5px"><input type="checkbox" ${f.errors ? 'checked' : ''} onchange="sbSet('errors',this.checked?'1':'')"> Failed only</label></div>
    <div class="tablewrap"><table><thead><tr><th>ID</th><th>Deal</th><th>Funder</th><th>Status</th><th>Response</th><th>Submitted by</th><th>Originator</th><th>Sent</th><th>Updated</th></tr></thead><tbody>
    ${r.rows.map(x => `<tr class="click" onclick="go('#/deal/${x.deal_id}')"><td class="mono faint">${x.id}</td><td><b>${esc(x.deal)}</b></td><td>${esc(x.lender)}</td><td><span class="badge ${x.status === 'approved' || x.status === 'funded' ? 'good' : x.status === 'declined' ? 'dnc' : x.status === 'info_needed' ? 'callback' : ''}">${esc(x.status.replace('_', ' '))}</span>${x.error ? ' <span class="badge dnc">error</span>' : ''}</td>
      <td style="max-width:360px;font-size:12px" class="muted">${esc(x.error || x.response || '')}</td><td>${esc(x.submitted_by || '')}</td><td>${esc(x.originator || '')}</td><td class="mono faint">${plAgo(x.sent_at)}</td><td class="mono faint">${plAgo(x.updated_at)}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">No submissions.</td></tr>'}</tbody></table></div>${plPager(r.total, f.off, 50, 'sbPage')}`);
}
function sbSet(k, v) { pl.sb[k] = v; pl.sb.off = 0; viewSubmissions(); }
function sbSearch(v) { plDebounce(() => { pl.sb.q = v; pl.sb.off = 0; viewSubmissions().then(() => plRefocus('sbq', v)); }); }
function sbPage(o) { pl.sb.off = o; viewSubmissions(); }

// ================= Offers =================
async function viewOffers() {
  const f = pl.of, r = await api('/api/pilot/offers?' + plQS(f)).catch(e => { toast(e.message, true); return null; });
  if (!r || S.route !== 'offers') return;
  S.offerRows = r.rows;
  V(`<div class="vtitle"><h1>Offers</h1><span class="muted">${r.rows.length} offers from funders</span>${isAdmin() ? '<a class="sm button" style="margin-left:auto" href="/api/pilot/export/offers">Export CSV</a>' : ''}</div>
    <div class="row wrap" style="gap:8px;margin-bottom:10px"><input id="ofq" placeholder="Search merchant…" value="${esc(f.q)}" oninput="ofSearch(this.value)" style="width:200px">
      ${plSel('ofs', ['submitted', 'info_needed', 'approved', 'declined', 'funded', 'withdrawn'], f.status, 'Any status', "ofSet('status',this.value)")}${plSel('ofl', r.lenders.map(l => [l.id, l.name]), f.lender, 'All funders', "ofSet('lender',this.value)")}${plSel('oft', ['Repriced Offer', 'Got Repriced'], f.tag, 'Any tag', "ofSet('tag',this.value)")}</div>
    <div class="tablewrap"><table><thead><tr><th>Deal</th><th>Funder</th><th>Status</th><th style="text-align:right">Amount</th><th style="text-align:right">Factor</th><th style="text-align:right">Term</th><th style="text-align:right">Payment</th><th style="text-align:right">Payback</th><th style="text-align:right">Commission</th><th>Tags</th><th>Updated</th></tr></thead><tbody>
    ${r.rows.map(x => `<tr><td class="click" onclick="go('#/deal/${x.deal_id}')"><b>${esc(x.deal)}</b></td><td>${esc(x.lender)}</td><td><span class="badge ${/approved|funded/.test(x.status) ? 'good' : ''}">${esc(x.status.replace('_', ' '))}</span></td><td class="mono" style="text-align:right">${plMoney(x.amount)}</td><td class="mono" style="text-align:right">${x.factor ?? '—'}</td>
      <td class="mono" style="text-align:right">${x.term ? x.term + 'd' : '—'}</td><td class="mono" style="text-align:right">${plMoney(x.payment)}${x.freq ? '/' + esc(x.freq).slice(0, 1) : ''}</td><td class="mono" style="text-align:right">${plMoney(x.payback)}</td><td class="mono" style="text-align:right">${plMoney(x.commission)}${x.points ? ` <span class="faint">${x.points}pt</span>` : ''}</td>
      <td><span class="click" onclick="offerTags(${x.id})">${x.tags ? x.tags.split(',').map(t => `<span class="badge callback">${esc(t.trim())}</span>`).join(' ') : '<span class="faint">+ tag</span>'}</span></td><td class="mono faint">${plAgo(x.updated_at)}</td></tr>`).join('') || '<tr><td colspan="11" class="empty">No offers yet.</td></tr>'}</tbody></table></div>`);
}
function ofSet(k, v) { pl.of[k] = v; viewOffers(); }
function ofSearch(v) { plDebounce(() => { pl.of.q = v; viewOffers().then(() => plRefocus('ofq', v)); }); }
function offerTags(id) {
  const o = S.offerRows.find(x => x.id === id), cur = String(o.tags || '').split(',').map(x => x.trim()).filter(Boolean);
  openModal(`<h3>Offer tags</h3>${['Repriced Offer', 'Got Repriced'].map(t => `<label class="row" style="gap:8px;margin:6px 0"><input type="checkbox" class="otag" value="${t}" ${cur.includes(t) ? 'checked' : ''}> ${t}</label>`).join('')}
    <div class="mact"><button onclick="closeModal()">Cancel</button><button class="primary" onclick="offerTagsSave(${id})">Save</button></div>`);
}
async function offerTagsSave(id) { try { await api('/api/pilot/offers/' + id, { tags: [...document.querySelectorAll('.otag:checked')].map(c => c.value).join(', ') }, 'PATCH'); closeModal(); viewOffers(); } catch (e) { toast(e.message, true); } }

// ================= Attribution =================
async function viewAttribution(tab) {
  if (!isAdmin()) { V('<div class="empty" style="padding:40px">Attribution is for admins.</div>'); return; }
  tab = tab === 'sources' ? 'sources' : 'batches'; const tabs = `<div class="rptabs"><a href="#/attribution/batches" class="${tab === 'batches' ? 'act' : ''}">Batches</a><a href="#/attribution/sources" class="${tab === 'sources' ? 'act' : ''}">Sources</a></div>`;
  if (tab === 'sources') {
    const r = await api('/api/pilot/sources').catch(e => { toast(e.message, true); return null; }); if (!r || S.route !== 'attribution') return; S.srcRows = r.rows;
    V(`<div class="vtitle"><h1>Attribution</h1><button class="primary sm" style="margin-left:auto" onclick="sourceModal()">+ New source</button></div>${tabs}
      <div class="tablewrap"><table><thead><tr><th>Source</th><th>Vendor</th><th>Contact</th><th>Phone</th><th>Email</th><th>Website</th><th style="text-align:right">Leads</th><th style="text-align:right">Total cost</th><th>Last import</th></tr></thead><tbody>
      ${r.rows.map((x, i) => `<tr class="click" onclick="sourceModal(${i})"><td><b>${esc(x.name)}</b></td><td>${esc(x.vendor || '')}</td><td>${esc(x.contact || '')}</td><td>${esc(x.phone || '')}</td><td>${esc(x.email || '')}</td><td>${esc(x.website || '')}</td><td class="mono" style="text-align:right">${(x.leads || 0).toLocaleString()}</td><td class="mono" style="text-align:right">${plMoney(x.total_cost)}</td><td class="faint">${plDay(x.last_at)}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">No sources yet — they appear when you import leads.</td></tr>'}</tbody></table></div>`);
    return;
  }
  const r = await api('/api/pilot/batches').catch(e => { toast(e.message, true); return null; }); if (!r || S.route !== 'attribution') return; S.batchRows = r.rows; S.batchSources = r.sources;
  const sum = k => r.rows.reduce((a, x) => a + (x[k] || 0), 0);
  V(`<div class="vtitle"><h1>Attribution</h1><div class="row" style="margin-left:auto;gap:8px"><a class="sm button" href="/api/pilot/export/batches">Export CSV</a><button class="primary sm" onclick="batchModal()">+ New batch</button></div></div>${tabs}
    <div class="kpis"><div class="kpi"><b>${r.rows.length}</b><span>Batches</span></div><div class="kpi"><b>${plMoney(sum('price'))}</b><span>Spent on leads</span></div><div class="kpi"><b>${sum('funded')}</b><span>Funded deals</span></div><div class="kpi"><b>${plMoney(sum('revenue'))}</b><span>Revenue</span></div><div class="kpi"><b style="color:${sum('revenue') - sum('price') >= 0 ? 'var(--green)' : 'var(--red)'}">${plMoney(sum('revenue') - sum('price'))}</b><span>Profit</span></div></div>
    <div class="tablewrap"><table><thead><tr><th>Batch</th><th>Source</th><th style="text-align:right">Price</th><th style="text-align:right">Count</th><th style="text-align:right">$/lead</th><th style="text-align:right">Leads in CRM</th><th style="text-align:right">Worked</th><th style="text-align:right">Deals</th><th style="text-align:right">Funded</th><th style="text-align:right">Revenue</th><th style="text-align:right">Profit</th><th style="text-align:right">ROI</th></tr></thead><tbody>
    ${r.rows.map((x, i) => `<tr class="click" onclick="batchModal(${i})"><td><b>${esc(x.name)}</b><div class="faint" style="font-size:11px">${plDay(x.created_at)}</div></td><td>${esc(x.source || '')}</td><td class="mono" style="text-align:right">${plMoney(x.price)}</td><td class="mono" style="text-align:right">${x.count ? x.count.toLocaleString() : '—'}</td><td class="mono" style="text-align:right">${x.per_lead != null ? '$' + x.per_lead.toFixed(2) : '—'}</td>
      <td class="mono" style="text-align:right">${x.leads.toLocaleString()}</td><td class="mono" style="text-align:right">${x.worked.toLocaleString()}</td><td class="mono" style="text-align:right">${x.deals}</td><td class="mono" style="text-align:right">${x.funded}</td><td class="mono" style="text-align:right">${plMoney(x.revenue)}</td>
      <td class="mono" style="text-align:right;color:${(x.profit || 0) >= 0 ? 'var(--green)' : 'var(--red)'}">${x.profit != null ? plMoney(x.profit) : '—'}</td><td class="mono" style="text-align:right">${x.roi != null ? x.roi + '%' : '—'}</td></tr>`).join('') || '<tr><td colspan="12" class="empty">No batches yet. Add one here, or type a batch name when you import a lead list.</td></tr>'}</tbody></table></div>`);
}
function sourceModal(i) {
  const x = i == null ? {} : S.srcRows[i];
  openModal(`<h3>${i == null ? 'New' : 'Edit'} source</h3><div class="grid2">${plIn('sr_name', 'Name', x.name, 'text', '', i == null ? '' : 'disabled')}${plIn('sr_vendor', 'Vendor', x.vendor)}${plIn('sr_contact', 'Contact', x.contact)}${plIn('sr_phone', 'Phone', x.phone)}${plIn('sr_email', 'Email', x.email)}${plIn('sr_website', 'Website', x.website)}${plIn('sr_cost', 'Total cost', x.total_cost, 'number')}</div>
    <div class="mact"><button onclick="closeModal()">Cancel</button><button class="primary" onclick="sourceSave()">Save</button></div>`);
}
async function sourceSave() { try { await api('/api/pilot/sources', { name: $('#sr_name').value, vendor: $('#sr_vendor').value, contact: $('#sr_contact').value, phone: $('#sr_phone').value, email: $('#sr_email').value, website: $('#sr_website').value, total_cost: $('#sr_cost').value }, 'PATCH'); closeModal(); viewAttribution('sources'); } catch (e) { toast(e.message, true); } }
function batchModal(i) {
  const x = i == null ? {} : S.batchRows[i];
  openModal(`<h3>${i == null ? 'New' : 'Edit'} batch</h3>${plIn('bt_name', 'Batch name', x.name, 'text', 'e.g. Lead Tycoons 5/18 aged 33k', i == null ? '' : 'disabled')}<div class="grid2">
    <div class="mf"><label>Source</label><input id="bt_source" list="btSrc" value="${esc(x.source || '')}"><datalist id="btSrc">${(S.batchSources || []).map(s => `<option>${esc(s)}</option>`).join('')}</datalist></div>${plIn('bt_vendor', 'Vendor', x.vendor)}${plIn('bt_price', 'Price paid', x.price, 'number')}${plIn('bt_count', 'Number of leads', x.count, 'number')}</div>
    <div class="faint" style="font-size:12px;margin-bottom:8px">Leads link to a batch by name when you import them — type the same batch name on the import screen.</div>
    <div class="mact" style="justify-content:space-between">${i == null ? '<span></span>' : `<button class="danger" onclick="batchDel(${x.id})">Delete</button>`}<div class="row"><button onclick="closeModal()">Cancel</button><button class="primary" onclick="batchSave(${i == null ? 0 : x.id})">Save</button></div></div>`);
}
async function batchSave(id) { const b = { name: $('#bt_name').value, source: $('#bt_source').value, vendor: $('#bt_vendor').value, price: $('#bt_price').value, count: $('#bt_count').value }; try { await api(id ? '/api/pilot/batches/' + id : '/api/pilot/batches', b, id ? 'PATCH' : 'POST'); closeModal(); viewAttribution('batches'); } catch (e) { toast(e.message, true); } }
async function batchDel(id) { if (!confirm('Delete this batch record? Your leads are not deleted.')) return; try { await api('/api/pilot/batches/' + id, undefined, 'DELETE'); closeModal(); viewAttribution('batches'); } catch (e) { toast(e.message, true); } }

// ================= Pilot setup (workflows, permissions, auto-submit, templates, statuses) =================
async function viewPilot(tab) {
  if (!isAdmin()) { V('<div class="empty" style="padding:40px">Pilot setup is for admins.</div>'); return; }
  const tabs = [['workflows', 'Workflows'], ['permissions', 'Permissions'], ['automation', 'Auto-submit & passes'], ['templates', 'Funder requests'], ['statuses', 'Deal statuses']];
  tab = tabs.some(t => t[0] === tab) ? tab : 'workflows';
  const head = `<div class="vtitle"><h1>Pilot setup</h1><span class="muted">Statuses, automations and who can do what</span></div><div class="rptabs">${tabs.map(([k, l]) => `<a href="#/pilot/${k}" class="${k === tab ? 'act' : ''}">${l}</a>`).join('')}</div>`;
  try {
    if (tab === 'workflows') {
      const r = await api('/api/pilot/workflows'); if (S.route !== 'pilot') return; S.wf = r;
      const tl = Object.fromEntries(r.triggers), al = Object.fromEntries(r.actions);
      V(head + `<div class="row" style="margin-bottom:10px"><span class="muted">When something happens on a deal, do something automatically.</span><button class="primary sm" style="margin-left:auto" onclick="wfModal()">+ New workflow</button></div>
        <div class="tablewrap"><table><thead><tr><th>On</th><th>Name</th><th>When</th><th>Then</th><th style="text-align:right">Runs</th><th>Last run</th><th>Active</th></tr></thead><tbody>
        ${r.rows.map((w, i) => `<tr class="click" onclick="wfModal(${i})"><td>${esc(tl[w.trigger] || w.trigger)}</td><td><b>${esc(w.name)}</b></td><td class="muted">${w.cond.status ? 'status = ' + esc(w.cond.status) : 'always'}</td><td>${esc(al[w.action] || w.action)}<div class="faint" style="font-size:11px">${esc(w.params.description || w.params.status || w.params.text || '')}</div></td><td class="mono" style="text-align:right">${w.runs}</td><td class="faint">${w.last_run ? plAgo(w.last_run) + ' ago' : '—'}</td>
          <td onclick="event.stopPropagation()"><input type="checkbox" ${w.active ? 'checked' : ''} onchange="wfActive(${w.id},this.checked)"></td></tr>`).join('') || '<tr><td colspan="7" class="empty">No workflows yet. Example: when a deal becomes <b>Offer Accepted</b>, create a task "Request contracts".</td></tr>'}</tbody></table></div>`);
    } else if (tab === 'permissions') {
      const r = await api('/api/pilot/permissions'); if (S.route !== 'pilot') return; S.perm = r;
      V(head + `<div class="faint" style="margin-bottom:10px;font-size:12.5px">Everything is allowed by default. Untick to take a permission away from a person. Admins always have everything.</div>
        <div class="tablewrap"><table><thead><tr><th>Person</th><th>Manager</th><th>Team</th>${r.perms.map(p => `<th style="font-size:10px;max-width:90px;white-space:normal;line-height:1.2">${esc(p[1])}</th>`).join('')}</tr></thead><tbody>
        ${r.users.map(u => `<tr><td><b>${esc(u.name)}</b><div class="faint" style="font-size:11px">${esc(u.role)}</div></td>
          <td>${plSel('pm' + u.id, r.users.filter(x => x.id !== u.id).map(x => [x.id, x.name]), u.manager_id, '—', `permField(${u.id},'manager_id',this.value)`)}</td><td><input value="${esc(u.team || '')}" style="width:90px" onchange="permField(${u.id},'team',this.value)"></td>
          ${r.perms.map(p => `<td style="text-align:center"><input type="checkbox" ${u.role === 'admin' ? 'disabled checked' : u.permissions[p[0]] === false ? '' : 'checked'} onchange="permSet(${u.id},'${p[0]}',this.checked)"></td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else if (tab === 'automation') {
      const c = await api('/api/pilot/config'); if (S.route !== 'pilot') return; S.pcfg = c;
      V(head + `<div class="card" style="margin-bottom:14px;max-width:760px"><h3>Auto-submit</h3><div class="faint" style="font-size:12.5px;margin-bottom:10px">When a deal's signed application and required bank statements are in, it's emailed to the best-matching funders automatically — ranked by your funder criteria. Turn off per deal with "Skip auto-submit" on the deal.</div>
        <label class="row" style="gap:8px;margin-bottom:8px"><input type="checkbox" id="as_on" ${c.autosub.enabled ? 'checked' : ''}> Submit new, ready deals automatically</label>${plIn('as_max', 'Max funders per deal', c.autosub.max, 'number')}</div>
        <div class="card" style="max-width:760px"><h3>Passes (round-robin)</h3><div class="faint" style="font-size:12.5px;margin-bottom:10px">Deals that haven't moved in a while get handed to the next person in the pool, so nothing goes stale.</div>
        <label class="row" style="gap:8px;margin-bottom:8px"><input type="checkbox" id="ps_on" ${c.passes.enabled ? 'checked' : ''}> Pass stale deals automatically</label><div class="grid2">${plIn('ps_days', 'Pass after this many quiet days', c.passes.days, 'number')}${plIn('ps_max', 'Max passes per deal', c.passes.max_passes, 'number')}</div>
        <div class="mf"><label>People in the pool</label><div class="row wrap" style="gap:10px">${c.users.map(u => `<label class="row" style="gap:5px"><input type="checkbox" class="pspool" value="${u.id}" ${c.passes.pool.includes(u.id) ? 'checked' : ''}> ${esc(u.name)}</label>`).join('')}</div></div></div>
        <button class="primary" style="margin-top:14px" onclick="pilotCfgSave('automation')">Save</button>`);
    } else if (tab === 'templates') {
      const c = await api('/api/pilot/config'); if (S.route !== 'pilot') return; S.pcfg = c;
      const names = { contracts: 'Request contracts', bump: 'Request a bump', info: 'Send information' };
      V(head + `<div class="faint" style="margin-bottom:10px;font-size:12.5px">Emails sent to a funder from the deal page. Variables: {company_name} {funder} {user_name} {company} {note}</div>
        ${Object.keys(names).map(k => `<div class="card" style="margin-bottom:12px;max-width:760px"><h3>${names[k]}</h3>${plIn('tp_s_' + k, 'Subject', c.templates[k].subject)}<div class="mf"><label>Body</label><textarea id="tp_b_${k}" rows="6">${esc(c.templates[k].body)}</textarea></div></div>`).join('')}
        <button class="primary" onclick="pilotCfgSave('templates')">Save templates</button>`);
    } else {
      const c = await api('/api/pilot/config'); if (S.route !== 'pilot') return;
      const g = { open: 'Open', funded: 'Funded', closed: 'Closed' };
      V(head + `<div class="faint" style="margin-bottom:12px;font-size:12.5px">Every deal has one of these statuses. Changing it also moves the deal in the pipeline. You change it from the deal page; workflows can change it too.</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px">${Object.entries(g).map(([k, l]) => `<div class="card"><h3>${l}</h3>${c.statuses.filter(s => s.group === k).map(s => `<div class="row" style="padding:4px 0;font-size:13px"><span class="grow">${esc(s.status)}</span><span class="faint mono" style="font-size:10px">${esc((typeof STAGE_LABELS !== 'undefined' && STAGE_LABELS[s.stage]) || s.stage)}</span></div>`).join('')}</div>`).join('')}</div>`);
    }
  } catch (e) { toast(e.message, true); }
}
async function pilotCfgSave(tab) {
  try {
    const body = tab === 'automation' ? { autosub: { enabled: $('#as_on').checked, max: $('#as_max').value }, passes: { enabled: $('#ps_on').checked, days: $('#ps_days').value, max_passes: $('#ps_max').value, pool: [...document.querySelectorAll('.pspool:checked')].map(c => Number(c.value)) } }
      : { templates: Object.fromEntries(['contracts', 'bump', 'info'].map(k => [k, { subject: $('#tp_s_' + k).value, body: $('#tp_b_' + k).value }])) };
    await api('/api/pilot/config', body, 'PUT'); toast('Saved');
  } catch (e) { toast(e.message, true); }
}
async function permSet(id, key, on) { const u = S.perm.users.find(x => x.id === id); if (on) delete u.permissions[key]; else u.permissions[key] = false; try { await api('/api/pilot/permissions/' + id, { permissions: u.permissions }, 'PUT'); } catch (e) { toast(e.message, true); } }
async function permField(id, k, v) { try { await api('/api/pilot/permissions/' + id, { [k]: v }, 'PUT'); } catch (e) { toast(e.message, true); } }
async function wfActive(id, on) { try { await api('/api/pilot/workflows/' + id, { active: on }, 'PATCH'); } catch (e) { toast(e.message, true); } }
function wfModal(i) {
  const r = S.wf, w = i == null ? { trigger: 'status_changed', action: 'create_task', cond: {}, params: { assign: 'owner', due_days: 1 } } : r.rows[i];
  openModal(`<h3>${i == null ? 'New' : 'Edit'} workflow</h3>${plIn('wf_name', 'Name', w.name, 'text', 'e.g. Chase signature after contracts sent')}
    <div class="grid2"><div class="mf"><label>When this happens</label>${plSel('wf_trig', r.triggers, w.trigger, null, '')}</div><div class="mf"><label>…and the status is (optional)</label>${plSel('wf_cond', r.statuses, w.cond.status || '', 'Any status', '')}</div></div>
    <div class="mf"><label>Do this</label>${plSel('wf_act', r.actions, w.action, null, 'wfAct()')}</div><div id="wfParams"></div>
    <div class="faint" style="font-size:11.5px;margin-bottom:6px">Use {company_name} and {status} in text.</div>
    <div class="mact" style="justify-content:space-between">${i == null ? '<span></span>' : `<button class="danger" onclick="wfDel(${w.id})">Delete</button>`}<div class="row"><button onclick="closeModal()">Cancel</button><button class="primary" onclick="wfSave(${i == null ? 0 : w.id})">Save</button></div></div>`, true);
  S.wfCur = w; wfAct();
}
function wfAct() {
  const a = $('#wf_act').value, p = (S.wfCur && S.wfCur.action === a ? S.wfCur.params : {}) || {}, r = S.wf;
  $('#wfParams').innerHTML = a === 'create_task' ? plIn('wp_desc', 'Task description', p.description) + `<div class="grid2"><div class="mf"><label>Assign to</label>${plSel('wp_assign', r.users.map(u => [u.id, u.name]), p.assign === 'owner' ? '' : p.assign, 'Deal owner', '')}</div>${plIn('wp_due', 'Due in (days)', p.due_days ?? 1, 'number')}</div>${plIn('wp_type', 'Task type', p.type || 'workflow')}`
    : a === 'set_status' ? `<div class="mf"><label>New status</label>${plSel('wp_status', r.statuses, p.status, null, '')}</div>` : plIn('wp_text', a === 'notify' ? 'Message' : 'Note', p.text);
}
async function wfSave(id) {
  const a = $('#wf_act').value, params = a === 'create_task' ? { description: $('#wp_desc').value, assign: $('#wp_assign').value || 'owner', due_days: $('#wp_due').value, type: $('#wp_type').value } : a === 'set_status' ? { status: $('#wp_status').value } : { text: $('#wp_text').value };
  const b = { name: $('#wf_name').value, trigger: $('#wf_trig').value, cond: { status: $('#wf_cond').value || undefined }, action: a, params };
  try { await api(id ? '/api/pilot/workflows/' + id : '/api/pilot/workflows', b, id ? 'PATCH' : 'POST'); closeModal(); viewPilot('workflows'); } catch (e) { toast(e.message, true); }
}
async function wfDel(id) { if (!confirm('Delete this workflow?')) return; try { await api('/api/pilot/workflows/' + id, undefined, 'DELETE'); closeModal(); viewPilot('workflows'); } catch (e) { toast(e.message, true); } }

// ================= Deal page: status + underwriting box =================
async function loadPilotBox(r) {
  const box = $('#pilotBox'); if (!box) return; S.pilotDeal = r.deal.id;
  const b = await api('/api/pilot/deals/' + r.deal.id).catch(() => null); if (!b || !$('#pilotBox')) return; S.pb = b;
  plRenderBox();
}
const plReloadDealBox = () => { if (S.pilotDeal && $('#pilotBox')) api('/api/pilot/deals/' + S.pilotDeal).then(b => { S.pb = b; plRenderBox(); }).catch(() => {}); };
function plRenderBox() {
  const b = S.pb, box = $('#pilotBox'); if (!box || !b) return; const tab = pl.tab, m = b.metrics, open = b.tasks.filter(t => t.status === 'open').length;
  const T = [['underwrite', 'Underwrite'], ['funders', `Funders (${b.qualified.length})`], ['details', 'Details'], ['tasks', `Tasks${open ? ' (' + open + ')' : ''}`], ['history', 'History']];
  const groups = { open: 'In progress', funded: 'Funded', closed: 'Closed' };
  box.innerHTML = `<div class="card"><div class="row wrap" style="gap:10px;margin-bottom:10px"><h3 style="margin:0">Pipeline status</h3>
      <select onchange="plSetStatus(this.value)" style="min-width:210px">${Object.entries(groups).map(([g, l]) => `<optgroup label="${l}">${b.statuses.filter(s => s.group === g).map(s => `<option ${s.status === b.status ? 'selected' : ''}>${esc(s.status)}</option>`).join('')}</optgroup>`).join('')}</select>
      <button class="sm" style="margin-left:auto" onclick="taskModal(${b.id})">+ Task</button></div>
    <div class="tabs" style="margin-bottom:12px">${T.map(([k, l]) => `<button class="${tab === k ? 'act' : ''}" onclick="pl.tab='${k}';plRenderBox()">${l}</button>`).join('')}</div>
    <div id="plBody">${plTab(tab, b, m)}</div></div>`;
}
function plTab(tab, b, m) {
  if (tab === 'underwrite') {
    const cell = (v, f) => v == null ? '<span class="faint">—</span>' : f === 'm' ? plMoney(v) : plNum(v);
    const cols = [['revenue', 'Revenue', 'm'], ['deposits', 'Deposits', 'm'], ['neg_days', 'Neg days', 'n'], ['low_days', 'Low days', 'n'], ['adb', 'ADB', 'm'], ['open_bal', 'Opening', 'm'], ['close_bal', 'Closing', 'm'], ['nsf', 'NSFs', 'n']];
    return `<div class="kpis" style="grid-template-columns:repeat(auto-fill,minmax(120px,1fr))"><div class="kpi"><b>${plMoney(m.avg.deposits)}</b><span>Avg deposits</span></div><div class="kpi"><b>${plMoney(m.avg.revenue)}</b><span>Avg revenue</span></div><div class="kpi"><b>${plMoney(m.avg.adb)}</b><span>Avg daily bal.</span></div><div class="kpi"><b>${m.avg.nsf ?? '—'}</b><span>Avg NSFs</span></div>
      <div class="kpi"><b>${m.positions}</b><span>Open positions</span></div><div class="kpi"><b>${plMoney(m.total_pulls)}</b><span>Pulls / month</span></div><div class="kpi"><b>${m.holdback_pct != null ? m.holdback_pct + '%' : '—'}</b><span>Holdback</span></div></div>
    <div class="row" style="margin:6px 0"><b style="font-size:12px">Bank statements</b>${S.dealData && S.dealData.deal.stmt ? '<button class="sm" style="margin-left:auto" onclick="plImportAI()">Import from statement reader</button>' : ''}</div>
    <div class="tablewrap"><table><thead><tr><th>Month</th><th>Account</th>${cols.map(c => `<th style="text-align:right">${c[1]}</th>`).join('')}<th></th></tr></thead><tbody>
      ${b.statements.map(s => `<tr><td class="mono">${esc(s.month)}</td><td class="faint">${esc(s.account || '')}</td>${cols.map(c => `<td class="mono" style="text-align:right">${cell(s[c[0]], c[2])}</td>`).join('')}<td><button class="sm" onclick="plDelStmt(${s.id})">✕</button></td></tr>`).join('')}
      ${b.statements.length ? `<tr style="background:var(--panel2)"><td><b>Average</b></td><td></td>${cols.map(c => `<td class="mono" style="text-align:right"><b>${cell(m.avg[c[0]], c[2])}</b></td>`).join('')}<td></td></tr><tr style="background:var(--panel2)"><td><b>Worst month</b></td><td></td>${cols.map(c => `<td class="mono" style="text-align:right">${cell(m.worst[c[0]], c[2])}</td>`).join('')}<td></td></tr>` : `<tr><td colspan="${cols.length + 3}" class="empty">No statements entered yet.</td></tr>`}
      <tr><td><input id="st_month" type="month" style="width:120px"></td><td><input id="st_account" placeholder="acct" style="width:60px"></td>${cols.map(c => `<td><input id="st_${c[0]}" type="number" step="any" style="width:80px"></td>`).join('')}<td><button class="sm primary" onclick="plAddStmt()">Add</button></td></tr></tbody></table></div>
    <div class="row" style="margin:14px 0 6px"><b style="font-size:12px">Existing positions</b></div>
    <div class="tablewrap"><table><thead><tr><th>Funder</th><th style="text-align:right">Payment</th><th>Frequency</th><th>Status</th><th style="text-align:right">Funded</th><th></th></tr></thead><tbody>
      ${b.positions.map(p => `<tr><td>${esc(p.funder)}</td><td class="mono" style="text-align:right">${plMoney(p.payment)}</td><td>${esc(p.frequency)}</td><td><span class="badge ${/paid|closed/i.test(p.status) ? 'good' : ''}">${esc(p.status)}</span></td><td class="mono" style="text-align:right">${plMoney(p.funded_amount)}</td><td><button class="sm" onclick="plDelPos(${p.id})">✕</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty">No positions.</td></tr>'}
      <tr><td><input id="ps_funder" placeholder="Funder" style="width:130px"></td><td><input id="ps_pay" type="number" step="any" style="width:80px"></td><td>${plSel('ps_freq', ['daily', 'weekly', 'biweekly', 'monthly'], 'daily', null, '')}</td><td>${plSel('ps_stat', ['Active', 'Paid off', 'Defaulted'], 'Active', null, '')}</td><td><input id="ps_amt" type="number" step="any" style="width:90px"></td><td><button class="sm primary" onclick="plAddPos()">Add</button></td></tr></tbody></table></div>`;
  }
  if (tab === 'funders') {
    const f = b.facts, can = b.requests.can_submit;
    const row = x => `<tr><td style="width:26px">${x.ok && x.email && !x.in_house && !x.submitted ? `<input type="checkbox" class="plpick" value="${x.id}" ${x.ok ? 'checked' : ''}>` : ''}</td><td class="mono faint">${x.rank ?? ''}</td><td><b>${esc(x.name)}</b>${x.preferred ? ' <span title="Prefers this industry" style="color:var(--amber)">★</span>' : ''}${x.in_house ? ' <span class="badge">in-house</span>' : ''}</td><td>${esc(x.grade || '')}</td><td class="faint">${esc(x.tags || '')}</td>
      <td class="mono" style="text-align:right">${plMoney(x.max_amount)}</td><td class="mono" style="text-align:right">${x.max_term_days ? x.max_term_days + 'd' : '—'}</td><td>${x.submitted ? `<span class="badge ${/approved|funded/.test(x.submitted) ? 'good' : ''}">${esc(x.submitted.replace('_', ' '))}</span> <button class="sm" onclick="plRequest('contracts',${x.id},'${esc(x.name).replace(/'/g, "\\'")}')">Contracts</button> <button class="sm" onclick="plRequest('bump',${x.id},'${esc(x.name).replace(/'/g, "\\'")}')">Bump</button>` : ''}${x.ok ? (x.unknown.length ? `<span class="faint" style="font-size:11px" title="Not enough data to check">? ${esc(x.unknown.slice(0, 2).join(', '))}</span>` : '') : `<span style="color:var(--red);font-size:11.5px">${esc(x.fail.join(' · '))}</span>`}</td></tr>`;
    return `<div class="faint" style="font-size:12px;margin-bottom:8px">Matched on revenue ${plMoney(f.revenue)} · ${f.tib != null ? f.tib + ' mo in business' : 'time in business unknown'} · credit ${f.fico ?? '?'} · ${f.positions ?? '?'} positions · ${f.state || '?'} · ${esc(f.industry || 'industry unknown')}</div>
      <div class="row wrap" style="gap:8px;margin-bottom:8px"><b>${b.qualified.length} qualified</b><span class="faint">of ${b.qualified.length + b.unqualified.length}</span><span style="margin-left:auto"></span>
        ${can ? `<button class="sm" onclick="plSubmitPicked()">Submit to selected</button><button class="sm primary" onclick="plAutoSub()">Auto-submit best matches</button>` : ''}</div>
      <div class="tablewrap"><table><thead><tr><th></th><th>#</th><th>Funder</th><th>Grade</th><th>Tags</th><th style="text-align:right">Max fund</th><th style="text-align:right">Max term</th><th>Status</th></tr></thead><tbody>${b.qualified.map(row).join('') || '<tr><td colspan="8" class="empty">No funder matches yet — add statements and complete the application.</td></tr>'}</tbody></table></div>
      ${b.unqualified.length ? `<details style="margin-top:10px"><summary class="muted" style="cursor:pointer">${b.unqualified.length} not qualified — why</summary><div class="tablewrap" style="margin-top:6px"><table><tbody>${b.unqualified.map(row).join('')}</tbody></table></div></details>` : ''}`;
  }
  if (tab === 'details') {
    const d = b.details;
    return `<div class="grid2"><div class="mf"><label>Legal structure</label>${plSel('dt_legal', PL_LEGAL, d.legal_structure, '—', '')}</div><div class="mf"><label>Default status</label>${plSel('dt_def', PL_DEFAULT, d.default_status, '—', '')}</div>
      ${plIn('dt_products', 'Products sought', d.products, 'text', 'e.g. Working Capital, Consolidation')}${plIn('dt_channel', 'Channel', d.channel)}${plIn('dt_excl', 'Exclusion tag', d.exclusion_tag)}${plIn('dt_batch', 'Batch', d.batch)}</div>
      <div class="faint" style="font-size:12px;margin-bottom:10px">Source: <b>${esc(d.source || '—')}</b>${d.pass_count ? ` · passed ${d.pass_count}×` : ''}</div>
      <label class="row" style="gap:8px;margin:6px 0"><input type="checkbox" id="dt_unsub" ${d.unsubscribe ? 'checked' : ''}> Unsubscribed — stop automated follow-ups to this merchant</label>
      <label class="row" style="gap:8px;margin:6px 0"><input type="checkbox" id="dt_skip" ${d.skip_autosub ? 'checked' : ''}> Skip auto-submit for this deal</label>
      <div class="row" style="margin:12px 0 6px"><b style="font-size:12px">Owners</b><button class="sm" style="margin-left:auto" onclick="plOwnerRow()">+ Owner</button></div><div id="dtOwners">${(d.owners.length ? d.owners : [{}]).map(plOwnerHtml).join('')}</div>
      <button class="primary sm" style="margin-top:10px" onclick="plSaveDetails()">Save details</button>`;
  }
  if (tab === 'tasks') return `<div class="tablewrap"><table><tbody>${b.tasks.map(t => `<tr style="${t.status === 'done' ? 'opacity:.5' : ''}"><td style="width:30px"><input type="checkbox" ${t.status === 'done' ? 'checked' : ''} onchange="tkDone(${t.id},this.checked)"></td><td><span class="badge">${esc(t.type)}</span></td><td>${esc(t.description)}</td><td class="muted">${esc(t.assigned_name || '')}</td><td>${t.status === 'done' ? '' : plDue(t.due_at)}</td></tr>`).join('') || '<tr><td class="empty">No tasks on this deal.</td></tr>'}</tbody></table></div>`;
  return `<div class="tablewrap"><table><thead><tr><th>When</th><th>Change</th><th>By</th></tr></thead><tbody>${b.history.map(h => `<tr><td class="mono faint">${fmtTime(h.at)}</td><td>${h.type === 'status' ? `${esc(h.prev || '—')} → <b>${esc(h.next)}</b>${h.reason ? ` <span class="faint">(${esc(h.reason)})</span>` : ''}` : esc(h.text)}</td><td class="muted">${esc(h.by)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">No changes yet.</td></tr>'}</tbody></table></div>`;
}
const plOwnerHtml = o => `<div class="row plown" style="gap:6px;margin-bottom:6px"><input placeholder="Name" value="${esc(o.name || '')}" style="flex:2"><input type="number" placeholder="%" value="${esc(o.pct ?? '')}" style="width:70px"><input placeholder="Email" value="${esc(o.email || '')}" style="flex:2"><input placeholder="Phone" value="${esc(o.phone || '')}" style="flex:1"><button class="sm" onclick="this.parentNode.remove()">✕</button></div>`;
function plOwnerRow() { $('#dtOwners').insertAdjacentHTML('beforeend', plOwnerHtml({})); }
async function plSaveDetails() {
  const owners = [...document.querySelectorAll('.plown')].map(r => { const i = r.querySelectorAll('input'); return { name: i[0].value, pct: i[1].value, email: i[2].value, phone: i[3].value }; }).filter(o => o.name);
  try { await api(`/api/pilot/deals/${S.pilotDeal}/details`, { legal_structure: $('#dt_legal').value, default_status: $('#dt_def').value, products: $('#dt_products').value, channel: $('#dt_channel').value, exclusion_tag: $('#dt_excl').value, batch: $('#dt_batch').value, unsubscribe: $('#dt_unsub').checked, skip_autosub: $('#dt_skip').checked, owners }, 'PATCH'); toast('Saved'); plReloadDealBox(); } catch (e) { toast(e.message, true); }
}
async function plSetStatus(v) { try { await api(`/api/pilot/deals/${S.pilotDeal}/status`, { status: v }); toast('Status: ' + v); route(); } catch (e) { toast(e.message, true); plReloadDealBox(); } }
async function plAddStmt() {
  const b = { month: $('#st_month').value, account: $('#st_account').value }; for (const k of ['revenue', 'deposits', 'neg_days', 'low_days', 'adb', 'open_bal', 'close_bal', 'nsf']) b[k] = $('#st_' + k).value;
  try { await api(`/api/pilot/deals/${S.pilotDeal}/statements`, b); plReloadDealBox(); } catch (e) { toast(e.message, true); }
}
async function plDelStmt(id) { try { await api(`/api/pilot/deals/${S.pilotDeal}/statements/${id}`, undefined, 'DELETE'); plReloadDealBox(); } catch (e) { toast(e.message, true); } }
async function plImportAI() { try { const r = await api(`/api/pilot/deals/${S.pilotDeal}/statements/import-ai`, {}); toast(`Imported ${r.statements} months, ${r.positions} positions`); plReloadDealBox(); } catch (e) { toast(e.message, true); } }
async function plAddPos() { try { await api(`/api/pilot/deals/${S.pilotDeal}/positions`, { funder: $('#ps_funder').value, payment: $('#ps_pay').value, frequency: $('#ps_freq').value, status: $('#ps_stat').value, funded_amount: $('#ps_amt').value }); plReloadDealBox(); } catch (e) { toast(e.message, true); } }
async function plDelPos(id) { try { await api(`/api/pilot/deals/${S.pilotDeal}/positions/${id}`, undefined, 'DELETE'); plReloadDealBox(); } catch (e) { toast(e.message, true); } }
async function plSubmitPicked() {
  const ids = [...document.querySelectorAll('.plpick:checked')].map(c => Number(c.value)); if (!ids.length) return toast('Tick at least one funder', true);
  if (!confirm(`Email this deal to ${ids.length} funder${ids.length === 1 ? '' : 's'}?`)) return;
  try { const r = await api(`/api/deals/${S.pilotDeal}/submit`, { lender_ids: ids }); const bad = r.results.filter(x => !x.ok); toast(`Sent to ${r.results.length - bad.length}${bad.length ? `, ${bad.length} failed: ${bad[0].error}` : ''}`, !!bad.length); route(); } catch (e) { toast(e.message, true); }
}
async function plAutoSub() {
  try { const p = await api(`/api/pilot/deals/${S.pilotDeal}/autosub`, { dry: true }); if (!confirm(`Email this deal to ${p.funders.length} funders?\n\n${p.funders.join(', ')}`)) return; const r = await api(`/api/pilot/deals/${S.pilotDeal}/autosub`, {}); toast(`Sent to ${r.results.filter(x => x.ok).length} funders`); route(); } catch (e) { toast(e.message, true); }
}
function plRequest(kind, lid, name) {
  openModal(`<h3>${kind === 'contracts' ? 'Request contracts from' : 'Ask for a bump from'} ${esc(name)}</h3><div class="faint" style="font-size:12px;margin-bottom:8px">Sends your saved template to the funder${kind === 'contracts' ? " (their contracts email if set)" : ''}. Add a note if you like.</div>
    <div class="mf"><label>Note (optional)</label><textarea id="rq_note" rows="3"></textarea></div><div class="mact"><button onclick="closeModal()">Cancel</button><button class="primary" onclick="plRequestSend('${kind}',${lid})">Send email</button></div>`);
}
async function plRequestSend(kind, lid) { try { const r = await api(`/api/pilot/deals/${S.pilotDeal}/request`, { kind, lender_id: lid, note: $('#rq_note').value }); closeModal(); toast('Sent to ' + r.to); route(); } catch (e) { toast(e.message, true); } }

// ================= Funder criteria modal (from the Lenders page) =================
async function funderModal(id) {
  const r = await api('/api/pilot/lenders/' + id).catch(e => { toast(e.message, true); return null; }); if (!r) return; const L = r.lender, m = r.metrics, rules = L.stmt_rules || {}; S.fm = { id, tab: 'criteria' };
  openModal(`<h3>${esc(L.name)}</h3><div class="tabs" style="margin-bottom:12px">${[['criteria', 'Criteria'], ['method', 'Submission'], ['metrics', 'Metrics']].map(([k, l]) => `<button class="${k === 'criteria' ? 'act' : ''}" data-fm="${k}" onclick="fmTab('${k}')">${l}</button>`).join('')}</div>
    <div id="fm_criteria"><div class="grid2">${plIn('fm_paper_grade', 'Paper grade', L.paper_grade, 'text', 'A, B, C…')}${plIn('fm_rank', 'Rank (1 = first choice)', L.rank, 'number')}${plIn('fm_tags', 'Tags', L.tags, 'text', 'comma separated')}${plIn('fm_products', 'Products they offer', L.products, 'text', 'Working Capital, Consolidation…')}
      ${plIn('fm_preferred_industries', 'Preferred industries', L.preferred_industries, 'text', 'e.g. restaurant, retail')}${plIn('fm_restricted_legal', 'Legal structures they don\'t fund', L.restricted_legal, 'text', 'e.g. sole proprietorship')}
      ${plIn('fm_default_ok', 'Default statuses accepted', L.default_ok, 'text', 'Clean File, Satisfied Default (blank = any)')}${plIn('fm_min_positions', 'Min existing positions', L.min_positions, 'number')}${plIn('fm_max_term_days', 'Max term (days)', L.max_term_days, 'number')}${plIn('fm_max_commission_pct', 'Max commission %', L.max_commission_pct, 'number')}</div>
      <div class="row" style="margin:6px 0"><b style="font-size:12px">Bank statement rules</b><span class="faint" style="font-size:11px">blank = no rule</span><button class="sm" style="margin-left:auto" onclick="lenderModal(${id})">Basic terms (revenue, TIB, FICO, states…) ›</button></div>
      <table style="width:100%"><thead><tr><th></th><th>Average</th><th>Worst month</th></tr></thead><tbody>${PL_METRICS.map(([k, l, mm]) => `<tr><td>${l} <span class="faint" style="font-size:10px">${mm}</span></td><td><input id="fm_a_${k}" type="number" step="any" value="${esc((rules.avg || {})[k] ?? '')}" style="width:100px"></td><td><input id="fm_w_${k}" type="number" step="any" value="${esc((rules.worst || {})[k] ?? '')}" style="width:100px"></td></tr>`).join('')}</tbody></table></div>
    <div id="fm_method" class="hidden"><div class="faint" style="font-size:12.5px;margin-bottom:10px">How deals are emailed to ${esc(L.name)}. Main address: <b>${esc(L.email || 'not set')}</b>${L.cc ? ' · cc ' + esc(L.cc) : ''}.</div>${plIn('fm_subject_prefix', 'Subject line prefix', L.subject_prefix, 'text', 'e.g. [Brookestone]')}${plIn('fm_contract_email', 'Contract requests go to', L.contract_email, 'email', 'blank = main address')}${plIn('fm_bump_email', 'Bump requests go to', L.bump_email, 'email', 'blank = main address')}</div>
    <div id="fm_metrics" class="hidden"><div class="kpis" style="grid-template-columns:repeat(auto-fill,minmax(130px,1fr))"><div class="kpi"><b>${m.submissions}</b><span>Submissions</span></div><div class="kpi"><b>${m.approval_rate != null ? m.approval_rate + '%' : '—'}</b><span>Approval rate</span></div><div class="kpi"><b>${plMoney(m.total_approved)}</b><span>Total approved</span></div><div class="kpi"><b>${m.advances}</b><span>Advances</span></div><div class="kpi"><b>${plMoney(m.total_funded)}</b><span>Total funded</span></div><div class="kpi"><b>${plMoney(m.total_earned)}</b><span>Total earned</span></div><div class="kpi"><b>${plMoney(m.outstanding)}</b><span>Owed to you</span></div></div>
      <div class="tablewrap" style="max-height:260px"><table><thead><tr><th>Deal</th><th>Status</th><th style="text-align:right">Offer</th><th>Note</th></tr></thead><tbody>${r.submissions.map(s => `<tr class="click" onclick="closeModal();go('#/deal/${s.deal_id}')"><td>${esc(s.title || 'Deal ' + s.deal_id)}</td><td>${esc(s.status.replace('_', ' '))}</td><td class="mono" style="text-align:right">${plMoney(s.offer_amount)}</td><td class="faint" style="font-size:11.5px">${esc(s.decline_reason || s.ai_note || '')}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No submissions yet.</td></tr>'}</tbody></table></div></div>
    <div class="mact"><button onclick="closeModal()">Close</button><button class="primary" onclick="fmSave(${id})">Save</button></div>`, true);
}
function fmTab(k) { for (const t of ['criteria', 'method', 'metrics']) $('#fm_' + t).classList.toggle('hidden', t !== k); document.querySelectorAll('[data-fm]').forEach(b => b.classList.toggle('act', b.dataset.fm === k)); }
async function fmSave(id) {
  const b = {}; for (const k of ['paper_grade', 'rank', 'tags', 'products', 'preferred_industries', 'restricted_legal', 'default_ok', 'min_positions', 'max_term_days', 'max_commission_pct', 'subject_prefix', 'contract_email', 'bump_email']) b[k] = $('#fm_' + k).value;
  b.stmt_rules = { avg: {}, worst: {} }; for (const [k] of PL_METRICS) { b.stmt_rules.avg[k] = $('#fm_a_' + k).value; b.stmt_rules.worst[k] = $('#fm_w_' + k).value; }
  try { await api('/api/pilot/lenders/' + id, b, 'PATCH'); closeModal(); toast('Funder saved'); if (S.route === 'lenders') viewLenders(); } catch (e) { toast(e.message, true); }
}

