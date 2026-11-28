// send-feedback-report
//
// Weekly report on Sally, the AI receptionist: what the calls were, what she
// did with them, and what callers said when texted for feedback. Monday 8am
// Melbourne to receptionist-feedback-report-emails (default david@), so the
// script and knowledge base can be tuned off real calls.
//
// Called by pg_cron through trigger_feedback_report() with x-report-secret.
// Body options: { dry_run: true }, { days: 7 }, { to_emails: [...] }.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const TZ = 'Australia/Melbourne';
const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const FROM = 'Dr Drapes Receptionist <send@quotes.drdrapes.com.au>';
const DEFAULT_TO = 'david@hudsongroup.com.au';
const APP_URL = 'https://quote.drdrapes.com.au/';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function esc(s: unknown) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ));
}

function clean(v: unknown) {
  const t = String(v ?? '').trim();
  return /^(n\/?a|none|null|unknown|not (provided|given|mentioned|applicable)|-)?\.?$/i.test(t) ? '' : t;
}

const when = (ts: string | null) => ts
  ? new Intl.DateTimeFormat('en-AU', {
      timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    }).format(new Date(ts))
  : '';

const day = (d: Date) => new Intl.DateTimeFormat('en-AU', { timeZone: TZ, day: 'numeric', month: 'short' }).format(d);

function phone(p: unknown) {
  const d = String(p ?? '').replace(/\D/g, '');
  const n = /^61[2-478]\d{8}$/.test(d) ? '0' + d.slice(2) : d;
  if (/^04\d{8}$/.test(n)) return `${n.slice(0, 4)} ${n.slice(4, 7)} ${n.slice(7)}`;
  if (/^0\d{9}$/.test(n)) return `${n.slice(0, 2)} ${n.slice(2, 6)} ${n.slice(6)}`;
  return n || 'Withheld';
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) + '%' : '–');

const stat = (label: string, value: string, sub = '') => `
  <td style="padding:10px 12px;background:#f5f7f7;border-radius:8px;vertical-align:top;width:25%">
    <div style="font-size:12px;color:#666">${label}</div>
    <div style="font-size:22px;font-weight:700;color:#0F6E63">${value}</div>
    ${sub ? `<div style="font-size:12px;color:#666">${sub}</div>` : ''}
  </td>`;

const h = (t: string) => `<p style="font-size:15px;font-weight:700;margin:22px 0 8px;color:#0b3d38">${t}</p>`;

function callLine(c: any, extra = '') {
  const a = c.analysis || {};
  const who = clean(a.caller_name) || c.message?.name || phone(c.from_number);
  const what = clean(a.reason) || c.summary || 'No summary.';
  return `<tr>
    <td style="padding:8px;border-bottom:1px solid #e5e7eb;vertical-align:top;white-space:nowrap;color:#555;font-size:13px">${esc(when(c.started_at || c.created_at))}</td>
    <td style="padding:8px;border-bottom:1px solid #e5e7eb;vertical-align:top;font-size:13px"><b>${esc(who)}</b><br/>${esc(what)}${extra}</td>
  </tr>`;
}

