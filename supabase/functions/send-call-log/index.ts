// send-call-log
//
// The morning call log from Sally, the AI receptionist. Weekdays at 8:30am
// Melbourne time, to drdrapes@ (receptionist-notify-email): every call since
// the last log, plus any callback still not marked handled in Drapr. Monday's
// covers the weekend.
//
// Called by pg_cron through trigger_call_log() with the x-report-secret header,
// the same gate as the follow-up digest. Body options:
//   { dry_run: true }      build it and return the counts, send nothing
//   { hours: 72 }          override the look-back window
//   { to_emails: [...] }   send somewhere else (testing)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const TZ = 'Australia/Melbourne';
const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const FROM = 'Dr Drapes Receptionist <send@quotes.drdrapes.com.au>';
const DEFAULT_TO = 'drdrapes@hudsongroup.com.au';
const APP_URL = 'https://quote.drdrapes.com.au/';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function esc(s: unknown) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ));
}

const when = (ts: string | null) => ts
  ? new Intl.DateTimeFormat('en-AU', {
      timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    }).format(new Date(ts))
  : '';

function phone(p: unknown) {
  const d = String(p ?? '').replace(/\D/g, '');
  const n = /^61[2-478]\d{8}$/.test(d) ? '0' + d.slice(2) : d;
  if (/^04\d{8}$/.test(n)) return `${n.slice(0, 4)} ${n.slice(4, 7)} ${n.slice(7)}`;
  if (/^0\d{9}$/.test(n)) return `${n.slice(0, 2)} ${n.slice(2, 6)} ${n.slice(6)}`;
  return n || 'Withheld';
}

// Retell sends 'N/A', 'none' and the like for fields that didn't come up.
function clean(v: unknown) {
  const t = String(v ?? '').trim();
  return /^(n\/?a|none|null|unknown|not (provided|given|mentioned|applicable)|-)?\.?$/i.test(t) ? '' : t;
}

function row(c: any, jobRefs: Record<string, string>) {
  const m = c.message || null;
  const a = c.analysis || {};
  const refs = (c.matched_job_ids || []).map((id: string) => jobRefs[id]).filter(Boolean);
  const tags: string[] = [];
  if (c.callback_requested && !c.handled_at) tags.push('<b style="color:#b91c1c">CALL BACK</b>');
  if (c.callback_requested && c.handled_at) tags.push('<span style="color:#047857">Handled</span>');
  if (/urgent/i.test(String(a.urgency || m?.urgency || ''))) tags.push('<b style="color:#b91c1c">URGENT</b>');
  if (clean(a.caller_type)) tags.push(esc(a.caller_type));
  if (c.sms_sent) tags.push('Quote link texted');
  if (refs.length) tags.push('Job ' + esc(refs.join(', ')));
  else if (clean(a.job_number)) tags.push('Job ' + esc(a.job_number));
  return `
    <tr>
      <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top;white-space:nowrap;color:#555">${esc(when(c.started_at || c.created_at))}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top;white-space:nowrap">
        ${clean(a.caller_name) || m?.name ? `<b>${esc(clean(a.caller_name) || m.name)}</b><br/>` : ''}${esc(phone(m?.callback_number || c.from_number))}${clean(a.suburb) ? `<br/><span style="color:#666">${esc(a.suburb)}</span>` : ''}
      </td>
      <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top">
        ${tags.length ? `<div style="font-size:12px;margin-bottom:4px">${tags.join(' · ')}</div>` : ''}
        ${clean(a.reason)
          ? `<b>${esc(a.reason)}</b>${clean(a.outcome) ? `<br/>${esc(a.outcome)}` : ''}${clean(a.action_needed) ? `<br/><span style="color:#b45309"><b>Action:</b> ${esc(a.action_needed)}</span>` : ''}`
          : esc(c.summary || 'No summary.')}
        ${m?.reason ? `<div style="margin-top:4px"><b>Message:</b> ${esc(m.reason)}${m.best_time ? ` <i>(best time: ${esc(m.best_time)})</i>` : ''}</div>` : ''}
        ${c.recording_url ? `<div style="margin-top:4px;font-size:12px"><a href="${esc(c.recording_url)}">Recording</a></div>` : ''}
      </td>
    </tr>`;
}

