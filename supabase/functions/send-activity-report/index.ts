// send-activity-report
//
// Weekly (Monday) and month-end (1st) activity report for Dr Drapes.
// Mirrors the two lenses the DrapesQuotePro Reports page already uses, so the
// emailed numbers agree with what the app shows:
//
//   COHORT   — quotes RAISED in the period, dated by created_at.
//              Answers "what did we quote, and what's it worth?"
//   ACTIVITY — what HAPPENED in the period, dated by the status change itself.
//              A job quoted in June and invoiced in August is August money.
//
// Plus where the work came from — web form, forwarded email, or entered
// straight into Drapr — matching the Reports page's "Where work came from".
//
// Plus FOLLOW-UP, the scoreboard for the quote chase (the worklist itself is
// send-followup-digest, Mon/Wed/Fri): follow-ups sent in the period, quotes
// opened online and not accepted, follow-ups overdue right now, and the win
// rate on quotes that had to wait for an answer.
//
// POST { period?: "week" | "month", from?, to?, to_emails?: string[], dry_run?: boolean }
//   period defaults to "week". from/to override it. Requires the x-report-secret header.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const FROM = 'Dr Drapes Curtain Clinic <send@quotes.drdrapes.com.au>';
const DEFAULT_RECIPIENTS = [
  'david@hudsongroup.com.au',
  'drdrapes@hudsongroup.com.au',
  'production1@hudsongroup.com.au',
];
const TZ = 'Australia/Melbourne';
const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const STATUSES = ['quoted', 'confirmed', 'in_progress', 'complete', 'invoiced', 'rehung'];

// Follow-up ladder. Must agree with the app and with send-followup-digest.
// Fallbacks only, the settings table wins.
const STAGE_DEFAULTS = [
  { n: 1, key: 'followup-days-1', days: 3, label: 'Nudge' },
  { n: 2, key: 'followup-days-2', days: 10, label: 'Check-in' },
  { n: 3, key: 'followup-days-3', days: 24, label: 'Closing off' },
];
const SAME_SEND_MS = 60000;
// The window the waiting-quote win rate is measured over. Four weeks, because
// one week of Dr Drapes decisions is too few to read a percentage off.
const WIN_WINDOW_DAYS = 28;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-report-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// ------------------------------------------------------------------ timezone
// Melbourne runs AEST (+10) and AEDT (+11), so the offset can't be hard-coded.
// Read it back off the formatter for the instant in question.

function tzParts(d: Date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(d)) if (part.type !== 'literal') p[part.type] = part.value;
  return {
    y: +p.year, m: +p.month, d: +p.day,
    hh: +p.hour % 24, mm: +p.minute, ss: +p.second,
    weekday: p.weekday,
  };
}

function tzOffsetMs(utc: Date) {
  const p = tzParts(utc);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - utc.getTime();
}

