# PowerDial CRM

A team power dialer and CRM on Twilio, modeled on VanillaSoft and Trellus.

## What it does

**Dialing**
- Parallel dialing (1–5 lines) or one line at a time. The first person who answers is connected; machines are skipped.
- Queue-based routing: due callbacks are dialed first, then your own leads, then the shared pool, with fewest attempts first. Two reps never get the same lead.
- **Voicemail drop**: record your voicemail once. It can be left automatically on every machine (waits for the beep), or you can press **V** when you hear a greeting and move on instantly.
- Optional auto-text after a voicemail drop.
- **Local presence and number rotation**: show a number with the lead's area code, or rotate through your pool, with a daily cap per number. Number health flags any number whose connect rate drops, which usually means it's been marked as spam.
- **Lists**: pick which list (campaign) to dial.
- **Warm and blind transfer** to a closer or any number.
- **Inbound calls**: when leads call your numbers back, the call goes to the lead's owner or the next free rep. If nobody is free, the caller is forwarded or leaves a voicemail.
- **DNC list**: numbers on it are never dialed or texted. STOP replies and DNC dispositions add numbers automatically.

**AI**
- **Live transcript** on every call, labeled You and Them.
- **Live AI coach**: when the merchant raises an objection or asks a question, a suggested reply appears on screen, drawn from your objection playbook.
- Talk-ratio meter and a "you've been talking too long" alert.
- **After every call**: summary, next steps, key facts (revenue, existing advances, amount, use of funds), objections, a **0–100 call score** with a scorecard and coaching tips, and a drafted follow-up text.

