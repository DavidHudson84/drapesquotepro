// quote-portal
//
// The customer's end of a quote. One public, unauthenticated endpoint behind
// the link in the quote email: it shows the quote, and it takes the answer —
// accepted, declined, or a question.
//
// Everything here runs as service role, because the anon key must never be
// able to read a job. The token in the link is the only key, it resolves to
// exactly one job, and every hit is logged: that log is both the rate limiter
// and, for an acceptance, the evidence that this customer agreed to these
// terms at this time from this address.
//
// POST { token, action, ... }
//
//   action: 'view'      -> the quote, as a customer may see it
//   action: 'accept'    { name, terms_confirmed, po_number? }
//   action: 'decline'   { reason, note? }
//   action: 'question'  { name?, message }
//
// ACCEPTING does exactly what the Confirm Acceptance button does in the app:
// records the acceptance, moves the job to Confirmed, and raises it in Fergus.
// It stops short in one place — where the Fergus matcher is not certain which
// customer or site this is, it holds off and flags it, because that question
// needs a person and the customer accepting at 9pm is not that person.
//
// WORK ITEMS are deliberately not built here. The quote lines become item
// records through the pricing engine that lives in index.html, and a second
// copy of that engine in Deno would drift from the first one within a month.
// The app fills them in the moment anyone opens the job. See jobPage().

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const FROM = 'Dr Drapes Curtain Clinic <send@quotes.drdrapes.com.au>';
const REPLY_TO = 'drdrapes@hudsongroup.com.au';

// A token answering more than this in ten minutes is not a customer reading
// their quote. Generous enough that a slow phone refreshing never trips it.
const RATE_LIMIT = 60;
const RATE_WINDOW_MIN = 10;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

// ------------------------------------------------------------------ catalogue
// Mirrors CATALOG and REPAIRS in index.html. Labels only — no rates, no tiers,
// none of the pricing engine. If a category is added there and not here, the
// portal falls back to the raw key rather than dropping the line, so a quote
// can never silently show a customer fewer items than it charges them for.

const ITEM_LABELS: Record<string, string> = {
  curtain: 'Standard Curtain / Drape',
  sheer: 'Sheer Curtain',
  velvet: 'Velvet / Silk / Linen / Satin',
  roman: 'Roman Blind',
  austrian: 'Austrian Blind',
  'roller-sun': 'Roller Blind — Sunscreen',
  'roller-block': 'Roller Blind — Blockout',
  venetian: 'Venetian Blind',
  pelmet: 'Pelmet',
  swags: 'Swags & Tails',
  valance: 'Valance on Hooks',
  custom: 'Custom item',
};

const REPAIR_LABELS: Record<string, string> = {
  'cord-replace': 'Cord Replace', 'cord-tidy': 'Cord Tidy',
  'hook-replace': 'Hook Replace', 'ring-replace': 'Ring Replace',
  'weight-replace': 'Weight Replace', 'track-repair': 'Track Repair',
  'track-replace': 'Track Replace', 'motor-service': 'Motor Service',
  'motor-replace': 'Motor Replace', 'lining-repair': 'Lining Repair',
  'heading-repair': 'Heading Repair', 'seam-repair': 'Seam Repair',
  'bracket-replace': 'Bracket Replace', 'wand-replace': 'Wand Replace',
  'fascia-repair': 'Fascia Repair',
};

const DECLINE_REASONS = ['price', 'elsewhere', 'timing', 'no_response', 'other'];

// Same rule as toMetres() in index.html: under 100 is metres, 100 and over is
// millimetres. Display only — the amounts shown are the ones the quote saved.
function metres(raw: unknown) {
  const n = parseFloat(String(raw ?? ''));
  if (!isFinite(n) || n <= 0) return 0;
  return n >= 100 ? n / 1000 : n;
}

function money(n: unknown) {
  return '$' + Number(n || 0).toLocaleString('en-AU', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

function escapeHtml(s: unknown) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ));
}

