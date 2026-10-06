// Encrypts sensitive application fields (SSN, date of birth, bank account) at rest
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { dir } = require('./db');

let key;
function getKey() {
  if (key) return key;
  if (process.env.APP_ENCRYPTION_KEY) key = crypto.createHash('sha256').update(process.env.APP_ENCRYPTION_KEY).digest();
  else {
    // generate once and keep next to the database — back this file up with the data folder
    const f = path.join(dir, '.app-key');
    if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    key = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
  }
  return key;
}
function enc(text) {
  if (text == null || text === '') return '';
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const out = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return 'enc:' + Buffer.concat([iv, c.getAuthTag(), out]).toString('base64');
}
function dec(v) {
  if (!v || !String(v).startsWith('enc:')) return v || '';
  try {
    const b = Buffer.from(String(v).slice(4), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', getKey(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return ''; }
}
const SENSITIVE = ['owner_ssn', 'owner_dob', 'bank_account', 'owner2_ssn', 'owner2_dob'];
const mask = v => v ? '•••' + String(v).replace(/\D/g, '').slice(-4) : '';

module.exports = { enc, dec, SENSITIVE, mask };
