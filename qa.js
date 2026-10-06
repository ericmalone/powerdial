// Call QA flags + transcript search (SQLite FTS5)
const express = require('express');
const { db, getSetting, setSetting, audit, hasFts } = require('./db');
const now = () => Date.now();
const safeJSON = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };

const QA_DEFAULTS = {
  enabled: true, ai: true,
  prohibited: ['guaranteed approval', 'guarantee you', 'guaranteed funding', 'no risk', 'risk free', 'risk-free', 'no credit check', 'this is a loan', 'apr of'],
  required: [], require_disclosure: false, disclosure_phrase: 'recorded',
};

module.exports = function qa(ctx) {
  const { claude, log, adminOnly, emitAll } = ctx;
  const r = express.Router();
  const cfg = () => ({ ...QA_DEFAULTS, ...(getSetting('qa', {}) || {}) });
  const textOf = c => [c.transcript, c.live_transcript].filter(Boolean).sort((a, b) => b.length - a.length)[0] || '';

  // ---------- search index ----------
  function index(c) {
    if (!hasFts) return;
    const t = textOf(c), ai = safeJSON(c.ai, {}), body = [t, c.notes, ai.summary].filter(Boolean).join('\n');
    db.prepare('DELETE FROM call_fts WHERE call_id=?').run(c.id);
    if (body.trim()) db.prepare('INSERT INTO call_fts(text, call_id) VALUES(?,?)').run(body, c.id);
  }
  // ---------- QA ----------
  function keywordFlags(text, c) {
    const flags = [], lc = text.toLowerCase();
    for (const ph of c.prohibited || []) {
      const p = String(ph).trim().toLowerCase(); if (!p) continue;
      const i = lc.indexOf(p); if (i >= 0) flags.push({ type: 'prohibited', severity: 'high', text: `Said “${ph}”`, quote: text.slice(Math.max(0, i - 80), i + p.length + 80).replace(/\s+/g, ' ') });
    }
    for (const ph of c.required || []) { const p = String(ph).trim().toLowerCase(); if (p && !lc.includes(p)) flags.push({ type: 'missing', severity: 'med', text: `Never said “${ph}”` }); }
    if (c.require_disclosure && c.disclosure_phrase && !lc.includes(String(c.disclosure_phrase).toLowerCase())) flags.push({ type: 'missing', severity: 'med', text: 'No recording disclosure heard' });
    return flags;
  }
  async function aiFlags(text, call) {
    if (!process.env.ANTHROPIC_API_KEY) return [];
    const j = await claude(`You review sales calls for a merchant cash advance (business funding) company for compliance problems. Read the call transcript and return ONLY JSON: {"flags":[{"type":"misleading|pressure|dnc_ignored|rude|privacy|other","severity":"high|med|low","text":"one short sentence","quote":"the exact words, max 160 chars"}]}.
Flag ONLY clear problems: promising or implying guaranteed approval, specific rates/amounts or "no risk"; calling the product a loan; false urgency or pressure tactics; continuing after the person asked to stop or be removed from the list; abusive or rude language; asking for full SSN or bank login on the call. Normal sales persistence is NOT a problem. If there are none, return {"flags":[]}.

TRANSCRIPT:
${text.slice(0, 24000)}`, 800);
    return (Array.isArray(j.flags) ? j.flags : []).slice(0, 8).map(f => ({ type: String(f.type || 'other'), severity: ['high', 'med', 'low'].includes(f.severity) ? f.severity : 'med', text: String(f.text || '').slice(0, 200), quote: String(f.quote || '').slice(0, 220), ai: true }));
  }
  async function process_(id) {
    const c = db.prepare('SELECT * FROM calls WHERE id=?').get(id); if (!c) return;
    const text = textOf(c); const s = cfg();
    index(c);
    if (!s.enabled || text.trim().split(/\s+/).length < 25) { db.prepare("UPDATE calls SET qa=? WHERE id=?").run(s.enabled ? 'clean' : 'skipped', id); return; }
    let flags = keywordFlags(text, s);
    if (s.ai) { try { flags = flags.concat(await aiFlags(text, c)); } catch (e) { log('QA AI error:', e.message); } }
    db.prepare('UPDATE calls SET qa=?, qa_flags=? WHERE id=?').run(flags.length ? 'flagged' : 'clean', JSON.stringify(flags), id);
    if (flags.length) {
      const lead = db.prepare('SELECT business,name FROM leads WHERE id=?').get(c.lead_id) || {};
      for (const a of db.prepare("SELECT id FROM users WHERE role='admin' AND active=1").all()) ctx.emitTo(a.id, 'deal_alert', { dealId: null, callId: id, text: `Call flagged: ${flags[0].text} (${lead.business || lead.name || 'lead'})` });
    }
  }
  let busy = false;
  async function sweep() {
    if (busy) return; busy = true;
    try {
      const t = now();
      const ids = db.prepare(`SELECT id FROM calls WHERE qa IS NULL AND (transcript IS NOT NULL AND transcript!='' OR live_transcript IS NOT NULL AND live_transcript!='')
        AND ended_at IS NOT NULL AND ((ai_status IN ('done','skipped','error')) OR ended_at<?) ORDER BY id DESC LIMIT 15`).all(t - 10 * 60000);
      for (const x of ids) { try { await process_(x.id); } catch (e) { log('QA error:', e.message); db.prepare("UPDATE calls SET qa='error' WHERE id=?").run(x.id); } }
    } finally { busy = false; }
  }
  setTimeout(sweep, 5000); setInterval(sweep, Number(process.env.QA_SWEEP_SECONDS || 30) * 1000).unref();

  r.get('/api/qa', adminOnly, (req, res) => {
    const status = req.query.status === 'all' ? null : 'flagged';
    const rows = db.prepare(`SELECT c.id, c.lead_id, c.started_at, c.duration, c.qa, c.qa_flags, c.disposition, u.name rep, l.business, l.name lead_name FROM calls c LEFT JOIN users u ON u.id=c.user_id LEFT JOIN leads l ON l.id=c.lead_id
      WHERE c.qa ${status ? "='flagged'" : "IN ('flagged','reviewed')"} ORDER BY c.started_at DESC LIMIT 100`).all().map(x => ({ ...x, flags: [].concat(safeJSON(x.qa_flags, [])).filter(Boolean), qa_flags: undefined }));
    const counts = db.prepare("SELECT qa, COUNT(*) n FROM calls WHERE qa IS NOT NULL GROUP BY qa").all();
    res.json({ rows, counts: Object.fromEntries(counts.map(x => [x.qa, x.n])), settings: cfg() });
  });
  r.put('/api/qa/settings', adminOnly, (req, res) => {
    const b = req.body || {}, list = v => (Array.isArray(v) ? v : String(v || '').split(/\n/)).map(x => String(x).trim()).filter(Boolean).slice(0, 60).map(x => x.slice(0, 100));
    setSetting('qa', { enabled: b.enabled !== false, ai: b.ai !== false, prohibited: list(b.prohibited), required: list(b.required), require_disclosure: !!b.require_disclosure, disclosure_phrase: String(b.disclosure_phrase || 'recorded').slice(0, 80) });
    audit(req, 'settings.update', 'settings', 'qa', ''); res.json({ ok: true });
  });
  r.post('/api/calls/:id/qa', adminOnly, (req, res) => {
    const id = Number(req.params.id), a = req.body.action;
    if (a === 'dismiss') db.prepare("UPDATE calls SET qa='reviewed' WHERE id=?").run(id);
    else if (a === 'recheck') { db.prepare('UPDATE calls SET qa=NULL WHERE id=?').run(id); sweep(); }
    else return res.status(400).json({ error: 'Unknown action' });
    audit(req, 'qa.' + a, 'call', id); res.json({ ok: true });
  });
  r.post('/api/qa/run', adminOnly, (req, res) => { db.prepare("UPDATE calls SET qa=NULL WHERE qa IN ('clean','skipped','error') AND started_at>?").run(now() - 30 * 864e5); sweep(); res.json({ ok: true }); });

  // ---------- search ----------
  const ftsQuery = q => String(q || '').replace(/["']/g, ' ').split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).slice(0, 12).map(w => '"' + w.replace(/[^\p{L}\p{N}_-]/gu, '') + '"').filter(w => w.length > 2).join(' ');
  r.get('/api/search/calls', (req, res) => {
    if (!hasFts) return res.status(501).json({ error: 'Search is not available on this database build' });
    const q = ftsQuery(req.query.q); if (!q) return res.json({ rows: [], total: 0 });
    const mine = req.user.role !== 'admin', who = !mine && req.query.rep ? Number(req.query.rep) : mine ? req.user.id : null;
    const from = Number(req.query.from) || 0, to = Number(req.query.to) || now() + 1;
    try {
      const rows = db.prepare(`SELECT c.id, c.lead_id, c.started_at, c.duration, c.disposition, c.score, c.qa, u.name rep, l.business, l.name lead_name, snippet(call_fts, 0, '[[', ']]', ' … ', 28) snip, bm25(call_fts) rank
        FROM call_fts JOIN calls c ON c.id=call_fts.call_id LEFT JOIN users u ON u.id=c.user_id LEFT JOIN leads l ON l.id=c.lead_id
        WHERE call_fts MATCH ? AND c.started_at>=? AND c.started_at<? ${who ? 'AND c.user_id=' + who : ''} ORDER BY rank LIMIT 60`).all(q, from, to);
      res.json({ rows, total: rows.length, q });
    } catch (e) { res.status(400).json({ error: 'Search failed: ' + e.message }); }
  });
  // backfill the index on startup
  setTimeout(() => {
    if (!hasFts) return;
    try {
      const ids = db.prepare(`SELECT id FROM calls WHERE ((transcript IS NOT NULL AND transcript!='') OR (live_transcript IS NOT NULL AND live_transcript!='')) AND id NOT IN (SELECT call_id FROM call_fts)`).all();
      db.transaction(() => { for (const x of ids) index(db.prepare('SELECT * FROM calls WHERE id=?').get(x.id)); })();
      if (ids.length) log(`Search index: added ${ids.length} calls`);
    } catch (e) { log('Search index error:', e.message); }
  }, 3000);
  return { router: r, sweep, index, QA_DEFAULTS };
};
module.exports.QA_DEFAULTS = QA_DEFAULTS;
