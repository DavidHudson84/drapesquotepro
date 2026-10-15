// send-followup-digest
//
// Monday, Wednesday and Friday morning worklist for Dr Drapes: who to phone
// first, then every open quote that wants a follow-up email today, split by
// which rung of the ladder it is due for.
//
// This is deliberately NOT the Week in review. That email answers "how did we
// go last week"; this one answers "what do I do this morning". Keeping them
// apart means this one can be worked straight down without scrolling past
// revenue figures.
//
// Two call lists sit above the email rungs:
//   - opened online and not accepted: the customer looked at the quote on the
//     accept page (quote_portal_events) and has done nothing since. The
//     warmest lead on the list, so it goes first.
//   - quotes of $1,500+ ex GST, five or more days old: worth a phone call on
//     top of the email ladder.
//
// The ladder here must agree with the app, or the email and the dashboard
// would disagree about the same quote:
//   - the clock starts the LATER of the day the quote was raised and the last
//     time the quote itself was emailed from Drapr. Quotes downloaded as a PDF
//     and sent by hand still age; re-sending a quote restarts the clock.
//   - follow-ups never restart it, or each rung would push the next one away.
//   - thresholds come from the settings table, the same rows Admin writes, so
//     retuning the cadence in the app retunes this email too.
//
// POST { to_emails?: string[], dry_run?: boolean }  (requires x-report-secret)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const FROM = 'Dr Drapes Curtain Clinic <send@quotes.drdrapes.com.au>';
const DEFAULT_RECIPIENTS = [
  'david@hudsongroup.com.au',
  'drdrapes@hudsongroup.com.au',
  'production1@hudsongroup.com.au',
];
const TZ = 'Australia/Melbourne';
const COMPANY_ID = '00000000-0000-0000-0000-000000000001';

// Fallbacks only, the settings table wins. These match the app's own defaults.
const STAGE_DEFAULTS = [
  { n: 1, key: 'followup-days-1', days: 3, label: 'Nudge' },
  { n: 2, key: 'followup-days-2', days: 10, label: 'Check-in' },
  { n: 3, key: 'followup-days-3', days: 24, label: 'Closing off' },
];
const LOST_AFTER_LAST_DAYS = 7;

// Phone as well as email once a quote is this big and this old. Ex GST,
// because that is how quotes are priced and how David reads them.
const CALL_MIN_EX_GST = 1500;
const CALL_AFTER_DAYS = 5;

// A follow-up is written into both the email log and the follow-up log, stamped
// by the send function in one and copied into the other. Pair them on a
// tolerance rather than an exact string: if that stamp were ever missing, a
// clock reset here would quietly stall the whole ladder.
const SAME_SEND_MS = 60000;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-report-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const fmtDate = (d: Date | null) =>
  d ? new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' }).format(d) : '';
const fmtShort = (d: Date | null) =>
  d ? new Intl.DateTimeFormat('en-AU', { timeZone: TZ, day: 'numeric', month: 'short' }).format(d) : '';
const money = (n: number) =>
  '$' + (Math.round(n * 100) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s: string) =>
  String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ------------------------------------------------------------------- ladder

const nearAny = (t: string, list: string[]) =>
  list.some((x) => Math.abs(new Date(t).getTime() - new Date(x).getTime()) < SAME_SEND_MS);

function quoteSentAt(job: any): Date | null {
  const chased: string[] = (job.data?.follow_ups || []).map((f: any) => f.sent_at).filter(Boolean);
  const log = (job.data?.quote?.email_log || []).filter((e: any) => e.sent_at && !nearAny(e.sent_at, chased));
  if (!log.length) return null;
  return new Date(log[log.length - 1].sent_at);
}

function clockFrom(job: any): Date | null {
  const raised = job.created_at || job.updated_at ? new Date(job.created_at || job.updated_at) : null;
  const sent = quoteSentAt(job);
  if (!raised) return sent;
  if (!sent) return raised;
  return sent > raised ? sent : raised;
}

