// Reports page: filters, KPI cards, charts, sortable tables, CSV export
const RP_TABS = [['overview', 'Overview'], ['reps', 'Reps'], ['deals', 'Deal performance'], ['team', 'Team P&L'], ['funders', 'Funders'], ['sources', 'Lead sources'], ['funnel', 'Funnel'], ['pipeline', 'Pipeline'], ['portfolio', 'Portfolio'], ['lenders', 'Lenders'], ['calls', 'Calls'], ['messaging', 'Texts & email'], ['inventory', 'Lead inventory'], ['export', 'Export']];
const RP_RANGES = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['month', 'This month'], ['lastmonth', 'Last month'], ['90', 'Last 90 days'], ['year', 'This year'], ['all', 'All time'], ['custom', 'Custom…']];
const RP_NO_RANGE = ['inventory', 'export'];                       // reports that ignore the date range
const RP_SOURCE_FILTER = ['funnel'];
const RP_USER_FILTER = ['overview', 'reps', 'deals', 'team', 'funders', 'pipeline', 'lenders', 'calls', 'messaging'];
const RP_COLORS = ['var(--green)', 'var(--purple)', 'var(--amber)', 'var(--blue)'];
const rp = { range: '30', from: '', to: '', user: '', source: '', sort: {}, tables: {} };

function rpRange() {
  const d0 = new Date(); d0.setHours(0, 0, 0, 0); const day = 864e5, t0 = d0.getTime(), r = rp.range;
  if (r === 'today') return [t0, ''];
  if (r === 'yesterday') return [t0 - day, t0];
  if (r === 'month') return [new Date(d0.getFullYear(), d0.getMonth(), 1).getTime(), ''];
  if (r === 'lastmonth') return [new Date(d0.getFullYear(), d0.getMonth() - 1, 1).getTime(), new Date(d0.getFullYear(), d0.getMonth(), 1).getTime()];
  if (r === 'year') return [new Date(d0.getFullYear(), 0, 1).getTime(), ''];
  if (r === 'all') return ['', ''];
  if (r === 'custom') return [rp.from ? new Date(rp.from + 'T00:00:00').getTime() : '', rp.to ? new Date(rp.to + 'T00:00:00').getTime() + day : ''];
  return [t0 - (Number(r) - 1) * day, ''];
}
function rpQuery(tab) {
  const [from, to] = RP_NO_RANGE.includes(tab) ? ['', ''] : rpRange(), p = new URLSearchParams();
  if (from !== '') p.set('from', from); if (to !== '') p.set('to', to);
  p.set('off', new Date().getTimezoneOffset());
  if (rp.user && RP_USER_FILTER.includes(tab)) p.set('user', rp.user);
  if (rp.source && RP_SOURCE_FILTER.includes(tab)) p.set('source', rp.source);
  return p.toString();
}

