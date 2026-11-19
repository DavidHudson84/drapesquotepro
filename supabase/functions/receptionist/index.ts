// receptionist
//
// Drapr's end of the AI phone receptionist. The voice side — answering, speech,
// the conversation itself — is Retell (retellai.com). Retell calls this one
// endpoint for everything it needs from Drapr:
//
//   1. INBOUND CALL WEBHOOK  { event: 'call_inbound', call_inbound: {...} }
//      Fires as the phone rings, before the agent speaks. We look the caller ID
//      up against Drapr and hand back dynamic variables, so the agent can open
//      with "Hi Sarah" and already knows there is a job on the go.
//
//   2. CUSTOM FUNCTIONS      { name, call, args }
//      find_caller_jobs   - the caller's jobs, matched on caller ID
//      find_job           - a job by number, only if the surname matches too
//      send_quote_link    - SMS the online quote form (Twilio)
//      take_message       - message / callback request, emailed to the office
//
//   3. CALL EVENTS           { event: 'call_started' | 'call_ended' | 'call_analyzed', call }
//      Logged to receptionist_calls. On call_analyzed the office gets a summary
//      email with the transcript, flagged CALL BACK where one was asked for.
//
// SECURITY. Every URL Retell is given carries ?key=<receptionist-secret> from
// integration_secrets; anything without it is turned away. JWT verification is
// off for this function — Retell has no Supabase login.
//
// What a caller can learn is deliberately narrow. Matching on caller ID uses
// the number the carrier delivered, never a number the caller says. A job
// looked up by number needs the surname on it too, and three wrong guesses on
// a call closes the lookup for that call. What comes back is status, suburb
// and the next booked visit — no prices, no street addresses, no notes.
//
// Secrets (Edge Function secrets): RESEND_API_KEY (already set),
// TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SMS_FROM.

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const TZ = 'Australia/Melbourne';
const FROM_EMAIL = 'Dr Drapes Receptionist <send@quotes.drdrapes.com.au>';
const DEFAULT_NOTIFY = 'drdrapes@hudsongroup.com.au';
const DEFAULT_FORM_URL = 'https://quote.drdrapes.com.au/request.html';
const MAX_LOOKUPS = 3;  // job-number + surname attempts per call
const MAX_SMS = 2;      // quote-link texts per call

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

// ------------------------------------------------------------------- helpers

function normPhone(p: unknown): string {
  const d = String(p ?? '').replace(/\D/g, '');
  if (/^61[2-478]\d{8}$/.test(d)) return '0' + d.slice(2);
  if (/^[2-478]\d{8}$/.test(d)) return '0' + d;
  return d;
}

const isMobile = (p: string) => /^04\d{8}$/.test(p);
const toE164 = (p: string) => '+61' + p.slice(1);
const firstName = (n: unknown) => String(n ?? '').trim().split(/\s+/)[0] || '';

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function escapeHtml(s: unknown) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ));
}

function melbNow() {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long',
    year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date());
}

function dayLabel(dateStr: string | null) {
  if (!dateStr) return '';
  // stop_date is a plain date; noon UTC keeps it on the right day in Melbourne.
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long',
  }).format(new Date(dateStr + 'T12:00:00Z'));
}

function timeLabel(ts: string | null) {
  if (!ts) return '';
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: TZ, hour: 'numeric', minute: '2-digit',
  }).format(new Date(ts)).replace(' ', '').toLowerCase();
}