const daysSince = (d: Date | null, now: Date) =>
  d ? Math.floor((now.getTime() - d.getTime()) / 86400000) : null;

// Highest rung reached, not the last recorded: a rung re-sent by hand must not
// walk the ladder backwards.
const stageSent = (job: any) =>
  (job.data?.follow_ups || []).reduce((m: number, f: any) => Math.max(m, Number(f.stage) || 0), 0);

// ------------------------------------------------------------------ handler

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const now = new Date();
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Same gate as the activity report: this hands back customer contact
    // details and emails them to staff, so it is not open to anyone with the URL.
    const { data: secretRow } = await sb
      .from('integration_secrets').select('value').eq('key', 'report-trigger-secret').single();
    const provided = req.headers.get('x-report-secret') || body.secret;
    if (!secretRow?.value || provided !== secretRow.value) {
      return json({ ok: false, error: 'Unauthorised' }, 401);
    }

    // Cadence from Admin, so this email and the dashboard never disagree.
    const { data: settingRows } = await sb
      .from('settings').select('key, value')
      .eq('company_id', COMPANY_ID).like('key', 'followup-days-%');
    const settings: Record<string, string> = {};
    for (const row of settingRows || []) settings[row.key] = row.value;
    const STAGES = STAGE_DEFAULTS.map((st) => {
      const v = Number(settings[st.key]);
      return { ...st, days: Number.isFinite(v) && v > 0 ? v : st.days };
    });

    // Page through: Supabase silently caps a plain select at 1,000.
    const jobs: any[] = [];
    for (let page = 0; ; page++) {
      const { data, error } = await sb
        .from('jobs')
        .select('id, quote_number, drd_number, customer_name, customer_email, customer_phone, site_address, status, archived, created_at, updated_at, data')
        .eq('status', 'quoted')
        .order('created_at', { ascending: true })
        .range(page * 1000, page * 1000 + 999);
      if (error) throw new Error(`Job fetch failed: ${error.message}`);
      jobs.push(...(data || []));
      if (!data || data.length < 1000) break;
    }

    const open = jobs.filter((j) => !j.archived);

    // What customers have done on the accept page, for the open quotes only.
    // Views and questions both count as "looked and stopped".
    const portal: Record<string, { views: number; questions: number; last: Date | null }> = {};
    const openIds = open.map((j) => j.id);
    for (let i = 0; i < openIds.length; i += 200) {
      const { data, error } = await sb
        .from('quote_portal_events')
        .select('job_id, action, created_at')
        .in('job_id', openIds.slice(i, i + 200))
        .in('action', ['view', 'question']);
      if (error) throw new Error(`Portal event fetch failed: ${error.message}`);
      for (const e of data || []) {
        const P = portal[e.job_id] || (portal[e.job_id] = { views: 0, questions: 0, last: null });
        if (e.action === 'view') P.views++; else P.questions++;
        const at = new Date(e.created_at);
        if (!P.last || at > P.last) P.last = at;
      }
    }

    const nudge: any[] = [], check: any[] = [], hail: any[] = [], close: any[] = [];
    const badEmail: any[] = [], unpriced: any[] = [], warm: any[] = [];
    const opened: any[] = [], bigCall: any[] = [];
    let openValue = 0;

    for (const j of open) {
      const total = Number(j.data?.quote?.total || 0);
      const exGst = Number(j.data?.quote?.subtotal ?? total / 1.1);
      const raised = j.created_at || j.updated_at ? new Date(j.created_at || j.updated_at) : null;
      const emailed = quoteSentAt(j);
      const clock = clockFrom(j);
      const age = daysSince(clock, now);
      const sent = stageSent(j);
      const fu = j.data?.follow_ups || [];
      const lastFu = fu.length ? fu[fu.length - 1] : null;
      const last3 = fu.filter((f: any) => Number(f.stage) === 3).pop();
      const P = portal[j.id];
      openValue += total;

      const row = {
        ref: j.quote_number || '',
        drd: j.drd_number || '',
        name: j.customer_name || '',
        email: j.customer_email || '',
        phone: j.customer_phone || '',
        suburb: j.site_address || '',
        total,
        exGst,
        raised,
        emailed,
        clock,
        age: age == null ? 0 : age,
        sent,
        lastFuAt: lastFu?.sent_at ? new Date(lastFu.sent_at) : null,
        handSent: !emailed,
        views: P?.views || 0,
        questions: P?.questions || 0,
        lastView: P?.last || null,
      };

      if (!row.email || !EMAIL_RE.test(row.email)) badEmail.push(row);
      if (total === 0) unpriced.push(row);

      // Ready to close beats a further chase: last chance sent, silence since.
      if (last3 && (daysSince(new Date(last3.sent_at), now) || 0) >= LOST_AFTER_LAST_DAYS) {
        close.push(row);
        continue;
      }

      if (row.views || row.questions) opened.push(row);
      else if (row.exGst >= CALL_MIN_EX_GST && row.age >= CALL_AFTER_DAYS) bigCall.push(row);

      // The rung this quote is due for: the highest threshold it has passed
      // that hasn't been sent. A quote left for two months gets the closing
      // email, not a "just checking it arrived" nudge.
      let due: any = null;
      for (const st of STAGES) if (st.n > sent && (age || 0) >= st.days) due = st;

      if (!due) { warm.push(row); continue; }
      if (due.n === 1) nudge.push(row);
      else if (due.n === 2) check.push(row);
      else hail.push(row);
    }

    const byAge = (a: any, b: any) => b.age - a.age;
    nudge.sort(byAge); check.sort(byAge); hail.sort(byAge); close.sort(byAge);
    badEmail.sort(byAge); unpriced.sort(byAge); warm.sort(byAge);
    opened.sort((a, b) => (b.lastView?.getTime() || 0) - (a.lastView?.getTime() || 0));
    bigCall.sort((a, b) => b.exGst - a.exGst);

    const sum = (rows: any[]) => rows.reduce((t, r) => t + r.total, 0);
    const dueCount = nudge.length + check.length + hail.length;
    const dueValue = sum(nudge) + sum(check) + sum(hail);
    const callCount = opened.length + bigCall.length;

    if (body.dry_run) {
      return json({
        ok: true, dry_run: true,
        cadence: STAGES.map((s) => s.days),
        open: open.length, open_value: Math.round(openValue * 100) / 100,
        due: dueCount, due_value: Math.round(dueValue * 100) / 100,
        to_phone: { opened_not_accepted: opened.length, over_threshold: bigCall.length },
        buckets: {
          nudge: nudge.length, check_in: check.length, closing_off: hail.length,
          closing_off_skipped_check_in: hail.filter((r) => r.sent < 2).length,
          ready_to_close: close.length, not_due: warm.length,
        },
        flags: { bad_email: badEmail.length, unpriced: unpriced.length },
        opened: opened.map((r) => ({ ref: r.ref, name: r.name, views: r.views, questions: r.questions, last: r.lastView, age: r.age })),
        over_threshold: bigCall.map((r) => ({ ref: r.ref, name: r.name, ex_gst: r.exGst, age: r.age })),
      });
    }

    // ------------------------------------------------------------------ html

    const tile = (v: string, l: string, accent?: string) =>
      `<td style="padding:14px 16px;background:#f6f7fb;border-radius:8px;vertical-align:top">
         <div style="font:700 22px/1.2 Arial,sans-serif;color:${accent || '#2b2d7e'}">${v}</div>
         <div style="font:400 12px/1.4 Arial,sans-serif;color:#666;padding-top:4px">${l}</div>
       </td>`;
    const gap = '<td style="width:10px"></td>';

    const rowHtml = (r: any, extra: string[] = []) => {
      const flags: string[] = [...extra];
      if (!r.email || !EMAIL_RE.test(r.email)) flags.push('<span style="color:#b3261e;font-weight:700">no usable email</span>');
      if (r.total === 0) flags.push('<span style="color:#b4740e;font-weight:700">never priced</span>');
      if (r.handSent) flags.push('<span style="color:#888">emailed by hand</span>');
      if (r.sent) flags.push(`<span style="color:#888">${r.sent} follow-up${r.sent === 1 ? '' : 's'} sent, last ${esc(fmtShort(r.lastFuAt))}</span>`);
      return `<tr>
        <td style="padding:9px 10px 9px 0;border-bottom:1px solid #eceef4;font:700 13px Arial,sans-serif;color:#2b2d7e;white-space:nowrap;vertical-align:top">${esc(r.ref)}</td>
        <td style="padding:9px 10px;border-bottom:1px solid #eceef4;font:400 13px/1.5 Arial,sans-serif;color:#222;vertical-align:top">
          <strong>${esc(r.name || 'No name')}</strong><br>
          <span style="color:#777;font-size:12px">${esc(r.suburb)}</span>
          ${flags.length ? `<br><span style="font-size:12px">${flags.join(' &middot; ')}</span>` : ''}
        </td>
        <td style="padding:9px 10px;border-bottom:1px solid #eceef4;font:400 12px/1.5 Arial,sans-serif;color:#555;white-space:nowrap;vertical-align:top">
          ${esc(r.phone)}<br>${esc(r.email || 'no email')}
        </td>
        <td style="padding:9px 10px;border-bottom:1px solid #eceef4;font:400 12px/1.5 Arial,sans-serif;color:#555;white-space:nowrap;vertical-align:top">
          raised ${esc(fmtShort(r.raised))}<br>
          ${r.emailed ? `sent ${esc(fmtShort(r.emailed))}` : '<span style="color:#999">not sent from Drapr</span>'}
        </td>
        <td style="padding:9px 0 9px 10px;border-bottom:1px solid #eceef4;font:700 13px Arial,sans-serif;color:#222;text-align:right;white-space:nowrap;vertical-align:top">
          ${r.total ? esc(money(r.total)) : 'no price'}<br><span style="font-weight:400;color:#777;font-size:12px">${r.age} days</span>
        </td>
      </tr>`;
    };

    const section = (title: string, blurb: string, rows: any[], accent: string, extra?: (r: any) => string[]) => {
      if (!rows.length) {
        return `<div style="margin:26px 0 0">
          <div style="font:700 15px Arial,sans-serif;color:${accent};border-left:4px solid ${accent};padding-left:10px">${esc(title)}: none</div>
        </div>`;
      }
      return `<div style="margin:26px 0 0">
        <div style="font:700 15px Arial,sans-serif;color:${accent};border-left:4px solid ${accent};padding-left:10px">
          ${esc(title)}: ${rows.length} worth ${esc(money(sum(rows)))}
        </div>
        <div style="font:400 12.5px/1.5 Arial,sans-serif;color:#777;padding:5px 0 8px 14px">${esc(blurb)}</div>
        <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">${rows.map((r) => rowHtml(r, extra ? extra(r) : [])).join('')}</table>
      </div>`;
    };

    const viewedFlag = (r: any) => {
      const bits: string[] = [];
      if (r.views) bits.push(`opened ${r.views}&times;, last ${esc(fmtShort(r.lastView))}`);
      if (r.questions) bits.push(`asked ${r.questions} question${r.questions === 1 ? '' : 's'}`);
      return [`<span style="color:#0F6E63;font-weight:700">${bits.join(', ')}</span>`];
    };
    const skippedCheckIn = (r: any) => r.sent < 2
      ? ['<span style="color:#b4740e;font-weight:700">check-in never sent: send that instead of closing off</span>']
      : [];

    const flagList = (title: string, rows: any[], note: string) => rows.length
      ? `<div style="margin-top:10px">
           <div style="font:700 13px Arial,sans-serif;color:#222">${esc(title)}: ${rows.length}</div>
           <div style="font:400 12.5px/1.6 Arial,sans-serif;color:#666;padding-top:3px">
             ${rows.map((r) => `${esc(r.ref)} ${esc(r.name)}${r.phone ? ' &middot; ' + esc(r.phone) : ''}`).join('<br>')}
           </div>
           <div style="font:400 12px/1.5 Arial,sans-serif;color:#888;padding-top:4px">${esc(note)}</div>
         </div>`
      : '';

    const html = `<div style="font-family:Arial,sans-serif;color:#222;max-width:760px">
  <h2 style="font:700 20px Arial,sans-serif;color:#2b2d7e;margin:0 0 4px">Dr Drapes: quotes to chase</h2>
  <div style="font:400 14px Arial,sans-serif;color:#666;margin-bottom:18px">
    ${esc(fmtDate(now))} &middot; follow-ups at ${STAGES.map((s) => s.days).join(' / ')} days
  </div>

  <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:6px"><tr>
    ${tile(String(callCount), 'To phone', '#0F6E63')}${gap}
    ${tile(String(dueCount), 'Follow-up emails due', '#b3261e')}${gap}
    ${tile(money(dueValue), 'Value waiting on a reply')}${gap}
    ${tile(money(openValue), `Open pipeline (${open.length} quotes)`)}
  </tr></table>

  <div style="font:700 13px Arial,sans-serif;color:#222;margin:24px 0 0;text-transform:uppercase;letter-spacing:.04em">Phone first</div>
  ${section('Opened online, not accepted', 'They looked at the quote and stopped. Call and ask if anything needs changing. Best before 2pm.', opened, '#0F6E63', viewedFlag)}
  ${section(`Over $${CALL_MIN_EX_GST.toLocaleString('en-AU')} ex GST, ${CALL_AFTER_DAYS}+ days`, 'Worth a call on top of the email. Log the call as a note on the job.', bigCall, '#0F6E63')}

  <div style="font:700 13px Arial,sans-serif;color:#222;margin:30px 0 0;text-transform:uppercase;letter-spacing:.04em">Then the emails</div>
  ${section('Closing off', `Open ${STAGES[2].days}+ days with no reply. The final email before the quote is written off.`, hail, '#b3261e', skippedCheckIn)}
  ${section('Check-in', `Open ${STAGES[1].days} to ${STAGES[2].days - 1} days. The one that answers new-versus-clean and offers to split the job.`, check, '#b4740e')}
  ${section('Nudge', `Open ${STAGES[0].days} to ${STAGES[1].days - 1} days. "Did it reach you?"`, nudge, '#2b2d7e')}
  ${section('Ready to close', `Closing-off email sent, ${LOST_AFTER_LAST_DAYS}+ days of silence since. Mark these declined in Drapr with the real reason, not another email.`, close, '#555')}

  ${(badEmail.length || unpriced.length) ? `<div style="margin:26px 0 0;padding:14px 16px;background:#fdf6f5;border-radius:8px">
    <div style="font:700 14px Arial,sans-serif;color:#222">Fix these before sending</div>
    ${flagList('No usable email address', badEmail, 'A follow-up to these will bounce silently. Phone them, or correct the address on the job first.')}
    ${flagList('Raised but never priced', unpriced, 'These carry a $0 total. They need a price or a close rather than a chase.')}
  </div>` : ''}

  <div style="font:400 12px/1.6 Arial,sans-serif;color:#888;margin-top:26px;border-top:1px solid #e5e5e5;padding-top:12px">
    Amounts include GST. The $${CALL_MIN_EX_GST.toLocaleString('en-AU')} call threshold is ex GST. A quote can appear in a phone list and an
    email list; phone first, then send the email if they don't pick up.<br>
    The clock starts the day a quote is raised, so quotes downloaded as a PDF and emailed by hand are chased on the
    same cadence as ones sent from Drapr, but only quotes sent from Drapr can show up as opened online.<br>
    Timing is set in Drapr under Admin and this email follows it. Nothing sends to a customer automatically: every
    follow-up is still a person pressing send, from the job page or the dashboard chase list.<br>
    ${warm.length} more open quote${warm.length === 1 ? '' : 's'} ${warm.length === 1 ? 'is' : 'are'} not due yet.
    The attached CSV lists all ${open.length}.
  </div>
</div>`;

    // ------------------------------------------------------------------- csv

    const csvRows = [...hail, ...check, ...nudge, ...close, ...warm].map((r) => ({
      bucket: hail.includes(r) ? 'Closing off' : check.includes(r) ? 'Check-in'
        : nudge.includes(r) ? 'Nudge' : close.includes(r) ? 'Ready to close' : 'Not due',
      phone_first: opened.includes(r) ? 'Opened online' : bigCall.includes(r) ? `Over $${CALL_MIN_EX_GST}` : '',
      quote_number: r.ref, drd_number: r.drd, customer_name: r.name,
      customer_email: r.email, customer_phone: r.phone, site_address: r.suburb,
      total_inc_gst: r.total.toFixed(2),
      subtotal_ex_gst: r.exGst.toFixed(2),
      raised: r.raised ? r.raised.toISOString().slice(0, 10) : '',
      quote_emailed_from_drapr: r.emailed ? r.emailed.toISOString().slice(0, 10) : '',
      clock_starts: r.clock ? r.clock.toISOString().slice(0, 10) : '',
      days_waiting: r.age,
      follow_ups_sent: r.sent,
      last_follow_up: r.lastFuAt ? r.lastFuAt.toISOString().slice(0, 10) : '',
      online_views: r.views,
      last_viewed: r.lastView ? r.lastView.toISOString().slice(0, 10) : '',
      email_usable: (!r.email || !EMAIL_RE.test(r.email)) ? 'NO' : 'yes',
      priced: r.total === 0 ? 'NO' : 'yes',
    }));

    const csvEsc = (v: any) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const cols = csvRows.length ? Object.keys(csvRows[0]) : [];
    const csv = csvRows.length
      ? [cols.join(','), ...csvRows.map((r: any) => cols.map((c) => csvEsc(r[c])).join(','))].join('\n') + '\n'
      : 'No open quotes\n';
    const b64 = (s: string) => {
      const bytes = new TextEncoder().encode(s);
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin);
    };
    const stamp = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(now).replace(/-/g, '');

    const to_emails: string[] = Array.isArray(body.to_emails) && body.to_emails.length
      ? body.to_emails : DEFAULT_RECIPIENTS;

    const subject = `Dr Drapes: ${callCount} to phone, ${dueCount} follow-up${dueCount === 1 ? '' : 's'} due (${money(dueValue)})`;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM,
        to: to_emails,
        reply_to: 'drdrapes@hudsongroup.com.au',
        subject: body.subject_prefix ? `${body.subject_prefix} ${subject}` : subject,
        html,
        attachments: [{ filename: `DrDrapes-OpenQuotes-${stamp}.csv`, content: b64(csv) }],
      }),
    });
    if (!res.ok) return json({ ok: false, error: 'Resend failed', detail: await res.text() }, 502);

    return json({
      ok: true, sent_to: to_emails,
      open: open.length, due: dueCount, due_value: Math.round(dueValue * 100) / 100,
      to_phone: { opened_not_accepted: opened.length, over_threshold: bigCall.length },
      buckets: {
        nudge: nudge.length, check_in: check.length, closing_off: hail.length,
        ready_to_close: close.length, not_due: warm.length,
      },
      flags: { bad_email: badEmail.length, unpriced: unpriced.length },
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || String(e) }, 500);
  }
});