// A wall-clock time in Melbourne -> the UTC instant it refers to.
function melbourne(y: number, m: number, d: number, hh = 0, mm = 0, ss = 0, ms = 0) {
  const target = Date.UTC(y, m - 1, d, hh, mm, ss, ms);
  let guess = new Date(target - 10 * 3600000);
  for (let i = 0; i < 4; i++) {
    const next = new Date(target - tzOffsetMs(guess));
    if (next.getTime() === guess.getTime()) break;
    guess = next;
  }
  return guess;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Last complete Monday..Sunday before today (Melbourne).
function lastWeek(now: Date) {
  const t = tzParts(now);
  const dow = DAYS.indexOf(t.weekday);
  const sinceMonday = (dow + 6) % 7;
  const thisMonday = melbourne(t.y, t.m, t.d, 0, 0, 0, 0);
  const from = new Date(thisMonday.getTime() - (sinceMonday + 7) * 86400000);
  const to = new Date(thisMonday.getTime() - sinceMonday * 86400000 - 1);
  return { from, to, label: 'Last week' };
}

// Last complete calendar month (Melbourne).
function lastMonth(now: Date) {
  const t = tzParts(now);
  const py = t.m === 1 ? t.y - 1 : t.y;
  const pm = t.m === 1 ? 12 : t.m - 1;
  const from = melbourne(py, pm, 1, 0, 0, 0, 0);
  const to = new Date(melbourne(t.y, t.m, 1, 0, 0, 0, 0).getTime() - 1);
  return { from, to, label: 'Last month' };
}

const fmtDate = (d: Date) =>
  new Intl.DateTimeFormat('en-AU', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' }).format(d);
const fmtShort = (d: Date | null) =>
  d ? new Intl.DateTimeFormat('en-AU', { timeZone: TZ, day: 'numeric', month: 'short' }).format(d) : '';
const money = (n: number) =>
  '$' + (Math.round(n * 100) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s: string) =>
  String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// -------------------------------------------------------------- aggregation

const DECLINE_LABELS: Record<string, string> = {
  price: 'Price',
  timing: 'Timing',
  went_elsewhere: 'Went elsewhere',
  no_response: 'No response',
  changed_mind: 'Changed mind',
  out_of_area: 'Out of area',
  other: 'Other',
};
const declineLabel = (r: string) =>
  DECLINE_LABELS[r] || r.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

// Where a job came from. Must match jobLeadSource / enquiryLeadSource in the
// app's index.html, or the email and the Reports page will disagree.
const LEAD_SOURCES: Array<[string, string]> = [['web', 'Web form'], ['email', 'Email'], ['direct', 'Entered in Drapr']];
const SOURCE_LABEL: Record<string, string> = Object.fromEntries(LEAD_SOURCES);
const jobLeadSource = (j: any) =>
  j.data?.enquiry_source ? (j.data.enquiry_source.source === 'email' ? 'email' : 'web') : 'direct';
const enquiryLeadSource = (e: any) => (e.source === 'email' ? 'email' : 'web');

function buildReport(jobs: any[], enquiries: any[], from: Date, to: Date) {
  const total = (j: any) => Number(j.data?.quote?.total || 0);
  const createdAt = (j: any) => new Date(j.created_at || j.updated_at || 0);
  // Last event of that status, matching how the Reports page dates things.
  const statusAt = (j: any, st: string) => {
    const h = (j.data?.status_history || []).filter((x: any) => x.status === st);
    return h.length ? new Date(h[h.length - 1].changed_at) : null;
  };
  const declinedAt = (j: any) => (j.data?.declined?.at ? new Date(j.data.declined.at) : null);
  const inRange = (d: Date | null) => !!d && d >= from && d <= to;

  const pool = jobs.filter((j) => !j.archived);

  // COHORT — quotes raised in the period.
  const cohort = pool.filter((j) => inRange(createdAt(j)));
  let quotedVal = 0;
  for (const j of cohort) quotedVal += total(j);
  const quotedCount = cohort.length;
  const avgQuote = quotedCount ? quotedVal / quotedCount : 0;

  // SOURCES — enquiries dated by arrival, quotes by when they were raised.
  const src: Record<string, { key: string; label: string; enquiries: number; converted: number; quotes: number; quotedVal: number; won: number }> =
    Object.fromEntries(LEAD_SOURCES.map(([key, label]) =>
      [key, { key, label, enquiries: 0, converted: 0, quotes: 0, quotedVal: 0, won: 0 }]));
  for (const e of enquiries) {
    if (!inRange(e.submitted_at ? new Date(e.submitted_at) : null)) continue;
    const S = src[enquiryLeadSource(e)];
    S.enquiries++;
    if (e.status === 'converted') S.converted++;
  }
  for (const j of cohort) {
    const S = src[jobLeadSource(j)];
    S.quotes++;
    S.quotedVal += total(j);
    if (STATUSES.indexOf(j.status) >= STATUSES.indexOf('confirmed')) S.won++;
  }
  const sources = LEAD_SOURCES.map(([key]) => src[key]);

  // ACTIVITY — status changes that happened in the period.
  let confirmedVal = 0, confirmedCount = 0;
  let invoicedVal = 0, invoicedCount = 0;
  let declinedVal = 0, declinedCount = 0;
  const reasons: Record<string, { count: number; val: number }> = {};
  const declinedJobs: any[] = [];
  const rows: any[] = [];

  for (const j of pool) {
    const t = total(j);
    const cAt = statusAt(j, 'confirmed');
    const iAt = statusAt(j, 'invoiced');
    const dAt = declinedAt(j);
    const events: string[] = [];

    if (inRange(createdAt(j))) events.push('quoted');
    if (inRange(cAt)) { confirmedVal += t; confirmedCount++; events.push('confirmed'); }
    if (inRange(iAt)) { invoicedVal += t; invoicedCount++; events.push('invoiced'); }
    if (j.status === 'declined' && inRange(dAt)) {
      declinedVal += t; declinedCount++; events.push('declined');
      const r = j.data?.declined?.reason || 'other';
      const R = reasons[r] || (reasons[r] = { count: 0, val: 0 });
      R.count++; R.val += t;
      declinedJobs.push({
        quote_number: j.quote_number || '',
        customer_name: j.customer_name || '',
        total: t,
        reason: declineLabel(r),
        note: j.data?.declined?.note || '',
      });
    }

    if (!events.length) continue;
    rows.push({
      quote_number: j.quote_number || '',
      drd_number: j.drd_number || '',
      po_number: j.data?.po_number || '',
      customer_name: j.customer_name || '',
      site_address: j.site_address || '',
      status: j.status || '',
      total: t.toFixed(2),
      events_in_period: events.join(' '),
      created_at: createdAt(j).toISOString(),
      confirmed_at: cAt ? cAt.toISOString() : '',
      invoiced_at: iAt ? iAt.toISOString() : '',
      declined_at: dAt ? dAt.toISOString() : '',
      declined_reason: j.status === 'declined' ? declineLabel(j.data?.declined?.reason || 'other') : '',
      created_by: j.data?.created_by || (j.data?.status_history || [])[0]?.changed_by || '',
      source: SOURCE_LABEL[jobLeadSource(j)],
    });
  }

  // Win rate on the quotes raised in this period, the only cohort it means
  // anything for. Quotes still sitting at Quoted aren't counted either way.
  let won = 0, lost = 0;
  for (const j of cohort) {
    if (STATUSES.indexOf(j.status) >= STATUSES.indexOf('confirmed')) won++;
    else if (j.status === 'declined') lost++;
  }
  const decided = won + lost;

  rows.sort((a, b) => a.created_at.localeCompare(b.created_at));

  return {
    quotedCount, quotedVal, avgQuote,
    confirmedCount, confirmedVal,
    invoicedCount, invoicedVal,
    declinedCount, declinedVal,
    reasonRows: Object.entries(reasons).sort((a, b) => b[1].val - a[1].val),
    declinedJobs,
    winRate: decided ? Math.round((won / decided) * 100) : null,
    won, lost,
    sources,
    rows,
  };
}

// ---------------------------------------------------------------- follow-up
// The scoreboard for the quote chase. Two lenses again:
//   - what was DONE in the period: follow-ups sent, by rung.
//   - where things stand NOW: open quotes, follow-ups overdue, quotes opened
//     online and not accepted. These are as at the moment the report runs.
// And the number that says whether chasing works: the win rate on quotes that
// had to wait for an answer, over the last four weeks against the four before.

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

function buildFollowUp(jobs: any[], viewed: Record<string, Date>, stages: any[], from: Date, to: Date, now: Date) {
  const pool = jobs.filter((j) => !j.archived);
  const total = (j: any) => Number(j.data?.quote?.total || 0);
  const inRange = (d: Date | null) => !!d && d >= from && d <= to;

  // Sent in the period, by rung. Read straight off each job's follow-up log.
  const sentByStage: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
  const sentBy: Record<string, number> = {};
  let sentTotal = 0;
  for (const j of pool) {
    for (const f of j.data?.follow_ups || []) {
      if (!inRange(f.sent_at ? new Date(f.sent_at) : null)) continue;
      const n = Number(f.stage) || 1;
      sentByStage[n] = (sentByStage[n] || 0) + 1;
      sentTotal++;
      const who = f.sent_by || 'Unknown';
      sentBy[who] = (sentBy[who] || 0) + 1;
    }
  }

  // Where things stand now.
  const open = pool.filter((j) => j.status === 'quoted');
  let openVal = 0, overdue = 0, overdueVal = 0;
  const openedNotAccepted: any[] = [];
  for (const j of open) {
    openVal += total(j);
    const clock = clockFrom(j);
    const age = clock ? Math.floor((now.getTime() - clock.getTime()) / 86400000) : 0;
    const sent = (j.data?.follow_ups || []).reduce((m: number, f: any) => Math.max(m, Number(f.stage) || 0), 0);
    if (stages.some((st) => st.n > sent && age >= st.days)) { overdue++; overdueVal += total(j); }
    if (viewed[j.id]) {
      openedNotAccepted.push({ ref: j.quote_number || '', name: j.customer_name || '', total: total(j), last: viewed[j.id] });
    }
  }
  openedNotAccepted.sort((a, b) => b.last.getTime() - a.last.getTime());

  // Waiting-quote win rate. Same-day confirmations are left out: those were
  // booked on the phone or on site and never waited on a reply, so chasing
  // can't move them and they'd drown the signal. Each decision is dated by
  // when it happened, so a quote raised in August and won last week counts
  // in this window.
  const winWindow = (end: Date) => {
    const start = new Date(end.getTime() - WIN_WINDOW_DAYS * 86400000);
    let w = 0, l = 0;
    for (const j of pool) {
      const created = new Date(j.created_at || j.updated_at || 0);
      if (j.status === 'declined') {
        const d = j.data?.declined?.at ? new Date(j.data.declined.at) : null;
        if (d && d > start && d <= end) l++;
        continue;
      }
      if (STATUSES.indexOf(j.status) < STATUSES.indexOf('confirmed')) continue;
      const firstConfirmed = (j.data?.status_history || []).find((x: any) => x.status === 'confirmed');
      if (!firstConfirmed) continue;
      const c = new Date(firstConfirmed.changed_at);
      if (c.getTime() - created.getTime() < 86400000) continue;
      if (c > start && c <= end) w++;
    }
    return { won: w, lost: l, rate: w + l ? Math.round((w / (w + l)) * 100) : null };
  };
  const winNow = winWindow(to);
  const winBefore = winWindow(new Date(to.getTime() - WIN_WINDOW_DAYS * 86400000));

  return {
    sentTotal, sentByStage, sentBy,
    openCount: open.length, openVal, overdue, overdueVal,
    openedNotAccepted,
    winNow, winBefore,
  };
}

// --------------------------------------------------------------------- CSV

function toCsv(rows: any[]) {
  if (!rows.length) return 'No activity in this period\n';
  const cols = Object.keys(rows[0]);
  const esc = (v: any) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

const b64 = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

// -------------------------------------------------------------------- email

function buildFollowUpHtml(f: any, stages: any[]) {
  const tile = (v: string, l: string) =>
    `<td style="padding:14px 16px;background:#f6f7fb;border-radius:8px;vertical-align:top">
       <div style="font:700 22px/1.2 Arial,sans-serif;color:#2b2d7e">${v}</div>
       <div style="font:400 12px/1.4 Arial,sans-serif;color:#666;padding-top:4px">${l}</div>
     </td>`;
  const gap = '<td style="width:10px"></td>';

  const rate = (w: any) => (w.rate === null ? 'n/a' : `${w.rate}%`);
  const stageLine = stages
    .map((st) => `${st.label} ${f.sentByStage[st.n] || 0}`)
    .join(' &middot; ');
  const byWho = Object.entries(f.sentBy).sort((a: any, b: any) => b[1] - a[1])
    .map(([who, n]) => `${esc(who)} ${n}`).join(', ');

  const opened = f.openedNotAccepted.length
    ? `<div style="font:400 13px/1.6 Arial,sans-serif;color:#666;padding-top:8px">
         <strong style="color:#222">Opened online, not accepted (${f.openedNotAccepted.length}):</strong><br>
         ${f.openedNotAccepted.map((o: any) =>
           `${esc(o.ref)} ${esc(o.name)}, ${money(o.total)}, last opened ${esc(fmtShort(o.last))}`).join('<br>')}
       </div>`
    : '';

  return `
  <div style="font:700 13px Arial,sans-serif;color:#222;margin:22px 0 8px">Follow-up</div>
  <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:6px"><tr>
    ${tile(String(f.sentTotal), 'Follow-ups sent')}${gap}
    ${tile(String(f.overdue), `Overdue now (${money(f.overdueVal)})`)}${gap}
    ${tile(String(f.openedNotAccepted.length), 'Opened online, not accepted')}${gap}
    ${tile(rate(f.winNow), 'Win rate on waiting quotes, last 4 weeks')}
  </tr></table>
  <div style="font:400 13px/1.6 Arial,sans-serif;color:#666">
    Sent: ${stageLine}${byWho ? ` (${byWho})` : ''}.<br>
    Win rate on waiting quotes: <strong style="color:#222">${rate(f.winNow)}</strong> over the last four weeks
    (${f.winNow.won} won, ${f.winNow.lost} declined), against ${rate(f.winBefore)} the four weeks before
    (${f.winBefore.won} won, ${f.winBefore.lost} declined).<br>
    Open quotes now: ${f.openCount} worth ${money(f.openVal)}.
  </div>
  ${opened}`;
}

function buildHtml(r: any, f: any, stages: any[], from: Date, to: Date, label: string) {
  const tile = (v: string, l: string) =>
    `<td style="padding:14px 16px;background:#f6f7fb;border-radius:8px;vertical-align:top">
       <div style="font:700 22px/1.2 Arial,sans-serif;color:#2b2d7e">${v}</div>
       <div style="font:400 12px/1.4 Arial,sans-serif;color:#666;padding-top:4px">${l}</div>
     </td>`;
  const gap = '<td style="width:10px"></td>';

  const reasonList = r.reasonRows.length
    ? `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin-top:6px">
        ${r.reasonRows.map(([k, v]: any) =>
          `<tr>
             <td style="padding:6px 0;font:400 14px Arial,sans-serif;color:#222">${declineLabel(k)}</td>
             <td style="padding:6px 0;font:400 14px Arial,sans-serif;color:#666;text-align:right">${v.count} · ${money(v.val)}</td>
           </tr>`).join('')}
       </table>
       ${r.declinedJobs.length ? `<div style="font:400 13px/1.6 Arial,sans-serif;color:#666;padding-top:8px">${
          r.declinedJobs.map((d: any) =>
            `${d.quote_number} ${d.customer_name}, ${money(d.total)}, ${d.reason}${d.note ? ': ' + d.note : ''}`
          ).join('<br>')}</div>` : ''}`
    : `<div style="font:400 14px Arial,sans-serif;color:#666">Nothing declined in this period.</div>`;

  const th = (t: string, right = true) =>
    `<th style="padding:6px 0 6px ${right ? '10px' : '0'};font:700 11px Arial,sans-serif;color:#888;text-transform:uppercase;letter-spacing:.04em;text-align:${right ? 'right' : 'left'};border-bottom:2px solid #e5e7ef">${t}</th>`;
  const td = (v: string, right = true, bold = false) =>
    `<td style="padding:7px 0 7px ${right ? '10px' : '0'};font:${bold ? 700 : 400} 14px Arial,sans-serif;color:#222;text-align:${right ? 'right' : 'left'};border-bottom:1px solid #eceef4;white-space:nowrap">${v}</td>`;
  const sourceTable = `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">
      <tr>${th('Source', false)}${th('Enquiries')}${th('Converted')}${th('Quotes')}${th('Quoted')}${th('Won')}</tr>
      ${r.sources.map((s: any) => {
        const direct = s.key === 'direct';
        return `<tr>${td(s.label, false, true)}${td(direct ? '—' : String(s.enquiries))}${td(direct ? '—' : String(s.converted))}${td(String(s.quotes))}${td(money(s.quotedVal))}${td(String(s.won))}</tr>`;
      }).join('')}
    </table>`;

  return `<div style="font-family:Arial,sans-serif;color:#222;max-width:640px">
  <h2 style="font:700 20px Arial,sans-serif;color:#2b2d7e;margin:0 0 4px">Dr Drapes — ${label}</h2>
  <div style="font:400 14px Arial,sans-serif;color:#666;margin-bottom:18px">${fmtDate(from)} to ${fmtDate(to)}</div>

  <div style="font:700 13px Arial,sans-serif;color:#222;margin:0 0 8px">Quotes raised</div>
  <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:18px"><tr>
    ${tile(String(r.quotedCount), 'New jobs in')}${gap}
    ${tile(money(r.quotedVal), 'Quoted')}${gap}
    ${tile(money(r.avgQuote), 'Average quote')}
  </tr></table>

  <div style="font:700 13px Arial,sans-serif;color:#222;margin:0 0 4px">Where work came from</div>
  <div style="margin-bottom:18px">${sourceTable}</div>

  <div style="font:700 13px Arial,sans-serif;color:#222;margin:0 0 8px">Activity in the period</div>
  <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:18px"><tr>
    ${tile(String(r.confirmedCount), 'Jobs confirmed')}${gap}
    ${tile(money(r.confirmedVal), 'Value confirmed')}${gap}
    ${tile(String(r.invoicedCount), 'Jobs invoiced')}${gap}
    ${tile(money(r.invoicedVal), 'Value invoiced')}
  </tr></table>

  <div style="font:700 13px Arial,sans-serif;color:#222;margin:0 0 4px">Declined${r.declinedCount ? ` — ${r.declinedCount} worth ${money(r.declinedVal)}` : ''}</div>
  ${reasonList}

  ${r.winRate !== null ? `<div style="font:400 14px Arial,sans-serif;color:#666;margin-top:18px">
     Win rate on quotes raised in this period: <strong style="color:#222">${r.winRate}%</strong>
     (${r.won} won, ${r.lost} declined, rest still open).</div>` : ''}

  ${buildFollowUpHtml(f, stages)}

  <div style="font:400 12px/1.6 Arial,sans-serif;color:#888;margin-top:22px;border-top:1px solid #e5e5e5;padding-top:12px">
    The attached CSV lists every job with activity in the period.<br>
    "Quotes raised" counts jobs by the date they were created. "Activity" counts them by the date the status
    actually changed, so a job quoted in June and invoiced last week is last week's money.<br>
    "Where work came from" counts enquiries by the day they arrived (web form, or an email forwarded to Drapr) and
    quotes by the day they were raised. "Entered in Drapr" is work typed straight in, such as phone calls.
    Converted is how many of those enquiries have become jobs so far.<br>
    "Follow-up" counts emails sent in the period. Overdue, opened online and open quotes are as at the time this
    report ran. The win rate on waiting quotes leaves out jobs confirmed the same day they were quoted, since those
    never waited on a reply. Amounts include GST.
  </div>
</div>`;
}

// ------------------------------------------------------------------ handler

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const now = new Date();
    const period = body.period === 'month' ? 'month' : 'week';

    let range = period === 'month' ? lastMonth(now) : lastWeek(now);
    if (body.from && body.to) {
      range = { from: new Date(body.from), to: new Date(body.to), label: body.label || 'Report' };
    }
    const { from, to, label } = range;

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // This endpoint hands back revenue figures and emails them to staff, so it
    // is not open to anyone who knows the URL. The secret lives in
    // integration_secrets, which has RLS on and no policies — service role only.
    const { data: secretRow } = await sb
      .from('integration_secrets').select('value').eq('key', 'report-trigger-secret').single();
    const provided = req.headers.get('x-report-secret') || body.secret;
    if (!secretRow?.value || provided !== secretRow.value) {
      return json({ ok: false, error: 'Unauthorised' }, 401);
    }

    // Page through every job. Supabase silently caps a plain select at 1,000.
    const jobs: any[] = [];
    for (let page = 0; ; page++) {
      const { data, error } = await sb
        .from('jobs')
        .select('id, quote_number, drd_number, customer_name, site_address, status, archived, created_at, updated_at, data')
        .order('created_at', { ascending: true })
        .range(page * 1000, page * 1000 + 999);
      if (error) throw new Error(`Job fetch failed: ${error.message}`);
      jobs.push(...(data || []));
      if (!data || data.length < 1000) break;
    }

    // Only the enquiries that arrived in the period; source is all that's
    // needed from the data blob.
    const enquiries: any[] = [];
    for (let page = 0; ; page++) {
      const { data, error } = await sb
        .from('enquiries')
        .select('status, submitted_at, source:data->>source')
        .gte('submitted_at', from.toISOString())
        .lte('submitted_at', to.toISOString())
        .order('submitted_at', { ascending: true })
        .range(page * 1000, page * 1000 + 999);
      if (error) throw new Error(`Enquiry fetch failed: ${error.message}`);
      enquiries.push(...(data || []));
      if (!data || data.length < 1000) break;
    }

    // Follow-up cadence from Admin, so this report and the app agree.
    const { data: settingRows } = await sb
      .from('settings').select('key, value')
      .eq('company_id', COMPANY_ID).like('key', 'followup-days-%');
    const settings: Record<string, string> = {};
    for (const row of settingRows || []) settings[row.key] = row.value;
    const stages = STAGE_DEFAULTS.map((st) => {
      const v = Number(settings[st.key]);
      return { ...st, days: Number.isFinite(v) && v > 0 ? v : st.days };
    });

    // When each open quote was last opened or questioned on the accept page.
    const openIds = jobs.filter((j) => j.status === 'quoted' && !j.archived).map((j) => j.id);
    const viewed: Record<string, Date> = {};
    for (let i = 0; i < openIds.length; i += 200) {
      const { data, error } = await sb
        .from('quote_portal_events')
        .select('job_id, created_at')
        .in('job_id', openIds.slice(i, i + 200))
        .in('action', ['view', 'question']);
      if (error) throw new Error(`Portal event fetch failed: ${error.message}`);
      for (const e of data || []) {
        const at = new Date(e.created_at);
        if (!viewed[e.job_id] || at > viewed[e.job_id]) viewed[e.job_id] = at;
      }
    }

    const r = buildReport(jobs, enquiries, from, to);
    const f = buildFollowUp(jobs, viewed, stages, from, to, now);
    const periodName = period === 'month'
      ? new Intl.DateTimeFormat('en-AU', { timeZone: TZ, month: 'long', year: 'numeric' }).format(from)
      : `${fmtDate(from)} to ${fmtDate(to)}`;
    const title = period === 'month' ? `Month in review — ${periodName}` : `Week in review — ${periodName}`;

    if (body.dry_run) {
      return json({
        ok: true, dry_run: true, period, label,
        from: from.toISOString(), to: to.toISOString(),
        jobs_scanned: jobs.length, enquiries_in_period: enquiries.length,
        summary: {
          quotedCount: r.quotedCount, quotedVal: r.quotedVal, avgQuote: Math.round(r.avgQuote * 100) / 100,
          confirmedCount: r.confirmedCount, confirmedVal: r.confirmedVal,
          invoicedCount: r.invoicedCount, invoicedVal: r.invoicedVal,
          declinedCount: r.declinedCount, declinedVal: r.declinedVal,
          reasons: r.reasonRows, winRate: r.winRate, rows: r.rows.length,
          sources: r.sources,
        },
        follow_up: {
          cadence: stages.map((s) => s.days),
          sent: f.sentTotal, sent_by_stage: f.sentByStage, sent_by: f.sentBy,
          open: f.openCount, open_value: Math.round(f.openVal * 100) / 100,
          overdue: f.overdue, overdue_value: Math.round(f.overdueVal * 100) / 100,
          opened_not_accepted: f.openedNotAccepted.map((o: any) => ({ ref: o.ref, name: o.name, last: o.last })),
          win_last_4_weeks: f.winNow, win_prior_4_weeks: f.winBefore,
        },
      });
    }

    const to_emails: string[] = Array.isArray(body.to_emails) && body.to_emails.length
      ? body.to_emails : DEFAULT_RECIPIENTS;

    const stamp = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(from).replace(/-/g, '');
    const filename = `DrDrapes-${period === 'month' ? 'Month' : 'Week'}-${stamp}.csv`;
    const subject = `Dr Drapes — ${title}`;

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
        html: buildHtml(r, f, stages, from, to, title),
        attachments: [{ filename, content: b64(toCsv(r.rows)) }],
      }),
    });
    if (!res.ok) return json({ ok: false, error: 'Resend failed', detail: await res.text() }, 502);

    return json({
      ok: true, period, sent_to: to_emails, filename,
      from: from.toISOString(), to: to.toISOString(),
      jobs_scanned: jobs.length, rows: r.rows.length,
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || String(e) }, 500);
  }
});
