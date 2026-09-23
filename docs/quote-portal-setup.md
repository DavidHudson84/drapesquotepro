# Online quote acceptance — how to turn it on

Nothing in this build is live until the steps below are done. Until then the app
behaves exactly as it did yesterday.

Work through it in order. Steps 1–3 make it work on the current web address, and
you can test it properly at that point. Step 4 is the DNS, and step 5 is the
tidy-up afterwards.

---

## 1. The database change

Supabase dashboard → **SQL Editor** → paste the whole of
`supabase/migrations/20260923000000_quote_portal.sql` → **Run**.

It adds two columns to the jobs table, a function that mints the customer's
link, a log table behind the accept page, and a private storage bucket that
keeps a copy of each quote PDF. It changes nothing that already exists and it
is safe to run twice.

## 2. The two backend functions

Supabase dashboard → **Edge Functions**.

**quote-portal** — new. Create a function with that exact name and paste in
`supabase/functions/quote-portal/index.ts`. In its settings, **JWT verification
must be off** — customers have no login, so a token is the only key they carry.

**send-quote-email** — already exists. Replace its code with
`supabase/functions/send-quote-email/index.ts`. The change is small: it adds the
accept button under the message and files a copy of the PDF it just sent. Quote
emails keep working exactly as before if you skip this, they simply go out
without a button.

Both use the Resend key already set on the project. Nothing new to configure.

## 3. Publish the app

Push the branch and merge it. GitHub Pages redeploys on its own, which brings
the new `accept.html` page and the app changes with it.

**Test it before telling anyone.** Raise a quote against your own email address,
price it, email it to yourself, and click the button in the email. Accept it.
You should get a confirmation email within seconds, the office should get the
notification, and the job should be sitting at Confirmed in Drapr — with a
Fergus number on it if the match was clean, or flagged on the dashboard if it
wasn't.

---

## 4. The DNS — step by step

This gives customers `quote.drdrapes.com.au` instead of a long github.io link.
Skip it and everything still works; the link is just uglier.

**Before you start, read this:** attaching a custom domain moves the *whole*
Pages site, so the staff app moves to `https://quote.drdrapes.com.au` too and
everyone re-bookmarks it once. GitHub redirects the old address to the new one,
so links already sent out keep working.

One naming note. It cannot be `quotes.drdrapes.com.au` — with the **s** — because
that host already carries the mail records that send your quote emails, and a
name can't be both. `quote.` (no s) is free to use, but the two sit next to each
other in the DNS list and look almost identical, so if you'd rather not have that
trap waiting for whoever edits DNS next, use `accept.drdrapes.com.au` or
`myquote.drdrapes.com.au` instead and put that in place of `quote` below.

### Step 1 — find where drdrapes.com.au DNS is managed

Usually wherever the website is hosted, or the registrar you bought the domain
from. If it is behind Cloudflare, you'll recognise the orange cloud icons.

### Step 2 — add one record

| Field | Value |
|---|---|
| Type | `CNAME` |
| Name / Host | `quote` |
| Value / Points to / Target | `davidhudson84.github.io` |
| TTL | 1 hour (or the default) |
| Proxy status *(Cloudflare only)* | **DNS only** — grey cloud, not orange |

Just `davidhudson84.github.io`. No `https://`, no `/drapesquotepro`, no trailing
dot unless your DNS host adds one itself.

The Cloudflare proxy setting matters: leave it orange and GitHub can't issue the
HTTPS certificate, and customers get a security warning instead of a quote.

Save it. DNS usually takes 10–30 minutes, occasionally a few hours.

### Step 3 — tell GitHub about it

GitHub → the `drapesquotepro` repository → **Settings** → **Pages** →
**Custom domain** → type `quote.drdrapes.com.au` → **Save**.

It runs a DNS check. Green tick means the record is right. If it complains,
wait twenty minutes and press Save again — it is nearly always DNS that hasn't
propagated yet rather than a wrong record.

### Step 4 — force HTTPS

Same page, tick **Enforce HTTPS**. The tickbox stays greyed out until GitHub has
issued the certificate, which takes up to an hour after the DNS check passes.
Don't send a quote until this is ticked.

### Step 5 — point the app at it

Drapr → **Admin** → **Email Templates** → **Customer quote link** → set it to:

```
https://quote.drdrapes.com.au/
```

Save. Every quote and follow-up from that moment carries the new address. Links
already in customers' inboxes keep working — the token finds the job either way.

---

## 5. Afterwards

**The staff login URL changed.** Send everyone the new one, and update the
`APP_URL` line at the top of the `send-password-reset` function in Supabase to
`https://quote.drdrapes.com.au/` or password reset emails will point staff at
the old address.

**Check the wording.** Admin → Email Templates → *Acceptance email — body* is
what a customer gets the second they accept, and it currently opens with "Hik,".
Worth fixing before the first one goes out unattended.

---

## What the office sees

Every acceptance, decline and question emails `drdrapes@hudsongroup.com.au` and
the company contact address straight away. On the dashboard, an **Accepted
online** card sits with the other attention cards; it counts acceptances nobody
has opened yet, and turns red when one is waiting to be pushed to Fergus. The
count clears when someone opens the job.

## Where a job can get stuck, and why

Fergus is raised automatically only when the customer and the site both match
records Fergus already holds. Where either is new, or where the address is
already held against a different customer, the push is held and the job says so
on the dashboard and on the job page — press **Push to Fergus** and approve the
match as you do today. That is deliberate: a duplicate Fergus customer takes
longer to unpick than a morning's wait, and it is exactly the mess the accounts
work was cleaning up.
