// Payments (funder -> house), Distributions (house -> reps), Advances ledger, and the per-deal split card
const mo = { pay: { status: '', type: '', funder: '', q: '', range: 'all' }, dist: { status: '', role: '', funder: '', recipient: '', q: '', range: 'all' }, adv: { status: '', funder: '', user: '', q: '', range: 'all' }, sel: new Set() };
const M_RANGES = [['all', 'All time'], ['month', 'This month'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['year', 'This year']];
const mMoney = v => v == null ? '—' : (v < 0 ? '−$' : '$') + Number(Math.abs(v)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const mDate = t => t ? new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const mRel = t => { if (!t) return '—'; const d = Math.round((new Date(t).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 864e5); return d === 0 ? 'Today' : d === -1 ? 'Yesterday' : d === 1 ? 'Tomorrow' : mDate(t); };
function mRange(r) {
  const d0 = new Date(); d0.setHours(0, 0, 0, 0); const t0 = d0.getTime(), day = 864e5;
  if (r === 'month') return { from: new Date(d0.getFullYear(), d0.getMonth(), 1).getTime() };
  if (r === 'year') return { from: new Date(d0.getFullYear(), 0, 1).getTime() };
  if (r === '30' || r === '90') return { from: t0 - (Number(r) - 1) * day };
  return {};
}
const mQuery = f => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(f)) if (v && k !== 'range') p.set(k, v); for (const [k, v] of Object.entries(mRange(f.range))) p.set(k, v); return p.toString(); };
const mSel = (key, id, opts, cur, all) => `<select onchange="mSet('${key}','${id}',this.value)"><option value="">${all}</option>${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
function mSet(key, id, v) { mo[key][id] = v; mo.sel.clear(); ({ pay: viewPayments, dist: viewDistributions, adv: viewAdvances })[key](); }
let mTimer; const mSearch = (key, v) => { clearTimeout(mTimer); mTimer = setTimeout(() => { mo[key].q = v; ({ pay: viewPayments, dist: viewDistributions, adv: viewAdvances })[key](); setTimeout(() => { const i = $('#mq'); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); } }, 50); }, 350); };
const mBar = (key, extra, exportKind) => `<div class="row wrap" style="gap:8px;margin-bottom:10px"><input id="mq" placeholder="Search merchant…" value="${esc(mo[key].q)}" oninput="mSearch('${key}',this.value)" style="width:200px">${extra}${mSel(key, 'range', M_RANGES, mo[key].range, 'All time').replace('<option value="">All time</option>', '').replace('<option value="all"', '<option value="all"')}
  ${exportKind && isAdmin() ? `<a class="sm button" style="margin-left:auto" href="/api/export/${exportKind}?${mQuery(mo[key])}">Export CSV</a>` : ''}</div>`;
const mBadge = (s, good) => `<span class="badge ${good.includes(s) ? 'good' : ''}">${esc(s)}</span>`;
function mTable(cols, rows, sums, selectable) {
  const all = selectable && rows.length && rows.every(r => mo.sel.has(r.id));
  return `<div class="tablewrap"><table><thead><tr>${selectable ? `<th style="width:30px"><input type="checkbox" ${all ? 'checked' : ''} onchange="mAll(this.checked)"></th>` : ''}${cols.map(c => `<th style="${c.r ? 'text-align:right' : ''}">${c.h}</th>`).join('')}</tr></thead><tbody>
    ${rows.map(r => `<tr>${selectable ? `<td><input type="checkbox" ${mo.sel.has(r.id) ? 'checked' : ''} onchange="mPick(${r.id},this.checked)"></td>` : ''}${cols.map(c => `<td style="${c.r ? 'text-align:right;font-family:var(--mono);' : ''}">${c.f(r)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length + 1}" class="empty">Nothing here yet.</td></tr>`}</tbody>
    ${sums ? `<tfoot><tr>${selectable ? '<td></td>' : ''}${cols.map(c => `<td style="${c.r ? 'text-align:right;' : ''}font-family:var(--mono);font-size:11.5px;color:var(--text2)">${sums[c.k] != null ? (c.sumLabel || 'SUM ') + mMoney(sums[c.k]) : ''}</td>`).join('')}</tr></tfoot>` : ''}</table></div>`;
}
let mRows = [];
function mPick(id, on) { on ? mo.sel.add(id) : mo.sel.delete(id); mBulk(); }
function mAll(on) { mRows.forEach(r => on ? mo.sel.add(r.id) : mo.sel.delete(r.id)); document.querySelectorAll('tbody input[type=checkbox]').forEach(c => c.checked = on); mBulk(); }
function mBulk() { const b = $('#mBulk'); if (!b) return; b.classList.toggle('hidden', !mo.sel.size); const n = $('#mBulkN'); if (n) n.textContent = mo.sel.size + ' selected'; }
const mBulkBar = (a, b) => `<div id="mBulk" class="row hidden" style="gap:8px;margin-bottom:8px;padding:8px 10px;background:var(--panel2);border-radius:8px"><b id="mBulkN"></b>${a}${b}</div>`;

// ---------------- Payments ----------------
async function viewPayments() {
  if (!isAdmin()) { V('<div class="empty" style="padding:40px">Payments are for admins.</div>'); return; }
  const f = mo.pay, r = await api('/api/money/payments?' + mQuery(f)).catch(e => { toast(e.message, true); return null; }); if (!r || S.route !== 'payments') return;
  mRows = r.rows;
  V(`<div class="vtitle"><h1>Payments</h1><span class="muted">What funders pay you on funded deals.</span><button class="sm" style="margin-left:auto" onclick="payModal()">+ Add payment</button></div>
    <div class="kpis"><div class="kpi"><b>${mMoney(r.sums.outstanding)}</b><span>Waiting on funders</span></div><div class="kpi"><b>${mMoney(r.sums.received)}</b><span>Received</span></div><div class="kpi"><b>${mMoney(r.sums.dist_out)}</b><span>Goes to reps / partners</span></div><div class="kpi"><b style="color:var(--green)">${mMoney(r.sums.profit)}</b><span>Profit to house</span></div></div>
    ${mBar('pay', mSel('pay', 'status', [['outstanding', 'Outstanding'], ['received', 'Received']], f.status, 'Any status') + mSel('pay', 'type', [['commission', 'Commission'], ['fee', 'Fee']], f.type, 'Any type') + mSel('pay', 'funder', r.funders.map(x => [x.id, x.name]), f.funder, 'All funders'), 'payments')}
    ${mBulkBar(`<button class="sm primary" onclick="payReceive(true)">Mark received</button>`, `<button class="sm" onclick="payReceive(false)">Mark not received</button>`)}
    ${mTable([{ h: 'Deal', f: x => `<a href="#/deal/${x.deal_id}">${esc(x.deal)}</a>` }, { h: 'Funder', f: x => esc(x.funder) }, { h: 'Type', f: x => `<span class="badge">${x.type}</span>` }, { h: 'Status', f: x => mBadge(x.status, ['received']) },
      { h: 'Funded', r: 1, k: 'funded_amount', f: x => mMoney(x.funded_amount) }, { h: 'Payment', r: 1, k: 'amount', f: x => `<a href="javascript:payEdit(${x.id},${x.amount})">${mMoney(x.amount)}</a>` }, { h: 'Dist out', r: 1, k: 'dist_out', f: x => mMoney(x.dist_out) }, { h: 'Profit to house', r: 1, k: 'profit', f: x => `<span style="color:${x.profit > 0 ? 'var(--green)' : 'inherit'}">${mMoney(x.profit)}</span>` },
      { h: 'Originator', f: x => esc(x.originator) }, { h: 'Closer', f: x => esc(x.closer) }, { h: 'Funded on', f: x => mDate(x.funded_at) }, { h: 'Expected', f: x => mRel(x.expected_on) }, { h: 'Received on', f: x => mDate(x.paid_on) }], r.rows, r.sums, true)}
    ${r.capped ? '<div class="faint" style="margin-top:6px">Showing the latest 1,000. Narrow the dates to see older ones.</div>' : ''}`);
  mBulk();
}
async function payReceive(got) { try { await api('/api/money/payments/receive', { ids: [...mo.sel], received: got }); mo.sel.clear(); toast('Updated'); viewPayments(); } catch (e) { toast(e.message, true); } }
async function payEdit(id, cur) { const v = prompt('Payment amount from the funder:', cur); if (v === null) return; try { await api('/api/money/payments/' + id, { amount: Number(v) }, 'PATCH'); toast('Saved — payouts recalculated'); viewPayments(); } catch (e) { toast(e.message, true); } }
function payModal(dealId) {
  openModal(`<h3>Add a funder payment</h3><div class="grid2"><div class="mf"><label>Deal ID</label><input id="pmDeal" type="number" value="${dealId || ''}"></div><div class="mf"><label>Type</label><select id="pmType"><option value="commission">Commission</option><option value="fee">Fee</option></select></div>
    <div class="mf"><label>Amount</label><input id="pmAmt" type="number" step="any"></div><div class="mf"><label>Expected on</label><input id="pmDate" type="date" value="${new Date(Date.now() + 864e5).toISOString().slice(0, 10)}"></div></div>
    <div class="faint" style="font-size:12px">Payouts to the originator, closer and partner are calculated from their splits automatically.</div><div class="mact"><button onclick="closeModal()">Cancel</button><button class="primary" onclick="paySave()">Add</button></div>`);
}
async function paySave() { try { await api('/api/money/payments', { deal_id: $('#pmDeal').value, type: $('#pmType').value, amount: $('#pmAmt').value, expected_on: new Date($('#pmDate').value + 'T12:00:00').getTime() }); closeModal(); toast('Added'); S.route === 'payments' ? viewPayments() : route(); } catch (e) { toast(e.message, true); } }

// ---------------- Distributions ----------------
async function viewDistributions() {
  const f = mo.dist, r = await api('/api/money/distributions?' + mQuery(f)).catch(e => { toast(e.message, true); return null; }); if (!r || S.route !== 'distributions') return;
  mRows = r.rows; const adm = isAdmin();
  V(`<div class="vtitle"><h1>${adm ? 'Distributions' : 'My payouts'}</h1><span class="muted">${adm ? 'What you owe your reps and partners out of each funder payment.' : 'Your share of each funded deal.'}</span></div>
    <div class="kpis"><div class="kpi"><b>${mMoney(r.sums.pending)}</b><span>${adm ? 'Still to pay out' : 'Coming to you'}</span></div><div class="kpi"><b>${mMoney(r.sums.paid)}</b><span>Paid out</span></div><div class="kpi"><b>${mMoney(r.sums.amount)}</b><span>Total in this view</span></div></div>
    ${mBar('dist', mSel('dist', 'status', [['pending', 'Pending'], ['paid', 'Paid']], f.status, 'Any status') + mSel('dist', 'role', [['originator', 'Originator'], ['closer', 'Closer'], ['iso', 'Partner']], f.role, 'Any role') + (adm ? mSel('dist', 'recipient', r.users.map(x => [x.id, x.name]), f.recipient, 'Everyone') : '') + mSel('dist', 'funder', r.funders.map(x => [x.id, x.name]), f.funder, 'All funders'), 'distributions')}
    ${adm ? mBulkBar(`<button class="sm primary" onclick="distPay(true)">Mark paid</button>`, `<button class="sm" onclick="distPay(false)">Mark unpaid</button>`) : ''}
    ${mTable([{ h: 'Deal', f: x => `<a href="#/deal/${x.deal_id}">${esc(x.deal)}</a>` }, { h: 'Funder', f: x => esc(x.funder) }, { h: 'Type', f: x => `<span class="badge">${x.type}</span>` }, { h: 'Role', f: x => ({ originator: 'Originator', closer: 'Closer', iso: 'Partner' })[x.role] },
      { h: 'Funded', r: 1, k: 'funded_amount', f: x => mMoney(x.funded_amount) }, { h: 'Payment', r: 1, k: 'payment_amount', f: x => mMoney(x.payment_amount) }, { h: 'Split', r: 1, f: x => x.split_pct != null ? Math.round(x.split_pct * 100) / 100 + '%' : '—' },
      { h: 'Payout', r: 1, k: 'amount', f: x => `<b>${mMoney(x.amount)}</b>` }, { h: 'Status', f: x => mBadge(x.status, ['paid']) + (x.status === 'pending' && x.funder_status === 'outstanding' ? ' <span class="faint" style="font-size:10px" title="The funder has not paid you for this deal yet">funder unpaid</span>' : '') },
      { h: 'Recipient', f: x => esc(x.recipient) }, { h: 'Funded on', f: x => mDate(x.funded_at) }, { h: 'Expected', f: x => mRel(x.expected_on) }, { h: 'Paid on', f: x => mDate(x.paid_on) }], r.rows, r.sums, adm)}
    ${r.capped ? '<div class="faint" style="margin-top:6px">Showing the latest 1,000. Narrow the dates to see older ones.</div>' : ''}`);
  mBulk();
}
async function distPay(paid) { try { await api('/api/money/distributions/pay', { ids: [...mo.sel], paid }); mo.sel.clear(); toast(paid ? 'Marked paid' : 'Marked unpaid'); viewDistributions(); } catch (e) { toast(e.message, true); } }

// ---------------- Advances ----------------
async function viewAdvances() {
  const f = mo.adv, r = await api('/api/money/advances?' + mQuery(f)).catch(e => { toast(e.message, true); return null; }); if (!r || S.route !== 'advances') return;
  const adm = isAdmin();
  V(`<div class="vtitle"><h1>Advances</h1><span class="muted">Every funded deal and how it is paying back.</span></div>
    <div class="kpis"><div class="kpi"><b>${r.sums.count}</b><span>Funded deals</span></div><div class="kpi"><b>${mMoney(r.sums.funded_amount)}</b><span>Funded</span></div><div class="kpi"><b>${mMoney(r.sums.payback)}</b><span>Total payback</span></div></div>
    ${mBar('adv', mSel('adv', 'status', r.statuses.map(s => [s, s]), f.status, 'Any status') + (adm ? mSel('adv', 'user', r.users.map(x => [x.id, x.name]), f.user, 'Everyone') : '') + mSel('adv', 'funder', r.funders.map(x => [x.id, x.name]), f.funder, 'All funders'), 'advances')}
    ${mTable([{ h: 'Deal', f: x => `<a href="#/deal/${x.deal_id}">${esc(x.deal)}</a>` }, { h: 'Funder', f: x => esc(x.funder) },
      { h: 'Status', f: x => adm ? `<select onchange="advStatus(${x.id},this.value)">${['', ...r.statuses].map(s => `<option value="${s}" ${(s || x.status) === x.status && (s !== '' || x.status === x.auto_status) ? 'selected' : ''}>${s || 'Auto: ' + x.auto_status}</option>`).join('')}</select>` : mBadge(x.status, ['Current']) },
      { h: 'Funded', r: 1, k: 'funded_amount', f: x => mMoney(x.funded_amount) }, { h: 'Payback', r: 1, k: 'payback', f: x => mMoney(x.payback) }, { h: 'Funded on', f: x => mDate(x.funded_at) },
      { h: 'Paid in', f: x => x.paid_pct == null ? '—' : `<div style="min-width:110px"><span class="mono">${x.paid_pct}%${x.estimated ? '*' : ''}</span>${progress(x.paid_pct, 100)}</div>` },
      { h: 'Originator', f: x => esc(x.originator) }, { h: 'Closer', f: x => esc(x.closer) }, { h: 'Source', f: x => esc(x.source) }, { h: 'Notes', f: x => `<span class="faint">${esc(x.notes)}</span>` }], r.rows, r.sums, false)}
    <div class="faint" style="margin-top:6px;font-size:11.5px">* estimated from the payment schedule until real payments are entered on the deal.</div>`);
}
async function advStatus(id, v) { try { await api('/api/money/advances/' + id, { status: v }, 'PATCH'); toast('Saved'); viewAdvances(); } catch (e) { toast(e.message, true); } }

// ---------------- deal page: splits + payouts ----------------
async function loadSplitBox(r) {
  const box = $('#splitBox'); if (!box) return; const d = r.deal;
  const m = await api('/api/money/deal/' + d.id).catch(() => null); if (!m || !$('#splitBox')) return;
  const adm = isAdmin(), ef = m.effective;
  box.innerHTML = `<div class="card"><h3>Payouts &amp; splits</h3>
    ${adm ? `<div class="grid2"><div class="mf"><label>Closer</label><select id="sp_closer"><option value="">None</option>${(S.users || []).map(u => `<option value="${u.id}" ${m.closer_id === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></div>
      <div class="mf"><label>Originator split %</label><input id="sp_orig" type="number" step="any" min="0" max="100" value="${m.orig_split ?? ''}" placeholder="${ef.orig != null ? 'rep default ' + ef.orig : 'none set'}"></div>
      <div class="mf"><label>Closer split %</label><input id="sp_clos" type="number" step="any" min="0" max="100" value="${m.closer_split ?? ''}" placeholder="${ef.closer != null ? 'rep default ' + ef.closer : 'none set'}"></div></div>
      <button class="sm" onclick="saveSplits(${d.id})">Save splits</button><span class="faint" style="font-size:11px;margin-left:8px">Splits are a % of what the funder pays you.</span>` : ''}
    ${m.payments.length ? `<div style="margin-top:10px"><b style="font-size:12px">Funder payments</b>${m.payments.map(p => `<div class="row" style="padding:3px 0;font-size:12.5px"><span class="badge">${p.type}</span><span class="mono">${mMoney(p.amount)}</span>${mBadge(p.status, ['received'])}<span class="faint grow">${p.status === 'received' ? 'received ' + mDate(p.paid_on) : 'expected ' + mRel(p.expected_on)}</span></div>`).join('')}</div>` : (d.stage === 'funded' ? '<div class="faint" style="margin-top:8px;font-size:12px">No funder payment yet — set the lender’s broker % or the company revenue on this deal, or add one on the Payments page.</div>' : '')}
    ${m.distributions.length ? `<div style="margin-top:10px"><b style="font-size:12px">Payouts</b>${m.distributions.map(x => `<div class="row" style="padding:3px 0;font-size:12.5px"><span style="width:90px">${esc(x.recipient)}</span><span class="faint" style="width:70px">${x.role}</span><span class="mono grow">${mMoney(x.amount)}${x.split_pct != null ? ` <span class="faint">(${Math.round(x.split_pct * 100) / 100}%)</span>` : ''}</span>${mBadge(x.status, ['paid'])}</div>`).join('')}</div>` : ''}</div>`;
}
async function saveSplits(id) { try { await api('/api/deals/' + id, { closer_id: $('#sp_closer').value, orig_split: $('#sp_orig').value, closer_split: $('#sp_clos').value }, 'PATCH'); toast('Saved — payouts recalculated'); route(); } catch (e) { toast(e.message, true); } }