// Street addresses stay out of the conversation; the suburb is enough for a
// caller to know which job is being talked about.
function suburbOf(addr: unknown) {
  const parts = String(addr ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  let last = parts.length > 1 ? parts[parts.length - 1] : parts[0] || '';
  last = last.replace(/\b(VIC|Victoria|NSW|QLD|SA|WA|TAS|ACT|NT)\b.*$/i, '').replace(/\d{4}\s*$/, '').trim();
  if (!/\d/.test(last)) return last;
  // No comma, so the street is still on the front ("12 Smith St Williamstown").
  // Keep what follows the street type; if there's no street type, say nothing.
  const m = last.match(/\b(st|street|rd|road|ave|avenue|ct|court|dr|drive|cres|crescent|pl|place|pde|parade|bvd|blvd|boulevard|hwy|highway|ln|lane|way|cl|close|tce|terrace|gr|grove|cct|circuit)\b\.?\s+(.+)$/i);
  return m && !/\d/.test(m[2]) ? m[2].trim() : '';
}

// What each Drapr status means to a customer, in words the agent can say.
const STATUS_WORDS: Record<string, string> = {
  draft: 'We are still preparing the quote.',
  quoted: 'The quote has been sent and we are waiting on the go-ahead to book it in.',
  confirmed: 'The quote is accepted and the job is booked in, waiting for take-down.',
  in_progress: 'The items are with us at the clinic being cleaned.',
  complete: 'Cleaning is finished and the items are ready to come back to you.',
  invoiced: 'Cleaning is finished and the invoice has been sent. Payment is due before rehang.',
  rehung: 'This job is finished — the items have been returned and rehung.',
  declined: 'This quote was closed without going ahead.',
};

const STOP_WORDS: Record<string, string> = {
  takedown: 'take-down', rehang: 'rehang', other: 'visit',
};

function describeJob(j: any) {
  const ref = j.quote_number || j.drd_number || '';
  const next = j.next_stop_date
    ? `Next booked visit: ${STOP_WORDS[j.next_stop_type] || 'visit'} on ${dayLabel(j.next_stop_date)}` +
      (j.next_stop_starts ? `, arrival window ${timeLabel(j.next_stop_starts)}` +
        (j.next_stop_ends ? ` to ${timeLabel(j.next_stop_ends)}` : '') : '') + '.'
    : (['confirmed', 'complete', 'invoiced'].includes(j.status)
        ? 'No visit is booked in the calendar yet — the team will be in touch to arrange it.'
        : '');
  return {
    job_number: ref,
    customer_first_name: firstName(j.customer_name),
    suburb: suburbOf(j.site_address),
    status: j.status,
    status_explained: STATUS_WORDS[j.status] || 'The team can confirm where this job is up to.',
    next_visit: next,
  };
}

async function settingsMap(sb: SupabaseClient) {
  const { data } = await sb.from('settings').select('key, value').like('key', 'receptionist-%');
  const m: Record<string, string> = {};
  (data || []).forEach((r: any) => { m[r.key] = r.value; });
  return m;
}

async function upsertCall(sb: SupabaseClient, callId: string, patch: Record<string, unknown>) {
  if (!callId) return;
  await sb.from('receptionist_calls').upsert(
    { call_id: callId, ...patch, updated_at: new Date().toISOString() },
    { onConflict: 'call_id' },
  );
}

async function getCall(sb: SupabaseClient, callId: string) {
  const { data } = await sb.from('receptionist_calls').select('*').eq('call_id', callId).maybeSingle();
  return data;
}

async function sendEmail(to: string, subject: string, html: string) {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to: to.split(',').map((s) => s.trim()), subject, html }),
  });
  return res.ok;
}

async function sendSms(to: string, body: string) {
  const sid = Deno.env.get('TWILIO_ACCOUNT_SID');
  const token = Deno.env.get('TWILIO_AUTH_TOKEN');
  const from = Deno.env.get('TWILIO_SMS_FROM');
  if (!sid || !token || !from) return { ok: false, error: 'SMS is not set up' };
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${sid}:${token}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  if (!res.ok) return { ok: false, error: await res.text() };
  return { ok: true };
}

// Text the staff on alert (receptionist-alert-mobiles: comma-separated
// mobiles). True if at least one went through.
async function alertStaff(settings: Record<string, string>, text: string) {
  const to = String(settings['receptionist-alert-mobiles'] || '')
    .split(/[,;]/).map(normPhone).filter(isMobile);
  if (!to.length) return false;
  const results = await Promise.all(to.map((m) => sendSms(toE164(m), text)));
  results.filter((r) => !r.ok).forEach((r) => console.error('staff alert failed', r.error));
  return results.some((r) => r.ok);
}

// Retell sends 'N/A', 'none', 'unknown' and the like for fields that didn't
// come up on the call. Treat them all as blank.
function clean(v: unknown) {
  const t = String(v ?? '').trim();
  return /^(n\/?a|none|null|unknown|not (provided|given|mentioned|applicable)|-)?\.?$/i.test(t) ? '' : t;
}

function phoneFmt(p: unknown) {
  const n = normPhone(p);
  if (/^04\d{8}$/.test(n)) return `${n.slice(0, 4)} ${n.slice(4, 7)} ${n.slice(7)}`;
  if (/^0\d{9}$/.test(n)) return `${n.slice(0, 2)} ${n.slice(2, 6)} ${n.slice(6)}`;
  return n || 'Withheld';
}

