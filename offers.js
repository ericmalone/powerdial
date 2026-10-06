// Offers (compare, send to merchant, merchant picks) and the funding contract (send + e-sign)
const express = require('express');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { db, getSetting, filesDir, audit } = require('./db');
const { contractPdf } = require('./pdf');
const now = () => Date.now();
const safeJSON = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };
const money = n => n == null ? '—' : '$' + Math.round(Number(n)).toLocaleString('en-US');
const DEFAULT_CONTRACT = `[PLACEHOLDER — NOT A REAL AGREEMENT]
Replace this text in Automation → Offers & contract with your attorney-approved funding agreement. Merge fields you can use: {business} {owner} {company} {date} {purchase_price} {purchased_amount} {factor} {term_days} {payment} {frequency} {deal_id}.`;

module.exports = function offers(ctx) {
  const { emitTo, emitAll, sendSms, fillTpl, PUBLIC_URL, log, adminOnly } = ctx;
  const r = express.Router();
  const D = () => ctx.deals;
  const company = () => process.env.COMPANY_NAME || 'Brookestone Funding';
  const hits = new Map();
  const limited = (req, max) => { const k = req.ip, t = now(); const a = (hits.get(k) || []).filter(x => t - x < 60000); a.push(t); hits.set(k, a); return a.length > max; };
  const byToken = t => db.prepare('SELECT * FROM deals WHERE upload_token=?').get(String(t || ''));
  const leadOf = d => db.prepare('SELECT * FROM leads WHERE id=?').get(d.lead_id) || {};
  const repOf = d => db.prepare('SELECT id,name,email FROM users WHERE id=?').get(d.owner_id) || {};
  const tell = (d, text, hot) => { if (d.owner_id) emitTo(d.owner_id, 'deal_alert', { dealId: d.id, text }); emitAll('deal_update', { dealId: d.id, leadId: d.lead_id }); };

  // ---------- offers ----------
  function cost(s) { return s.offer_amount && s.offer_factor ? Math.round(s.offer_amount * s.offer_factor * 100) / 100 : null; }
  function paymentOf(s) {
    if (s.offer_payment) return { amount: s.offer_payment, est: false };
    const pb = cost(s); if (!pb || !s.offer_term_days) return { amount: null, est: false };
    const n = s.offer_freq === 'weekly' ? s.offer_term_days / 7 : s.offer_term_days * 5 / 7;
    return { amount: Math.round(pb / n * 100) / 100, est: true };
  }
  function offerRows(d) {
    const subs = db.prepare(`SELECT s.*, ln.name lender_name, ln.in_house, ln.broker_pct FROM submissions s JOIN lenders ln ON ln.id=s.lender_id
      WHERE s.deal_id=? AND s.status IN ('approved','funded') AND s.offer_amount IS NOT NULL ORDER BY s.offer_factor, s.offer_amount DESC`).all(d.id);
    const pub = safeJSON(d.offers_published, []);
    const rows = subs.map(s => {
      const pb = cost(s), pay = paymentOf(s), p = pub.find(x => x.sub_id === s.id);
      const co = s.in_house ? (pb ? Math.round((pb - s.offer_amount) * 100) / 100 : null) : (s.broker_pct ? Math.round(s.offer_amount * s.broker_pct) / 100 : null);
      return { sub_id: s.id, lender_id: s.lender_id, lender_name: s.lender_name, in_house: !!s.in_house, amount: s.offer_amount, factor: s.offer_factor, payback: pb, cost: pb ? Math.round((pb - s.offer_amount) * 100) / 100 : null,
        term_days: s.offer_term_days, payment: pay.amount, payment_est: pay.est, freq: s.offer_freq || 'daily', our_revenue: co, status: s.status, published: !!p, label: p ? p.label : null, chosen: d.offer_chosen === s.id };
    });
    if (rows.length) {
      const lowF = Math.min(...rows.filter(x => x.factor).map(x => x.factor)), hiA = Math.max(...rows.map(x => x.amount));
      for (const x of rows) { x.best_rate = !!x.factor && x.factor === lowF; x.most_cash = x.amount === hiA; }
    }
    return rows;
  }
  r.get('/api/deals/:id/offers', (req, res) => {
    const d = D().getDeal(Number(req.params.id)); if (!d) return res.status(404).json({ error: 'Deal not found' });
    res.json({ rows: offerRows(d), sent_at: d.offers_sent_at, chosen_at: d.offer_chosen_at, link: d.upload_token ? `${PUBLIC_URL}/offer/${d.upload_token}` : null, show_lender: getSetting('offers_show_lender', false) === true });
  });
  function applyOffer(d, subId, userId, why) {
    const s = db.prepare('SELECT s.*, ln.name lender_name FROM submissions s JOIN lenders ln ON ln.id=s.lender_id WHERE s.id=? AND s.deal_id=?').get(subId, d.id); if (!s) return null;
    const f = { lender_id: s.lender_id, funded_amount: s.offer_amount, factor_rate: s.offer_factor, payback: cost(s), term_days: s.offer_term_days, offer_chosen: s.id, updated_at: now() };
    const pay = paymentOf(s); f.payment_amount = pay.amount; f.payment_freq = s.offer_freq === 'weekly' ? 'weekly' : 'daily';
    db.prepare(`UPDATE deals SET ${Object.keys(f).map(k => k + '=?').join(',')} WHERE id=?`).run(...Object.values(f), d.id);
    D().event(d.id, userId, 'offer', `${why}: ${s.lender_name} — ${money(s.offer_amount)} at ${s.offer_factor}x${s.offer_term_days ? ', ' + s.offer_term_days + ' days' : ''}`);
    D().advance(D().getDeal(d.id), 'offer');
    return s;
  }
  r.post('/api/deals/:id/offers/accept', (req, res) => {
    const d = D().getDeal(Number(req.params.id)); if (!d) return res.status(404).json({ error: 'Deal not found' });
    const s = applyOffer(d, Number(req.body.sub_id), req.user.id, 'Offer selected');
    if (!s) return res.status(404).json({ error: 'Offer not found' });
    res.json({ ok: true });
  });
  r.post('/api/deals/:id/offers/publish', async (req, res) => {
    const d = D().getDeal(Number(req.params.id)); if (!d) return res.status(404).json({ error: 'Deal not found' });
    const ids = (req.body.sub_ids || []).map(Number), rows = offerRows(d).filter(x => ids.includes(x.sub_id));
    if (!rows.length) return res.status(400).json({ error: 'Pick at least one offer to show the merchant' });
    const pub = rows.map((x, i) => ({ sub_id: x.sub_id, label: String.fromCharCode(65 + i) }));
    db.prepare('UPDATE deals SET offers_published=?, updated_at=? WHERE id=?').run(JSON.stringify(pub), now(), d.id);
    const link = `${PUBLIC_URL}/offer/${D().ensureToken(d)}`, lead = leadOf(d), first = (lead.name || '').split(' ')[0] || 'there', rep = (req.user.name || '').split(' ')[0];
    try {
      if (req.body.via === 'sms') { const m = await sendSms(lead, `Hi ${first}, it's ${rep} with ${company()}. Good news — your funding offers are ready. Take a look and pick the one you like: ${link}`, req.user); if (m.status === 'failed') throw new Error('SMS failed: ' + m.error); }
      else if (req.body.via === 'email') { if (!lead.email) throw new Error('This lead has no email address'); await ctx.sendLeadEmail(lead, req.user, { subject: `Your ${company()} funding offers`, text: `Hi ${first},\n\nYour funding offers are ready. Review them and pick the one you like here:\n${link}\n\n${req.user.name}\n${company()}` }); }
    } catch (e) { return res.status(400).json({ error: e.message }); }
    if (req.body.via) db.prepare('UPDATE deals SET offers_sent_at=? WHERE id=?').run(now(), d.id);
    D().event(d.id, req.user.id, 'offer', `Showed ${rows.length} offer${rows.length > 1 ? 's' : ''} to the merchant${req.body.via ? ' (link sent by ' + req.body.via + ')' : ''}`);
    audit(req, 'offers.publish', 'deal', d.id, `${rows.length} offers`);
    res.json({ ok: true, link });
  });
  // merchant offer page
  r.get('/offer/:token', (req, res) => { if (!byToken(req.params.token)) return res.status(404).send('This link has expired. Please contact your funding specialist.'); res.sendFile(path.join(__dirname, 'public', 'offer.html')); });
  r.get('/offer-api/:token', (req, res) => {
    if (limited(req, 60)) return res.status(429).json({ error: 'Too many requests' });
    const d = byToken(req.params.token); if (!d) return res.status(404).json({ error: 'Link expired' });
    const lead = leadOf(d), pub = safeJSON(d.offers_published, []), show = getSetting('offers_show_lender', false) === true;
    const rows = offerRows(d).filter(x => pub.some(p => p.sub_id === x.sub_id)).map(x => ({ label: pub.find(p => p.sub_id === x.sub_id).label, amount: x.amount, factor: x.factor, payback: x.payback, cost: x.cost, term_days: x.term_days, payment: x.payment, payment_est: x.payment_est, freq: x.freq, lender: show ? x.lender_name : null, chosen: x.chosen })).sort((a, b) => a.label.localeCompare(b.label));
    res.json({ company: company(), rep: repOf(d).name || '', business: lead.business || d.title, offers: rows, chosen: (rows.find(x => x.chosen) || {}).label || null });
  });
  r.post('/offer-api/:token/choose', express.json({ limit: '10kb' }), (req, res) => {
    if (limited(req, 20)) return res.status(429).json({ error: 'Too many requests' });
    const d = byToken(req.params.token); if (!d) return res.status(404).json({ error: 'Link expired' });
    if (['funded', 'lost'].includes(d.stage) || d.contract_signed_at) return res.status(400).json({ error: 'This deal is already closed. Please contact your funding specialist.' });
    const pub = safeJSON(d.offers_published, []), p = pub.find(x => x.label === String(req.body.label || ''));
    if (!p) return res.status(400).json({ error: 'Pick one of the offers' });
    const s = applyOffer(d, p.sub_id, null, 'Merchant chose offer ' + p.label);
    db.prepare('UPDATE deals SET offer_chosen_at=? WHERE id=?').run(now(), d.id);
    if (s) tell(d, `${leadOf(d).business || d.title} chose offer ${p.label} (${money(s.offer_amount)}) — send the contract`, true);
    res.json({ ok: true });
  });

  // ---------- funding contract ----------
  function terms(d) {
    const lead = leadOf(d), a = D().decApp(D().appOf(d));
    return { business: a.legal_name || lead.business || d.title, owner: a.owner_name || lead.name || '', company: company(), date: new Date().toLocaleDateString('en-US'),
      purchase_price: money(d.funded_amount), purchased_amount: money(d.payback), factor: d.factor_rate != null ? String(d.factor_rate) : '—', term_days: d.term_days != null ? String(d.term_days) : '—',
      payment: money(d.payment_amount), frequency: d.payment_freq === 'weekly' ? 'weekly' : 'daily', deal_id: String(d.id) };
  }
  const render = (tpl, t) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => k in t ? t[k] : m);
  const termRows = t => [['Merchant', t.business], ['Funding amount (purchase price)', t.purchase_price], ['Amount to be repaid (purchased amount)', t.purchased_amount], ['Factor rate', t.factor], ['Payment', `${t.payment} ${t.frequency}`], ['Estimated term', `${t.term_days} days`]];
  const missing = d => ['funded_amount', 'factor_rate', 'payback', 'payment_amount', 'term_days'].filter(k => !d[k]).map(k => ({ funded_amount: 'funding amount', factor_rate: 'factor rate', payback: 'payback', payment_amount: 'payment', term_days: 'term' }[k]));
  const tplOf = () => { const t = String(getSetting('contract_template', '') || '').trim(); return t || null; };
  r.get('/api/deals/:id/contract', (req, res) => {
    const d = D().getDeal(Number(req.params.id)); if (!d) return res.status(404).json({ error: 'Deal not found' });
    const sig = safeJSON(d.contract_sig, null);
    res.json({ template_ready: !!tplOf(), missing: missing(d), sent_at: d.contract_sent_at, signed_at: d.contract_signed_at, signed_name: sig && sig.name, link: d.upload_token && d.contract_sent_at ? `${PUBLIC_URL}/sign/${d.upload_token}` : null });
  });
  r.post('/api/deals/:id/contract/send', async (req, res) => {
    const d = D().getDeal(Number(req.params.id)); if (!d) return res.status(404).json({ error: 'Deal not found' });
    if (!tplOf()) return res.status(400).json({ error: 'Add your funding agreement text first (Automation → Offers & contract).' });
    const m = missing(d); if (m.length) return res.status(400).json({ error: 'Fill in the funding terms first: ' + m.join(', ') });
    if (d.contract_signed_at && !req.body.resend) return res.status(400).json({ error: 'This contract is already signed.' });
    const body = render(tplOf(), terms(d));
    db.prepare('UPDATE deals SET contract_body=?, contract_sent_at=?, contract_signed_at=NULL, contract_sig=NULL, updated_at=? WHERE id=?').run(body, now(), now(), d.id);
    const link = `${PUBLIC_URL}/sign/${D().ensureToken(d)}`, lead = leadOf(d), first = (lead.name || '').split(' ')[0] || 'there', rep = (req.user.name || '').split(' ')[0];
    try {
      if (req.body.via === 'sms') { const x = await sendSms(lead, `Hi ${first}, it's ${rep} with ${company()}. Your funding agreement is ready to review and sign: ${link}`, req.user); if (x.status === 'failed') throw new Error('SMS failed: ' + x.error); }
      else if (req.body.via === 'email') { if (!lead.email) throw new Error('This lead has no email address'); await ctx.sendLeadEmail(lead, req.user, { subject: `Your ${company()} funding agreement`, text: `Hi ${first},\n\nYour funding agreement is ready. Review and sign it here:\n${link}\n\n${req.user.name}\n${company()}` }); }
    } catch (e) { return res.status(400).json({ error: e.message }); }
    D().event(d.id, req.user.id, 'contract', `Contract sent for signature${req.body.via ? ' by ' + req.body.via : ''}`);
    D().advance(D().getDeal(d.id), 'contract');
    audit(req, 'contract.send', 'deal', d.id, req.body.via || 'link only');
    res.json({ ok: true, link });
  });
  r.get('/api/deals/:id/contract.pdf', async (req, res) => {
    const d = D().getDeal(Number(req.params.id)); if (!d) return res.status(404).json({ error: 'Deal not found' });
    const t = terms(d), sig = safeJSON(d.contract_sig, null), body = d.contract_body || (tplOf() ? render(tplOf(), t) : DEFAULT_CONTRACT);
    res.type('pdf').send(await contractPdf({ title: 'Funding Agreement', company: company(), dealId: d.id, body, terms: termRows(t), sig, signed: !!sig }));
  });
  r.get('/sign/:token', (req, res) => { const d = byToken(req.params.token); if (!d || !d.contract_sent_at) return res.status(404).send('This link has expired. Please contact your funding specialist.'); res.sendFile(path.join(__dirname, 'public', 'sign.html')); });
  r.get('/sign-api/:token', (req, res) => {
    if (limited(req, 60)) return res.status(429).json({ error: 'Too many requests' });
    const d = byToken(req.params.token); if (!d || !d.contract_sent_at) return res.status(404).json({ error: 'Link expired' });
    const sig = safeJSON(d.contract_sig, null), t = terms(d);
    res.json({ company: company(), rep: repOf(d).name || '', business: t.business, owner: t.owner, body: d.contract_body, terms: termRows(t), signed: !!d.contract_signed_at, signed_name: sig && sig.name, signed_at: d.contract_signed_at });
  });
  r.post('/sign-api/:token', express.json({ limit: '1mb' }), async (req, res) => {
    if (limited(req, 10)) return res.status(429).json({ error: 'Too many requests' });
    const d = byToken(req.params.token); if (!d || !d.contract_sent_at) return res.status(404).json({ error: 'Link expired' });
    if (d.contract_signed_at) return res.status(400).json({ error: 'This agreement is already signed.' });
    const b = req.body || {}, name = String(b.name || '').trim().slice(0, 120);
    if (!name) return res.status(400).json({ error: 'Please type your full name.' });
    if (!b.agree) return res.status(400).json({ error: 'Please check the agreement box.' });
    if (!/^data:image\/png;base64,/.test(String(b.signature || '')) || b.signature.length > 900000) return res.status(400).json({ error: 'Please sign in the box.' });
    const sig = { name, image: b.signature, ip: req.ip, ua: String(req.headers['user-agent'] || '').slice(0, 200), at: now() };
    db.prepare('UPDATE deals SET contract_sig=?, contract_signed_at=?, updated_at=? WHERE id=?').run(JSON.stringify(sig), sig.at, now(), d.id);
    try {
      const t = terms(d), pdf = await contractPdf({ title: 'Funding Agreement', company: company(), dealId: d.id, body: d.contract_body, terms: termRows(t), sig, signed: true });
      const file = crypto.randomBytes(16).toString('hex') + '.pdf'; fs.writeFileSync(path.join(filesDir, file), pdf);
      db.prepare("INSERT INTO deal_files(deal_id,kind,name,file,size,mime,uploaded_by,created_at) VALUES(?,?,?,?,?,?,NULL,?)").run(d.id, 'contract', `Signed agreement - ${t.business}.pdf`, file, pdf.length, 'application/pdf', now());
    } catch (e) { log('Contract PDF error:', e.message); }
    D().event(d.id, null, 'contract', `Contract signed by ${name} (IP ${req.ip})`);
    tell(d, `${leadOf(d).business || d.title} SIGNED the contract — ready to fund`, true);
    res.json({ ok: true });
  });

  return { router: r, offerRows };
};
module.exports.DEFAULT_CONTRACT = DEFAULT_CONTRACT;