async function viewReports(tab) {
  if (!isAdmin()) { V('<div class="empty" style="padding:40px">Reports are for admins.</div>'); return; }
  tab = RP_TABS.some(t => t[0] === tab) ? tab : 'overview';
  rp.tab = tab;
  if (!rp.touched) rp.range = ['sources', 'funnel', 'funders'].includes(tab) ? 'all' : '30';   // lead-source reports follow leads for their whole life
  const lists = S.lists || [];
  V(`<div class="vtitle"><h1>Reports</h1>
      <div class="row wrap" style="margin-left:auto;gap:8px">
        ${RP_NO_RANGE.includes(tab) ? '<span class="faint" style="font-size:12px">Live snapshot</span>' : `<select id="rpRange">${RP_RANGES.map(([v, l]) => `<option value="${v}" ${rp.range === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <span id="rpCustom" class="row ${rp.range === 'custom' ? '' : 'hidden'}" style="gap:6px"><input type="date" id="rpFrom" value="${esc(rp.from)}"><span class="muted">to</span><input type="date" id="rpTo" value="${esc(rp.to)}"></span>`}
        ${RP_USER_FILTER.includes(tab) ? `<select id="rpUser"><option value="">All reps</option>${S.users.map(u => `<option value="${u.id}" ${String(rp.user) === String(u.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>` : ''}
        ${RP_SOURCE_FILTER.includes(tab) ? `<select id="rpSource"><option value="">All lead sources</option>${lists.map(l => `<option value="${esc(l.name)}" ${rp.source === l.name ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>` : ''}
      </div></div>
    <div class="rptabs">${RP_TABS.map(([k, l]) => `<a href="#/reports/${k}" class="${k === tab ? 'act' : ''}">${l}</a>`).join('')}</div>
    <div id="rpBody" class="muted" style="padding:20px 0">Loading…</div>`);
  const reload = () => viewReports(tab);
  const rr = $('#rpRange'); if (rr) rr.onchange = e => { rp.range = e.target.value; rp.touched = true; reload(); };
  const f = $('#rpFrom'), t = $('#rpTo'); if (f) f.onchange = e => { rp.from = e.target.value; reload(); }; if (t) t.onchange = e => { rp.to = e.target.value; reload(); };
  const ru = $('#rpUser'); if (ru) ru.onchange = e => { rp.user = e.target.value; reload(); };
  const rs = $('#rpSource'); if (rs) rs.onchange = e => { rp.source = e.target.value; reload(); };
  if (tab === 'export') return rpExport();
  let data;
  try { data = await api(`/api/reports/${tab}?${rpQuery(tab)}`); } catch (e) { if (S.route === 'reports') $('#rpBody').innerHTML = `<div class="card" style="color:var(--red)">${esc(e.message)}</div>`; return; }
  if (S.route !== 'reports' || rp.tab !== tab) return;
  rp.tables = {}; (data.tables || []).forEach(t => { rp.tables[t.id] = t; if (t.defaultSort && !rp.sort[t.id]) rp.sort[t.id] = { key: t.defaultSort, dir: -1 }; });
  $('#rpBody').className = '';
  $('#rpBody').innerHTML = `${data.note ? `<div class="rpnote">${esc(data.note)}</div>` : ''}
    ${(data.tools || []).includes('costs') ? '<div style="margin-bottom:12px"><button onclick="costsModal()">Set lead costs</button> <span class="faint" style="font-size:12px;margin-left:6px">Enter what each list cost to see profit and ROI.</span></div>' : ''}
    ${rpKpis(data.kpis || [])}
    ${(data.charts || []).length ? `<div class="rpcharts">${data.charts.map(rpChart).join('')}</div>` : ''}
    ${(data.tables || []).map(rpTable).join('')}`;
}

// ---------- formatting ----------
const rpNum = (v, d = 0) => Number(v).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
function rpFmt(v, fmt) {
  if (v == null || v === '' || (typeof v === 'number' && isNaN(v))) return '—';
  switch (fmt) {
    case 'int': return rpNum(v);
    case 'num': return rpNum(v, 1);
    case 'money': return (v < 0 ? '−$' : '$') + rpNum(Math.abs(v));
    case 'money2': return (v < 0 ? '−$' : '$') + rpNum(Math.abs(v), 2);
    case 'pct': return rpNum(v, Math.abs(v) < 10 && v % 1 ? 1 : 0) + '%';
    case 'dur': return fmtDur(v);
    case 'date': return new Date(v).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    case 'datetime': return fmtTime(v);
    default: return String(v);
  }
}
const rpPlain = (v, fmt) => v == null ? '' : fmt === 'datetime' || fmt === 'date' ? new Date(v).toISOString().slice(0, fmt === 'date' ? 10 : 16).replace('T', ' ') : fmt === 'dur' ? fmtDur(v) : v;

function rpKpis(kpis) {
  if (!kpis.length) return '';
  return `<div class="kpis">${kpis.map(k => {
    let d = '';
    if (k.prev != null && k.value != null && typeof k.prev === 'number' && k.prev !== k.value) {
      const up = k.value > k.prev, ch = k.prev ? Math.round(Math.abs(k.value - k.prev) / Math.abs(k.prev) * 100) : null;
      d = `<em style="color:${up ? 'var(--green)' : 'var(--red)'}">${up ? '▲' : '▼'}${ch != null ? ' ' + ch + '%' : ''}</em>`;
    }
    return `<div class="kpi"><b>${rpFmt(k.value, k.fmt)}${d}</b><span>${esc(k.label)}</span></div>`;
  }).join('')}</div>`;
}

function rpChart(c) {
  const max = Math.max(1e-9, ...c.series.flatMap(s => s.values.map(v => Math.abs(v || 0)))), many = c.labels.length > 16;
  const legend = c.series.length > 1 ? `<div class="rplegend">${c.series.map((s, i) => `<span><i style="background:${RP_COLORS[i % 4]}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';
  if (c.horizontal) {
    const s = c.series[0];
    return `<div class="card"><h3>${esc(c.title)}</h3>${c.labels.map((l, i) => `<div class="row" style="padding:3px 0"><span style="width:140px;font-size:12px" class="muted">${esc(l)}</span><div style="flex:1;height:16px;background:var(--panel3);border-radius:3px;overflow:hidden"><div style="height:100%;width:${(s.values[i] || 0) / max * 100}%;background:var(--green);opacity:${1 - i * 0.06}"></div></div><b class="mono" style="width:70px;text-align:right">${rpFmt(s.values[i], c.fmt)}</b></div>`).join('')}</div>`;
  }
  return `<div class="card"><h3>${esc(c.title)}</h3>${legend}<div class="rpbars" style="${many ? '' : 'gap:10px'}">${c.labels.map((l, i) => `<div class="rpgrp" title="${esc(l)}: ${c.series.map(s => s.name + ' ' + rpFmt(s.values[i], c.fmt)).join(' · ')}">
      <div class="rpcols">${c.series.map((s, j) => `<div class="rpcol" style="height:${Math.max(1, Math.abs(s.values[i] || 0) / max * 100)}%;background:${RP_COLORS[j % 4]}">${!many && c.series.length === 1 ? `<span>${rpFmt(s.values[i], c.fmt)}</span>` : ''}</div>`).join('')}</div>
      <label>${many && i % Math.ceil(c.labels.length / 12) ? '' : esc(many && /^[A-Za-z]{3} \d+$/.test(l) && i && !/ 1$/.test(l) ? l.split(' ')[1] : String(l).length > 14 ? String(l).slice(0, 13) + '…' : l)}</label></div>`).join('')}</div></div>`;
}

function rpTable(t) {
  const st = rp.sort[t.id];
  let rows = t.rows.slice();
  if (st && !t.noSort) rows.sort((a, b) => { const x = a[st.key], y = b[st.key]; if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return (typeof x === 'string' ? x.localeCompare(y) : x - y) * st.dir; });
  const maxes = {}; t.columns.forEach(c => { if (c.bar || c.heat) maxes[c.key] = Math.max(1e-9, ...t.rows.map(r => Math.abs(r[c.key] || 0))); });
  const head = t.columns.map(c => `<th ${t.noSort ? '' : `onclick="rpSort('${t.id}','${c.key}')"`} title="${esc(c.tip || '')}" style="${c.fmt === 'text' || c.fmt === 'link' || c.fmt === 'verdict' ? '' : 'text-align:right'}">${esc(c.label)}${st && st.key === c.key ? (st.dir < 0 ? ' ▼' : ' ▲') : ''}</th>`).join('');
  const body = rows.length ? rows.map(r => `<tr>${t.columns.map((c, ci) => rpCell(r, c, ci, maxes)).join('')}</tr>`).join('') : `<tr><td colspan="${t.columns.length}" class="empty">Nothing to show for this period.</td></tr>`;
  return `<div style="margin-bottom:18px"><div class="row" style="margin-bottom:6px"><h3 class="grow" style="margin:0">${esc(t.title)}</h3><span class="faint" style="font-size:11px">${t.rows.length} row${t.rows.length === 1 ? '' : 's'}</span><button class="sm" onclick="rpCsv('${t.id}')">Export CSV</button></div>
    <div class="tablewrap rptable"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div></div>`;
}
function rpCell(r, c, ci, maxes) {
  const v = r[c.key], txt = rpFmt(v, c.fmt), right = !['text', 'link', 'verdict'].includes(c.fmt) ? 'text-align:right;' : '';
  if (c.fmt === 'link') return `<td>${r._href ? `<a href="${esc(r._href)}">${esc(txt)}</a>` : esc(txt)}</td>`;
  if (c.fmt === 'verdict') { const col = v === 'Profitable' ? 'var(--green)' : v === 'Losing money' ? 'var(--red)' : v === 'Still working it' ? 'var(--amber)' : 'var(--text2)'; return `<td><span class="badge" style="color:${col};border-color:${col}">${esc(v)}</span></td>`; }
  let style = right, inner = c.fmt === 'text' ? esc(txt) : txt;
  if (c.fmt !== 'text') style += 'font-family:var(--mono);';
  if (ci === 0) style += 'font-weight:600;';
  if (c.signed && v != null) style += `color:${v > 0 ? 'var(--green)' : v < 0 ? 'var(--red)' : 'inherit'};`;
  if (c.score && v != null) style += `color:${scoreColor(v)};`;
  if (c.heat && v) style += `background:rgba(0,255,136,${(0.08 + 0.5 * Math.abs(v) / maxes[c.key]).toFixed(2)});`;
  if (c.bar && v) return `<td style="${style}position:relative"><div style="position:absolute;left:0;top:3px;bottom:3px;width:${Math.abs(v) / maxes[c.key] * 100}%;background:var(--green-bg);border-right:2px solid var(--green-dim)"></div><span style="position:relative">${inner}</span></td>`;
  return `<td style="${style}">${inner}</td>`;
}
function rpSort(id, key) { const s = rp.sort[id]; rp.sort[id] = { key, dir: s && s.key === key ? -s.dir : -1 }; const t = rp.tables[id]; const el = event.target.closest('div[style*="margin-bottom:18px"]'); if (el) el.outerHTML = rpTable(t); }
function rpCsv(id) {
  const t = rp.tables[id], q = v => { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const lines = [t.columns.map(c => q(c.label)).join(',')];
  const st = rp.sort[id], rows = t.rows.slice();
  if (st && !t.noSort) rows.sort((a, b) => { const x = a[st.key], y = b[st.key]; if (x == null) return 1; if (y == null) return -1; return (typeof x === 'string' ? x.localeCompare(y) : x - y) * st.dir; });
  for (const r of rows) lines.push(t.columns.map(c => q(rpPlain(r[c.key], c.fmt))).join(','));
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  a.download = `${t.csv || t.id}-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- lead list costs ----------
async function costsModal() {
  const rows = await api('/api/sources').catch(e => { toast(e.message, true); return null; }); if (!rows) return;
  openModal(`<h3>Lead list costs</h3><div class="faint" style="margin-bottom:10px;font-size:12px">Enter the total you paid for each list (for example $1,500 for 5,000 leads). Used for cost per lead, cost per funded deal, profit and ROI.</div>
    <div style="max-height:55vh;overflow:auto"><table><thead><tr><th>List</th><th style="text-align:right">Leads</th><th>Vendor</th><th>Total cost $</th></tr></thead><tbody>
    ${rows.map((r, i) => `<tr data-name="${esc(r.name)}"><td>${esc(r.name)}</td><td class="mono" style="text-align:right">${rpNum(r.leads)}</td><td><input class="cv" value="${esc(r.vendor)}" placeholder="optional" style="width:130px"></td><td><input class="cc" type="number" min="0" step="any" value="${r.total_cost ?? ''}" style="width:110px"></td></tr>`).join('') || '<tr><td colspan="4" class="empty">No lead lists yet. Import a CSV first.</td></tr>'}</tbody></table></div>
    <div class="mact"><button onclick="closeModal()">Cancel</button><button class="primary" onclick="saveCosts()">Save</button></div>`);
}
async function saveCosts() {
  const sources = [...document.querySelectorAll('#modalBody tbody tr[data-name]')].map(tr => ({ name: tr.dataset.name, vendor: tr.querySelector('.cv').value, total_cost: tr.querySelector('.cc').value }));
  try { await api('/api/sources', { sources }, 'PUT'); closeModal(); toast('Costs saved'); viewReports(rp.tab); } catch (e) { toast(e.message, true); }
}

// ---------- export tab ----------
function rpExport() {
  const kinds = [['deals', 'Deals', 'Every deal with stage, amounts, owner, closer and source (by date created).'], ['submissions', 'Submissions', 'Every lender submission with status and offer (by date sent).'], ['advances', 'Advances', 'Funded deals with funder, paid-in %, originator and closer (by date funded).'],
    ['payments', 'Funder payments', 'What funders paid or owe you, what was paid out and your profit (by date funded).'], ['distributions', 'Distributions', 'Every rep and partner payout with split and status (by date funded).']];
  const day = 864e5, t0 = new Date().setHours(0, 0, 0, 0), start = new Date(t0 - 29 * day).toISOString().slice(0, 10), end = new Date(t0).toISOString().slice(0, 10);
  $('#rpBody').className = '';
  $('#rpBody').innerHTML = `<div class="rpnote">Download any of these as a spreadsheet (CSV). Leave the dates empty for everything.</div>
    <div class="row" style="gap:8px;margin-bottom:12px"><span class="muted">From</span><input type="date" id="exFrom"><span class="muted">to</span><input type="date" id="exTo"><button class="sm" onclick="$('#exFrom').value='${start}';$('#exTo').value='${end}'">Last 30 days</button><button class="sm" onclick="$('#exFrom').value='';$('#exTo').value=''">All time</button></div>
    <div class="tablewrap"><table><tbody>${kinds.map(([k, l, d]) => `<tr><td style="width:180px"><b>${l}</b></td><td class="muted">${d}</td><td style="width:120px;text-align:right"><button class="sm primary" onclick="rpDownload('${k}')">Download</button></td></tr>`).join('')}</tbody></table></div>`;
}
function rpDownload(kind) {
  const p = new URLSearchParams(), f = $('#exFrom').value, t = $('#exTo').value;
  if (f) p.set('from', new Date(f + 'T00:00:00').getTime()); if (t) p.set('to', new Date(t + 'T00:00:00').getTime() + 864e5);
  location.href = `/api/export/${kind}?${p}`;
}
