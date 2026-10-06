// Reports: rep activity, lead-source profitability, funnel, pipeline, lenders, calls, messaging, inventory.
// Every report returns { title, note, kpis[], charts[], tables[] } and the page renders them generically (sortable, CSV export).
const express = require('express');
const { db, getSetting } = require('./db');

const DAY = 864e5, now = () => Date.now();
const INTERESTED = "('Interested','App Sent')";
const STAGE_LABEL = { interested: 'Interested', app_sent: 'App sent', app_in: 'App in', docs_in: 'Docs in', submitted: 'Submitted', offer: 'Offer', contract: 'Contract out', funded: 'Funded', lost: 'Lost' };
const STAGE_ORDER = ['interested', 'app_sent', 'app_in', 'docs_in', 'submitted', 'offer', 'contract', 'funded'];
const safeJSON = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const pct = (a, b) => (b ? Math.round(a / b * 1000) / 10 : null);
const div = (a, b) => (b ? a / b : null);
const round = (n, p = 2) => (n == null ? null : Math.round(n * 10 ** p) / 10 ** p);

// company revenue and rep commission per funded deal (same rules as deals.js)
const REV_SQL = `CASE WHEN d.revenue_override IS NOT NULL THEN d.revenue_override WHEN d.funded_amount IS NULL THEN NULL
  WHEN ln.id IS NULL OR ln.in_house=1 THEN (CASE WHEN d.payback>0 THEN d.payback-d.funded_amount END)
  WHEN ln.broker_pct>0 THEN d.funded_amount*ln.broker_pct/100.0 END`;
const COMM_SQL = `(CASE WHEN d.commission_amt IS NOT NULL THEN d.commission_amt WHEN d.funded_amount IS NULL THEN NULL
  ELSE ROUND(d.funded_amount*COALESCE(d.commission_pct, u.commission_pct, 0))/100.0 END) + (CASE WHEN d.iso_id IS NOT NULL THEN ROUND(COALESCE(d.funded_amount,0)*COALESCE(d.iso_pct,0))/100.0 ELSE 0 END)`;
const DEAL_JOIN = 'LEFT JOIN lenders ln ON ln.id=d.lender_id LEFT JOIN users u ON u.id=d.owner_id';