**Deals (merchant to funded)**
- **Pipeline board**: drag deals through Interested → App sent → App in → Docs in → Submitted → Offer → Contract out → Funded. Marking a call Interested or App Sent creates the deal automatically.
- **Secure application link**: text or email it to the merchant. They fill in the app, e-sign it and upload bank statements from their phone, and the deal advances on its own while the rep gets an alert. SSN and date of birth are encrypted in the database.
- **Lender submissions**: add your partner lenders with their requirements (minimum revenue, time in business, credit, maximum positions, amount range, states and industries they won't fund). Each deal shows which lenders it qualifies for. One click emails the signed application PDF plus every document to the lenders you pick.
- Lender replies are read by AI and update the status and offer (amount, factor, term, payment) automatically. Marking a submission Funded fills in the funding terms.
- **Renewals**: paid-in % is estimated from the payment schedule, or you can enter the collected amount. At 50% (adjustable) the merchant is put back in the rep's queue as a due callback.
- **Commissions**: set a default % per rep, or override it per deal. Each rep sees their earnings; admins mark commissions paid.

**New in v4**
- **Bank statement reader (AI)**: when a merchant uploads statements, they are read automatically. You get average monthly revenue, average daily balance, NSFs, revenue trend, and any existing funders found (with their daily/weekly payment), plus red flags (for example stated revenue far above what the bank shows). Blank fields on the application are filled in. Needs `ANTHROPIC_API_KEY`.
- **Document chasing**: each deal has a checklist (signed app, statements, ID, voided check — you choose which are required under Automation). The merchant is texted and emailed automatically until it's all in (default after 4 hours, then 1, 2, 4 and 7 days), only inside calling hours, and never right after a live conversation. The merchant's page shows what's still missing.
- **Lead intake with speed-to-lead**: Automation → Lead intake gives you private web addresses for website forms, Facebook/Google lead ads, Zapier or Instantly. A new lead is created, assigned to the next available rep (or one you choose), jumps to the top of the queue and pops up on the rep's screen. Optional instant text (only turn it on for forms where the person agreed to texts). Duplicates are noted on the existing lead instead of added again.
- **Smart queue**: every lead gets a 1–100 score from how its list and state have converted for you, how many times it's been dialed and whether the merchant texted or emailed back. The dialer works hot leads first, then due callbacks, then the best scores. Turn off under Automation → Smart queue.
- **Alternate phone numbers**: extra phone columns in an import (or numbers added on the lead) are kept. If a number is marked Wrong Number the dialer switches to the next one automatically.
- **Goals and leaderboard**: set daily dial/connect/app goals and a monthly funded-dollar goal (team default, or per rep). Reps see progress on the dialer; the Sales floor shows a live leaderboard for today, this week and this month.
- **Send to all matching lenders** in one click, **side-by-side offer comparison** (amount, factor, payback, cost, payment, term, your revenue), and a **merchant offer page** where the merchant picks between offers labeled A, B, C. Their pick fills in the funding terms and alerts the rep.
- **Funding contract e-sign**: paste your attorney-approved agreement once (Automation → Offers & contract). Terms merge in from the deal, the merchant signs on their phone, and a signed PDF (name, time, IP) is saved on the deal. **The agreement text is yours to supply — the app ships with a placeholder and will not send a contract until you add one.**
- **Partner (ISO / broker) portal**: add a user with the role "Partner". They log in to a simple portal to submit deals with statements, see status, and see their commission. Deals from partners are assigned to your reps and the partner's commission is included in profit reports. Mark partner commissions paid under Commissions.
- **Payment tracking**: on funded in-house deals, enter payments and NSFs (or paste/import a CSV from your bank or processor). You're alerted when a merchant falls 2+ payments behind. Real payments replace the schedule estimate for renewals and reports. New **Portfolio** report: outstanding, collected vs expected, behind list, NSFs, renewal-ready, partner payouts.
- **Weekly email summary**: pick the day and time; get one email with the week's numbers, reps, lead-source profit, pipeline, payments and what needs your attention.
- **Do-not-call / litigator scrub**: upload any list of numbers to block (matching leads are blocked at once, imports and inbound leads are checked), and optionally check each new lead against a scrub service you subscribe to.
- **Call quality flags**: calls are checked for words reps must never say (editable), required phrases, and — with AI — misleading promises, pressure and ignored stop requests. Flagged calls show in Automation → Compliance, on the call itself and in the Calls report.
- **Money flow (like MCA Pilot)**: when a deal funds, the funder's commission shows up under **Payments** (outstanding until you mark it received). **Distributions** shows what you owe each rep and partner out of it: set each person's split under Team & setup ("split 25/10" = 25% as originator, 10% as closer), and override per deal on the deal page (pick a closer there too). Mark payouts paid in bulk; edit a payment amount and unpaid payouts recalculate. Reps see only their own payouts. **Advances** lists every funded deal with paid-in %, funder, originator and closer, and a status you can set (Current, Paid off, Collections, Default…).
- **More reports**: Deal performance (deals in → submitted → approved → funded with ratios and what each rep earns per deal), Team P&L (payments in, payouts out, profit, funders who owe you), Funders (funded, units, approved, earned per funder), and Lead sources now also show conversion and cost at every stage plus a by-vendor roll-up. The **Export** tab downloads deals, submissions, advances, payments and distributions as CSV.
- **Text blasts**: left menu → Text blasts. Pick leads already in the CRM (by list, status, state) or upload a sheet (CSV; any column order, we find the phone numbers), write one message with {first} {business} {rep} {company}, and send now or schedule it. Texts go out at a controlled speed, only inside each person's calling hours, and skip do-not-call numbers, STOP replies and anyone texted in the last 24h. Reps can blast their own leads or their own sheet (limits and on/off in Settings on that page). Each blast shows sent / delivered / replies / opt-outs / failed, and replies land in the Inbox. "Reply STOP to opt out." is added to every text.
- **Search every call**: left menu → Search finds any word or phrase across all transcripts.
- **Activity log and backups**: logins, SSN views, exports, deletes, imports, user and setting changes and commission payments are logged. The database is backed up every night (last 14 kept) and you can download a copy.

**Follow-up**
- **Email** from the CRM (SMTP). With IMAP set up, merchant and lender replies are logged automatically.
- **Sequences**: timed text, email and call-reminder steps (for example: day 0 text, day 2 call, day 3 email). They can start automatically after a disposition or a voicemail drop, and stop when the lead replies or is marked closed.
- **Calling hours by the lead's time zone**: each lead's time zone is detected from their number. The dialer and automated texts only reach them inside your window (default 8am–9pm their time).

**Lead sources and import**
- **Import with a review step**: you see how each column was read (change any with a dropdown), then how many leads are new, already in the CRM (and which list they came from), repeated in the file, on your DNC list, or have no valid phone, before anything is added.
- Enter the **vendor and total cost** of a list at import (or later under Reports → Lead sources → Set lead costs). Every lead keeps its source through to the funded deal, and the deal shows it.

**Reports** (admins; Reports in the left menu). Every table sorts by clicking a heading and exports to CSV.
- **Overview**: dials, conversations, talk time, interested, apps, funded dollars, revenue, commissions, texts and emails, with arrows against the previous period and daily charts.
- **Reps**: scorecard per rep (dials, connect %, talk time, interested, deals, funded $, revenue, commission, call score, dials per active hour, first and last dial), dials per day, when each rep dials by hour, outcomes by rep, and which rep works which lead source best.
- **Lead sources**: per list, leads, % dialed, reach %, interested, apps, submitted, offers, funded, funded $, revenue, rep commission, cost, cost per lead / reached lead / app / funded deal, profit, ROI and a plain verdict (Profitable, Losing money, Still working it, Add cost).
- **Funnel**: lead → dialed → reached → interested → app sent → app back → statements → submitted → offer → funded, filterable by source, plus results by month imported and why deals were lost.
- **Pipeline**: open deals and dollars by stage, average days in stage, deals going cold, owner results and win rate, and how fast deals move.
- **Lenders**: submissions, approval and decline rates, reply time, average offer and factor, funded dollars, revenue and decline reasons.
- **Calls**: best hours and days, outcomes, whether longer conversations convert, state results, caller ID health, objections, score distribution, and the best and worst scored calls to coach from.
- **Texts & email**: texts per rep, reply rate, sequence results (replies, deals, funded) and opt-outs.
- **Lead inventory**: leads never dialed, overdue callbacks, tries per lead, by source and by owner.

**How revenue and profit are figured**: for deals funded in-house, revenue is payback minus funded amount. For partner lenders it is the funded amount times that lender's broker % (set on the lender). You can override the revenue on any deal. Profit = revenue − rep commission − list cost.

**CRM**
- Lead profile with every dial, recording, AI note, manual note and the full SMS thread.
- Shared SMS inbox with templates.
- **Branching call scripts**: buttons move the rep to the next step, as in VanillaSoft.
- Objection playbook in the dialer.
- **Sales floor**: see every rep live, and as an admin **listen, whisper or barge** into calls.
- Dashboard with dials, conversations, talk time, voicemails, apps and average score per rep, plus an **objections report** across the team and **best hours to call**.

## MCA Pilot features (v5)

Everything below is in the left menu. Admin-only items are marked.

- **Needs action** – one queue of every deal waiting on you (19 action types: chase signature, fulfill stip request, pitch offer, nudge ignored funders, resubmit or close out, renewal follow-up…), oldest first. Reps see their own deals; the number shows on the menu.
- **26 deal statuses** – New Application → Ready to Submit → Submitted → Approved → Offer Pitched/Selected → Repricing → Offer Accepted → Contracts Requested/Sent/Signed → Final Review → Funded (Missed Payments / Defaulted / Up for Renewal / Renewed) and the six Closed reasons. Set from the box on the deal page; it also moves the deal in the pipeline. Full history is kept.
- **Underwrite tab (deal page)** – bank statements by month (revenue, deposits, negative days, low-balance days, ADB, opening/closing balance, NSFs) with Average and Worst-month rows, existing positions, total pulls and holdback %. "Import from statement reader" fills it from the AI read.
- **Funders tab (deal page)** – every funder sorted into Qualified / Not qualified with the exact reason, ranked. Submit to selected, or **Auto-submit best matches**. Request contracts or a bump from a funder in one click.
- **Funder criteria (Lenders → Criteria, admin)** – paper grade, rank, tags, products, preferred industries, restricted legal structures, accepted default statuses, min positions, max term/commission, bank-statement rules (average and worst-month, 9 metrics), email subject prefix, separate contract and bump emails, and funder metrics (approval rate, total approved/funded/earned).
- **Details tab** – legal structure, default status, products sought, owners with ownership %, channel, exclusion tag, batch, "Unsubscribed" and "Skip auto-submit" flags.
- **Tasks** – per-deal and per-funder tasks with type, assignee, due date and pin. Funder stip requests create a task automatically and close it when the funder moves on.
- **Submissions / Offers** – every submission and every offer across all deals, filterable, with payback, commission and points. Tag offers "Repriced Offer" / "Got Repriced". CSV export (admin).
- **Attribution (admin)** – **Batches** (price, count, $/lead, leads, deals, funded, revenue, profit, ROI — type a batch name on the lead import screen) and **Sources** (vendor and contact details).
- **Pilot setup (admin)** – *Workflows* (when a deal is created / status changes / offer arrives / submission fails / all funders decline / task created or due / renewal due → create a task, change status, add a note or notify the owner), *Permissions* per person plus manager and team, *Auto-submit & passes* (auto-submit when docs are complete; round-robin passes for stale deals), *Funder request* email templates, and the status list.

Auto-submit and passes are **off** until you turn them on in Pilot setup. Auto-submit emails funders, so it needs your SMTP settings.

## 1. Twilio setup (one time)

1. **Numbers**: buy at least one number with Voice + SMS. For local presence, buy numbers in the area codes you call most.
2. **API key**: Console → Account → API keys → Create (Standard). Save the SID (`SK…`) and the secret.
3. **TwiML App**: Console → Voice → TwiML Apps → Create. Set the Voice URL to `https://YOUR-URL/twilio/voice`. Save the SID (`AP…`).
4. **For each number**:
   - Voice "A call comes in" → `https://YOUR-URL/twilio/inbound`
   - Messaging "A message comes in" → `https://YOUR-URL/twilio/sms`
5. **Voice geo permissions**: make sure US/Canada is enabled.
6. **SMS**: register A2P 10DLC (Console → Messaging → Regulatory Compliance). Carriers block unregistered texts.
7. **Caller ID reputation** (optional but recommended): register your numbers for STIR/SHAKEN in Twilio Trust Hub, and with the Free Caller Registry. This reduces "Spam Likely" labels.

After you log in, go to **Team & setup → Import from Twilio** to load your numbers into the caller ID pool.

## 2. Email (for app links, sequences and lender submissions)

Fill in `SMTP_*` and `IMAP_*` in `.env`.
- **Google Workspace**: use `smtp.gmail.com` / `imap.gmail.com` with an app password.
- **Use a dedicated mailbox** such as deals@yourdomain. Lender replies land in it and are matched to the deal by the `[PD-…]` tag in the subject.

## 3. AI keys

- **Deepgram** (console.deepgram.com): used for the live transcript and post-call transcription.
- **Anthropic** (console.anthropic.com): used for the live coach, call notes and scoring.

If you leave both out, the dialer and CRM still work without AI.

## 4. Run it

Requires Node.js 18 or newer.

```bash
npm install
cp .env.example .env        # fill in your values
npm start
```

Twilio has to reach the app at a public **https** address, and it uses WebSockets for the live transcript.

- **Testing**: run `ngrok http 3000`, then put the URL in `PUBLIC_URL` and in the Twilio webhooks above.
- **Production**: deploy to Render, Railway or a VPS that supports WebSockets. Keep the `data/` folder on a persistent disk and back it up. It holds the database, uploaded statements, voicemails and the encryption key (`data/.app-key`) used for SSNs.

Log in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Then:
1. Add reps under **Team & setup**.
2. Load your numbers and pick a caller ID mode.
3. Edit the script and the playbook.
4. Each rep records a voicemail under **My settings**.
5. Add partner lenders under **Lenders**, and set each rep's commission % under **Team & setup**.
6. Build your follow-up sequences under **Sequences**.

## v4 settings and notes

Everything below is optional and has sensible defaults. Settings live in the app under **Automation**; the environment variables are only for tuning.

- Statement reading, call notes and QA all use `ANTHROPIC_API_KEY`. Without it those features simply stay off.
- Merchant text and email reminders need Twilio and SMTP set up as above.
- `STMT_DELAY_SECONDS` (25) waits after the last upload before reading statements. `CHASE_TICK_SECONDS` (300) and `CHASE_QUIET_HOURS` (3) control how often reminders are checked and how long after a live conversation they stay quiet.
- `BLAST_TICK_SECONDS` (5) is how often the text-blast sender wakes up; speed is set per blast (texts per minute).
- `INTAKE_TEXT_DELAY_SECONDS` (20) is the pause before the instant text to a new inbound lead.
- `PAYMENT_CHECK_MINUTES` (60) is how often payment status is re-checked. Behind-on-payments triggers after 2 missed payments.
- `BACKUP_KEEP` (14) and `BACKUP_HOUR` (3) set nightly backups. Backups go to `data/backups`. Your uploaded documents live in `data/files` — copy the whole `data` folder if you can.
- **Keep your encryption key.** SSN and date of birth are encrypted. Set `APP_ENCRYPTION_KEY` in `.env` or back up `data/.app-key`; a backup can't be read without it.
- Partner accounts can only use the partner portal; they cannot see leads, other deals or any rep data.
- Texting a lead that submitted a web form is generally allowed only if they agreed to be contacted. The instant-text switch is off by default for every intake address.
- The scrub-service check works with any lookup service that returns text you can match on; this app does not include a scrub subscription.

## Dialer shortcuts

| Key | Action |
| --- | --- |
| N | Dial next |
| H | Hang up |
| M | Mute |
| V | Drop voicemail |
| T | Transfer |
| 1–8 | Dispositions |

## Script format

Branching script steps look like this:

```
# start: Opener
Hi, is this {first}?
-> Yes, it's them: intro
-> Gatekeeper: gatekeeper

# intro: Intro
{first}, this is {rep} with {company}...
```

Merge fields: `{first}` `{name}` `{business}` `{state}` `{rep}` `{company}`

## Troubleshooting

- **"This call cannot be connected"**: Twilio can't reach `PUBLIC_URL`. ngrok URLs change on every restart.
- **"Failed #21215"**: geo permissions are blocking the call. **"#21210"**: the caller ID isn't verified or owned.
- **Texts fail with #30034**: the number isn't registered for A2P 10DLC.
- **No live transcript**: your host must support WebSockets, and `PUBLIC_URL` must be https.
- **A number shows "check" in number health**: it's likely flagged as spam. Pause it, register it (see step 7), or replace it.