const table = (rows: string) => `<table style="width:100%;border-collapse:collapse;margin:0 0 6px">${rows}</table>`;

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: secretRow } = await sb
      .from('integration_secrets').select('value').eq('key', 'report-trigger-secret').single();
    const provided = req.headers.get('x-report-secret') || body.secret;
    if (!secretRow?.value || provided !== secretRow.value) return json({ ok: false, error: 'Unauthorised' }, 401);

    const days = Number(body.days) > 0 ? Number(body.days) : 7;
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400000);
    const since = start.toISOString();

    const cols = 'id, call_id, from_number, started_at, created_at, duration_s, summary, sentiment, analysis, message, callback_requested, handled_at, sms_sent, matched_job_ids, disconnection_reason, feedback_due_at, feedback_sent_at, feedback_reply, feedback_score, feedback_at';
    const [{ data: callData, error: e1 }, { data: fbData, error: e2 }, { data: optData }, { data: openData }, { data: setting }] = await Promise.all([
      sb.from('receptionist_calls').select(cols).eq('company_id', COMPANY_ID)
        .gte('created_at', since).neq('call_id', 'test_call').order('created_at'),
      // Feedback is reported by when it was sent, so a call late last week whose
      // text went out this week still counts here.
      sb.from('receptionist_calls').select(cols).eq('company_id', COMPANY_ID)
        .gte('feedback_sent_at', since).order('feedback_sent_at'),
      sb.from('receptionist_sms_optout').select('phone, created_at').gte('created_at', since),
      sb.from('receptionist_calls').select(cols).eq('company_id', COMPANY_ID)
        .eq('callback_requested', true).is('handled_at', null).order('created_at'),
      sb.from('settings').select('value').eq('company_id', COMPANY_ID)
        .eq('key', 'receptionist-feedback-report-emails').maybeSingle(),
    ]);
    if (e1 || e2) throw (e1 || e2);
    const calls = callData || [];
    const fb = fbData || [];
    const optouts = optData || [];
    const open = openData || [];

    // ---- the calls
    const mins = calls.reduce((s: number, c: any) => s + (c.duration_s || 0), 0) / 60;
    const quoteLinks = calls.filter((c: any) => c.sms_sent).length;
    const callbacks = calls.filter((c: any) => c.callback_requested).length;
    const lookups = calls.filter((c: any) => (c.matched_job_ids || []).length).length;
    const short = calls.filter((c: any) => (c.duration_s || 0) > 0 && c.duration_s < 20);
    const types: Record<string, number> = {};
    calls.forEach((c: any) => { const t = clean(c.analysis?.caller_type) || 'Not classified'; types[t] = (types[t] || 0) + 1; });
    const negative = calls.filter((c: any) => /negative/i.test(c.sentiment || ''));
    // Calls where Sally neither looked anything up, sent the form nor took a
    // message: worth reading, since that's where the script falls short.
    const nothing = calls.filter((c: any) => !c.sms_sent && !c.callback_requested
      && !(c.matched_job_ids || []).length && (c.duration_s || 0) >= 20);

    // ---- the feedback
    const replied = fb.filter((c: any) => c.feedback_reply);
    const scored = replied.filter((c: any) => c.feedback_score !== null && c.feedback_score !== undefined);
    const avg = scored.length ? (scored.reduce((s: number, c: any) => s + c.feedback_score, 0) / scored.length) : null;
    const low = scored.filter((c: any) => c.feedback_score <= 6);
    const waiting = calls.filter((c: any) => c.feedback_due_at && !c.feedback_sent_at).length;

    const { data: until } = await sb.from('settings').select('value').eq('company_id', COMPANY_ID)
      .eq('key', 'receptionist-feedback-until').maybeSingle();

    const to: string[] = Array.isArray(body.to_emails) && body.to_emails.length
      ? body.to_emails
      : String(setting?.value || DEFAULT_TO).split(',').map((s) => s.trim()).filter(Boolean);

    const result = {
      ok: true, days, calls: calls.length, feedback_sent: fb.length, replies: replied.length,
      avg_score: avg, optouts: optouts.length, to,
    };
    if (body.dry_run) return json({ ...result, sent: false, dry_run: true });

    const period = `${day(start)} – ${day(end)}`;
    const typeRows = Object.entries(types).sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `<tr><td style="padding:3px 12px 3px 0;font-size:13px">${esc(t)}</td><td style="font-size:13px"><b>${n}</b></td></tr>`).join('');

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;color:#222;max-width:760px">
        <p style="font-size:18px;font-weight:700;margin:0 0 2px">Sally's week: ${esc(period)}</p>
        <p style="margin:0 0 16px;color:#666">The calls, what she did with them, and what callers said.</p>

        <table style="width:100%;border-collapse:separate;border-spacing:6px"><tr>
          ${stat('Calls answered', String(calls.length), `${Math.round(mins)} min in total`)}
          ${stat('Quote links texted', String(quoteLinks), pct(quoteLinks, calls.length) + ' of calls')}
          ${stat('Callbacks taken', String(callbacks), `${open.length} still waiting overall`)}
          ${stat('Job lookups', String(lookups), 'existing customers')}
        </tr><tr>
          ${stat('Feedback texts', String(fb.length), waiting ? `${waiting} more queued` : '')}
          ${stat('Replies', String(replied.length), pct(replied.length, fb.length) + ' reply rate')}
          ${stat('Average score', avg === null ? '–' : avg.toFixed(1) + '/10', `${scored.length} scored`)}
          ${stat('Opted out', String(optouts.length), 'replied STOP')}
        </tr></table>

        ${calls.length ? `${h('Who called')}<table style="border-collapse:collapse">${typeRows}</table>` : ''}

        ${h(`What callers said (${replied.length})`)}
        ${replied.length ? table(replied.map((c: any) => callLine(c,
          `<div style="margin-top:6px;padding:8px 10px;background:${c.feedback_score !== null && c.feedback_score <= 6 ? '#fef2f2' : '#f0fdf4'};border-radius:6px">
             ${c.feedback_score !== null && c.feedback_score !== undefined ? `<b>${c.feedback_score}/10</b> · ` : ''}"${esc(c.feedback_reply)}"</div>`)).join(''))
          : `<p style="color:#666;font-size:13px">No replies yet.${fb.length ? '' : ' No feedback texts went out this week. They only go to callers on a mobile, once per number, after calls of 20 seconds or more.'}</p>`}

        ${low.length ? `${h(`Low scores to look at (${low.length})`)}${table(low.map((c: any) => callLine(c,
          `<div style="margin-top:4px;color:#b91c1c;font-size:13px">${c.feedback_score}/10 · ${esc(c.summary || '')}</div>`)).join(''))}` : ''}

        ${nothing.length ? `${h(`Calls where Sally didn't text a link, take a message or find a job (${nothing.length})`)}
          <p style="margin:0 0 6px;color:#666;font-size:13px">Usually general questions, which is fine. Worth a read in case she missed something.</p>
          ${table(nothing.map((c: any) => callLine(c)).join(''))}` : ''}

        ${negative.length ? `${h(`Callers who sounded unhappy (${negative.length})`)}${table(negative.map((c: any) => callLine(c)).join(''))}` : ''}

        ${short.length ? `${h(`Hung up within 20 seconds (${short.length})`)}
          <p style="margin:0 0 6px;color:#666;font-size:13px">A few is normal. Lots of them would point at the greeting.</p>
          ${table(short.map((c: any) => callLine(c)).join(''))}` : ''}

        ${open.length ? `${h(`Callbacks still waiting (${open.length})`)}${table(open.map((c: any) => callLine(c,
          c.message?.reason ? `<div style="margin-top:4px;font-size:13px"><b>Message:</b> ${esc(c.message.reason)}</div>` : '')).join(''))}` : ''}

        <p style="margin:22px 0 0;color:#666;font-size:12px">
          Recordings and full transcripts are on the <a href="${APP_URL}">Calls page in Drapr</a>.
          ${until?.value ? `Feedback texts run until ${esc(until.value)}.` : ''}
        </p>
      </div>`;

    const subject = `Sally's week: ${calls.length} call${calls.length === 1 ? '' : 's'}, ${replied.length} feedback repl${replied.length === 1 ? 'y' : 'ies'}${avg === null ? '' : `, avg ${avg.toFixed(1)}/10`}`;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${Deno.env.get('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to, reply_to: 'drdrapes@hudsongroup.com.au', subject, html }),
    });
    if (!res.ok) return json({ ok: false, error: 'Resend failed', detail: await res.text() }, 502);
    return json({ ...result, sent: true });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || String(e) }, 500);
  }
});