function melbTime(ts: string | null) {
  if (!ts) return '';
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  }).format(new Date(ts));
}

// Retell's transcript comes in fragments: several lines from the same speaker
// in a row, and half-sentences cut off when the other person talks over them.
// Name the speakers, drop Sally's cut-off restarts, carry the caller's
// fragments into their next line, and join consecutive lines.
function tidyTranscript(t: unknown): { who: string; text: string }[] {
  const out: ({ who: string; text: string } | null)[] = [];
  for (const raw of String(t ?? '').split('\n')) {
    const m = raw.match(/^\s*(Agent|User)\s*:\s*(.*)$/i);
    if (!m) { const l = out[out.length - 1]; if (l && raw.trim()) l.text += ' ' + raw.trim(); continue; }
    const text = m[2].trim();
    if (text) out.push({ who: /agent/i.test(m[1]) ? 'Sally' : 'Caller', text });
  }
  const done = (x: string) => /[.?!\u2026]["')]?$/.test(x);
  for (let i = 0; i < out.length; i++) {
    const cur = out[i];
    if (!cur || done(cur.text)) continue;
    if (cur.who === 'Sally' && cur.text.split(/\s+/).length <= 8) { out[i] = null; continue; }
    const j = out.findIndex((x, k) => k > i && k <= i + 2 && x && x.who === cur.who);
    if (j > i) { out[j]!.text = cur.text + ' ' + out[j]!.text; out[i] = null; }
  }
  const merged: { who: string; text: string }[] = [];
  for (const x of out) {
    if (!x) continue;
    const last = merged[merged.length - 1];
    if (last && last.who === x.who) last.text = (last.text + ' ' + x.text).replace(/\s+/g, ' ');
    else merged.push({ ...x });
  }
  return merged;
}

function transcriptHtml(t: unknown) {
  const turns = tidyTranscript(t);
  if (!turns.length) return '<p style="color:#666">No transcript.</p>';
  return turns.map((x) => `<p style="margin:0 0 8px;font-size:14px;line-height:1.45"><b style="color:${x.who === 'Sally' ? '#0F6E63' : '#333'}">${x.who}:</b> ${escapeHtml(x.text)}</p>`).join('');
}

// Keep working after the response has gone back to Retell. Supabase's runtime
// holds the worker open for anything handed to waitUntil.
function inBackground(p: Promise<unknown>) {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p);
}

// ----------------------------------------------------------- inbound webhook

async function onInbound(sb: SupabaseClient, inbound: any) {
  const from = normPhone(inbound?.from_number);
  const vars: Record<string, string> = {
    current_time_melbourne: melbNow(),
    caller_known: 'no',
    caller_first_name: '',
    caller_job_summary: '',
  };
  if (from.length === 10) {
    const { data } = await sb.rpc('receptionist_jobs_for_phone', { p_phone: from });
    const jobs = (data || []) as any[];
    if (jobs.length) {
      const live = jobs.filter((j) => !['rehung', 'declined'].includes(j.status));
      const top = describeJob(live[0] || jobs[0]);
      vars.caller_known = 'yes';
      vars.caller_first_name = top.customer_first_name;
      vars.caller_job_summary = live.length
        ? `${live.length} open job(s). Most recent: ${top.job_number} in ${top.suburb}. ${top.status_explained} ${top.next_visit}`.trim()
        : `Past customer. Last job ${top.job_number} in ${top.suburb}: ${top.status_explained}`;
    }
  }
  return json({ call_inbound: { dynamic_variables: vars } });
}

// --------------------------------------------------------- custom functions

async function fnFindCallerJobs(sb: SupabaseClient, call: any) {
  const from = normPhone(call?.from_number);
  if (from.length !== 10) {
    return { found: false, reason: 'The caller ID is withheld, so ask for their job number and surname instead.' };
  }
  const { data, error } = await sb.rpc('receptionist_jobs_for_phone', { p_phone: from });
  if (error) return { found: false, reason: 'Lookup is unavailable right now. Offer to take a message.' };
  const jobs = (data || []) as any[];
  if (!jobs.length) {
    return { found: false, reason: 'No jobs are on file for the number they are calling from. Ask for their job number and surname, or whether it might be under a different number.' };
  }
  await upsertCall(sb, call.call_id, { matched_job_ids: jobs.map((j) => j.id) });
  return { found: true, jobs: jobs.map(describeJob) };
}

