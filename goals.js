// Rep goals + live leaderboard
const express = require('express');
const { db, getSetting, audit } = require('./db');
const safeJSON = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };
const KEYS = ['dials', 'connects', 'apps', 'funded'];
module.exports = function goals(ctx) {
  const r = express.Router();
  const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const startOfMonth = () => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const startOfWeek = () => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
  function goalsFor(u, def) { const mine = safeJSON(u.goals, {}); const g = {}; for (const k of KEYS) g[k] = mine[k] != null && mine[k] !== '' ? Number(mine[k]) : Number(def[k] || 0); return g; }
  function board(period) {
    const from = period === 'month' ? startOfMonth() : period === 'week' ? startOfWeek() : startOfDay(), mFrom = startOfMonth();
    const def = (getSetting('goals', {}) || {});
    const users = db.prepare("SELECT id,name,role,goals FROM users WHERE active=1 AND role!='iso' ORDER BY name").all();
    return users.map(u => {
      const c = db.prepare(`SELECT COUNT(*) dials, COALESCE(SUM(connected),0) connects, COALESCE(SUM(CASE WHEN connected=1 THEN duration END),0) talk, COALESCE(SUM(disposition='App Sent'),0) apps, COALESCE(SUM(disposition='Interested'),0) interested
        FROM calls WHERE user_id=? AND direction='out' AND started_at>=?`).get(u.id, from);
      const f = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(funded_amount),0) amt FROM deals WHERE owner_id=? AND stage='funded' AND funded_at>=?`).get(u.id, from);
      const fm = db.prepare(`SELECT COALESCE(SUM(funded_amount),0) amt FROM deals WHERE owner_id=? AND stage='funded' AND funded_at>=?`).get(u.id, mFrom);
      const g = goalsFor(u, def);
      return { id: u.id, name: u.name, dials: c.dials, connects: c.connects, talk: c.talk, apps: c.apps, interested: c.interested, funded_n: f.n, funded_amt: f.amt, month_funded: fm.amt, goals: g, own_goals: safeJSON(u.goals, {}) };
    });
  }
  r.get('/api/leaderboard', (req, res) => {
    const period = ['today', 'week', 'month'].includes(req.query.period) ? req.query.period : 'today';
    res.json({ period, rows: board(period), defaults: (getSetting('goals', {}) || {}), me: req.user.id });
  });
  r.get('/api/my-goals', (req, res) => {
    const me = board('today').find(x => x.id === req.user.id); if (!me) return res.json({});
    const all = board('today').slice().sort((a, b) => b.dials - a.dials), rank = all.findIndex(x => x.id === me.id) + 1;
    res.json({ ...me, rank, of: all.length });
  });
  r.patch('/api/users/:id/goals', ctx.adminOnly, (req, res) => {
    const g = {}; for (const k of KEYS) { const v = req.body[k]; if (v !== '' && v != null && !isNaN(Number(v))) g[k] = Math.max(0, Number(v)); }
    db.prepare('UPDATE users SET goals=? WHERE id=?').run(JSON.stringify(g), Number(req.params.id));
    audit(req, 'goals.update', 'user', Number(req.params.id), JSON.stringify(g)); res.json({ ok: true });
  });
  return { router: r };
};