async function sha256(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const firstName = (n: unknown) => String(n ?? '').trim().split(/\s+/)[0] || '';

// ------------------------------------------------------------------- the view
// What the customer is allowed to see. Built by naming every field rather than
// by deleting the private ones, so a new field added to the quote in the app
// is invisible here until someone decides it should be visible. Rates, margin,
// internal notes, photos, staff names and the Fergus side all stay behind.

function buildView(job: any, company: any, settings: Record<string, string>) {
  const q = job.data?.quote || {};

  const lineDetail = (it: any) => {
    if (it.cat === 'custom') return '';
    const w = metres(it.width), d = metres(it.drop);
    const bits: string[] = [];
    if (w && d) bits.push(`${w.toFixed(2)}m W × ${d.toFixed(2)}m H`);
    else if (w) bits.push(`${w.toFixed(2)}m W`);
    if (it.mould) bits.push('mould treatment');
    if (it.item_note) bits.push(String(it.item_note));
    return bits.join(' · ');
  };

  const rooms = (q.rooms || []).map((room: any) => ({
    name: room.name || 'Room',
    lines: [
      ...(room.items || []).map((it: any) => ({
        label: it.cat === 'custom'
          ? (it.label || 'Custom item')
          : (ITEM_LABELS[it.cat] || it.cat),
        detail: lineDetail(it),
        amount: Number(it.amount) || 0,
      })),
      ...(room.repairs || []).map((r: any) => ({
        label: REPAIR_LABELS[r.key] || r.key,
        detail: `qty ${Math.max(0, parseInt(r.qty, 10) || 0)}`,
        amount: Number(r.amount) || 0,
      })),
    ],
  })).filter((r: any) => r.lines.length);

  const repairs = (q.repairs || []).map((r: any) => ({
    label: REPAIR_LABELS[r.key] || r.key,
    detail: `qty ${Math.max(0, parseInt(r.qty, 10) || 0)}`,
    amount: Number(r.amount) || 0,
  }));

  // Same rows, same wording and same order as the PDF's Extras block.
  const ex = q.extras || {};
  const extras: any[] = [];
  if (ex.fuel_on && Number(ex.fuel_amt)) extras.push({ label: 'Fuel levy', amount: Number(ex.fuel_amt) });
  ([['transport', 'Transport'], ['rehang', 'Rehang'], ['callout', 'Call-out'], ['storage', 'Storage']] as const)
    .forEach(([k, l]) => { if (Number(ex[k])) extras.push({ label: l, amount: Number(ex[k]) }); });
  if (Number(ex.other_amt)) extras.push({ label: ex.other_desc || 'Other', amount: Number(ex.other_amt) });

  const acc = job.data?.acceptance || {};
  const dec = job.data?.declined || null;

  // 'decided' is what the page keys off: an accepted or declined quote shows
  // its outcome and no buttons. Anything past Confirmed counts as accepted too
  // — a job already in production is not one to re-ask the customer about.
  const accepted = !!acc.confirmed_at ||
    ['confirmed', 'in_progress', 'complete', 'invoiced', 'rehung'].includes(job.status);

  return {
    quote_number: job.quote_number || '',
    quote_date: q.quote_date || job.quote_date || null,
    customer_first_name: firstName(job.customer_name),
    site_address: job.site_address || '',
    reference: job.account_reference || q.claim_number || '',
    insurer: q.insurer_name || '',

    company: {
      name: company?.name || 'Dr Drapes Curtain Clinic',
      phone: company?.contact_phone || '',
      email: company?.contact_email || '',
    },

    rooms,
    repairs,
    extras,
    notes: q.notes || '',

    subtotal: Number(q.subtotal) || 0,
    gst: Number(q.gst) || 0,
    total: Number(q.total) || 0,
    discount_amount: Number(q.discount_amount) || 0,

    terms: settings['terms-text'] || '',
    outro: settings['email-outro'] || '',

    decided: accepted || !!dec,
    decision: accepted ? 'accepted' : (dec ? 'declined' : null),
    accepted_at: acc.confirmed_at || null,
    accepted_by: acc.confirmed_by || null,
    declined_at: dec?.at || null,
    po_number: job.data?.po_number || '',
  };
}

// ------------------------------------------------------------------ the email

async function sendEmail(to: string[], subject: string, html: string, replyTo = REPLY_TO) {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key || !to.filter(Boolean).length) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: to.filter(Boolean), reply_to: replyTo, subject, html }),
  });
  if (!res.ok) console.error('Resend failed', await res.text());
  return res.ok;
}