async function fnFindJob(sb: SupabaseClient, call: any, args: any) {
  const row = await getCall(sb, call.call_id);
  const attempts = row?.lookup_attempts || 0;
  if (attempts >= MAX_LOOKUPS) {
    return { found: false, reason: 'Too many lookup attempts on this call. Do not try again — offer to take a message for the team to call back.' };
  }
  await upsertCall(sb, call.call_id, { lookup_attempts: attempts + 1 });

  const number = String(args?.job_number ?? '').trim();
  const surname = String(args?.surname ?? '').trim().toLowerCase();
  if (!number || surname.length < 2) {
    return { found: false, reason: 'Need both the job or quote number and the surname on the booking.' };
  }
  const { data, error } = await sb.rpc('receptionist_job_by_number', { p_number: number });
  if (error) return { found: false, reason: 'Lookup is unavailable right now. Offer to take a message.' };
  const match = ((data || []) as any[]).find((j) =>
    String(j.customer_name || '').toLowerCase().split(/[\s,&]+/).includes(surname) ||
    String(j.customer_name || '').toLowerCase().includes(surname));
  if (!match) {
    // Same answer whether the number or the name was wrong — nothing to fish with.
    return { found: false, reason: 'No job matches that number and surname together. Check the number with them once; otherwise take a message.' };
  }
  const ids = new Set([...(row?.matched_job_ids || []), match.id]);
  await upsertCall(sb, call.call_id, { matched_job_ids: [...ids] });
  return { found: true, jobs: [describeJob(match)] };
}

async function fnSendQuoteLink(sb: SupabaseClient, call: any, args: any, settings: Record<string, string>) {
  const row = await getCall(sb, call.call_id);
  const sent = row?.sms_sent || 0;
  if (sent >= MAX_SMS) return { sent: false, reason: 'The link has already been sent on this call.' };

  const caller = normPhone(call?.from_number);
  const asked = normPhone(args?.mobile);
  const to = isMobile(asked) ? asked : (isMobile(caller) ? caller : '');
  if (!to) {
    return { sent: false, reason: 'They are not calling from a mobile. Ask for a mobile number to text the link to, then call this again with it.' };
  }

  const url = new URL(settings['receptionist-form-url'] || DEFAULT_FORM_URL);
  const name = String(args?.name ?? '').trim();
  if (name) url.searchParams.set('name', name);
  url.searchParams.set('phone', to);
  url.searchParams.set('src', 'phone');

  const hi = firstName(name) ? `Hi ${firstName(name)}, ` : 'Hi, ';
  const body = (settings['receptionist-sms-body'] ||
    "{hi}thanks for calling Dr Drapes. Here's the link for your quote request - add your curtain or blind sizes and a few photos and we'll come back to you with a price: {link}")
    .replace('{hi}', hi).replace('{link}', url.toString());

  const res = await sendSms(toE164(to), body);
  if (!res.ok) {
    console.error('sms failed', res.error);
    return { sent: false, reason: 'The text did not go through. Apologise, and let them know they can also find the quote form on the Dr Drapes website.' };
  }
  await upsertCall(sb, call.call_id, { sms_sent: sent + 1 });
  return { sent: true, to_last_three: to.slice(-3) };
}

