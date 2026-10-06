// DNC / litigator scrub: upload your own lists, and/or check every new lead against a provider you subscribe to
const express = require('express');
const { db, getSetting, setSetting, audit } = require('./db');
const now = () => Date.now();
const DEFAULTS = { enabled: false, provider_url: '', api_key: '', mode: 'flag_if_contains', match_text: '', reason: 'Scrub provider', rps: 5, hold: false };

module.exports = function scrub(ctx) {
  const { normPhone, adminOnly, log, emitAll } = ctx;
  const r = express.Router();
  const cfg = () => ({ ...DEFAULTS, ...(getSetting('scrub', {}) || {}) });
  let lastError = '', running = false, checked = 0, flagged = 0;

  const digits = t => {
    const out = new Set();
    for (const line of String(t || '').split(/[\r\n,;\t]+/)) {
      const one = normPhone(line.trim()); if (one) { out.add(one); continue; }
      for (const m of line.split(/\s+/)) { const p = normPhone(m); if (p) out.add(p); }
    }
    return [...out];
  };
  function addDncBulk(phones, reason) {
    let fresh = 0, leads = 0;
    const has = db.prepare('SELECT 1 FROM dnc WHERE phone=?'), ins = db.prepare('INSERT OR IGNORE INTO dnc(phone,reason,created_at) VALUES(?,?,?)'), upd = db.prepare("UPDATE leads SET status='dnc', updated_at=? WHERE phone=? AND status!='dnc'");
    db.transaction(() => { for (const p of phones) { if (!has.get(p)) fresh++; ins.run(p, reason, now()); leads += upd.run(now(), p).changes; } })();
    return { fresh, leads };
  }
  r.get('/api/scrub', adminOnly, (req, res) => {
    const s = cfg(), by = db.prepare("SELECT reason, COUNT(*) n, MAX(created_at) last_at FROM dnc GROUP BY reason ORDER BY n DESC").all();
    res.json({ settings: { ...s, api_key: s.api_key ? '••••' : '' }, by_reason: by, total: db.prepare('SELECT COUNT(*) n FROM dnc').get().n,
      pending: db.prepare("SELECT COUNT(*) n FROM leads WHERE scrub_at IS NULL AND status IN ('new','callback')").get().n, checked, flagged, last_error: lastError });
  });
  r.put('/api/scrub', adminOnly, (req, res) => {
    const b = req.body || {}, old = cfg();
    const s = { enabled: !!b.enabled, provider_url: String(b.provider_url || '').trim().slice(0, 500), api_key: b.api_key && b.api_key !== '••••' ? String(b.api_key).trim().slice(0, 300) : old.api_key,
      mode: b.mode === 'flag_unless_contains' ? 'flag_unless_contains' : 'flag_if_contains', match_text: String(b.match_text || '').trim().slice(0, 200), reason: String(b.reason || 'Scrub provider').trim().slice(0, 60) || 'Scrub provider',
      rps: Math.min(20, Math.max(1, Number(b.rps) || 5)), hold: !!b.hold };
    if (s.enabled && (!/^https:\/\//i.test(s.provider_url) || !s.match_text)) return res.status(400).json({ error: 'Enter the provider web address (https://…) and the text that marks a number as blocked' });
    setSetting('scrub', s);
    audit(req, 'scrub.settings', 'settings', 'scrub', s.enabled ? 'enabled' : 'disabled'); lastError = ''; res.json({ ok: true });
  });
  r.post('/api/scrub/upload', adminOnly, (req, res) => {
    const label = String(req.body.label || '').trim().slice(0, 60); if (!label) return res.status(400).json({ error: 'Give the list a name (for example “Litigator list” or “NY state DNC”)' });
    const phones = digits(req.body.text); if (!phones.length) return res.status(400).json({ error: 'No phone numbers found' });
    if (req.body.dry) {
      const has = db.prepare('SELECT 1 FROM dnc WHERE phone=?'); let already = 0, matches = 0; const lead = db.prepare("SELECT 1 FROM leads WHERE phone=? AND status!='dnc'");
      for (const p of phones) { if (has.get(p)) already++; if (lead.get(p)) matches++; }
      return res.json({ dry: true, numbers: phones.length, already_blocked: already, matching_leads: matches });
    }
    const o = addDncBulk(phones, label); audit(req, 'scrub.upload', 'dnc', label, `${phones.length} numbers, ${o.leads} leads blocked`);
    emitAll('lead_update', {}); res.json({ ok: true, numbers: phones.length, new_blocked: o.fresh, leads_blocked: o.leads });
  });
  r.post('/api/scrub/run', adminOnly, (req, res) => {
    if (!cfg().enabled) return res.status(400).json({ error: 'Turn on the provider check first' });
    db.prepare("UPDATE leads SET scrub_at=NULL WHERE status IN ('new','callback')").run(); worker(); res.json({ ok: true });
  });
  r.post('/api/scrub/remove', adminOnly, (req, res) => {
    const label = String(req.body.label || ''); if (!label) return res.status(400).json({ error: 'Pick a list' });
    const n = db.prepare('DELETE FROM dnc WHERE reason=?').run(label).changes; audit(req, 'scrub.remove', 'dnc', label, `${n} numbers removed from DNC (leads already marked DNC stay that way)`); res.json({ removed: n });
  });

  async function check(phone, s) {
    const url = s.provider_url.replace(/\{phone\}/g, encodeURIComponent(phone.replace(/^\+1/, ''))).replace(/\{e164\}/g, encodeURIComponent(phone)).replace(/\{key\}/g, encodeURIComponent(s.api_key || ''));
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
    try {
      const resp = await fetch(url, { signal: ctl.signal, headers: s.api_key ? { Authorization: 'Bearer ' + s.api_key } : {} });
      const body = (await resp.text()).toLowerCase();
      if (!resp.ok) throw new Error(`Provider answered ${resp.status}`);
      const has = body.includes(s.match_text.toLowerCase());
      return s.mode === 'flag_unless_contains' ? !has : has;
    } finally { clearTimeout(t); }
  }
  async function worker() {
    const s = cfg(); if (!s.enabled || running) return; running = true;
    try {
      let errs = 0;
      for (;;) {
        const batch = db.prepare("SELECT id, phone FROM leads WHERE scrub_at IS NULL AND status IN ('new','callback') ORDER BY id DESC LIMIT ?").all(s.rps);
        if (!batch.length) break;
        const res = await Promise.all(batch.map(async l => { try { const bad = await check(l.phone, s); return { l, bad }; } catch (e) { return { l, err: e.message }; } }));
        for (const x of res) {
          if (x.err) { errs++; lastError = x.err; continue; }
          checked++; db.prepare('UPDATE leads SET scrub_at=? WHERE id=?').run(now(), x.l.id);
          if (x.bad) { flagged++; ctx.addDnc(x.l.phone, s.reason); }
        }
        if (errs >= 10) { log('Scrub: stopping after repeated provider errors:', lastError); break; }
        await new Promise(r => setTimeout(r, 1000));
      }
      if (!errs) lastError = '';
    } finally { running = false; }
  }
  setInterval(() => { try { if (cfg().enabled) worker(); } catch {} }, 20000).unref();
  // when the provider is off, leads are marked as checked-against-our-lists the moment they arrive so nothing is held back
  setInterval(() => { try { if (!cfg().enabled) db.prepare("UPDATE leads SET scrub_at=? WHERE scrub_at IS NULL").run(now()); } catch {} }, 20000).unref();
  return { router: r, worker, cfg };
};
module.exports.DEFAULTS = DEFAULTS;