const shell = (inner: string) => `
<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,Helvetica,sans-serif;margin:0;background:#f1f4f3">
<div style="max-width:600px;margin:20px auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e2e8e7">
  <div style="background:#0F6E63;padding:22px 28px">
    <div style="font-size:19px;font-weight:700;color:#fff">Dr Drapes Curtain Clinic</div>
  </div>
  <div style="padding:26px 28px">${inner}</div>
</div></body></html>`;

// The office copy. Written to be read on a phone in two seconds: what happened,
// which quote, how much, and whether anything is now waiting on a person.
function staffHtml(kind: 'accepted' | 'declined' | 'question', job: any, extra: Record<string, string>) {
  const rows = Object.entries(extra)
    .filter(([, v]) => v)
    .map(([k, v]) => `<tr>
      <td style="padding:7px 12px;color:#5A6866;font-size:12px;white-space:nowrap;vertical-align:top">${escapeHtml(k)}</td>
      <td style="padding:7px 12px;color:#12211F;font-size:14px">${escapeHtml(v)}</td></tr>`).join('');

  const headline = kind === 'accepted'
    ? `Quote ${escapeHtml(job.quote_number)} accepted online`
    : kind === 'declined'
      ? `Quote ${escapeHtml(job.quote_number)} declined online`
      : `Question on quote ${escapeHtml(job.quote_number)}`;

  const colour = kind === 'accepted' ? '#1E7A4B' : kind === 'declined' ? '#B3261E' : '#0F6E63';

  return shell(`
    <div style="font-size:18px;font-weight:700;color:${colour};margin:0 0 4px">${headline}</div>
    <div style="font-size:13px;color:#5A6866;margin:0 0 18px">${escapeHtml(job.customer_name || '')}${job.site_address ? ' — ' + escapeHtml(job.site_address) : ''}</div>
    <table style="width:100%;border-collapse:collapse;background:#f7faf9;border:1px solid #e2e8e7;border-radius:6px">${rows}</table>
    <p style="color:#5A6866;font-size:12px;margin:18px 0 0">The job is open in Drapr under ${escapeHtml(job.quote_number)}.</p>`);
}

