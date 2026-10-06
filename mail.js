// Email: send through SMTP, read replies through IMAP
const nodemailer = require('nodemailer');
const env = process.env;

let transport;
const enabled = () => !!(env.SMTP_HOST && env.SMTP_USER);
function tx() {
  if (!transport) transport = nodemailer.createTransport({
    host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 587), secure: Number(env.SMTP_PORT) === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  return transport;
}
const fromAddr = () => env.EMAIL_FROM || env.SMTP_USER;

// returns { messageId }
async function send({ to, cc, subject, text, html, attachments, fromName, replyTo, inReplyTo }) {
  if (!enabled()) throw new Error('Email is not set up (add SMTP settings to .env)');
  const info = await tx().sendMail({
    from: fromName ? `"${fromName.replace(/"/g, '')}" <${fromAddr()}>` : fromAddr(),
    to, cc: cc || undefined, subject, text, html, attachments, replyTo: replyTo || env.EMAIL_REPLY_TO || undefined,
    inReplyTo: inReplyTo || undefined, references: inReplyTo || undefined,
  });
  return { messageId: info.messageId };
}

// Polls the inbox and hands each new message to onMessage(parsed)
function startImap(onMessage, log) {
  if (!env.IMAP_HOST || !env.IMAP_USER) return;
  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');
  let busy = false, lastUid = null;
  const poll = async () => {
    if (busy) return; busy = true;
    const client = new ImapFlow({ host: env.IMAP_HOST, port: Number(env.IMAP_PORT || 993), secure: true, auth: { user: env.IMAP_USER, pass: env.IMAP_PASS || env.SMTP_PASS }, logger: false });
    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        if (lastUid == null) { lastUid = (client.mailbox.uidNext || 1) - 1; return; } // start from "now" on first run
        for await (const m of client.fetch({ uid: `${lastUid + 1}:*` }, { uid: true, source: true }, { uid: true })) {
          if (m.uid <= lastUid) continue;
          lastUid = m.uid;
          try { await onMessage(await simpleParser(m.source)); } catch (e) { log && log('Email handling error:', e.message); }
        }
      } finally { lock.release(); }
      await client.logout();
    } catch (e) { log && log('IMAP error:', e.message); try { await client.logout(); } catch {} }
    finally { busy = false; }
  };
  poll(); setInterval(poll, Number(env.IMAP_POLL_SECONDS || 60) * 1000);
}

module.exports = { enabled, send, startImap, fromAddr };