async function fnTakeMessage(sb: SupabaseClient, call: any, args: any, settings: Record<string, string>) {
  const message = {
    name: String(args?.name ?? '').trim(),
    callback_number: normPhone(args?.callback_number) || normPhone(call?.from_number),
    reason: String(args?.reason ?? '').trim(),
    urgency: String(args?.urgency ?? 'normal').trim(),
    best_time: String(args?.best_time ?? '').trim(),
    taken_at: new Date().toISOString(),
  };
  await upsertCall(sb, call.call_id, {
    from_number: call?.from_number, to_number: call?.to_number,
    message, callback_requested: true,
  });

  // Straight to the office now — not held for the end-of-call summary. Sent in
  // the background: the caller is on the line, and Sally shouldn't sit in
  // silence while an email and two texts go out.
  const to = settings['receptionist-notify-email'] || DEFAULT_NOTIFY;
  const urgent = /urgent|high/i.test(message.urgency);
  const caller = message.callback_number || 'withheld';
  const notify = Promise.all([
    sendEmail(to,
    `${urgent ? 'URGENT ' : ''}CALL BACK: ${message.name || message.callback_number || 'caller'} — ${message.reason.slice(0, 60)}`,
    `<p><b>Message taken by the AI receptionist</b> · ${escapeHtml(melbNow())}</p>
     <table cellpadding="4">
       <tr><td><b>Name</b></td><td>${escapeHtml(message.name)}</td></tr>
       <tr><td><b>Call back on</b></td><td>${escapeHtml(message.callback_number)}</td></tr>
       <tr><td><b>Best time</b></td><td>${escapeHtml(message.best_time)}</td></tr>
       <tr><td><b>Urgency</b></td><td>${escapeHtml(message.urgency)}</td></tr>
       <tr><td valign="top"><b>Message</b></td><td>${escapeHtml(message.reason)}</td></tr>
     </table>
     <p style="color:#666">The full summary and transcript follow once the call ends.</p>`),
    // And a text to the people on alert, so a callback isn't sitting in an
    // inbox all weekend.
    alertStaff(settings,
      `${urgent ? 'URGENT ' : ''}Dr Drapes CALL BACK: ${message.name || 'caller'} ${caller}` +
      `${message.best_time ? ' (' + message.best_time + ')' : ''} - ${message.reason}`),
  ]).catch((e) => console.error('callback notify failed', e));
  inBackground(notify);
  return { saved: true };
}

// --------------------------------------------------------------- call events