const table = (rows: string) => `
  <table style="width:100%;border-collapse:collapse;font-size:14px;margin:6px 0 18px">
    <tr style="text-align:left;color:#555;font-size:12px">
      <th style="padding:6px 8px;border-bottom:2px solid #0F6E63">When</th>
      <th style="padding:6px 8px;border-bottom:2px solid #0F6E63">Caller</th>
      <th style="padding:6px 8px;border-bottom:2px solid #0F6E63">What it was about</th>
    </tr>${rows}
  </table>`;

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: secretRow } = await sb
      .from('integration_secrets').select('value').eq('key', 'report-trigger-secret').single();
    const provided = req.headers.get('x-report-secret') || body.secret;
    if (!secretRow?.value || provided !== secretRow.value) return json({ ok: false, error: 'Unauthorised' }, 401);

    // Monday looks back over the weekend; every other weekday, one day.
    const now = new Date();
    const dow = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'short' }).format(now);
    const hours = Number(body.hours) > 0 ? Number(body.hours) : (dow === 'Mon' ? 72 : 24);
    const since = new Date(now.getTime() - hours * 3600 * 1000).toISOString();

    const cols = 'id, call_id, analysis, from_number, started_at, created_at, duration_s, summary, message, callback_requested, handled_at, sms_sent, matched_job_ids, recording_url';
    const [{ data: recent, error: e1 }, { data: open, error: e2 }] = await Promise.all([
      sb.from('receptionist_calls').select(cols).eq('company_id', COMPANY_ID)
        .gte('created_at', since).neq('call_id', 'test_call').order('created_at'),
      sb.from('receptionist_calls').select(cols).eq('company_id', COMPANY_ID)
        .lt('created_at', since).eq('callback_requested', true).is('handled_at', null).order('created_at'),
    ]);
    if (e1 || e2) throw (e1 || e2);
    const calls = recent || [];
    const older = open || [];

    // Job numbers for any call Sally matched to a job.
    const ids = [...new Set([...calls, ...older].flatMap((c: any) => c.matched_job_ids || []))];
    const jobRefs: Record<string, string> = {};
    if (ids.length) {
      const { data: jobs } = await sb.from('jobs').select('id, quote_number, drd_number').in('id', ids);
      (jobs || []).forEach((j: any) => { jobRefs[j.id] = j.quote_number || j.drd_number || ''; });
    }

    const callbacks = calls.filter((c: any) => c.callback_requested && !c.handled_at).length + older.length;
    const quoteLinks = calls.filter((c: any) => c.sms_sent).length;

    const { data: setting } = await sb.from('settings').select('value')
      .eq('company_id', COMPANY_ID).eq('key', 'receptionist-notify-email').maybeSingle();
    const to: string[] = Array.isArray(body.to_emails) && body.to_emails.length
      ? body.to_emails
      : String(setting?.value || DEFAULT_TO).split(',').map((s) => s.trim()).filter(Boolean);

    const result = { ok: true, hours, calls: calls.length, callbacks_open: callbacks, quote_links: quoteLinks, to };
    if (!calls.length && !older.length) return json({ ...result, sent: false, reason: 'nothing to report' });
    if (body.dry_run) return json({ ...result, sent: false, dry_run: true });

    const period = dow === 'Mon' && hours === 72 ? 'over the weekend' : `in the last ${hours} hours`;
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;color:#222;max-width:760px">
        <p style="font-size:15px;margin:0 0 6px"><b>Sally took ${calls.length} call${calls.length === 1 ? '' : 's'} ${period}.</b></p>
        <p style="margin:0 0 16px;color:#555">${callbacks} callback${callbacks === 1 ? '' : 's'} waiting · ${quoteLinks} quote link${quoteLinks === 1 ? '' : 's'} texted</p>
        ${calls.length ? table(calls.map((c: any) => row(c, jobRefs)).join('')) : ''}
        ${older.length ? `<p style="margin:8px 0 0"><b style="color:#b91c1c">Still waiting on a callback from earlier</b></p>${table(older.map((c: any) => row(c, jobRefs)).join(''))}` : ''}
        <p style="color:#555;font-size:13px">Mark callbacks as handled on the <a href="${APP_URL}">Calls page in Drapr</a>, and they'll drop off this list.</p>
      </div>`;

    const subject = `Sally's call log: ${calls.length} call${calls.length === 1 ? '' : 's'}, ${callbacks} to call back`;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${Deno.env.get('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to, reply_to: DEFAULT_TO, subject, html }),
    });
    if (!res.ok) return json({ ok: false, error: 'Resend failed', detail: await res.text() }, 502);
    return json({ ...result, sent: true });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || String(e) }, 500);
  }
});
