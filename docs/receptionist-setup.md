# AI receptionist — how to turn it on

This replaces Sophie AI with our own receptionist. It runs on Retell for the voice,
a Twilio number, and Drapr for everything it knows about customers and jobs.

Nothing changes for callers until step 7, where you point call forwarding at the new
number. Until then Sophie keeps answering and you can test the new one alongside it.
Rolling back is the same switch in reverse.

**Running cost at 200–250 calls a month** (about 600 minutes): roughly US$45–80 for
Retell, US$10–15 for the Twilio number, call minutes and SMS. That's around A$85–140
a month, against $300 for Sophie.

---

## 1. Database

Supabase → **SQL Editor** → paste all of
`supabase/migrations/20261117000000_receptionist.sql` → **Run**.

It adds the call log table, two lookup functions only the receptionist can use, and
a secret key. Nothing that already exists is changed, and it's safe to run twice.

Then get the key, because you'll need it in steps 4 and 5:

```sql
select value from integration_secrets where key = 'receptionist-secret';
```

## 2. Backend function

Supabase → **Edge Functions** → create a function named exactly **receptionist**,
and paste in `supabase/functions/receptionist/index.ts`.
**Turn JWT verification off** in its settings. Retell has no Drapr login; the key in
the URL is what protects it.

## 3. Twilio number

Buy **one Australian mobile number** (+61 4…) in Twilio. A mobile number does both
voice and SMS. Australian landline (03) numbers can't send texts, so they can't send
the quote link.

Twilio requires a regulatory bundle for Australian numbers: ABN, business address,
and ID. Approval usually takes 1–3 business days, so start this first.

Then add three secrets: Supabase → **Edge Functions → Secrets**:

| Name | Value |
|---|---|
| `TWILIO_ACCOUNT_SID` | from the Twilio console home page |
| `TWILIO_AUTH_TOKEN`  | same page |
| `TWILIO_SMS_FROM`    | the new number, in +614… form |

## 4. Retell account and phone number

Sign up at retellai.com and add a payment card (it's pay as you go).

**Phone Numbers → Import** your Twilio number. Retell's import guide walks you
through it: you create an Elastic SIP Trunk in Twilio, point it at Retell, and paste
the termination address into Retell. Ten minutes. Send me a screenshot if it fights
you.

On the imported number, set:
- **Inbound call webhook URL:**
  `https://kspezkqanaqrhbirqmlc.supabase.co/functions/v1/receptionist?key=YOUR_KEY`
  This is how the agent knows who's calling before it says hello.

## 5. The agent

**Agents → Create → Single Prompt Agent.**

- **Voice:** pick an Australian English voice. Test a few.
- **Language:** English (Australia).
- **Prompt:** paste from `docs/receptionist-agent-prompt.md`.
- **Knowledge Base:** create one, paste in `docs/receptionist-knowledge-base.md`
  once you've filled the gaps, and attach it.
- **Functions:** add the four custom functions from the same doc, each with the URL
  and your key.
- **Webhook URL** (agent settings): the same receptionist URL with your key. It sends
  call started, ended and analysed events, which become the call log and the summary
  emails.
- **Data storage / privacy:** keep recordings and transcripts on. They're your
  record of what was said.

Assign the agent to the phone number for **inbound** calls.

## 6. Test it

Ring the new mobile number directly. Try:

1. From your own mobile, if you're on a job in Drapr: "Where's my order up to?"
2. From a phone that isn't on file: give a real job number and surname, then a
   wrong surname. The wrong one should get nowhere.
3. "I want a quote for my lounge curtains." You should get the text, and the link
   should open the form with your name and number filled in.
4. "Can someone call me back?" The office should get the CALL BACK email
   straight away, then a summary with the transcript after you hang up.

Tweak the prompt and knowledge base until it sounds right. Every change in Retell
takes effect on the next call.

## 7. Go live

In the portal for the 1300 652 866 number, change the forwarding destination for
**no answer, busy and after hours** from Sophie's number to the new Twilio mobile.
Do this from wherever Sophie is set up now.

Once it's been fine for a week, cancel Sophie.

---

## Optional settings

Add rows to the Drapr `settings` table to change the defaults. Every one is
optional:

| key | default |
|---|---|
| `receptionist-notify-email` | drdrapes@hudsongroup.com.au (comma-separate for several) |
| `receptionist-email-all-calls` | `yes`. Set `no` to only email when a callback is asked for |
| `receptionist-alert-mobiles` | none. Mobiles that get a text after every call, comma-separated, e.g. `0412345678,0498765432` |
| `receptionist-sms-all-calls` | `yes`. Set `no` to only text when a callback is asked for |
| `receptionist-call-log-emails` | drdrapes@ and production1@. Who gets the 8:30am morning call log (comma-separated) |
| `receptionist-form-url` | https://quote.drdrapes.com.au/request.html |
| `receptionist-sms-body` | the standard text. Use `{hi}` and `{link}` placeholders |

### Text alerts to David and Nicole

After every call, each mobile in `receptionist-alert-mobiles` gets a short text
with the caller's number, CALL BACK if they asked for one, and the call summary.
When a message is taken, a CALL BACK text goes out straight away, without waiting
for the call to end. Add the numbers in Supabase → SQL Editor:

```sql
insert into settings (key, value, company_id)
values ('receptionist-alert-mobiles', '04XXXXXXXX,04YYYYYYYY', '00000000-0000-0000-0000-000000000001');
```

Each alert is kept to one SMS part, about 8 cents a text per person. At 250
calls a month that's roughly A$40 a month for two people. Set
`receptionist-sms-all-calls` to `no` to only get texts for callbacks.

## What callers can and can't find out

A caller is matched to a job either by the number the phone network says they're
calling from, or by job number plus surname together. Three wrong guesses closes
lookups for that call. The receptionist only says the job's status, suburb and next
booked visit. It never gives street addresses, prices, balances or notes, and it
never confirms whether someone is a customer.

The agent opens by saying it's an AI assistant and that calls are recorded. That
keeps us on the right side of the Commonwealth interception rules and the Privacy
Act.
