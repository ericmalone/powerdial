// Lead time zones (from the phone number) + calling-hours checks
const geo = require('libphonenumber-geo-carrier');
const { parsePhoneNumber } = require('libphonenumber-js');
const { db, getSetting } = require('./db');

const US_EXTREMES = ['America/New_York', 'America/Los_Angeles']; // used when a lead's zone is unknown

async function phoneTz(phone) {
  try { const z = await geo.timezones(parsePhoneNumber(phone)); return (z || []).filter(x => x && x !== 'Etc/Unknown').join(','); }
  catch { return ''; }
}
function localMinutes(tz, at = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(at);
  return Number(p.find(x => x.type === 'hour').value) * 60 + Number(p.find(x => x.type === 'minute').value);
}
function windowMins() {
  const [sh, sm] = String(getSetting('call_window_start', '08:00')).split(':').map(Number);
  const [eh, em] = String(getSetting('call_window_end', '21:00')).split(':').map(Number);
  return [sh * 60 + (sm || 0), eh * 60 + (em || 0)];
}
// is it OK to call/text a lead whose tz string is `tzs` (comma list) right now?
function okNow(tzs, at = new Date()) {
  const [a, b] = windowMins();
  const zones = (tzs || '').split(',').filter(z => z.includes('/'));
  return (zones.length ? zones : US_EXTREMES).every(z => { try { const m = localMinutes(z, at); return m >= a && m < b; } catch { return true; } });
}
// all distinct tz values in the leads table that are currently callable (for SQL filtering)
function callableTzs() {
  const all = db.prepare("SELECT DISTINCT tz FROM leads").all().map(r => r.tz || '');
  return all.filter(t => okNow(t));
}
function localTime(tzs) {
  const z = (tzs || '').split(',')[0]; if (!z) return null;
  try { return new Date().toLocaleTimeString('en-US', { timeZone: z, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); } catch { return null; }
}
// next time it will be OK to contact (for rescheduling sequence steps)
function nextOkTime(tzs) {
  let t = Date.now();
  for (let i = 0; i < 96; i++) { if (okNow(tzs, new Date(t))) return t; t += 15 * 60000; }
  return Date.now() + 864e5;
}
async function backfill() {
  const rows = db.prepare("SELECT id, phone FROM leads WHERE tz='' OR tz IS NULL LIMIT 5000").all();
  const up = db.prepare('UPDATE leads SET tz=? WHERE id=?');
  for (const r of rows) up.run((await phoneTz(r.phone)) || '?', r.id);
  return rows.length;
}

module.exports = { phoneTz, okNow, callableTzs, localTime, nextOkTime, backfill };