// ------------------------------------------------------------------- handler

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'Body must be JSON' }, 400); }

  const token = String(body?.token ?? '').trim();
  const action = String(body?.action ?? 'view');
  if (!token) return json({ error: 'not_found' }, 404);

  const tokenHash = await sha256(token);
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || null;
  const ua = (req.headers.get('user-agent') || '').slice(0, 300) || null;

  const log = async (jobId: string | null, act: string, detail: Record<string, unknown> = {}) => {
    try {
      await admin.from('quote_portal_events')
        .insert({ job_id: jobId, token_hash: tokenHash, action: act, ip, user_agent: ua, detail });
    } catch (e) { console.error('portal log failed', e); }
  };

  try {
    // Rate limit before the token is resolved, so a guessing bot is throttled
    // on the attempts themselves rather than on the ones that happen to land.
    const since = new Date(Date.now() - RATE_WINDOW_MIN * 60_000).toISOString();
    const { count } = await admin
      .from('quote_portal_events')
      .select('id', { count: 'exact', head: true })
      .eq('token_hash', tokenHash)
      .gte('created_at', since);
    if ((count ?? 0) > RATE_LIMIT) {
      return json({ error: 'rate_limited' }, 429);
    }

    const { data: job } = await admin
      .from('jobs')
      .select('*')
      .eq('accept_token', token)
      .maybeSingle();

    if (!job || job.archived) {
      await log(null, 'miss', { action });
      return json({ error: 'not_found' }, 404);
    }

    const [{ data: company }, { data: settingRows }] = await Promise.all([
      admin.from('companies').select('name, contact_email, contact_phone').eq('id', job.company_id).single(),
      admin.from('settings').select('key, value').eq('company_id', job.company_id),
    ]);
    const settings: Record<string, string> = {};
    (settingRows || []).forEach((r: any) => { settings[r.key] = r.value; });

    const officeTo = [company?.contact_email, REPLY_TO].filter(Boolean) as string[];
    const customerTo = job.customer_email ? [job.customer_email] : [];

    // ------------------------------------------------------------------ view
    if (action === 'view') {
      await log(job.id, 'view');
      const view: any = buildView(job, company, settings);

      // The Download button hands back the exact PDF that was emailed, not a
      // fresh rendering of it. If none was archived — a quote sent by hand
      // from Outlook before this existed — the button simply isn't offered.
      const path = job.data?.quote?.pdf_path;
      if (path) {
        const { data: signed } = await admin.storage.from('quote-pdfs').createSignedUrl(path, 3600);
        if (signed?.signedUrl) view.pdf_url = signed.signedUrl;
      }
      return json({ ok: true, quote: view });
    }

    // A quote that has already been answered never takes a second answer. The
    // page reloads and shows the outcome instead, so a double-tap on a slow
    // phone can't decline a job that is already in production.
    const alreadyAccepted = !!job.data?.acceptance?.confirmed_at ||
      ['confirmed', 'in_progress', 'complete', 'invoiced', 'rehung'].includes(job.status);
    const alreadyDeclined = job.status === 'declined';

    // --------------------------------------------------------------- accept
    if (action === 'accept') {
      if (alreadyAccepted) return json({ ok: true, already: true, decision: 'accepted' });
      if (alreadyDeclined) return json({ error: 'already_declined' }, 409);
      if (job.status !== 'quoted') return json({ error: 'not_open' }, 409);

      const name = String(body?.name ?? '').trim();
      if (name.length < 2) return json({ error: 'name_required' }, 400);
      if (!body?.terms_confirmed) return json({ error: 'terms_required' }, 400);

      const total = Number(job.data?.quote?.total) || 0;
      if (total <= 0) return json({ error: 'no_quote' }, 409);

      const at = new Date().toISOString();
      const poNumber = String(body?.po_number ?? '').trim().slice(0, 60);

      const data = job.data ?? {};
      // 'how: online' is what the app's acceptance banner and the reports read
      // to tell a self-service acceptance from one taken over the phone.
      data.acceptance = {
        how: 'online',
        terms_confirmed: true,
        confirmed_at: at,
        confirmed_by: name,
        online: {
          name,
          email: job.customer_email || null,
          ip,
          user_agent: ua,
          po_number: poNumber || null,
          terms_version_length: (settings['terms-text'] || '').length,
        },
      };
      if (poNumber) data.po_number = poNumber;
      data.status_history = [...(data.status_history || []), {
        status: 'confirmed',
        changed_by: `${name} (online)`,
        changed_at: at,
        note: 'Accepted by the customer from the quote link',
      }];

      // Matching on status as well as id is the lock: if the office confirmed
      // or declined this quote in the seconds since the page loaded, nothing
      // is updated and the customer is told to reload rather than overwriting
      // a decision a person already made.
      const { data: won, error: upErr } = await admin.from('jobs')
        .update({ data, status: 'confirmed', updated_at: at })
        .eq('id', job.id)
        .eq('status', 'quoted')
        .select('id');
      if (upErr) {
        console.error('accept write failed', upErr);
        return json({ error: 'write_failed' }, 500);
      }
      if (!won || !won.length) return json({ error: 'not_open' }, 409);

      // Fergus. Preview first: where the matcher is sure who this customer and
      // site are, raise the job now. Where it isn't, leave it — a duplicate
      // Fergus customer costs more to unpick than a morning's delay.
      let fergus: any = { pushed: false, reason: 'not attempted' };
      try {
        fergus = await pushToFergus(job.id);
      } catch (e) {
        console.error('fergus push failed', e);
        fergus = { pushed: false, reason: String(e) };
      }
      // Re-read before writing the result back. push-to-fergus has just
      // rewritten this job's data itself to record which Fergus records it
      // attached to, and writing our own copy over the top would erase that
      // audit trail — the one thing that makes a wrong match unpickable later.
      const { data: after } = await admin.from('jobs').select('data').eq('id', job.id).single();
      const merged = { ...(after?.data ?? data) };
      merged.acceptance = { ...(merged.acceptance ?? data.acceptance), fergus };
      await admin.from('jobs').update({ data: merged }).eq('id', job.id);

      await log(job.id, 'accept', { name, total, po_number: poNumber || null, fergus });

      const ref = job.quote_number || '';
      const bodyTpl = (settings['acceptance-email-body'] || '')
        .replace(/\{ref\}/g, ref)
        .replace(/\{company\}/g, company?.name || 'Dr Drapes Curtain Clinic');
      const greeting = job.customer_name ? `Hi ${escapeHtml(firstName(job.customer_name))},` : 'Hi,';

      await Promise.all([
        customerTo.length ? sendEmail(customerTo, `Quote ${ref} accepted — thank you`, shell(`
          <p style="color:#12211F;font-size:15px;margin:0 0 14px">${greeting}</p>
          <div style="color:#3a4a48;font-size:14px;white-space:pre-wrap;margin:0 0 20px">${escapeHtml(bodyTpl || 'Thanks — we have your acceptance and we will be in touch shortly to arrange collection.')}</div>
          <table style="width:100%;border-collapse:collapse;background:#f7faf9;border:1px solid #e2e8e7;border-radius:6px">
            <tr><td style="padding:8px 12px;color:#5A6866;font-size:12px">Quote</td><td style="padding:8px 12px;color:#12211F;font-size:14px;font-weight:700">${escapeHtml(ref)}</td></tr>
            <tr><td style="padding:0 12px 8px;color:#5A6866;font-size:12px">Total (inc GST)</td><td style="padding:0 12px 8px;color:#12211F;font-size:14px">${money(total)}</td></tr>
            <tr><td style="padding:0 12px 8px;color:#5A6866;font-size:12px">Accepted by</td><td style="padding:0 12px 8px;color:#12211F;font-size:14px">${escapeHtml(name)}</td></tr>
            ${poNumber ? `<tr><td style="padding:0 12px 8px;color:#5A6866;font-size:12px">Your reference</td><td style="padding:0 12px 8px;color:#12211F;font-size:14px">${escapeHtml(poNumber)}</td></tr>` : ''}
          </table>
          <p style="color:#8a9694;font-size:12px;margin:18px 0 0">Accepted ${new Date(at).toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' })} · terms of trade accepted.</p>`)) : null,

        sendEmail(officeTo, `✅ ${ref} accepted online — ${money(total)}`, staffHtml('accepted', job, {
          'Accepted by': name,
          'Total': money(total),
          'Their reference': poNumber,
          'Fergus': fergus.pushed
            ? `raised as ${fergus.fergus_job_no || 'a new job'}`
            : `NOT raised — ${fergus.reason}. Open the job and press Push to Fergus.`,
        })),
      ]);

      return json({ ok: true, decision: 'accepted' });
    }

    // -------------------------------------------------------------- decline
    if (action === 'decline') {
      if (alreadyAccepted) return json({ error: 'already_accepted' }, 409);
      if (alreadyDeclined) return json({ ok: true, already: true, decision: 'declined' });
      if (job.status !== 'quoted') return json({ error: 'not_open' }, 409);

      const reason = DECLINE_REASONS.includes(String(body?.reason)) ? String(body.reason) : 'other';
      const note = String(body?.note ?? '').trim().slice(0, 1000);
      const at = new Date().toISOString();

      const data = job.data ?? {};
      data.declined = { reason, note, at, by: 'Customer (online)' };
      data.status_history = [...(data.status_history || []), {
        status: 'declined',
        changed_by: 'Customer (online)',
        changed_at: at,
        note: 'Declined by the customer from the quote link',
      }];

      const { data: won, error: upErr } = await admin.from('jobs')
        .update({ data, status: 'declined', updated_at: at })
        .eq('id', job.id)
        .eq('status', 'quoted')
        .select('id');
      if (upErr) return json({ error: 'write_failed' }, 500);
      if (!won || !won.length) return json({ error: 'not_open' }, 409);

      await log(job.id, 'decline', { reason, note });

      const ref = job.quote_number || '';
      await Promise.all([
        customerTo.length ? sendEmail(customerTo, `Quote ${ref} — thanks for letting us know`, shell(`
          <p style="color:#12211F;font-size:15px;margin:0 0 14px">Hi ${escapeHtml(firstName(job.customer_name)) || 'there'},</p>
          <p style="color:#3a4a48;font-size:14px;margin:0 0 14px">Thanks for coming back to us on quote ${escapeHtml(ref)} — we've closed it off and you won't hear from us about it again.</p>
          <p style="color:#3a4a48;font-size:14px;margin:0 0 14px">If anything changes, or you'd like it re-quoted differently, just reply to this email and we'll pick it straight back up.</p>
          <p style="color:#3a4a48;font-size:14px;margin:0">Kind regards,<br/>The Dr Drapes Team</p>`)) : null,

        sendEmail(officeTo, `Quote ${ref} declined online — ${reason}`, staffHtml('declined', job, {
          'Reason': reason,
          'What they said': note,
          'Quote value': money(job.data?.quote?.total || 0),
        })),
      ]);

      return json({ ok: true, decision: 'declined' });
    }

    // ------------------------------------------------------------- question
    if (action === 'question') {
      const message = String(body?.message ?? '').trim().slice(0, 4000);
      if (message.length < 3) return json({ error: 'message_required' }, 400);
      const name = String(body?.name ?? '').trim().slice(0, 120) || job.customer_name || 'The customer';
      const at = new Date().toISOString();

      const data = job.data ?? {};
      data.portal_messages = [...(data.portal_messages || []), { at, name, message }];
      await admin.from('jobs').update({ data, updated_at: at }).eq('id', job.id);

      await log(job.id, 'question', { message });

      const ref = job.quote_number || '';
      await Promise.all([
        customerTo.length ? sendEmail(customerTo, `We've got your question about quote ${ref}`, shell(`
          <p style="color:#12211F;font-size:15px;margin:0 0 14px">Hi ${escapeHtml(firstName(job.customer_name)) || 'there'},</p>
          <p style="color:#3a4a48;font-size:14px;margin:0 0 14px">Thanks — your message about quote ${escapeHtml(ref)} has come through and someone will come back to you shortly. The quote stays open in the meantime.</p>
          <div style="background:#f7faf9;border:1px solid #e2e8e7;border-radius:6px;padding:12px 14px;color:#3a4a48;font-size:13px;white-space:pre-wrap">${escapeHtml(message)}</div>
          <p style="color:#3a4a48;font-size:14px;margin:16px 0 0">Kind regards,<br/>The Dr Drapes Team</p>`)) : null,

        sendEmail(officeTo, `Question on quote ${ref} — ${firstName(name) || 'customer'}`, staffHtml('question', job, {
          'From': name,
          'Message': message,
          'Quote value': money(job.data?.quote?.total || 0),
        }), job.customer_email || REPLY_TO),
      ]);

      return json({ ok: true });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (e) {
    console.error('quote-portal error', e);
    return json({ error: 'server_error' }, 500);
  }
});