async function onCallEvent(sb: SupabaseClient, event: string, call: any, settings: Record<string, string>) {
  const callId = call?.call_id;
  if (!callId) return json({ ok: true });
  const ms = (t: unknown) => (typeof t === 'number' ? new Date(t).toISOString() : null);

  const patch: Record<string, unknown> = {
    from_number: call.from_number ?? null,
    to_number: call.to_number ?? null,
    status: call.call_status ?? (event === 'call_started' ? 'ongoing' : 'ended'),
  };
  if (call.start_timestamp) patch.started_at = ms(call.start_timestamp);
  if (call.end_timestamp) patch.ended_at = ms(call.end_timestamp);
  if (call.duration_ms) patch.duration_s = Math.round(call.duration_ms / 1000);
  if (call.transcript) patch.transcript = call.transcript;
  if (call.recording_url) patch.recording_url = call.recording_url;
  if (call.disconnection_reason) patch.disconnection_reason = call.disconnection_reason;
  if (call.call_analysis?.call_summary) patch.summary = call.call_analysis.call_summary;
  if (call.call_analysis?.user_sentiment) patch.sentiment = call.call_analysis.user_sentiment;
  const custom = call.call_analysis?.custom_analysis_data;
  if (custom && typeof custom === 'object' && Object.keys(custom).length) patch.analysis = custom;
  await upsertCall(sb, callId, patch);

  if (event !== 'call_analyzed') return json({ ok: true });

  const row = await getCall(sb, callId);
  if (!row) return json({ ok: true });
  const caller = normPhone(row.from_number) || 'withheld number';

  // Text alert for every call, to the mobiles in receptionist-alert-mobiles.
  // Short on purpose: who, what, and whether they need a callback. The email
  // carries the transcript.
  const smsEvery = (settings['receptionist-sms-all-calls'] || 'yes').toLowerCase() !== 'no';
  if (!row.sms_alerted_at && (smsEvery || row.callback_requested)) {
    const a = row.analysis || {};
    const what = (clean(a.reason)
      ? `${clean(a.caller_name) ? clean(a.caller_name) + ' - ' : ''}${clean(a.reason)}${clean(a.action_needed) ? '. Action: ' + clean(a.action_needed) : ''}`
      : (row.summary || 'No summary.')).replace(/\s+/g, ' ');
    // One SMS part (160 plain characters) per person per call keeps this to
    // about 8 cents a text. Smart quotes would force the dearer unicode rate.
    const head = `DrDrapes ${caller}${row.callback_requested ? ' CALL BACK' : ''}: `;
    const plain = what.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2013\u2014]/g, '-').replace(/[^\x20-\x7E]/g, '');
    const room = 160 - head.length;
    const text = head + (plain.length > room ? plain.slice(0, room - 3) + '...' : plain);
    if (await alertStaff(settings, text)) {
      await upsertCall(sb, callId, { sms_alerted_at: new Date().toISOString() });
    }
  }

  if (row.notified_at) return json({ ok: true });
  const everyCall = (settings['receptionist-email-all-calls'] || 'yes').toLowerCase() !== 'no';
  if (!everyCall && !row.callback_requested) return json({ ok: true });

  const mins = row.duration_s ? `${Math.max(1, Math.round(row.duration_s / 60))} min` : '';
  const flag = row.callback_requested ? 'CALL BACK · ' : '';
  const a = row.analysis || {};
  const m = row.message || {};
  const who = clean(a.caller_name) || clean(m.name) || 'Caller';
  const urgent = /urgent/i.test(String(a.urgency || m.urgency || ''));
  const line = (label: string, val: unknown) => clean(val)
    ? `<tr><td style="padding:4px 12px 4px 0;color:#666;vertical-align:top;white-space:nowrap">${label}</td><td style="padding:4px 0">${escapeHtml(val)}</td></tr>` : '';
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#222;max-width:680px">
      <p style="font-size:16px;margin:0 0 4px"><b>${urgent ? '<span style="color:#b91c1c">URGENT · </span>' : ''}${row.callback_requested ? '<span style="color:#b91c1c">CALL BACK · </span>' : ''}${escapeHtml(who)}</b></p>
      <p style="margin:0 0 14px;color:#666">${escapeHtml(phoneFmt(m.callback_number || row.from_number))} · ${escapeHtml(melbTime(row.started_at))}${mins ? ' · ' + mins : ''}</p>
      <table style="border-collapse:collapse;font-size:14px;margin-bottom:12px">
        ${line('Caller', a.caller_type)}
        ${line('Why they called', a.reason)}
        ${line('What Sally did', a.outcome)}
        ${line('Action needed', a.action_needed)}
        ${line('Job', a.job_number)}
        ${line('Suburb', a.suburb)}
        ${m.reason ? line('Message', m.reason) : ''}
        ${m.reason ? line('Call back on', `${phoneFmt(m.callback_number)}${m.best_time ? ' (' + m.best_time + ')' : ''}`) : ''}
        ${row.sms_sent ? line('Quote link', 'Texted to the caller') : ''}
      </table>
      <p style="margin:0 0 12px;padding:10px 12px;background:#f5f7f7;border-radius:6px;font-size:14px">${escapeHtml(row.summary || 'No summary.')}</p>
      ${row.recording_url ? `<p style="margin:0 0 16px"><a href="${escapeHtml(row.recording_url)}">Listen to the recording</a></p>` : ''}
      <p style="margin:18px 0 6px;color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.05em">Transcript</p>
      ${transcriptHtml(row.transcript)}
    </div>`;
  const subjectWhat = clean(a.reason) || (row.summary || '').slice(0, 70);
  const ok = await sendEmail(settings['receptionist-notify-email'] || DEFAULT_NOTIFY,
    `${urgent ? 'URGENT ' : ''}${flag}${who === 'Caller' ? caller : who}${subjectWhat ? ' — ' + subjectWhat : ''}`, html);
  if (ok) await upsertCall(sb, callId, { notified_at: new Date().toISOString() });
  return json({ ok: true });
}

// ------------------------------------------------------------------- handler

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const key = new URL(req.url).searchParams.get('key') || req.headers.get('x-receptionist-key') || '';
  const { data: secret } = await sb.from('integration_secrets')
    .select('value').eq('key', 'receptionist-secret').maybeSingle();
  if (!secret?.value || !safeEqual(key, secret.value)) return json({ error: 'unauthorised' }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }

  try {
    if (body.event === 'call_inbound') return await onInbound(sb, body.call_inbound);

    const settings = await settingsMap(sb);

    if (['call_started', 'call_ended', 'call_analyzed'].includes(body.event)) {
      return await onCallEvent(sb, body.event, body.call, settings);
    }

    if (body.name) {
      const call = body.call || {};
      const args = body.args || {};
      let out: unknown;
      switch (body.name) {
        case 'find_caller_jobs': out = await fnFindCallerJobs(sb, call); break;
        case 'find_job': out = await fnFindJob(sb, call, args); break;
        case 'send_quote_link': out = await fnSendQuoteLink(sb, call, args, settings); break;
        case 'take_message': out = await fnTakeMessage(sb, call, args, settings); break;
        default: out = { error: `Unknown function ${body.name}` };
      }
      return json(out);
    }

    return json({ ok: true, ignored: true });
  } catch (err) {
    console.error('receptionist error', err);
    // Retell reads this to the model; keep it something the agent can act on.
    return json({ error: 'Something went wrong on our side. Offer to take a message for the team.' });
  }
});
