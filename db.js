// SQLite storage for PowerDial CRM
let Database;
try { if (process.env.FORCE_NODE_SQLITE) throw new Error('forced'); Database = require('better-sqlite3'); new Database(':memory:').close(); }
catch { Database = require('./sqlite-shim'); console.log('Using the built-in SQLite driver'); }
const path = require('path');
const fs = require('fs');

const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dir, { recursive: true });
const db = new Database(path.join(dir, 'crm.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'rep',          -- admin | rep
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  name TEXT DEFAULT '',
  business TEXT DEFAULT '',
  phone TEXT NOT NULL UNIQUE,
  email TEXT DEFAULT '',
  state TEXT DEFAULT '',
  extra TEXT DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'new',        -- new | callback | done | dnc
  disposition TEXT DEFAULT '',
  last_outcome TEXT DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_called INTEGER,
  callback_at INTEGER,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  locked_by INTEGER,
  locked_until INTEGER,
  unread_sms INTEGER NOT NULL DEFAULT 0,
  last_sms_at INTEGER,
  source TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS leads_status ON leads(status, callback_at, last_called);
CREATE INDEX IF NOT EXISTS leads_sms ON leads(last_sms_at);
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  batch_id TEXT,
  call_sid TEXT,
  from_number TEXT,
  to_number TEXT,
  status TEXT DEFAULT 'queued',
  outcome TEXT DEFAULT '',
  answered_by TEXT DEFAULT '',
  connected INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  answered_at INTEGER,
  ended_at INTEGER,
  duration INTEGER DEFAULT 0,
  disposition TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  error TEXT DEFAULT '',
  recording_sid TEXT,
  recording_url TEXT,
  recording_duration INTEGER,
  transcript TEXT,
  ai TEXT,                                   -- JSON from Claude
  ai_status TEXT DEFAULT '',                 -- '' | pending | done | skipped | error
  ai_error TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS calls_lead ON calls(lead_id, started_at);
CREATE INDEX IF NOT EXISTS calls_user ON calls(user_id, started_at);
CREATE INDEX IF NOT EXISTS calls_sid ON calls(call_sid);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  direction TEXT NOT NULL,                   -- in | out
  body TEXT NOT NULL DEFAULT '',
  media TEXT DEFAULT '[]',
  from_number TEXT,
  to_number TEXT,
  sid TEXT,
  status TEXT DEFAULT '',
  error TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS msgs_lead ON messages(lead_id, created_at);
CREATE INDEX IF NOT EXISTS msgs_sid ON messages(sid);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_lead ON notes(lead_id, created_at);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS numbers (
  id INTEGER PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  label TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS voicemails (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  file TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,  -- NULL = shared with team
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dnc (
  phone TEXT PRIMARY KEY,
  reason TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
`);
// add columns to existing installs
function addCol(table, col, type) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}
addCol('users', 'phone', "TEXT DEFAULT ''");
addCol('users', 'voicemail_id', 'INTEGER');
addCol('calls', 'vm_dropped', 'INTEGER NOT NULL DEFAULT 0');
addCol('calls', 'score', 'INTEGER');
addCol('calls', 'talk_ratio', 'REAL');
addCol('calls', 'transferred_to', "TEXT DEFAULT ''");
addCol('calls', 'live_transcript', 'TEXT');
addCol('calls', 'direction', "TEXT DEFAULT 'out'");
db.exec('CREATE INDEX IF NOT EXISTS calls_from ON calls(from_number, started_at)');

addCol('leads', 'tz', "TEXT DEFAULT ''");
addCol('leads', 'email_last_at', 'INTEGER');
addCol('users', 'commission_pct', 'REAL DEFAULT 0');
addCol('messages', 'enrollment_id', 'INTEGER');


db.exec(`
CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  stage TEXT NOT NULL DEFAULT 'interested',
  title TEXT DEFAULT '',
  amount_requested REAL,
  app TEXT DEFAULT '{}',              -- application answers (JSON); sensitive fields encrypted
  app_signed_at INTEGER,
  upload_token TEXT UNIQUE,
  lender_id INTEGER,                  -- lender that funded (NULL = in-house / not funded)
  funded_amount REAL, factor_rate REAL, payback REAL, term_days INTEGER,
  payment_amount REAL, payment_freq TEXT DEFAULT 'daily',
  funded_at INTEGER,
  collected REAL,                     -- manual paid-in override; NULL = estimate from schedule
  renewal_queued_at INTEGER,
  commission_pct REAL, commission_amt REAL, commission_paid_at INTEGER,
  lost_reason TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS deals_lead ON deals(lead_id);
CREATE INDEX IF NOT EXISTS deals_stage ON deals(stage, updated_at);
CREATE TABLE IF NOT EXISTS deal_files (
  id INTEGER PRIMARY KEY,
  deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'statement',  -- statement | application | id | voided_check | contract | other
  name TEXT NOT NULL, file TEXT NOT NULL, size INTEGER, mime TEXT,
  uploaded_by INTEGER,                      -- user id, NULL = merchant
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS deal_events (
  id INTEGER PRIMARY KEY,
  deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  user_id INTEGER, kind TEXT NOT NULL, body TEXT DEFAULT '', created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS deal_events_deal ON deal_events(deal_id, created_at);
CREATE TABLE IF NOT EXISTS lenders (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  contact_name TEXT DEFAULT '', email TEXT DEFAULT '', cc TEXT DEFAULT '', phone TEXT DEFAULT '',
  in_house INTEGER NOT NULL DEFAULT 0,
  min_monthly_revenue REAL, min_tib_months INTEGER, min_fico INTEGER, max_positions INTEGER,
  min_amount REAL, max_amount REAL,
  excluded_states TEXT DEFAULT '', excluded_industries TEXT DEFAULT '',
  notes TEXT DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY,
  deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  lender_id INTEGER NOT NULL REFERENCES lenders(id) ON DELETE CASCADE,
  user_id INTEGER,
  status TEXT NOT NULL DEFAULT 'submitted',  -- submitted | info_needed | approved | declined | funded | withdrawn
  offer_amount REAL, offer_factor REAL, offer_term_days INTEGER, offer_payment REAL, offer_freq TEXT,
  decline_reason TEXT DEFAULT '', notes TEXT DEFAULT '', ai_note TEXT DEFAULT '',
  message_id TEXT, error TEXT DEFAULT '',
  sent_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS subs_deal ON submissions(deal_id);
CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  deal_id INTEGER, submission_id INTEGER, lender_id INTEGER, user_id INTEGER, enrollment_id INTEGER,
  direction TEXT NOT NULL,               -- in | out
  subject TEXT DEFAULT '', body TEXT DEFAULT '', from_addr TEXT, to_addr TEXT,
  message_id TEXT, in_reply_to TEXT, attachments TEXT DEFAULT '[]',
  status TEXT DEFAULT '', error TEXT DEFAULT '', created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS emails_lead ON emails(lead_id, created_at);
CREATE INDEX IF NOT EXISTS emails_msgid ON emails(message_id);
CREATE TABLE IF NOT EXISTS sequences (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL,
  steps TEXT NOT NULL DEFAULT '[]',      -- [{day, hour, type: sms|email|call, subject, body}]
  active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  sequence_id INTEGER NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  user_id INTEGER, step INTEGER NOT NULL DEFAULT 0, next_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active', stop_reason TEXT DEFAULT '',
  started_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS enroll_due ON enrollments(status, next_at);
`);

addCol('lenders', 'broker_pct', 'REAL');          // % of funded amount the lender pays us (brokered deals)
addCol('deals', 'revenue_override', 'REAL');      // what the company earns on this deal, if you want to set it by hand
db.exec(`
CREATE TABLE IF NOT EXISTS lead_sources (
  name TEXT PRIMARY KEY,
  total_cost REAL,                 -- what the list cost in total
  vendor TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS calls_started ON calls(started_at);
CREATE INDEX IF NOT EXISTS leads_source ON leads(source);
CREATE INDEX IF NOT EXISTS leads_created ON leads(created_at);
`);

// ---- v4 additions ----
addCol('deals', 'stmt_analysis', 'TEXT');          // AI read of the bank statements (JSON)
addCol('deals', 'stmt_analyzed_at', 'INTEGER');
addCol('deals', 'stmt_status', "TEXT DEFAULT ''");   // '' | running | done | error
addCol('deals', 'stmt_error', "TEXT DEFAULT ''");
addCol('deals', 'last_chase_at', 'INTEGER');
addCol('deals', 'chase_count', 'INTEGER NOT NULL DEFAULT 0');
addCol('deals', 'chase_off', 'INTEGER NOT NULL DEFAULT 0');
addCol('deals', 'offers_published', 'TEXT');       // JSON: [{sub_id, label}] shown to the merchant
addCol('deals', 'offers_sent_at', 'INTEGER');
addCol('deals', 'offer_chosen', 'INTEGER');        // submission id the merchant picked
addCol('deals', 'offer_chosen_at', 'INTEGER');
addCol('deals', 'contract_body', 'TEXT');
addCol('deals', 'contract_sent_at', 'INTEGER');
addCol('deals', 'contract_signed_at', 'INTEGER');
addCol('deals', 'contract_sig', 'TEXT');           // JSON: name, ip, ua, signature image
addCol('deals', 'iso_id', 'INTEGER');              // broker who submitted the deal
addCol('deals', 'iso_pct', 'REAL');                // override of the broker's default %
addCol('deals', 'iso_paid_at', 'INTEGER');
addCol('deals', 'pay_status', "TEXT DEFAULT ''");  // '' | current | behind | default
addCol('deals', 'behind_alert_at', 'INTEGER');
addCol('leads', 'score', 'INTEGER');
addCol('leads', 'score_why', "TEXT DEFAULT ''");
addCol('leads', 'hot', 'INTEGER NOT NULL DEFAULT 0');
addCol('leads', 'scrub_at', 'INTEGER');
addCol('calls', 'qa', 'TEXT');
addCol('calls', 'qa_flags', 'TEXT');
addCol('users', 'goals', 'TEXT');
db.exec(`
CREATE TABLE IF NOT EXISTS lead_phones (
  id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  phone TEXT NOT NULL, label TEXT DEFAULT '', bad INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  UNIQUE(lead_id, phone)
);
CREATE INDEX IF NOT EXISTS lead_phones_lead ON lead_phones(lead_id);
CREATE TABLE IF NOT EXISTS intake_keys (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, token TEXT NOT NULL UNIQUE, source TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, hot INTEGER NOT NULL DEFAULT 1,
  auto_text INTEGER NOT NULL DEFAULT 0, text_template TEXT DEFAULT '',
  assign TEXT NOT NULL DEFAULT 'round_robin',     -- none | round_robin | user:<id>
  received INTEGER NOT NULL DEFAULT 0, last_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  paid_on INTEGER NOT NULL,                       -- day the payment was due / debited (ms, local noon)
  amount REAL NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'payment',           -- payment | nsf | adjust
  note TEXT DEFAULT '', user_id INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_deal ON payments(deal_id, paid_on);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY, user_id INTEGER, user_name TEXT DEFAULT '', action TEXT NOT NULL,
  entity TEXT DEFAULT '', entity_id TEXT DEFAULT '', detail TEXT DEFAULT '', ip TEXT DEFAULT '', at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
CREATE INDEX IF NOT EXISTS audit_action ON audit(action, at);
`);
db.exec(`
CREATE TABLE IF NOT EXISTS intake_log (
  id INTEGER PRIMARY KEY, key_id INTEGER, received_at INTEGER NOT NULL,
  status TEXT NOT NULL,                  -- added | duplicate | rejected | dnc
  lead_id INTEGER, assigned_to INTEGER, reason TEXT DEFAULT '', payload TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS intake_log_at ON intake_log(received_at);
`);
let hasFts = true;
try { db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS call_fts USING fts5(text, call_id UNINDEXED, tokenize='porter unicode61')"); } catch { hasFts = false; }
function audit(req, action, entity, entityId, detail) {
  try {
    const u = req && req.user;
    db.prepare('INSERT INTO audit(user_id,user_name,action,entity,entity_id,detail,ip,at) VALUES(?,?,?,?,?,?,?,?)')
      .run(u ? u.id : null, u ? u.name : '', action, entity || '', entityId == null ? '' : String(entityId), String(detail || '').slice(0, 500), req ? String(req.ip || '') : '', Date.now());
  } catch {}
}

const mediaDir = path.join(dir, 'media');
fs.mkdirSync(mediaDir, { recursive: true });
const filesDir = path.join(dir, 'files');
fs.mkdirSync(filesDir, { recursive: true });

const getSetting =(k, d) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? JSON.parse(r.value) : d; };
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, JSON.stringify(v));

module.exports = { db, getSetting, setSetting, mediaDir, filesDir, dir, audit, hasFts };