// ---------------------------------------------------------------- Fergus push
//
// Calls the existing push-to-fergus function rather than re-implementing any of
// it: all the customer and site matching, the account handling and the DRD
// write-back already live there and are exercised by every manual acceptance.
// Preview first — the same two-step the app does — but with no one to answer a
// question, an uncertain match means stop, not guess.

async function pushToFergus(jobId: string) {
  const base = Deno.env.get('SUPABASE_URL')!;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const call = async (payload: Record<string, unknown>) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25_000);
    try {
      const res = await fetch(`${base}/functions/v1/push-to-fergus`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
        body: JSON.stringify({ job_id: jobId, ...payload }),
        signal: ctl.signal,
      });
      return await res.json().catch(() => ({}));
    } finally { clearTimeout(timer); }
  };

  const pv = await call({ preview: true });
  if (!pv?.ok) return { pushed: false, reason: pv?.error || 'Fergus preview failed' };
  if (pv.needs_confirmation) {
    return {
      pushed: false,
      needs_confirmation: true,
      reason: pv.site?.conflict
        ? 'that address is already held against another Fergus customer, so the match needs checking'
        : 'this is a new customer or site in Fergus, so the match needs checking',
    };
  }

  const out = await call({});
  if (!out?.ok) return { pushed: false, reason: out?.error || 'Fergus push failed' };
  return {
    pushed: true,
    fergus_job_id: out.fergus_job_id ?? null,
    fergus_job_no: out.fergus_job_no ?? null,
    reason: out.already ? 'already in Fergus' : 'raised',
  };
}