module.exports = function reports(ctx) {
  const { adminOnly, OBJECTION_CATEGORIES } = ctx;
  const r = express.Router();

  // ---- request params ----
  function params(req) {
    const q = req.query, t = now();
    const from = q.from === undefined || q.from === '' ? 0 : Number(q.from) || 0;
    const to = q.to === undefined || q.to === '' ? t + 1 : Number(q.to) || t + 1;
    const off = Number(q.off) || 0;               // browser's getTimezoneOffset(): minutes UTC is ahead of local
    return { from, to, off, offMs: off * 60000, user: q.user ? Number(q.user) : null, source: q.source ? String(q.source) : '' };
  }
  const dayExpr = (col, offMs) => `strftime('%Y-%m-%d', (${col} - ${Math.round(offMs)})/1000, 'unixepoch')`;
  const monthExpr = (col, offMs) => `strftime('%Y-%m', (${col} - ${Math.round(offMs)})/1000, 'unixepoch')`;
  const hourExpr = (col, offMs) => `CAST(strftime('%H', (${col} - ${Math.round(offMs)})/1000, 'unixepoch') AS INTEGER)`;
  const dowExpr = (col, offMs) => `CAST(strftime('%w', (${col} - ${Math.round(offMs)})/1000, 'unixepoch') AS INTEGER)`;
  const col = (key, label, fmt = 'text', extra = {}) => ({ key, label, fmt, ...extra });
  const hourLabel = h => `${((h + 11) % 12) + 1}${h < 12 ? 'am' : 'pm'}`;

  // list of period buckets between from and to (days, or months for long ranges)
  function buckets({ from, to, offMs }, firstData) {
    const start = from || firstData || to - 30 * DAY;
    const days = Math.max(1, Math.ceil((Math.min(to, now() + 1) - start) / DAY));
    const monthly = days > 92;
    const out = [], seen = new Set();
    for (let t = start; t < Math.min(to, now() + 1) + (monthly ? 0 : DAY - 1); t += monthly ? 7 * DAY : DAY) {
      const d = new Date(t - offMs), k = monthly ? d.toISOString().slice(0, 7) : d.toISOString().slice(0, 10);
      if (!seen.has(k)) { seen.add(k); out.push(k); }
      if (out.length > 400) break;
    }
    return { keys: out, monthly };
  }
  const bucketLabel = (k, monthly) => monthly ? new Date(k + '-15').toLocaleDateString('en-US', { month: 'short', year: '2-digit' }) : new Date(k + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

  // =========================================================== overview
  function totals(from, to, user) {
    const cu = user ? ' AND user_id=' + user : '';
    const c = db.prepare(`SELECT COUNT(*) dials, COALESCE(SUM(connected),0) connects, COALESCE(SUM(CASE WHEN connected=1 THEN duration END),0) talk,
      COALESCE(SUM(disposition IN ${INTERESTED}),0) interested, COALESCE(SUM(disposition='App Sent'),0) apps FROM calls WHERE started_at>=? AND started_at<? AND direction='out'${cu}`).get(from, to);
    const du = user ? ' AND d.owner_id=' + user : '';
    const created = db.prepare(`SELECT COUNT(*) n FROM deals d WHERE created_at>=? AND created_at<?${du}`).get(from, to).n;
    const f = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(d.funded_amount),0) amt, COALESCE(SUM(${REV_SQL}),0) rev, COALESCE(SUM(${COMM_SQL}),0) comm
      FROM deals d ${DEAL_JOIN} WHERE d.stage='funded' AND d.funded_at>=? AND d.funded_at<?${du}`).get(from, to);
    const m = db.prepare(`SELECT COALESCE(SUM(direction='out'),0) sent, COALESCE(SUM(direction='in'),0) recv FROM messages WHERE created_at>=? AND created_at<?${user ? ' AND (user_id=' + user + ' OR direction=\'in\')' : ''}`).get(from, to);
    const e = db.prepare(`SELECT COUNT(*) n FROM emails WHERE direction='out' AND lead_id IS NOT NULL AND created_at>=? AND created_at<?${user ? ' AND user_id=' + user : ''}`).get(from, to).n;
    return { ...c, deals: created, funded: f.n, funded_amt: f.amt, revenue: f.rev, commission: f.comm, texts_sent: m.sent, texts_recv: m.recv, emails: e };
  }
  function overview(p) {
    const cur = totals(p.from, p.to, p.user);
    const span = p.to - p.from, prev = p.from ? totals(p.from - span, p.from, p.user) : null;
    const k = (label, key, fmt, v) => { const val = v !== undefined ? v : cur[key], pv = prev ? (v !== undefined ? null : prev[key]) : null; return { label, value: val, fmt, prev: pv }; };
    const kpis = [k('Dials', 'dials', 'int'), k('Conversations', 'connects', 'int'), { label: 'Connect rate', value: pct(cur.connects, cur.dials), fmt: 'pct', prev: prev ? pct(prev.connects, prev.dials) : null },
      k('Talk time', 'talk', 'dur'), k('Interested', 'interested', 'int'), k('Apps sent', 'apps', 'int'), k('Deals created', 'deals', 'int'),
      k('Funded deals', 'funded', 'int'), k('Funded dollars', 'funded_amt', 'money'), k('Company revenue', 'revenue', 'money'), k('Rep commissions', 'commission', 'money'),
      { label: 'Revenue after commissions', value: cur.revenue - cur.commission, fmt: 'money', prev: prev ? prev.revenue - prev.commission : null },
      k('Texts sent', 'texts_sent', 'int'), k('Texts received', 'texts_recv', 'int'), k('Emails sent', 'emails', 'int')];
    const first = db.prepare('SELECT MIN(started_at) t FROM calls').get().t;
    const b = buckets(p, first), by = b.monthly ? monthExpr : dayExpr, cu = p.user ? ' AND user_id=' + p.user : '';
    const calls = Object.fromEntries(db.prepare(`SELECT ${by('started_at', p.offMs)} k, COUNT(*) dials, SUM(connected) connects FROM calls WHERE started_at>=? AND started_at<? AND direction='out'${cu} GROUP BY k`).all(p.from, p.to).map(x => [x.k, x]));
    const du = p.user ? ' AND d.owner_id=' + p.user : '';
    const fund = Object.fromEntries(db.prepare(`SELECT ${by('d.funded_at', p.offMs)} k, SUM(d.funded_amount) amt, SUM(${REV_SQL}) rev FROM deals d ${DEAL_JOIN} WHERE d.stage='funded' AND d.funded_at>=? AND d.funded_at<?${du} GROUP BY k`).all(p.from, p.to).map(x => [x.k, x]));
    const labels = b.keys.map(x => bucketLabel(x, b.monthly));
    return { title: 'Overview', note: prev ? 'Arrows compare with the previous period of the same length.' : '', kpis,
      charts: [
        { title: 'Dials and conversations', labels, fmt: 'int', series: [{ name: 'Dials', values: b.keys.map(x => calls[x]?.dials || 0) }, { name: 'Conversations', values: b.keys.map(x => calls[x]?.connects || 0) }] },
        { title: 'Funded dollars and revenue', labels, fmt: 'money', series: [{ name: 'Funded', values: b.keys.map(x => fund[x]?.amt || 0) }, { name: 'Revenue', values: b.keys.map(x => fund[x]?.rev || 0) }] }],
      tables: [] };
  }

  // =========================================================== reps
  function repsReport(p) {
    const users = db.prepare('SELECT id, name, role FROM users WHERE active=1 AND role!=\'iso\' ORDER BY name').all().filter(u => !p.user || u.id === p.user);
    const call = Object.fromEntries(db.prepare(`SELECT user_id, COUNT(*) dials, SUM(connected) connects, COALESCE(SUM(CASE WHEN connected=1 THEN duration END),0) talk, SUM(vm_dropped) vms,
      SUM(disposition IN ${INTERESTED}) interested, SUM(disposition='App Sent') apps, SUM(disposition='Callback') callbacks, ROUND(AVG(score),0) score, ROUND(AVG(talk_ratio)*100,0) talk_ratio,
      COUNT(DISTINCT ${dayExpr('started_at', p.offMs)}) days, COUNT(DISTINCT ${dayExpr('started_at', p.offMs)} || '-' || ${hourExpr('started_at', p.offMs)}) active_hours,
      MIN(started_at) first_at, MAX(started_at) last_at
      FROM calls WHERE started_at>=? AND started_at<? AND direction='out' AND user_id IS NOT NULL GROUP BY user_id`).all(p.from, p.to).map(x => [x.user_id, x]));
    const deal = Object.fromEntries(db.prepare(`SELECT d.owner_id, COUNT(*) n FROM deals d WHERE created_at>=? AND created_at<? AND owner_id IS NOT NULL GROUP BY d.owner_id`).all(p.from, p.to).map(x => [x.owner_id, x.n]));
    const sub = Object.fromEntries(db.prepare(`SELECT s.user_id, COUNT(DISTINCT s.deal_id) n FROM submissions s WHERE sent_at>=? AND sent_at<? AND s.user_id IS NOT NULL GROUP BY s.user_id`).all(p.from, p.to).map(x => [x.user_id, x.n]));
    const fund = Object.fromEntries(db.prepare(`SELECT d.owner_id, COUNT(*) n, SUM(d.funded_amount) amt, SUM(${REV_SQL}) rev, SUM(${COMM_SQL}) comm FROM deals d ${DEAL_JOIN}
      WHERE d.stage='funded' AND d.funded_at>=? AND d.funded_at<? AND d.owner_id IS NOT NULL GROUP BY d.owner_id`).all(p.from, p.to).map(x => [x.owner_id, x]));
    const sms = Object.fromEntries(db.prepare("SELECT user_id, COUNT(*) n FROM messages WHERE direction='out' AND created_at>=? AND created_at<? AND user_id IS NOT NULL GROUP BY user_id").all(p.from, p.to).map(x => [x.user_id, x.n]));
    const em = Object.fromEntries(db.prepare("SELECT user_id, COUNT(*) n FROM emails WHERE direction='out' AND lead_id IS NOT NULL AND created_at>=? AND created_at<? AND user_id IS NOT NULL GROUP BY user_id").all(p.from, p.to).map(x => [x.user_id, x.n]));
    const rows = users.map(u => {
      const c = call[u.id] || {}, f = fund[u.id] || {};
      return { name: u.name, dials: c.dials || 0, connects: c.connects || 0, connect_rate: pct(c.connects || 0, c.dials || 0), talk: c.talk || 0, avg_talk: c.connects ? Math.round(c.talk / c.connects) : null,
        vms: c.vms || 0, interested: c.interested || 0, interest_rate: pct(c.interested || 0, c.connects || 0), apps: c.apps || 0, deals: deal[u.id] || 0, submitted: sub[u.id] || 0,
        funded: f.n || 0, funded_amt: f.amt || 0, revenue: f.rev || 0, commission: f.comm || 0, score: c.score ?? null, talk_ratio: c.talk_ratio ?? null,
        days: c.days || 0, dials_per_day: c.days ? Math.round(c.dials / c.days) : null, dials_per_hour: c.active_hours ? round(c.dials / c.active_hours, 1) : null, texts: sms[u.id] || 0, emails: em[u.id] || 0,
        first_at: c.first_at || null, last_at: c.last_at || null };
    }).sort((a, b) => b.dials - a.dials);
    const tableMain = { id: 'reps', title: 'Rep scorecard', csv: 'reps', defaultSort: 'dials', columns: [
      col('name', 'Rep'), col('dials', 'Dials', 'int', { bar: 1 }), col('connects', 'Convos', 'int'), col('connect_rate', 'Connect %', 'pct'), col('talk', 'Talk time', 'dur'), col('avg_talk', 'Avg convo', 'dur'),
      col('vms', 'VMs', 'int'), col('interested', 'Interested', 'int'), col('interest_rate', 'Interest %', 'pct', { tip: 'Interested per conversation' }), col('apps', 'Apps sent', 'int'), col('deals', 'Deals', 'int'), col('submitted', 'Submitted', 'int'),
      col('funded', 'Funded', 'int'), col('funded_amt', 'Funded $', 'money'), col('revenue', 'Revenue', 'money'), col('commission', 'Commission', 'money'),
      col('score', 'Avg score', 'int', { score: 1 }), col('talk_ratio', 'Talk %', 'pct'), col('days', 'Days dialing', 'int'), col('dials_per_day', 'Dials / day', 'int'), col('dials_per_hour', 'Dials / active hr', 'num'),
      col('texts', 'Texts', 'int'), col('emails', 'Emails', 'int'), col('first_at', 'First dial', 'datetime'), col('last_at', 'Last dial', 'datetime')], rows };

    // dials per rep per day
    const first = db.prepare('SELECT MIN(started_at) t FROM calls').get().t, b = buckets(p, first);
    const keys = b.keys.slice(-31), by = b.monthly ? monthExpr : dayExpr;
    const grid = {};
    for (const x of db.prepare(`SELECT user_id, ${by('started_at', p.offMs)} k, COUNT(*) n FROM calls WHERE started_at>=? AND started_at<? AND direction='out' AND user_id IS NOT NULL GROUP BY user_id, k`).all(p.from, p.to)) (grid[x.user_id] = grid[x.user_id] || {})[x.k] = x.n;
    const dayRows = users.map(u => { const o = { name: u.name, total: 0 }; keys.forEach((k, i) => { o['d' + i] = grid[u.id]?.[k] || 0; o.total += o['d' + i]; }); return o; });
    const dayTable = { id: 'daily', title: `Dials per day${b.keys.length > 31 ? ' (last 31 days of the range)' : ''}`, csv: 'dials-per-day', heat: true,
      columns: [col('name', 'Rep'), ...keys.map((k, i) => col('d' + i, bucketLabel(k, b.monthly), 'int', { heat: 1 })), col('total', 'Total', 'int')], rows: dayRows };

    // dials per rep per hour
    const hg = {};
    for (const x of db.prepare(`SELECT user_id, ${hourExpr('started_at', p.offMs)} h, COUNT(*) n FROM calls WHERE started_at>=? AND started_at<? AND direction='out' AND user_id IS NOT NULL GROUP BY user_id, h`).all(p.from, p.to)) (hg[x.user_id] = hg[x.user_id] || {})[x.h] = x.n;
    const hours = Array.from({ length: 15 }, (_, i) => i + 7);
    const hourTable = { id: 'hourly', title: 'When each rep dials (dials by hour of day)', csv: 'dials-by-hour', heat: true,
      columns: [col('name', 'Rep'), ...hours.map(h => col('h' + h, hourLabel(h), 'int', { heat: 1 }))], rows: users.map(u => { const o = { name: u.name }; hours.forEach(h => { o['h' + h] = hg[u.id]?.[h] || 0; }); return o; }) };

    // dispositions per rep
    const dispos = db.prepare(`SELECT DISTINCT disposition d FROM calls WHERE disposition!='' AND started_at>=? AND started_at<? AND direction='out'`).all(p.from, p.to).map(x => x.d);
    const dg = {};
    for (const x of db.prepare(`SELECT user_id, disposition d, COUNT(*) n FROM calls WHERE disposition!='' AND started_at>=? AND started_at<? AND direction='out' AND user_id IS NOT NULL GROUP BY user_id, d`).all(p.from, p.to)) (dg[x.user_id] = dg[x.user_id] || {})[x.d] = x.n;
    const dispTable = { id: 'dispos', title: 'Outcomes by rep', csv: 'outcomes-by-rep', columns: [col('name', 'Rep'), ...dispos.map((d, i) => col('x' + i, d, 'int')), col('total', 'Total', 'int')],
      rows: users.map(u => { const o = { name: u.name, total: 0 }; dispos.forEach((d, i) => { o['x' + i] = dg[u.id]?.[d] || 0; o.total += o['x' + i]; }); return o; }) };

    // rep x lead source
    const rs = db.prepare(`SELECT u.name rep, l.source src, COUNT(*) dials, SUM(c.connected) connects, SUM(c.disposition IN ${INTERESTED}) interested, SUM(c.disposition='App Sent') apps
      FROM calls c JOIN leads l ON l.id=c.lead_id JOIN users u ON u.id=c.user_id WHERE c.started_at>=? AND c.started_at<? AND c.direction='out' AND l.source!=''${p.user ? ' AND c.user_id=' + p.user : ''}
      GROUP BY c.user_id, l.source HAVING dials>=10 ORDER BY interested DESC, dials DESC LIMIT 300`).all(p.from, p.to)
      .map(x => ({ ...x, connect_rate: pct(x.connects, x.dials), interest_rate: pct(x.interested, x.connects) }));
    const repSource = { id: 'repsource', title: 'Who works which lead source best (10+ dials)', csv: 'rep-by-source', columns: [col('rep', 'Rep'), col('src', 'Lead source'), col('dials', 'Dials', 'int'), col('connects', 'Convos', 'int'), col('connect_rate', 'Connect %', 'pct'),
      col('interested', 'Interested', 'int'), col('interest_rate', 'Interest %', 'pct'), col('apps', 'Apps sent', 'int')], rows: rs };
    return { title: 'Reps', note: 'Deals, funded dollars and commission are credited to the deal owner. Calls are outbound only.', kpis: [], charts: [], tables: [tableMain, dayTable, hourTable, dispTable, repSource] };
  }

  // =========================================================== lead sources
  function sourcesData(p) {
    const lf = `l.source!='' AND l.created_at>=? AND l.created_at<?`;
    const leadRows = db.prepare(`SELECT l.source, COUNT(*) leads, SUM(l.attempts=0 AND l.status='new') untouched, SUM(l.attempts>0) dialed, COALESCE(SUM(l.attempts),0) attempts,
      COALESCE(SUM(cs.conn),0) reached, COALESCE(SUM(cs.intr),0) interested, COALESCE(SUM(cs.wn),0) wrong, SUM(l.status='dnc') dnc, MIN(l.created_at) first_at
      FROM leads l LEFT JOIN (SELECT lead_id, MAX(connected) conn, MAX(disposition IN ${INTERESTED}) intr, MAX(disposition='Wrong Number') wn FROM calls GROUP BY lead_id) cs ON cs.lead_id=l.id
      WHERE ${lf} GROUP BY l.source`).all(p.from, p.to);
    const dealRows = Object.fromEntries(db.prepare(`SELECT l.source, COUNT(*) deals, SUM(d.app_signed_at IS NOT NULL) apps_in,
      SUM(EXISTS(SELECT 1 FROM submissions s WHERE s.deal_id=d.id)) submitted,
      SUM(EXISTS(SELECT 1 FROM submissions s WHERE s.deal_id=d.id AND (s.status IN ('approved','funded') OR s.offer_amount>0))) offers,
      SUM(d.stage='funded') funded, COALESCE(SUM(CASE WHEN d.stage='funded' THEN d.funded_amount END),0) funded_amt,
      COALESCE(SUM(CASE WHEN d.stage='funded' THEN ${REV_SQL} END),0) revenue, COALESCE(SUM(CASE WHEN d.stage='funded' THEN ${COMM_SQL} END),0) commission,
      AVG(CASE WHEN d.stage='funded' AND d.funded_at>0 THEN (d.funded_at-l.created_at)/86400000.0 END) days_to_fund
      FROM deals d JOIN leads l ON l.id=d.lead_id ${DEAL_JOIN} WHERE ${lf} GROUP BY l.source`).all(p.from, p.to).map(x => [x.source, x]));
    const costs = Object.fromEntries(db.prepare('SELECT * FROM lead_sources').all().map(x => [x.name, x]));
    const rows = leadRows.map(l => {
      const d = dealRows[l.source] || {}, cost = costs[l.source]?.total_cost ?? null;
      const revenue = d.revenue || 0, commission = d.commission || 0, funded = d.funded || 0;
      const profit = cost != null || revenue ? revenue - commission - (cost || 0) : null;
      let verdict;
      if (cost == null) verdict = revenue - commission > 0 ? 'Add cost' : 'Add cost';
      else if (profit > 0) verdict = 'Profitable';
      else if (l.dialed / l.leads < 0.5 && !funded) verdict = 'Still working it';
      else verdict = 'Losing money';
      return { source: l.source, vendor: costs[l.source]?.vendor || '', first_at: l.first_at, leads: l.leads, untouched: l.untouched, dialed_pct: pct(l.dialed, l.leads), reached: l.reached, reach_pct: pct(l.reached, l.dialed),
        dnc_pct: pct(l.dnc, l.leads), wrong_pct: pct(l.wrong, l.dialed), attempts_per: round(div(l.attempts, l.dialed), 1), interested: l.interested, interested_pct: pct(l.interested, l.reached),
        deals: d.deals || 0, apps_in: d.apps_in || 0, submitted: d.submitted || 0, offers: d.offers || 0, funded, funded_amt: d.funded_amt || 0, close_pct: pct(funded, l.leads),
        days_to_fund: d.days_to_fund != null ? Math.round(d.days_to_fund) : null, revenue, commission, cost, cost_per_lead: cost != null ? round(cost / l.leads, 2) : null,
        cost_per_reach: cost != null ? round(div(cost, l.reached), 2) : null, cost_per_app: cost != null ? round(div(cost, d.apps_in), 2) : null, cost_per_funded: cost != null ? round(div(cost, funded), 2) : null,
        profit, roi: cost ? round((profit / cost) * 100, 0) : null, verdict };
    });
    return { rows, costs };
  }
  function sourcesReport(p) {
    const { rows } = sourcesData(p);
    rows.sort((a, b) => (b.profit ?? -1e12) - (a.profit ?? -1e12) || b.funded - a.funded || b.leads - a.leads);
    const tot = rows.reduce((a, x) => { for (const k of ['leads', 'funded', 'funded_amt', 'revenue', 'commission']) a[k] += x[k] || 0; a.cost += x.cost || 0; a.reached += x.reached; return a; }, { leads: 0, funded: 0, funded_amt: 0, revenue: 0, commission: 0, cost: 0, reached: 0 });
    const profit = tot.revenue - tot.commission - tot.cost;
    const kpis = [{ label: 'Lead sources', value: rows.length, fmt: 'int' }, { label: 'Leads', value: tot.leads, fmt: 'int' }, { label: 'Lead spend', value: tot.cost, fmt: 'money' },
      { label: 'Funded deals', value: tot.funded, fmt: 'int' }, { label: 'Revenue', value: tot.revenue, fmt: 'money' }, { label: 'Net profit', value: profit, fmt: 'money' },
      { label: 'Cost per funded deal', value: tot.funded ? round(tot.cost / tot.funded, 0) : null, fmt: 'money' }, { label: 'Lead spend ROI', value: tot.cost ? round(profit / tot.cost * 100, 0) : null, fmt: 'pct' }];
    const top = rows.slice(0, 12);
    const main = { id: 'sources', title: 'Lead source performance', csv: 'lead-sources', defaultSort: 'profit', verdict: 1, columns: [
      col('source', 'Source'), col('verdict', 'Verdict', 'verdict'), col('leads', 'Leads', 'int'), col('dialed_pct', 'Dialed %', 'pct'), col('reached', 'Reached', 'int'), col('reach_pct', 'Reach %', 'pct', { tip: 'Conversations per lead dialed' }),
      col('interested', 'Interested', 'int'), col('interested_pct', 'Interest %', 'pct', { tip: 'Interested per lead reached' }), col('apps_in', 'Apps in', 'int'), col('submitted', 'Submitted', 'int'), col('offers', 'Offers', 'int'),
      col('funded', 'Funded', 'int'), col('close_pct', 'Close %', 'pct', { tip: 'Funded per lead' }), col('funded_amt', 'Funded $', 'money'), col('revenue', 'Revenue', 'money'), col('commission', 'Commission', 'money'),
      col('cost', 'Cost', 'money'), col('cost_per_lead', 'Cost / lead', 'money2'), col('cost_per_reach', 'Cost / reach', 'money2'), col('cost_per_app', 'Cost / app', 'money'), col('cost_per_funded', 'Cost / funded', 'money'),
      col('profit', 'Profit', 'money', { signed: 1 }), col('roi', 'ROI %', 'pct', { signed: 1 }), col('days_to_fund', 'Days to fund', 'int'),
      col('untouched', 'Untouched', 'int'), col('attempts_per', 'Tries / lead', 'num'), col('dnc_pct', 'DNC %', 'pct'), col('wrong_pct', 'Wrong # %', 'pct'), col('vendor', 'Vendor'), col('first_at', 'Imported', 'date')], rows };
    return { title: 'Lead sources', note: 'Based on leads imported in the date range, followed through to funding. Revenue is the spread on in-house deals or the lender’s broker % (set on each lender); you can override it per deal. Profit = revenue − rep commission − what you paid for the list. Set list costs with “Set lead costs”.',
      kpis, tools: ['costs'], charts: [
        { title: 'Revenue vs. cost by source (top 12)', labels: top.map(x => x.source), fmt: 'money', series: [{ name: 'Revenue', values: top.map(x => x.revenue) }, { name: 'Cost', values: top.map(x => x.cost || 0) }] },
        { title: 'Reach and interest rate by source (top 12)', labels: top.map(x => x.source), fmt: 'pct', series: [{ name: 'Reach %', values: top.map(x => x.reach_pct || 0) }, { name: 'Interest %', values: top.map(x => x.interested_pct || 0) }] }],
      tables: [main, stageTable(rows), vendorTable(rows)] };
  }
  function stageTable(rows) {
    return { id: 'stages', title: 'Conversion and cost at every stage', csv: 'source-stage-conversion', defaultSort: 'funded', columns: [col('source', 'Lead source / batch'), col('leads', 'Leads', 'int'), col('reached', 'Reached', 'int'), col('r_pct', 'Reached %', 'pct'), col('interested', 'Interested', 'int'), col('i_pct', 'Interested %', 'pct'),
      col('apps_in', 'Apps in', 'int'), col('a_pct', 'Apps %', 'pct'), col('submitted', 'Submitted', 'int'), col('s_pct', 'Submitted %', 'pct'), col('offers', 'Offers', 'int'), col('o_pct', 'Offer %', 'pct'), col('funded', 'Funded', 'int'), col('f_pct', 'Funded %', 'pct'),
      col('cps', 'Cost / submitted', 'money'), col('cpo', 'Cost / offer', 'money'), col('cpf', 'Cost / funded', 'money'), col('avg_comm', 'Avg commission / funded', 'money'), col('avg_rev', 'Avg revenue / funded', 'money')],
      rows: rows.map(x => ({ source: x.source, leads: x.leads, reached: x.reached, r_pct: pct(x.reached, x.leads), interested: x.interested, i_pct: pct(x.interested, x.leads), apps_in: x.apps_in, a_pct: pct(x.apps_in, x.leads), submitted: x.submitted, s_pct: pct(x.submitted, x.leads), offers: x.offers, o_pct: pct(x.offers, x.leads), funded: x.funded, f_pct: pct(x.funded, x.leads),
        cps: x.cost != null ? round(div(x.cost, x.submitted), 0) : null, cpo: x.cost != null ? round(div(x.cost, x.offers), 0) : null, cpf: x.cost_per_funded != null ? Math.round(x.cost_per_funded) : null, avg_comm: x.funded ? round(x.commission / x.funded, 0) : null, avg_rev: x.funded ? round(x.revenue / x.funded, 0) : null })) };
  }
  function vendorTable(rows) {
    const g = {};
    for (const x of rows) { const k = x.vendor || '(no vendor set)'; const o = g[k] = g[k] || { vendor: k, batches: 0, leads: 0, reached: 0, interested: 0, submitted: 0, funded: 0, funded_amt: 0, revenue: 0, commission: 0, cost: 0, hasCost: false }; o.batches++; for (const f of ['leads', 'reached', 'interested', 'submitted', 'funded', 'funded_amt', 'revenue', 'commission']) o[f] += x[f] || 0; if (x.cost != null) { o.cost += x.cost; o.hasCost = true; } }
    return { id: 'vendors', title: 'By vendor (all of a vendor’s lists together)', csv: 'lead-vendors', defaultSort: 'profit', columns: [col('vendor', 'Vendor'), col('batches', 'Lists', 'int'), col('leads', 'Leads', 'int'), col('reached', 'Reached', 'int'), col('interested', 'Interested', 'int'), col('submitted', 'Submitted', 'int'), col('funded', 'Funded', 'int'), col('funded_amt', 'Funded $', 'money'),
      col('revenue', 'Revenue', 'money'), col('commission', 'Commission', 'money'), col('cost', 'Cost', 'money'), col('cpf', 'Cost / funded', 'money'), col('profit', 'Profit', 'money', { signed: 1 }), col('roi', 'ROI %', 'pct', { signed: 1 })],
      rows: Object.values(g).map(o => { const profit = o.hasCost || o.revenue ? o.revenue - o.commission - o.cost : null; return { ...o, cost: o.hasCost ? o.cost : null, cpf: o.hasCost && o.funded ? Math.round(o.cost / o.funded) : null, profit, roi: o.hasCost && o.cost ? round(profit / o.cost * 100, 0) : null }; }) };
  }

  // =========================================================== funnel
  function funnelReport(p) {
    const where = ['l.created_at>=?', 'l.created_at<?'], args = [p.from, p.to];
    if (p.source) { where.push('l.source=?'); args.push(p.source); }
    const rows = db.prepare(`SELECT l.id, l.attempts, l.created_at, l.source,
      COALESCE(cs.conn,0) conn, COALESCE(cs.intr,0) intr, COALESCE(ds.has_deal,0) has_deal, COALESCE(ds.sent,0) sent, COALESCE(ds.app_in,0) app_in, COALESCE(ds.docs,0) docs,
      COALESCE(ds.subm,0) subm, COALESCE(ds.offer,0) offer, COALESCE(ds.funded,0) funded
      FROM leads l
      LEFT JOIN (SELECT lead_id, MAX(connected) conn, MAX(disposition IN ${INTERESTED}) intr FROM calls GROUP BY lead_id) cs ON cs.lead_id=l.id
      LEFT JOIN (SELECT d.lead_id, 1 has_deal,
        MAX(d.app_signed_at IS NOT NULL OR d.stage IN ('app_sent','app_in','docs_in','submitted','offer','contract','funded') OR EXISTS(SELECT 1 FROM deal_events e WHERE e.deal_id=d.id AND e.kind='link')) sent,
        MAX(d.app_signed_at IS NOT NULL OR d.stage IN ('app_in','docs_in','submitted','offer','contract','funded')) app_in,
        MAX(EXISTS(SELECT 1 FROM deal_files f WHERE f.deal_id=d.id AND f.kind='statement') OR d.stage IN ('docs_in','submitted','offer','contract','funded')) docs,
        MAX(EXISTS(SELECT 1 FROM submissions s WHERE s.deal_id=d.id) OR d.stage IN ('submitted','offer','contract','funded')) subm,
        MAX(EXISTS(SELECT 1 FROM submissions s WHERE s.deal_id=d.id AND (s.status IN ('approved','funded') OR s.offer_amount>0)) OR d.stage IN ('offer','contract','funded')) offer,
        MAX(d.stage='funded') funded FROM deals d GROUP BY d.lead_id) ds ON ds.lead_id=l.id
      WHERE ${where.join(' AND ')}`).all(...args);
    const n = f => rows.filter(f).length;
    const steps = [['Leads', rows.length], ['Dialed', n(x => x.attempts > 0)], ['Reached a person', n(x => x.conn)], ['Interested', n(x => x.intr || x.has_deal)], ['App sent', n(x => x.sent)],
      ['App back', n(x => x.app_in)], ['Statements in', n(x => x.docs)], ['Submitted to lender', n(x => x.subm)], ['Offer received', n(x => x.offer)], ['Funded', n(x => x.funded)]];
    const fr = steps.map(([label, count], i) => ({ step: label, count, of_prev: i ? pct(count, steps[i - 1][1]) : null, of_leads: pct(count, steps[0][1]) }));
    // cohorts by import month
    const co = {};
    for (const x of rows) {
      const k = new Date(x.created_at - p.offMs).toISOString().slice(0, 7), o = co[k] = co[k] || { month: k, leads: 0, dialed: 0, reached: 0, interested: 0, apps: 0, submitted: 0, funded: 0 };
      o.leads++; if (x.attempts > 0) o.dialed++; if (x.conn) o.reached++; if (x.intr || x.has_deal) o.interested++; if (x.app_in) o.apps++; if (x.subm) o.submitted++; if (x.funded) o.funded++;
    }
    const cohort = Object.values(co).sort((a, b) => b.month.localeCompare(a.month)).map(o => ({ ...o, reach_pct: pct(o.reached, o.dialed), interest_pct: pct(o.interested, o.reached), close_pct: pct(o.funded, o.leads) }));
    const lost = db.prepare(`SELECT COALESCE(NULLIF(d.lost_reason,''),'(no reason given)') reason, COUNT(*) n, COALESCE(SUM(d.amount_requested),0) amt FROM deals d JOIN leads l ON l.id=d.lead_id
      WHERE d.stage='lost' AND ${where.join(' AND ')} GROUP BY reason ORDER BY n DESC LIMIT 25`).all(...args);
    return { title: 'Funnel', note: `Follows every lead imported in the date range${p.source ? ' from “' + p.source + '”' : ''} from first dial to funded.`, kpis: [],
      charts: [{ title: 'Lead to funded', labels: fr.map(x => x.step), fmt: 'int', series: [{ name: 'Leads', values: fr.map(x => x.count) }], horizontal: true }],
      tables: [{ id: 'funnel', title: 'Funnel steps', csv: 'funnel', noSort: true, columns: [col('step', 'Step'), col('count', 'Count', 'int'), col('of_prev', '% of previous step', 'pct'), col('of_leads', '% of all leads', 'pct')], rows: fr },
        { id: 'cohort', title: 'By month imported', csv: 'funnel-cohorts', columns: [col('month', 'Month'), col('leads', 'Leads', 'int'), col('dialed', 'Dialed', 'int'), col('reached', 'Reached', 'int'), col('reach_pct', 'Reach %', 'pct'), col('interested', 'Interested', 'int'),
          col('interest_pct', 'Interest %', 'pct'), col('apps', 'Apps back', 'int'), col('submitted', 'Submitted', 'int'), col('funded', 'Funded', 'int'), col('close_pct', 'Close %', 'pct')], rows: cohort },
        { id: 'lost', title: 'Why deals were lost', csv: 'lost-reasons', columns: [col('reason', 'Reason'), col('n', 'Deals', 'int', { bar: 1 }), col('amt', 'Requested $', 'money')], rows: lost }] };
  }

  // =========================================================== pipeline
  function pipelineReport(p) {
    const t = now(), du = p.user ? ' AND d.owner_id=' + p.user : '';
    const open = db.prepare(`SELECT d.*, l.source, l.name lead_name, l.business lead_business, u.name owner_name,
      COALESCE((SELECT MAX(e.created_at) FROM deal_events e WHERE e.deal_id=d.id AND e.kind='stage'), d.created_at) stage_at
      FROM deals d JOIN leads l ON l.id=d.lead_id LEFT JOIN users u ON u.id=d.owner_id WHERE d.stage NOT IN ('funded','lost')${du}`).all();
    const byStage = STAGE_ORDER.filter(s => s !== 'funded').map(s => {
      const ds = open.filter(d => d.stage === s), age = ds.map(d => (t - d.stage_at) / DAY);
      return { stage: STAGE_LABEL[s], deals: ds.length, amount: ds.reduce((a, d) => a + (d.amount_requested || 0), 0), avg_days: ds.length ? round(age.reduce((a, b) => a + b, 0) / ds.length, 1) : null, oldest: ds.length ? Math.round(Math.max(...age)) : null,
        stalled: ds.filter(d => (t - d.updated_at) > 7 * DAY).length };
    });
    const stalled = open.filter(d => t - d.updated_at > 5 * DAY).sort((a, b) => a.updated_at - b.updated_at).slice(0, 100)
      .map(d => ({ deal: d.title || d.lead_business || d.lead_name, owner: d.owner_name || 'Unassigned', stage: STAGE_LABEL[d.stage], amount: d.amount_requested, idle: Math.round((t - d.updated_at) / DAY), source: d.source, _href: '#/deal/' + d.id }));
    const owners = db.prepare(`SELECT COALESCE(u.name,'Unassigned') owner, SUM(d.stage NOT IN ('funded','lost')) open_deals, COALESCE(SUM(CASE WHEN d.stage NOT IN ('funded','lost') THEN d.amount_requested END),0) open_amt,
      SUM(d.stage='funded' AND d.funded_at>=? AND d.funded_at<?) funded, COALESCE(SUM(CASE WHEN d.stage='funded' AND d.funded_at>=? AND d.funded_at<? THEN d.funded_amount END),0) funded_amt,
      SUM(d.stage='lost' AND d.updated_at>=? AND d.updated_at<?) lost
      FROM deals d LEFT JOIN users u ON u.id=d.owner_id GROUP BY d.owner_id ORDER BY open_deals DESC`).all(p.from, p.to, p.from, p.to, p.from, p.to)
      .map(x => ({ ...x, win_pct: pct(x.funded, x.funded + x.lost) }));
    // how long deals take to reach each stage (deals created in range)
    const ds = db.prepare(`SELECT d.id, d.created_at, d.funded_at FROM deals d WHERE d.created_at>=? AND d.created_at<?${du}`).all(p.from, p.to);
    const reach = {}; STAGE_ORDER.forEach(s => reach[s] = []);
    if (ds.length) {
      const ids = new Map(ds.map(x => [x.id, x]));
      for (const e of db.prepare("SELECT deal_id, body, created_at FROM deal_events WHERE kind='stage' ORDER BY created_at").all()) {
        const d = ids.get(e.deal_id); if (!d) continue;
        const m = /→ ([A-Za-z ]+?)(?: \(|$)/.exec(e.body); if (!m) continue;
        const s = Object.keys(STAGE_LABEL).find(k => STAGE_LABEL[k] === m[1].trim()); if (s && reach[s] && !reach[s]._seen?.has(e.deal_id)) { (reach[s]._seen = reach[s]._seen || new Set()).add(e.deal_id); reach[s].push((e.created_at - d.created_at) / DAY); }
      }
    }
    const velocity = STAGE_ORDER.filter(s => s !== 'interested').map(s => ({ stage: STAGE_LABEL[s], deals: reach[s].length, avg_days: reach[s].length ? round(reach[s].reduce((a, b) => a + b, 0) / reach[s].length, 1) : null, median_days: reach[s].length ? round([...reach[s]].sort((a, b) => a - b)[Math.floor(reach[s].length / 2)], 1) : null }));
    const f = db.prepare(`SELECT COUNT(*) n FROM deals d WHERE d.stage='funded' AND d.funded_at>=? AND d.funded_at<?${du}`).get(p.from, p.to).n;
    const lost = db.prepare(`SELECT COUNT(*) n FROM deals d WHERE d.stage='lost' AND d.updated_at>=? AND d.updated_at<?${du}`).get(p.from, p.to).n;
    const kpis = [{ label: 'Open deals', value: open.length, fmt: 'int' }, { label: 'Open pipeline $', value: open.reduce((a, d) => a + (d.amount_requested || 0), 0), fmt: 'money' },
      { label: 'Stalled (7+ days)', value: open.filter(d => t - d.updated_at > 7 * DAY).length, fmt: 'int' }, { label: 'Funded in range', value: f, fmt: 'int' }, { label: 'Lost in range', value: lost, fmt: 'int' }, { label: 'Win rate', value: pct(f, f + lost), fmt: 'pct' }];
    return { title: 'Pipeline', kpis, charts: [{ title: 'Open deals by stage', labels: byStage.map(x => x.stage), fmt: 'int', series: [{ name: 'Deals', values: byStage.map(x => x.deals) }] }],
      tables: [{ id: 'stages', title: 'Open deals by stage', csv: 'pipeline-stages', noSort: true, columns: [col('stage', 'Stage'), col('deals', 'Deals', 'int'), col('amount', 'Requested $', 'money'), col('avg_days', 'Avg days in stage', 'num'), col('oldest', 'Oldest (days)', 'int'), col('stalled', 'Stalled 7+ days', 'int')], rows: byStage },
        { id: 'stalled', title: 'Deals going cold (5+ days with no activity)', csv: 'stalled-deals', columns: [col('deal', 'Deal', 'link'), col('owner', 'Owner'), col('stage', 'Stage'), col('amount', 'Requested', 'money'), col('idle', 'Days idle', 'int', { bar: 1 }), col('source', 'Source')], rows: stalled },
        { id: 'owners', title: 'By deal owner', csv: 'pipeline-owners', columns: [col('owner', 'Owner'), col('open_deals', 'Open deals', 'int'), col('open_amt', 'Open $', 'money'), col('funded', 'Funded', 'int'), col('funded_amt', 'Funded $', 'money'), col('lost', 'Lost', 'int'), col('win_pct', 'Win %', 'pct')], rows: owners },
        { id: 'velocity', title: 'How fast deals move (deals created in range)', csv: 'pipeline-velocity', noSort: true, columns: [col('stage', 'Reached stage'), col('deals', 'Deals', 'int'), col('avg_days', 'Avg days from creation', 'num'), col('median_days', 'Median days', 'num')], rows: velocity }] };
  }

  // =========================================================== lenders
  function lendersReport(p) {
    const subs = db.prepare(`SELECT s.*, ln.name lender, ln.in_house FROM submissions s JOIN lenders ln ON ln.id=s.lender_id WHERE s.sent_at>=? AND s.sent_at<?${p.user ? ' AND s.user_id=' + p.user : ''}`).all(p.from, p.to);
    const by = {};
    for (const s of subs) {
      const o = by[s.lender_id] = by[s.lender_id] || { lender: s.lender, subs: 0, approved: 0, funded: 0, declined: 0, info: 0, pending: 0, factors: [], offers: [], resp: [], reasons: {} };
      o.subs++; if (s.status === 'approved') o.approved++; else if (s.status === 'funded') { o.funded++; } else if (s.status === 'declined') o.declined++; else if (s.status === 'info_needed') o.info++; else if (s.status === 'submitted') o.pending++;
      if (s.offer_factor) o.factors.push(s.offer_factor); if (s.offer_amount) o.offers.push(s.offer_amount);
      if (s.status !== 'submitted' && s.updated_at > s.sent_at) o.resp.push((s.updated_at - s.sent_at) / 3600000);
      if (s.status === 'declined' && s.decline_reason) { const k = s.decline_reason.trim().slice(0, 60); o.reasons[k] = (o.reasons[k] || 0) + 1; }
    }
    const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const money = db.prepare(`SELECT ln.name lender, COUNT(*) n, COALESCE(SUM(d.funded_amount),0) amt, COALESCE(SUM(${REV_SQL}),0) rev FROM deals d JOIN lenders ln ON ln.id=d.lender_id LEFT JOIN users u ON u.id=d.owner_id
      WHERE d.stage='funded' AND d.funded_at>=? AND d.funded_at<?${p.user ? ' AND d.owner_id=' + p.user : ''} GROUP BY d.lender_id`).all(p.from, p.to);
    const mm = Object.fromEntries(money.map(x => [x.lender, x]));
    const rows = Object.values(by).map(o => {
      const won = o.approved + o.funded, answered = o.subs - o.pending;
      return { lender: o.lender, subs: o.subs, approved: won, funded: o.funded, declined: o.declined, info: o.info, pending: o.pending, approve_pct: pct(won, o.subs), answered_pct: pct(answered, o.subs), decline_pct: pct(o.declined, o.subs),
        avg_factor: round(avg(o.factors), 2), avg_offer: avg(o.offers) != null ? Math.round(avg(o.offers)) : null, resp_hours: avg(o.resp) != null ? round(avg(o.resp), 1) : null,
        funded_amt: mm[o.lender]?.amt || 0, revenue: mm[o.lender]?.rev || 0, top_reason: Object.entries(o.reasons).sort((a, b) => b[1] - a[1])[0]?.[0] || '' };
    }).sort((a, b) => b.subs - a.subs);
    const reasons = {};
    for (const s of subs) if (s.status === 'declined') { const k = (s.decline_reason || '(no reason given)').trim().slice(0, 80); reasons[k] = (reasons[k] || 0) + 1; }
    const total = rows.reduce((a, x) => { a.subs += x.subs; a.won += x.approved; a.funded += x.funded; return a; }, { subs: 0, won: 0, funded: 0 });
    return { title: 'Lenders', note: 'Counts submissions sent in the date range.', kpis: [{ label: 'Submissions', value: total.subs, fmt: 'int' }, { label: 'Approval rate', value: pct(total.won, total.subs), fmt: 'pct' }, { label: 'Funded', value: total.funded, fmt: 'int' }],
      charts: [{ title: 'Approval rate by lender', labels: rows.map(x => x.lender), fmt: 'pct', series: [{ name: 'Approved %', values: rows.map(x => x.approve_pct || 0) }, { name: 'Declined %', values: rows.map(x => x.decline_pct || 0) }] }],
      tables: [{ id: 'lenders', title: 'Lender scorecard', csv: 'lenders', defaultSort: 'subs', columns: [col('lender', 'Lender'), col('subs', 'Sent', 'int'), col('pending', 'Waiting', 'int'), col('info', 'Need info', 'int'), col('approved', 'Approved', 'int'), col('declined', 'Declined', 'int'), col('funded', 'Funded', 'int'),
        col('approve_pct', 'Approval %', 'pct'), col('answered_pct', 'Answered %', 'pct'), col('resp_hours', 'Avg reply (hrs)', 'num'), col('avg_offer', 'Avg offer', 'money'), col('avg_factor', 'Avg factor', 'num'), col('funded_amt', 'Funded $', 'money'), col('revenue', 'Revenue', 'money'), col('top_reason', 'Top decline reason')], rows },
        { id: 'declines', title: 'Decline reasons', csv: 'decline-reasons', columns: [col('reason', 'Reason'), col('n', 'Count', 'int', { bar: 1 })], rows: Object.entries(reasons).map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n).slice(0, 30) }] };
  }

  // =========================================================== calls
  function qaTable(p, cu) {
    const rows = db.prepare(`SELECT c.id, c.lead_id, c.started_at, c.qa, c.qa_flags, u.name rep, l.business, l.name lead_name FROM calls c LEFT JOIN users u ON u.id=c.user_id LEFT JOIN leads l ON l.id=c.lead_id
      WHERE c.qa IN ('flagged','reviewed') AND c.started_at>=? AND c.started_at<?${cu} ORDER BY c.started_at DESC LIMIT 50`).all(p.from, p.to);
    return { id: 'qa', title: 'Calls flagged by QA', csv: 'qa-flags', columns: [col('lead', 'Lead', 'link'), col('rep', 'Rep'), col('when', 'When', 'datetime'), col('problem', 'What was flagged'), col('state', 'Review')],
      rows: rows.map(x => { let f = []; try { f = JSON.parse(x.qa_flags) || []; } catch {} return { lead: x.business || x.lead_name || 'Lead', rep: x.rep || '', when: x.started_at, problem: [].concat(f).map(z => z.text).join('; '), state: x.qa === 'reviewed' ? 'Reviewed' : 'Needs review', _href: '#/lead/' + x.lead_id }; }) };
  }
  function callsReport(p) {
    const cu = p.user ? ' AND c.user_id=' + p.user : '', base = `FROM calls c WHERE c.started_at>=? AND c.started_at<? AND c.direction='out'${cu}`;
    const dispos = db.prepare(`SELECT disposition d, COUNT(*) n ${base} AND disposition!='' GROUP BY d ORDER BY n DESC`).all(p.from, p.to), dTot = dispos.reduce((a, x) => a + x.n, 0);
    const hours = db.prepare(`SELECT ${hourExpr('c.started_at', p.offMs)} h, COUNT(*) dials, SUM(connected) connects, SUM(disposition IN ${INTERESTED}) interested ${base} GROUP BY h ORDER BY h`).all(p.from, p.to)
      .map(x => ({ hour: hourLabel(x.h), dials: x.dials, connects: x.connects, connect_rate: pct(x.connects, x.dials), interested: x.interested, interest_rate: pct(x.interested, x.connects) }));
    const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dows = db.prepare(`SELECT ${dowExpr('c.started_at', p.offMs)} w, COUNT(*) dials, SUM(connected) connects, SUM(disposition IN ${INTERESTED}) interested ${base} GROUP BY w ORDER BY w`).all(p.from, p.to)
      .map(x => ({ day: DOW[x.w], dials: x.dials, connects: x.connects, connect_rate: pct(x.connects, x.dials), interested: x.interested, interest_rate: pct(x.interested, x.connects) }));
    const lens = [['Under 10 sec', 0, 10], ['10–30 sec', 10, 30], ['30–60 sec', 30, 60], ['1–3 min', 60, 180], ['3–10 min', 180, 600], ['10+ min', 600, 1e9]].map(([label, a, b]) => {
      const x = db.prepare(`SELECT COUNT(*) n, SUM(disposition IN ${INTERESTED}) intr ${base} AND connected=1 AND duration>=? AND duration<?`).get(p.from, p.to, a, b);
      return { length: label, calls: x.n, interested: x.intr || 0, interest_rate: pct(x.intr || 0, x.n) };
    });
    const nums = db.prepare(`SELECT from_number num, COUNT(*) dials, SUM(connected) connects, MAX(started_at) last_at ${base} AND from_number IS NOT NULL GROUP BY from_number ORDER BY dials DESC LIMIT 60`).all(p.from, p.to);
    const avgRate = pct(nums.reduce((a, x) => a + (x.connects || 0), 0), nums.reduce((a, x) => a + x.dials, 0)) || 0;
    const numRows = nums.map(x => ({ ...x, connect_rate: pct(x.connects, x.dials), flag: x.dials >= 30 && pct(x.connects, x.dials) < avgRate * 0.5 ? 'Check — low connect rate' : '' }));
    const states = db.prepare(`SELECT l.state st, COUNT(*) dials, SUM(c.connected) connects, SUM(c.disposition IN ${INTERESTED}) interested FROM calls c JOIN leads l ON l.id=c.lead_id
      WHERE c.started_at>=? AND c.started_at<? AND c.direction='out'${cu} AND l.state!='' GROUP BY l.state HAVING dials>=10 ORDER BY dials DESC LIMIT 60`).all(p.from, p.to)
      .map(x => ({ state: x.st, dials: x.dials, connects: x.connects, connect_rate: pct(x.connects, x.dials), interested: x.interested, interest_rate: pct(x.interested, x.connects) }));
    const scoreBuckets = [['85–100 (great)', 85, 101], ['70–84 (good)', 70, 85], ['50–69 (needs work)', 50, 70], ['Under 50', 0, 50]].map(([label, a, b]) => ({ range: label, calls: db.prepare(`SELECT COUNT(*) n ${base} AND score>=? AND score<?`).get(p.from, p.to, a, b).n }));
    const obj = {};
    for (const x of db.prepare(`SELECT ai ${base} AND ai_status='done'`).all(p.from, p.to)) for (let cat of (safeJSON(x.ai, {}).objection_categories || [])) { if (!OBJECTION_CATEGORIES.includes(cat)) cat = 'other'; obj[cat] = (obj[cat] || 0) + 1; }
    const worst = db.prepare(`SELECT c.id, c.lead_id, c.score, c.duration, c.started_at, c.disposition, u.name rep, COALESCE(NULLIF(l.business,''), NULLIF(l.name,''), l.phone) lead FROM calls c JOIN leads l ON l.id=c.lead_id LEFT JOIN users u ON u.id=c.user_id
      WHERE c.started_at>=? AND c.started_at<? AND c.direction='out' AND c.score IS NOT NULL${cu} ORDER BY c.score ASC, c.started_at DESC LIMIT 15`).all(p.from, p.to).map(x => ({ ...x, _href: '#/lead/' + x.lead_id }));
    const best = db.prepare(`SELECT c.id, c.lead_id, c.score, c.duration, c.started_at, c.disposition, u.name rep, COALESCE(NULLIF(l.business,''), NULLIF(l.name,''), l.phone) lead FROM calls c JOIN leads l ON l.id=c.lead_id LEFT JOIN users u ON u.id=c.user_id
      WHERE c.started_at>=? AND c.started_at<? AND c.direction='out' AND c.score IS NOT NULL${cu} ORDER BY c.score DESC, c.started_at DESC LIMIT 15`).all(p.from, p.to).map(x => ({ ...x, _href: '#/lead/' + x.lead_id }));
    const T = totals(p.from, p.to, p.user);
    const callCols = [col('lead', 'Lead', 'link'), col('rep', 'Rep'), col('score', 'Score', 'int', { score: 1 }), col('duration', 'Length', 'dur'), col('disposition', 'Outcome'), col('started_at', 'When', 'datetime')];
    return { title: 'Calls', kpis: [{ label: 'Dials', value: T.dials, fmt: 'int' }, { label: 'Conversations', value: T.connects, fmt: 'int' }, { label: 'Connect rate', value: pct(T.connects, T.dials), fmt: 'pct' }, { label: 'Talk time', value: T.talk, fmt: 'dur' }],
      charts: [{ title: 'Connect rate by hour of day', labels: hours.map(x => x.hour), fmt: 'pct', series: [{ name: 'Connect %', values: hours.map(x => x.connect_rate || 0) }] }],
      tables: [qaTable(p, cu), 
        { id: 'hours', title: 'Best hours to call', csv: 'calls-by-hour', noSort: true, columns: [col('hour', 'Hour'), col('dials', 'Dials', 'int'), col('connects', 'Convos', 'int'), col('connect_rate', 'Connect %', 'pct', { bar: 1 }), col('interested', 'Interested', 'int'), col('interest_rate', 'Interest %', 'pct')], rows: hours },
        { id: 'dow', title: 'Best days to call', csv: 'calls-by-weekday', noSort: true, columns: [col('day', 'Day'), col('dials', 'Dials', 'int'), col('connects', 'Convos', 'int'), col('connect_rate', 'Connect %', 'pct', { bar: 1 }), col('interested', 'Interested', 'int'), col('interest_rate', 'Interest %', 'pct')], rows: dows },
        { id: 'dispos', title: 'Outcomes', csv: 'call-outcomes', columns: [col('d', 'Outcome'), col('n', 'Calls', 'int', { bar: 1 }), col('p', '% of dispositioned', 'pct')], rows: dispos.map(x => ({ ...x, p: pct(x.n, dTot) })) },
        { id: 'lens', title: 'Does a longer conversation lead to interest?', csv: 'call-length', noSort: true, columns: [col('length', 'Conversation length'), col('calls', 'Calls', 'int'), col('interested', 'Interested', 'int'), col('interest_rate', 'Interest %', 'pct', { bar: 1 })], rows: lens },
        { id: 'states', title: 'By state (10+ dials)', csv: 'calls-by-state', columns: [col('state', 'State'), col('dials', 'Dials', 'int'), col('connects', 'Convos', 'int'), col('connect_rate', 'Connect %', 'pct'), col('interested', 'Interested', 'int'), col('interest_rate', 'Interest %', 'pct')], rows: states },
        { id: 'numbers', title: 'Number health', csv: 'number-health', columns: [col('num', 'Caller ID'), col('dials', 'Dials', 'int'), col('connects', 'Convos', 'int'), col('connect_rate', 'Connect %', 'pct'), col('last_at', 'Last used', 'datetime'), col('flag', 'Flag')], rows: numRows },
        { id: 'objections', title: 'Objections heard', csv: 'objections', columns: [col('category', 'Objection'), col('n', 'Times', 'int', { bar: 1 })], rows: Object.entries(obj).map(([category, n]) => ({ category: category.replace(/_/g, ' '), n })).sort((a, b) => b.n - a.n) },
        { id: 'scores', title: 'Call score distribution', csv: 'call-scores', noSort: true, columns: [col('range', 'Score'), col('calls', 'Calls', 'int', { bar: 1 })], rows: scoreBuckets },
        { id: 'best', title: 'Highest-scored calls', csv: 'best-calls', noSort: true, columns: callCols, rows: best },
        { id: 'worst', title: 'Lowest-scored calls (coaching list)', csv: 'worst-calls', noSort: true, columns: callCols, rows: worst }] };
  }

  // =========================================================== texts, email, sequences
  function messagingReport(p) {
    const users = db.prepare('SELECT id, name FROM users WHERE active=1 AND role!=\'iso\' ORDER BY name').all().filter(u => !p.user || u.id === p.user);
    const out = Object.fromEntries(db.prepare("SELECT user_id, COUNT(*) n, COUNT(DISTINCT lead_id) leads FROM messages WHERE direction='out' AND created_at>=? AND created_at<? AND user_id IS NOT NULL GROUP BY user_id").all(p.from, p.to).map(x => [x.user_id, x]));
    // a lead "replied" if an inbound text arrived within 3 days after one of our texts
    const reply = Object.fromEntries(db.prepare(`SELECT m.user_id, COUNT(DISTINCT m.lead_id) n FROM messages m WHERE m.direction='out' AND m.created_at>=? AND m.created_at<? AND m.user_id IS NOT NULL
      AND EXISTS(SELECT 1 FROM messages r WHERE r.lead_id=m.lead_id AND r.direction='in' AND r.created_at>m.created_at AND r.created_at<m.created_at+259200000) GROUP BY m.user_id`).all(p.from, p.to).map(x => [x.user_id, x.n]));
    const eout = Object.fromEntries(db.prepare("SELECT user_id, COUNT(*) n FROM emails WHERE direction='out' AND lead_id IS NOT NULL AND created_at>=? AND created_at<? AND user_id IS NOT NULL GROUP BY user_id").all(p.from, p.to).map(x => [x.user_id, x.n]));
    const sl = Object.fromEntries(db.prepare("SELECT user_id, COUNT(*) n FROM messages WHERE direction='out' AND enrollment_id IS NOT NULL AND created_at>=? AND created_at<? AND user_id IS NOT NULL GROUP BY user_id").all(p.from, p.to).map(x => [x.user_id, x.n]));
    const rows = users.map(u => ({ rep: u.name, texts: out[u.id]?.n || 0, leads: out[u.id]?.leads || 0, replied: reply[u.id] || 0, reply_pct: pct(reply[u.id] || 0, out[u.id]?.leads || 0), auto: sl[u.id] || 0, emails: eout[u.id] || 0 }));
    const m = db.prepare("SELECT COALESCE(SUM(direction='out'),0) sent, COALESCE(SUM(direction='in'),0) recv, COALESCE(SUM(direction='out' AND status IN ('failed','undelivered')),0) failed FROM messages WHERE created_at>=? AND created_at<?").get(p.from, p.to);
    const stops = db.prepare("SELECT COUNT(*) n FROM dnc WHERE created_at>=? AND created_at<? AND (reason LIKE '%STOP%' OR reason LIKE '%SMS%')").get(p.from, p.to).n;
    const e = db.prepare("SELECT COALESCE(SUM(direction='out' AND lead_id IS NOT NULL),0) sent, COALESCE(SUM(direction='in' AND lead_id IS NOT NULL),0) recv, COALESCE(SUM(direction='out' AND submission_id IS NOT NULL),0) lender FROM emails WHERE created_at>=? AND created_at<?").get(p.from, p.to);
    const seqs = db.prepare(`SELECT s.name, COUNT(e.id) enrolled, SUM(e.status='active') active, SUM(e.status='done') done, SUM(e.status='stopped') stopped,
      SUM(e.status='stopped' AND (e.stop_reason LIKE '%repl%' OR e.stop_reason LIKE '%text%' OR e.stop_reason LIKE '%email%')) replied,
      SUM(EXISTS(SELECT 1 FROM deals d WHERE d.lead_id=e.lead_id AND d.created_at>=e.started_at)) to_deal,
      SUM(EXISTS(SELECT 1 FROM deals d WHERE d.lead_id=e.lead_id AND d.created_at>=e.started_at AND d.stage='funded')) funded
      FROM sequences s LEFT JOIN enrollments e ON e.sequence_id=s.id AND e.started_at>=? AND e.started_at<? GROUP BY s.id ORDER BY enrolled DESC`).all(p.from, p.to)
      .map(x => ({ ...x, reply_pct: pct(x.replied, x.enrolled), deal_pct: pct(x.to_deal, x.enrolled) }));
    const stopWhy = db.prepare("SELECT COALESCE(NULLIF(stop_reason,''),'(none)') reason, COUNT(*) n FROM enrollments WHERE status='stopped' AND started_at>=? AND started_at<? GROUP BY reason ORDER BY n DESC LIMIT 15").all(p.from, p.to);
    const first = db.prepare('SELECT MIN(created_at) t FROM messages').get().t, b = buckets(p, first), by = b.monthly ? monthExpr : dayExpr;
    const md = Object.fromEntries(db.prepare(`SELECT ${by('created_at', p.offMs)} k, SUM(direction='out') sent, SUM(direction='in') recv FROM messages WHERE created_at>=? AND created_at<? GROUP BY k`).all(p.from, p.to).map(x => [x.k, x]));
    return { title: 'Texts, email & sequences', note: 'Reply = the lead texted back within 3 days of a text from that rep.',
      kpis: [{ label: 'Texts sent', value: m.sent, fmt: 'int' }, { label: 'Texts received', value: m.recv, fmt: 'int' }, { label: 'Failed texts', value: m.failed, fmt: 'int' }, { label: 'STOP opt-outs', value: stops, fmt: 'int' },
        { label: 'Emails to merchants', value: e.sent, fmt: 'int' }, { label: 'Merchant email replies', value: e.recv, fmt: 'int' }, { label: 'Lender submission emails', value: e.lender, fmt: 'int' }],
      charts: [{ title: 'Texts per period', labels: b.keys.map(x => bucketLabel(x, b.monthly)), fmt: 'int', series: [{ name: 'Sent', values: b.keys.map(x => md[x]?.sent || 0) }, { name: 'Received', values: b.keys.map(x => md[x]?.recv || 0) }] }],
      tables: [{ id: 'msgreps', title: 'By rep', csv: 'messaging-by-rep', columns: [col('rep', 'Rep'), col('texts', 'Texts sent', 'int'), col('leads', 'Leads texted', 'int'), col('replied', 'Replied', 'int'), col('reply_pct', 'Reply %', 'pct'), col('auto', 'From sequences', 'int'), col('emails', 'Emails sent', 'int')], rows },
        { id: 'seqs', title: 'Sequences', csv: 'sequences', columns: [col('name', 'Sequence'), col('enrolled', 'Enrolled', 'int'), col('active', 'Running', 'int'), col('done', 'Finished', 'int'), col('stopped', 'Stopped', 'int'), col('replied', 'Stopped by reply', 'int'), col('reply_pct', 'Reply %', 'pct'), col('to_deal', 'Became a deal', 'int'), col('deal_pct', 'Deal %', 'pct'), col('funded', 'Funded', 'int')], rows: seqs },
        { id: 'stopwhy', title: 'Why sequences stopped', csv: 'sequence-stops', columns: [col('reason', 'Reason'), col('n', 'Count', 'int', { bar: 1 })], rows: stopWhy }] };
  }

  // =========================================================== lead inventory
  function inventoryReport(p) {
    const t = now();
    const src = db.prepare(`SELECT source, COUNT(*) total, SUM(status='new' AND attempts=0) untouched, SUM(status='new') new_n, SUM(status='callback') callbacks, SUM(status='callback' AND callback_at<?) overdue, SUM(status='done') done, SUM(status='dnc') dnc,
      ROUND(AVG(attempts),1) avg_attempts, SUM(status='new' AND attempts>=6) maxed FROM leads WHERE source!='' GROUP BY source ORDER BY total DESC`).all(t);
    const own = db.prepare(`SELECT COALESCE(u.name,'Shared pool') owner, COUNT(*) total, SUM(l.status='new' AND l.attempts=0) untouched, SUM(l.status='callback') callbacks, SUM(l.status='callback' AND l.callback_at<?) overdue, SUM(l.status='done') done
      FROM leads l LEFT JOIN users u ON u.id=l.owner_id GROUP BY l.owner_id ORDER BY total DESC`).all(t);
    const att = db.prepare("SELECT MIN(attempts,6) a, COUNT(*) n FROM leads WHERE status NOT IN ('dnc','done') GROUP BY a ORDER BY a").all().map(x => ({ tries: x.a >= 6 ? '6 or more' : String(x.a), n: x.n }));
    const stat = db.prepare('SELECT status, COUNT(*) n FROM leads GROUP BY status ORDER BY n DESC').all();
    const tot = stat.reduce((a, x) => a + x.n, 0);
    const cb = db.prepare(`SELECT l.id, COALESCE(NULLIF(l.business,''),NULLIF(l.name,''),l.phone) lead, u.name owner, l.callback_at, l.source FROM leads l LEFT JOIN users u ON u.id=l.owner_id
      WHERE l.status='callback' AND l.callback_at<? ORDER BY l.callback_at LIMIT 100`).all(t).map(x => ({ ...x, days: Math.round((t - x.callback_at) / DAY), _href: '#/lead/' + x.id }));
    return { title: 'Lead inventory', note: 'A snapshot of your lead database right now. The date range does not apply here.',
      kpis: [{ label: 'Total leads', value: tot, fmt: 'int' }, ...stat.slice(0, 4).map(x => ({ label: x.status === 'new' ? 'New / in rotation' : x.status === 'done' ? 'Closed' : x.status === 'dnc' ? 'DNC' : 'Callbacks', value: x.n, fmt: 'int' }))],
      charts: [], tables: [
        { id: 'inv_src', title: 'By lead source', csv: 'inventory-by-source', columns: [col('source', 'Source'), col('total', 'Leads', 'int'), col('untouched', 'Never dialed', 'int', { bar: 1 }), col('new_n', 'In rotation', 'int'), col('maxed', 'Hit max tries', 'int'), col('callbacks', 'Callbacks', 'int'), col('overdue', 'Overdue callbacks', 'int'),
          col('done', 'Closed', 'int'), col('dnc', 'DNC', 'int'), col('avg_attempts', 'Avg tries', 'num')], rows: src },
        { id: 'inv_own', title: 'By owner', csv: 'inventory-by-owner', columns: [col('owner', 'Owner'), col('total', 'Leads', 'int'), col('untouched', 'Never dialed', 'int'), col('callbacks', 'Callbacks', 'int'), col('overdue', 'Overdue callbacks', 'int'), col('done', 'Closed', 'int')], rows: own },
        { id: 'inv_att', title: 'How many times open leads have been dialed', csv: 'inventory-attempts', noSort: true, columns: [col('tries', 'Dial attempts'), col('n', 'Leads', 'int', { bar: 1 })], rows: att },
        { id: 'inv_cb', title: 'Overdue callbacks (oldest first)', csv: 'overdue-callbacks', noSort: true, columns: [col('lead', 'Lead', 'link'), col('owner', 'Owner'), col('callback_at', 'Was due', 'datetime'), col('days', 'Days late', 'int', { bar: 1 }), col('source', 'Source')], rows: cb }] };
  }


  // =========================================================== portfolio (in-house funded deals: payments, behind, NSFs)
  function portfolioReport(p) {
    const pay = ctx.payments; if (!pay) return { title: 'Portfolio', kpis: [], charts: [], tables: [] };
    const list = pay.portfolio().filter(x => !p.user || x.d.owner_id === p.user);
    const t = now();
    const active = list.filter(x => x.s.status !== 'paid_off');
    const tracked = list.filter(x => x.s.rows.length);
    const funded = list.reduce((a, x) => a + (x.d.funded_amount || 0), 0), payback = list.reduce((a, x) => a + (x.d.payback || 0), 0), received = list.reduce((a, x) => a + x.s.received, 0);
    const outstanding = active.reduce((a, x) => a + (x.s.outstanding || 0), 0);
    const behind = list.filter(x => x.s.status === 'behind');
    const nsf30 = list.reduce((a, x) => a + x.s.nsf_30, 0);
    const exp = tracked.reduce((a, x) => a + (x.s.expected || 0), 0), rec = tracked.reduce((a, x) => a + x.s.received, 0);
    const kpis = [{ label: 'Active deals', value: active.length, fmt: 'int' }, { label: 'Total funded', value: funded, fmt: 'money' }, { label: 'Total to be repaid', value: payback, fmt: 'money' },
      { label: 'Collected so far', value: received, fmt: 'money' }, { label: 'Still outstanding', value: outstanding, fmt: 'money' }, { label: 'Collected vs expected', value: pct(rec, exp), fmt: 'pct' },
      { label: 'Behind on payments', value: behind.length, fmt: 'int' }, { label: 'NSFs (last 30 days)', value: nsf30, fmt: 'int' }];
    const name = x => x.d.lead_business || x.d.lead_name || x.d.title;
    const row = x => ({ deal: name(x), owner: x.d.owner_name || '', funded_at: x.d.funded_at, funded: x.d.funded_amount, payback: x.d.payback, collected: x.s.received, pct: pct(x.s.received, x.d.payback), outstanding: x.s.outstanding,
      expected: x.s.expected, missed: x.s.rows.length ? x.s.missed : null, nsf: x.s.nsf_total, nsf30: x.s.nsf_30, last: x.s.last_payment_on, status: ({ current: 'On track', behind: 'Behind', paid_off: 'Paid in full', no_data: 'No payments entered' })[x.s.status], _href: '#/deal/' + x.d.id });
    const cols = [col('deal', 'Merchant', 'link'), col('owner', 'Owner'), col('funded_at', 'Funded', 'date'), col('funded', 'Funded $', 'money'), col('payback', 'Payback', 'money'), col('collected', 'Collected', 'money'), col('pct', 'Paid %', 'pct', { bar: 1 }), col('outstanding', 'Outstanding', 'money'), col('missed', 'Missed', 'int'), col('nsf30', 'NSF 30d', 'int'), col('last', 'Last payment', 'date'), col('status', 'Status')];
    // weekly collections (last 12 weeks)
    const wk = []; for (let i = 11; i >= 0; i--) { const to = t - i * 7 * DAY, from = to - 7 * DAY; const r = db.prepare("SELECT COALESCE(SUM(CASE WHEN kind!='nsf' THEN amount END),0) paid, COALESCE(SUM(CASE WHEN kind='nsf' THEN amount END),0) nsf FROM payments WHERE paid_on>=? AND paid_on<?").get(from, to); wk.push({ week: new Date(to - DAY).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), collected: r.paid, returned: r.nsf }); }
    const nsfRows = db.prepare("SELECT p.*, d.id deal_id, l.business, l.name FROM payments p JOIN deals d ON d.id=p.deal_id JOIN leads l ON l.id=d.lead_id WHERE p.kind='nsf' ORDER BY p.paid_on DESC LIMIT 40").all().map(x => ({ deal: x.business || x.name, paid_on: x.paid_on, amount: x.amount, note: x.note, _href: '#/deal/' + x.deal_id }));
    const renew = list.filter(x => x.d.payback && x.s.received / x.d.payback * 100 >= Number(getSetting('renewal_pct', 50)) && x.s.status !== 'behind' && x.s.status !== 'paid_off').map(row);
    const iso = db.prepare("SELECT u.name, COUNT(*) deals, SUM(d.funded_amount) volume, SUM(ROUND(d.funded_amount*COALESCE(d.iso_pct,0))/100.0) earned, SUM(CASE WHEN d.iso_paid_at IS NOT NULL THEN ROUND(d.funded_amount*COALESCE(d.iso_pct,0))/100.0 ELSE 0 END) paid FROM deals d JOIN users u ON u.id=d.iso_id WHERE d.stage='funded' GROUP BY u.id ORDER BY volume DESC").all().map(x => ({ ...x, owed: x.earned - x.paid }));
    return { title: 'Portfolio', note: 'In-house funded deals only. Payments come from what you enter or import on each deal; deals with no payments entered show a schedule estimate and are not flagged as behind.', kpis,
      charts: [{ title: 'Collected per week (last 12 weeks)', labels: wk.map(x => x.week), fmt: 'money', series: [{ name: 'Collected', values: wk.map(x => x.collected) }, { name: 'Returned (NSF)', values: wk.map(x => x.returned) }] }],
      tables: [{ id: 'behind', title: 'Behind on payments', csv: 'behind-on-payments', columns: cols, rows: behind.map(row) },
        { id: 'active', title: 'All active deals', csv: 'portfolio-active', columns: cols, rows: active.map(row) },
        { id: 'nsf', title: 'Recent NSFs / returned payments', csv: 'nsf', columns: [col('deal', 'Merchant', 'link'), col('paid_on', 'Date', 'date'), col('amount', 'Amount', 'money'), col('note', 'Note')], rows: nsfRows },
        { id: 'renew', title: 'Ready to renew (paid past the renewal threshold, current)', csv: 'renewal-ready', columns: cols, rows: renew },
        { id: 'iso', title: 'Partner (ISO) payouts', csv: 'iso-payouts', columns: [col('name', 'Partner'), col('deals', 'Funded deals', 'int'), col('volume', 'Volume', 'money'), col('earned', 'Commission earned', 'money'), col('paid', 'Paid', 'money'), col('owed', 'Owed', 'money')], rows: iso }] };
  }


  // =========================================================== money: team P&L, deal performance, funders
  const hasMoney = () => { try { db.prepare('SELECT 1 FROM funder_payments LIMIT 1').get(); return true; } catch { return false; } };
  function teamReport(p) {
    if (!hasMoney()) return { title: 'Team P&L', kpis: [], charts: [], tables: [] };
    const base = `FROM funder_payments f JOIN deals d ON d.id=f.deal_id JOIN leads l ON l.id=d.lead_id LEFT JOIN lenders ln ON ln.id=d.lender_id WHERE d.funded_at>=? AND d.funded_at<?${p.user ? ' AND (d.owner_id=' + p.user + ' OR d.closer_id=' + p.user + ')' : ''}`;
    const pay = db.prepare(`SELECT f.type, f.status, COUNT(*) n, COALESCE(SUM(f.amount),0) amt ${base} GROUP BY f.type, f.status`).all(p.from, p.to);
    const dist = db.prepare(`SELECT x.type, x.status, COALESCE(SUM(x.amount),0) amt FROM distributions x JOIN deals d ON d.id=x.deal_id WHERE d.funded_at>=? AND d.funded_at<?${p.user ? ' AND (d.owner_id=' + p.user + ' OR d.closer_id=' + p.user + ')' : ''} GROUP BY x.type, x.status`).all(p.from, p.to);
    const S = (a, f) => a.filter(f).reduce((n, x) => n + x.amt, 0);
    const cPay = S(pay, x => x.type === 'commission'), fPay = S(pay, x => x.type === 'fee'), cDist = S(dist, x => x.type === 'commission'), fDist = S(dist, x => x.type === 'fee');
    const got = S(pay, x => x.status === 'received'), owed = S(pay, x => x.status === 'outstanding'), dPaid = S(dist, x => x.status === 'paid'), dDue = S(dist, x => x.status === 'pending');
    const kpis = [{ label: 'Commission payments', value: cPay, fmt: 'money' }, { label: 'Fee payments', value: fPay, fmt: 'money' }, { label: 'Total payments', value: cPay + fPay, fmt: 'money' },
      { label: 'Commission distributions', value: cDist, fmt: 'money' }, { label: 'Fee distributions', value: fDist, fmt: 'money' }, { label: 'Total distributions', value: cDist + fDist, fmt: 'money' },
      { label: 'Commission profit', value: cPay - cDist, fmt: 'money' }, { label: 'Fee profit', value: fPay - fDist, fmt: 'money' }, { label: 'Total profit', value: cPay + fPay - cDist - fDist, fmt: 'money' },
      { label: 'Received from funders', value: got, fmt: 'money' }, { label: 'Still owed by funders', value: owed, fmt: 'money' }, { label: 'Owed to reps (pending)', value: dDue, fmt: 'money' }];
    const first = db.prepare(`SELECT MIN(d.funded_at) t ${base}`).get(p.from, p.to)?.t;
    const b = buckets(p, first), ex = dayExpr('d.funded_at', p.offMs), mx = b.monthly ? monthExpr('d.funded_at', p.offMs) : ex;
    const dp = Object.fromEntries(db.prepare(`SELECT ${mx} k, SUM(f.amount) a ${base} GROUP BY k`).all(p.from, p.to).map(x => [x.k, x.a]));
    const dd = Object.fromEntries(db.prepare(`SELECT ${mx} k, SUM(x.amount) a FROM distributions x JOIN deals d ON d.id=x.deal_id WHERE d.funded_at>=? AND d.funded_at<?${p.user ? ' AND (d.owner_id=' + p.user + ' OR d.closer_id=' + p.user + ')' : ''} GROUP BY k`).all(p.from, p.to).map(x => [x.k, x.a]));
    const byFunder = db.prepare(`SELECT COALESCE(ln.name,'In-house') funder, COUNT(DISTINCT d.id) deals, COALESCE(SUM(d.funded_amount),0) funded, COALESCE(SUM(f.amount),0) payments, COALESCE(SUM(f.amount),0)-COALESCE(SUM((SELECT SUM(x.amount) FROM distributions x WHERE x.payment_id=f.id)),0) profit ${base} GROUP BY ln.id ORDER BY payments DESC`).all(p.from, p.to);
    const byRep = db.prepare(`SELECT u.name, COUNT(DISTINCT x.deal_id) deals, SUM(x.amount) earned, SUM(CASE WHEN x.status='paid' THEN x.amount ELSE 0 END) paid, SUM(CASE WHEN x.status='pending' THEN x.amount ELSE 0 END) pending
      FROM distributions x JOIN users u ON u.id=x.user_id JOIN deals d ON d.id=x.deal_id WHERE d.funded_at>=? AND d.funded_at<?${p.user ? ' AND x.user_id=' + p.user : ''} GROUP BY x.user_id ORDER BY earned DESC`).all(p.from, p.to);
    const owedRows = db.prepare(`SELECT f.id, d.id deal_id, COALESCE(NULLIF(l.business,''),l.name) deal, COALESCE(ln.name,'In-house') funder, f.amount, f.expected_on, d.funded_at ${base} AND f.status='outstanding' ORDER BY f.expected_on LIMIT 200`).all(p.from, p.to)
      .map(x => ({ ...x, late: x.expected_on ? Math.max(0, Math.floor((now() - x.expected_on) / DAY)) : null, _href: '#/deal/' + x.deal_id }));
    return { title: 'Team P&L', note: 'Counts deals funded in the date range. Payments are what funders pay you; distributions are what you owe your reps and partners out of them; profit is what is left.', kpis,
      charts: [{ title: 'Payments vs distributions', labels: b.keys.map(k => bucketLabel(k, b.monthly)), fmt: 'money', series: [{ name: 'Payments', values: b.keys.map(k => dp[k] || 0) }, { name: 'Distributions', values: b.keys.map(k => dd[k] || 0) }] }],
      tables: [{ id: 'funders', title: 'Profit by funder', csv: 'profit-by-funder', defaultSort: 'profit', columns: [col('funder', 'Funder'), col('deals', 'Deals', 'int'), col('funded', 'Funded $', 'money'), col('payments', 'Payments', 'money'), col('profit', 'Profit to house', 'money', { signed: 1 })], rows: byFunder },
        { id: 'reps', title: 'Payouts by person', csv: 'payouts-by-person', defaultSort: 'earned', columns: [col('name', 'Person'), col('deals', 'Deals', 'int'), col('earned', 'Earned', 'money'), col('paid', 'Paid', 'money'), col('pending', 'Still owed', 'money')], rows: byRep },
        { id: 'owed', title: 'Funder payments not received yet', csv: 'outstanding-funder-payments', columns: [col('deal', 'Deal', 'link'), col('funder', 'Funder'), col('amount', 'Amount', 'money'), col('funded_at', 'Funded', 'date'), col('expected_on', 'Expected', 'date'), col('late', 'Days late', 'int', { bar: 1 })], rows: owedRows }] };
  }

  function dealsReport(p) {
    const w = 'd.created_at>=? AND d.created_at<?', ow = p.user ? ' AND d.owner_id=' + p.user : '';
    const users = db.prepare("SELECT id,name FROM users WHERE role!='iso' AND active=1 ORDER BY name").all();
    const inRows = Object.fromEntries(db.prepare(`SELECT d.owner_id id, COUNT(*) n, SUM(EXISTS(SELECT 1 FROM submissions s WHERE s.deal_id=d.id)) subm,
      SUM(EXISTS(SELECT 1 FROM submissions s WHERE s.deal_id=d.id AND (s.status IN ('approved','funded') OR s.offer_amount>0))) appr FROM deals d WHERE ${w}${ow} GROUP BY d.owner_id`).all(p.from, p.to).map(x => [x.id, x]));
    const fRows = Object.fromEntries(db.prepare(`SELECT d.owner_id id, COUNT(*) n, COALESCE(SUM(d.funded_amount),0) amt, AVG(d.funded_amount) avg_amt FROM deals d WHERE d.stage='funded' AND d.funded_at>=? AND d.funded_at<?${ow} GROUP BY d.owner_id`).all(p.from, p.to).map(x => [x.id, x]));
    const dRows = hasMoney() ? Object.fromEntries(db.prepare(`SELECT x.user_id id, SUM(x.amount) amt FROM distributions x JOIN deals d ON d.id=x.deal_id WHERE d.funded_at>=? AND d.funded_at<?${p.user ? ' AND x.user_id=' + p.user : ''} GROUP BY x.user_id`).all(p.from, p.to).map(x => [x.id, x.amt])) : {};
    const rows = users.map(u => { const i = inRows[u.id] || {}, f = fRows[u.id] || {}, dist = dRows[u.id] || 0;
      return { name: u.name, deals_in: i.n || 0, submitted: i.subm || 0, approved: i.appr || 0, funded: f.n || 0, funded_amt: f.amt || 0, sub_ratio: pct(i.subm || 0, i.n || 0), appr_ratio: pct(i.appr || 0, i.subm || 0), close_ratio: pct(f.n || 0, i.appr || 0),
        avg_funded: f.avg_amt != null ? Math.round(f.avg_amt) : null, dist, per_in: round(div(dist, i.n), 2), per_sub: round(div(dist, i.subm), 2), per_appr: round(div(dist, i.appr), 2), per_funded: round(div(dist, f.n), 2) }; })
      .filter(x => x.deals_in || x.funded || x.dist).sort((a, b) => b.funded_amt - a.funded_amt || b.deals_in - a.deals_in);
    const T = rows.reduce((a, x) => { for (const k of ['deals_in', 'submitted', 'approved', 'funded', 'funded_amt', 'dist']) a[k] += x[k]; return a; }, { deals_in: 0, submitted: 0, approved: 0, funded: 0, funded_amt: 0, dist: 0 });
    const first = db.prepare(`SELECT MIN(created_at) t FROM deals d WHERE ${w}${ow}`).get(p.from, p.to)?.t, b = buckets(p, first), mx = b.monthly ? monthExpr('d.created_at', p.offMs) : dayExpr('d.created_at', p.offMs);
    const over = Object.fromEntries(db.prepare(`SELECT ${mx} k, COUNT(*) n FROM deals d WHERE ${w}${ow} GROUP BY k`).all(p.from, p.to).map(x => [x.k, x.n]));
    const fx = b.monthly ? monthExpr('d.funded_at', p.offMs) : dayExpr('d.funded_at', p.offMs);
    const fover = Object.fromEntries(db.prepare(`SELECT ${fx} k, COALESCE(SUM(d.funded_amount),0) a FROM deals d WHERE d.stage='funded' AND d.funded_at>=? AND d.funded_at<?${ow} GROUP BY k`).all(p.from, p.to).map(x => [x.k, x.a]));
    const funded = db.prepare(`SELECT d.id, COALESCE(NULLIF(l.business,''),l.name) deal, COALESCE(ln.name,'In-house') funder, d.funded_amount amount, d.funded_at, u.name owner, ${REV_SQL} revenue
      FROM deals d JOIN leads l ON l.id=d.lead_id LEFT JOIN users u ON u.id=d.owner_id ${'LEFT JOIN lenders ln ON ln.id=d.lender_id'} WHERE d.stage='funded' AND d.funded_at>=? AND d.funded_at<?${ow} ORDER BY d.funded_at DESC LIMIT 300`).all(p.from, p.to).map(x => ({ ...x, _href: '#/deal/' + x.id }));
    const top = funded.slice().sort((a, b) => b.amount - a.amount).slice(0, 12);
    const kpis = [{ label: 'Deals in', value: T.deals_in, fmt: 'int' }, { label: 'Submitted', value: T.submitted, fmt: 'int' }, { label: 'Approved', value: T.approved, fmt: 'int' }, { label: 'Funded', value: T.funded, fmt: 'int' },
      { label: 'Amount funded', value: T.funded_amt, fmt: 'money' }, { label: 'Paid to reps (earned)', value: T.dist, fmt: 'money' },
      { label: 'Submission ratio', value: pct(T.submitted, T.deals_in), fmt: 'pct' }, { label: 'Approval ratio', value: pct(T.approved, T.submitted), fmt: 'pct' }, { label: 'Closing ratio', value: pct(T.funded, T.approved), fmt: 'pct' },
      { label: 'Avg funded deal', value: T.funded ? Math.round(T.funded_amt / T.funded) : null, fmt: 'money' }];
    return { title: 'Deal performance', note: 'Deals in, submitted and approved count deals created in the range. Funded counts deals funded in the range. Ratios: submitted ÷ in, approved ÷ submitted, funded ÷ approved. Dollar values are what the rep earned per deal at that stage.', kpis,
      charts: [{ title: 'Deals created over time', labels: b.keys.map(k => bucketLabel(k, b.monthly)), fmt: 'int', series: [{ name: 'Deals', values: b.keys.map(k => over[k] || 0) }] },
        { title: 'Amount funded over time', labels: b.keys.map(k => bucketLabel(k, b.monthly)), fmt: 'money', series: [{ name: 'Funded $', values: b.keys.map(k => fover[k] || 0) }] },
        { title: 'Biggest funded deals', horizontal: 1, labels: top.map(x => x.deal), fmt: 'money', series: [{ name: 'Funded', values: top.map(x => x.amount) }] }],
      tables: [{ id: 'dreps', title: 'Rep deal scorecard', csv: 'rep-deals', defaultSort: 'funded_amt', columns: [col('name', 'Rep'), col('deals_in', 'Deals in', 'int'), col('submitted', 'Submitted', 'int'), col('approved', 'Approved', 'int'), col('funded', 'Funded', 'int'), col('funded_amt', 'Funded $', 'money'),
        col('sub_ratio', 'Submission %', 'pct'), col('appr_ratio', 'Approval %', 'pct'), col('close_ratio', 'Closing %', 'pct'), col('avg_funded', 'Avg funded', 'money'), col('dist', 'Earned', 'money'),
        col('per_in', '$ / deal in', 'money2'), col('per_sub', '$ / submitted', 'money2'), col('per_appr', '$ / approved', 'money2'), col('per_funded', '$ / funded', 'money')], rows },
        { id: 'fundeddeals', title: 'Funded deals', csv: 'funded-deals', columns: [col('deal', 'Deal', 'link'), col('owner', 'Owner'), col('funder', 'Funder'), col('amount', 'Funded', 'money'), col('revenue', 'Company revenue', 'money'), col('funded_at', 'Funded', 'datetime')], rows: funded }] };
  }

  function fundersReport(p) {
    const subs = db.prepare(`SELECT s.lender_id, COUNT(*) subs, SUM(s.status IN ('approved','funded') OR s.offer_amount>0) approved, COALESCE(SUM(CASE WHEN s.status IN ('approved','funded') OR s.offer_amount>0 THEN s.offer_amount END),0) approved_amt
      FROM submissions s WHERE s.sent_at>=? AND s.sent_at<?${p.user ? ' AND s.user_id=' + p.user : ''} GROUP BY s.lender_id`).all(p.from, p.to);
    const fund = Object.fromEntries(db.prepare(`SELECT d.lender_id id, COUNT(*) n, COALESCE(SUM(d.funded_amount),0) amt, COALESCE(SUM(${REV_SQL}),0) rev FROM deals d LEFT JOIN lenders ln ON ln.id=d.lender_id LEFT JOIN users u ON u.id=d.owner_id
      WHERE d.stage='funded' AND d.funded_at>=? AND d.funded_at<? GROUP BY d.lender_id`).all(p.from, p.to).map(x => [x.id, x]));
    const earned = hasMoney() ? Object.fromEntries(db.prepare(`SELECT d.lender_id id, SUM(f.amount) amt, SUM(CASE WHEN f.status='outstanding' THEN f.amount ELSE 0 END) owed FROM funder_payments f JOIN deals d ON d.id=f.deal_id WHERE d.funded_at>=? AND d.funded_at<? GROUP BY d.lender_id`).all(p.from, p.to).map(x => [x.id, x])) : {};
    const names = Object.fromEntries(db.prepare('SELECT id,name FROM lenders').all().map(x => [x.id, x.name]));
    const ids = new Set([...subs.map(x => x.lender_id), ...Object.keys(fund).map(k => k === 'null' ? null : Number(k)), ...Object.keys(earned).map(k => k === 'null' ? null : Number(k))]);
    const sm = Object.fromEntries(subs.map(x => [x.lender_id, x]));
    const rows = [...ids].map(id => { const s = sm[id] || {}, f = fund[id] || {}, e = earned[id] || {};
      return { funder: id ? names[id] || 'Unknown' : 'In-house', funded_amt: f.amt || 0, units: f.n || 0, approved_amt: s.approved_amt || 0, earned: e.amt != null ? e.amt : f.rev || 0, owed: e.owed || 0, subs: s.subs || 0, approved: s.approved || 0, appr_pct: pct(s.approved || 0, s.subs || 0), fund_pct: pct(f.n || 0, s.approved || 0), avg_funded: f.n ? Math.round(f.amt / f.n) : null, earn_pct: f.amt ? round((e.amt != null ? e.amt : f.rev || 0) / f.amt * 100, 1) : null }; })
      .filter(x => x.subs || x.units || x.earned).sort((a, b) => b.funded_amt - a.funded_amt);
    const T = rows.reduce((a, x) => { a.funded += x.funded_amt; a.units += x.units; a.earned += x.earned; a.subs += x.subs; a.owed += x.owed; return a; }, { funded: 0, units: 0, earned: 0, subs: 0, owed: 0 });
    const byEarn = rows.slice().sort((a, b) => b.earned - a.earned).slice(0, 12);
    return { title: 'Funders', note: 'Per funder in the date range: submissions sent, offers approved, deals funded, and what the funder paid (or owes) you. “Earn %” is your commission as a percent of the funded amount.',
      kpis: [{ label: 'Funders used', value: rows.length, fmt: 'int' }, { label: 'Submissions', value: T.subs, fmt: 'int' }, { label: 'Units funded', value: T.units, fmt: 'int' }, { label: 'Amount funded', value: T.funded, fmt: 'money' }, { label: 'Commission earned', value: T.earned, fmt: 'money' }, { label: 'Not received yet', value: T.owed, fmt: 'money' }],
      charts: [{ title: 'Commission earned by funder (top 12)', horizontal: 1, labels: byEarn.map(x => x.funder), fmt: 'money', series: [{ name: 'Earned', values: byEarn.map(x => x.earned) }] }],
      tables: [{ id: 'funderpl', title: 'Funder analytics', csv: 'funder-analytics', defaultSort: 'funded_amt', columns: [col('funder', 'Funder'), col('funded_amt', 'Amount funded', 'money'), col('units', 'Units funded', 'int'), col('approved_amt', 'Amount approved', 'money'), col('earned', 'Amount earned', 'money'), col('owed', 'Not received', 'money'), col('subs', 'Submitted deals', 'int'),
        col('approved', 'Approved', 'int'), col('appr_pct', 'Approval %', 'pct'), col('fund_pct', 'Funded / approved %', 'pct'), col('avg_funded', 'Avg funded', 'money'), col('earn_pct', 'Earn % of funded', 'pct')], rows }] };
  }

  const REPORTS = { team: teamReport, deals: dealsReport, funders: fundersReport, portfolio: portfolioReport, overview, reps: repsReport, sources: sourcesReport, funnel: funnelReport, pipeline: pipelineReport, lenders: lendersReport, calls: callsReport, messaging: messagingReport, inventory: inventoryReport };
  r.get('/api/reports/:name', adminOnly, (req, res) => {
    const fn = REPORTS[req.params.name]; if (!fn) return res.status(404).json({ error: 'Unknown report' });
    try { res.json(fn(params(req))); } catch (e) { console.error('Report failed:', e); res.status(500).json({ error: 'Report failed: ' + e.message }); }
  });

  // ---- lead sources: list with costs, set cost ----
  r.get('/api/sources', adminOnly, (req, res) => {
    const costs = Object.fromEntries(db.prepare('SELECT * FROM lead_sources').all().map(x => [x.name, x]));
    const rows = db.prepare("SELECT source name, COUNT(*) leads, MIN(created_at) first_at FROM leads WHERE source!='' GROUP BY source ORDER BY MAX(created_at) DESC").all();
    res.json(rows.map(x => ({ ...x, total_cost: costs[x.name]?.total_cost ?? null, vendor: costs[x.name]?.vendor || '' })));
  });
  r.put('/api/sources', adminOnly, (req, res) => {
    const list = Array.isArray(req.body.sources) ? req.body.sources : [];
    db.transaction(() => {
      for (const s of list) {
        const name = String(s.name || '').trim(); if (!name) continue;
        const cost = s.total_cost === '' || s.total_cost == null ? null : Math.max(0, Number(s.total_cost));
        db.prepare('INSERT INTO lead_sources(name,total_cost,vendor,created_at) VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET total_cost=excluded.total_cost, vendor=excluded.vendor').run(name, Number.isFinite(cost) ? cost : null, String(s.vendor || '').trim(), now());
      }
    })();
    res.json({ ok: true });
  });
  return { router: r, build: (name, p) => REPORTS[name](p) };
};
