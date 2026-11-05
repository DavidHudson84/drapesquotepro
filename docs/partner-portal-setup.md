# Partner portal — how it works and how to switch it on

Trade partners (Haven Window Furnishings first) get their own login at
**https://quote.drdrapes.com.au/partner.html**. They quote on our price list,
do the pre-inspection, send the quote to their customer, and follow the job
through to rehang. Every quote is a normal Drapr job tagged to the partner.

Nothing is live until the three steps below are done.

---

## Switching it on

1. **Database.** Supabase → SQL Editor → paste
   `supabase/migrations/20261105000000_partner_portal.sql` → Run. It only adds
   things: partner columns on accounts and jobs, the partner logins table, the
   trigger that emails partners on status changes, and the monthly statement
   schedule. Safe to run twice. **Run this before step 3**, because the updated
   app reads the new columns.
2. **Backend function.** Supabase → Edge Functions → new function named
   `partner-portal`, paste `supabase/functions/partner-portal/index.ts`,
   **JWT verification off** (it checks logins itself, and the database calls
   it with a secret). It uses the Resend key already on the project.
3. **Publish.** Merge the branch. GitHub Pages publishes `partner.html` and the
   Drapr changes.

## Setting up a partner (about two minutes)

1. Drapr → **Admin → Accounts** → add or edit the partner's account (for
   example Haven Window Furnishings). Put their phone and email in, because both
   print on the co-branded quote.
2. Tick **This business is a partner** and set:
   - Commission when **we** do the takedown and rehang (default 30%)
   - Commission when **they** do it (default 50%)
   - Rehang charge added when we do it, and transport added to every quote
     (ex GST, blank = none). Partners can't change prices, so these are how
     our install and transport get onto their quotes.
   - Who usually bills the customer (they can change it per quote)
   - Where job updates go (blank = every login)
3. **Save account**, open it again, and under **Logins** enter the person's
   name and email → **Send login invite**. They get an email with a
   set-password link that lasts 7 days. Add as many people as they need. **Switch
   off** ends a login immediately.

You create the logins. Partners can't sign themselves up.

## What happens on a partner job

| When | What happens |
|---|---|
| Partner saves a quote | It becomes a job in Drapr at Quoted, with the next DRQ number. The office gets an email with the total and commission. It shows "via Haven" in the jobs list. |
| Partner emails it from the portal | Customer gets the co-branded PDF and the usual **Accept online** button. The partner is cc'd, and replies go to the partner and to us. |
| Customer accepts online, or the partner presses **Customer has accepted** | Job moves to Confirmed, Fergus is raised automatically if the match is certain (otherwise it's flagged on the dashboard as now), and the office is emailed. The dashboard's accepted card counts it until someone opens the job. |
| Any status change in Drapr | The partner is emailed automatically: accepted, in our workshop, cleaned and ready, invoiced (with their commission), completed, declined. |
| 1st of the month, 8am | Each partner gets a commission statement for jobs invoiced last month. You get a summary of what to pay. |

## Who bills the customer (set per job)

- **Dr Drapes bills the customer.** Fergus raises the job against the
  customer. Commission is paid to the partner monthly. Pay it from Xero, then tick it off in
  **Admin → Partners → Commission to pay** with the bill or RCTI number.
- **Partner bills their customer.** Fergus raises the job against the partner's
  account. The job page shows what to invoice them: the quote less their
  commission. Nothing to pay separately.

Change either on the job's **Partner & Commission** panel. You can also
override the commission % on any single job there.

## Commission rules built in

- Paid on the cleaning and repair lines only, **ex GST**. Transport, rehang,
  call-out, storage and fuel are excluded.
- Any discount the office gives comes off the commission base in proportion.
- Earned in the month the job is marked **Invoiced**.
- If you edit a partner's quote in Drapr, the commission follows the new
  price when you save it.

**GST / paying commission:** if a partner is GST-registered, the cleanest way
to pay them is a recipient-created tax invoice (RCTI) from Xero. That needs a
short written RCTI agreement with each partner (GST Act, s 29-70 and the RCTI
determination). Otherwise they invoice you for the amount on their statement.

## What partners can and can't see

They see only their own jobs: customer, quote, status, their commission and
their pre-inspection. They can't see other partners, our other customers,
internal notes, Fergus, or any price list beyond the rates on their own quotes.
Their login has no access to the staff app or to the database directly.

## Limits worth knowing

- Partners can't use custom line items, change rates, add discounts or add
  extras. If a quote needs any of that, edit it in Drapr. The partner then
  sees the updated quote.
- Once a quote is accepted, the partner can't change it. Once the job is In
  Progress, they can't change the pre-inspection.
- Partner quotes aren't linked to a customer record until someone opens and
  saves the customer details in Drapr. Fergus matching works as it does for
  online acceptances.
