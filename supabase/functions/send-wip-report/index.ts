// send-wip-report
//
// Weekly work-in-progress report for Dr Drapes, emailed Wednesday 8:30am
// Melbourne time ahead of the Wednesday 10am WIP call. Every accepted job that isn't
// Rehung yet, worked through in the order the call should go:
//
//   1. Drapr out of date: Fergus says something happened that Drapr doesn't
//      show (a takedown or rehang already on the run sheet), or the job hasn't
//      been touched in two weeks. Fix these before the call.
//   2. Over the 3-week turnaround, oldest first.
//   3. Needs booking: confirmed with no takedown booked, clean/ready with no
//      rehang booked.
//   4. The coming week's takedowns and rehangs from the Fergus calendar.
//   5. The full WIP list by stage, with the item ticks (taken/clean/hung).
//
// The turnaround clock starts at acceptance (the first Confirmed entry in the
// status history). Customers are told 1 to 3 weeks, so 14 days is "at risk"
// and 21 is "over".
//
// Called by pg_cron through trigger_wip_report() with the x-report-secret
// header. Body options:
//   { dry_run: true }      build it and return the counts, send nothing
//   { to_emails: [...] }   send somewhere else (testing)
// Recipients come from the wip-report-emails setting, falling back to the
// defaults below.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const TZ = 'Australia/Melbourne';
const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const FROM = 'Dr Drapes Curtain Clinic <send@quotes.drdrapes.com.au>';
const DEFAULT_RECIPIENTS = [
  'david@hudsongroup.com.au',
  'drdrapes@hudsongroup.com.au',
  'production1@hudsongroup.com.au',
];
const APP_URL = 'https://quote.drdrapes.com.au/';

const AT_RISK_DAYS = 14;
const OVER_DAYS = 21;
const STALE_DAYS = 14;
const WIP_STATUSES = ['confirmed', 'in_progress', 'complete', 'invoiced'];
const STAGE = {
  confirmed: 'Confirmed, awaiting takedown',
  in_progress: 'In the plant',
  complete: 'Clean / ready, awaiting rehang',
  invoiced: 'Invoiced, not yet marked Rehung',
} as Record<string, string>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function esc(s: unknown) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ));
}

const DAY = 86400000;
const melDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d); // YYYY-MM-DD
const fmtDay = (iso: string | null) => iso
  ? new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })
      .format(new Date(iso.slice(0, 10) + 'T00:00:00Z'))
  : '';
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(b.slice(0, 10) + 'T00:00:00Z') - Date.parse(a.slice(0, 10) + 'T00:00:00Z')) / DAY);
const money = (n: number) => '$' + Math.round(n).toLocaleString('en-AU');

// Ex GST, because that is how quotes are priced and how David reads them.
function exGst(j: any) {
  const q = j.data?.quote || {};
  const total = Number(q.total || 0);
  const gst = Number(q.gst || 0);
  return gst > 0 ? total - gst : total / 1.1;
}

function firstAt(j: any, status: string) {
  const h = (j.data?.status_history || []).filter((x: any) => x.status === status && x.changed_at);
  return h.length ? h.map((x: any) => x.changed_at).sort()[0] : null;
}
function lastAt(j: any, status: string) {
  const h = (j.data?.status_history || []).filter((x: any) => x.status === status && x.changed_at);
  return h.length ? h.map((x: any) => x.changed_at).sort().pop() : null;
}

function ticks(j: any) {
  const items = Array.isArray(j.data?.items) ? j.data.items : [];
  return {
    total: items.length,
    taken: items.filter((i: any) => i.taken).length,
    clean: items.filter((i: any) => i.prod_done).length,
    hung: items.filter((i: any) => i.rehung).length,
  };
}

const TH = 'padding:6px 8px;border-bottom:2px solid #0F6E63;text-align:left;color:#555;font-size:12px';
const TD = 'padding:7px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top';
function table(head: string[], rows: string[][]) {
  if (!rows.length) return '<p style="color:#047857;margin:4px 0 18px">Nothing here. Good.</p>';
  return `<table style="width:100%;border-collapse:collapse;font-size:13px;margin:6px 0 20px">
    <tr>${head.map((h) => `<th style="${TH}">${esc(h)}</th>`).join('')}</tr>
    ${rows.map((r) => `<tr>${r.map((c) => `<td style="${TD}">${c}</td>`).join('')}</tr>`).join('')}
  </table>`;
}
const h2 = (t: string, sub = '') => `<h3 style="margin:22px 0 2px;color:#0F6E63;font-size:16px">${t}</h3>${sub ? `<p style="margin:0 0 4px;color:#666;font-size:13px">${sub}</p>` : ''}`;
const ageCell = (d: number | null) => d == null ? '<span style="color:#999">?</span>'
  : d > OVER_DAYS ? `<b style="color:#b91c1c">${d}d</b>`
  : d >= AT_RISK_DAYS ? `<b style="color:#b45309">${d}d</b>` : `${d}d`;

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: secretRow } = await sb
      .from('integration_secrets').select('value').eq('key', 'report-trigger-secret').single();
    const provided = req.headers.get('x-report-secret') || body.secret;
    if (!secretRow?.value || provided !== secretRow.value) return json({ ok: false, error: 'Unauthorised' }, 401);

    const today = melDate(new Date());
    const weekEnd = melDate(new Date(Date.now() + 7 * DAY));

    const [{ data: jobsRaw, error: e1 }, { data: past, error: e2 }, { data: ahead, error: e3 }, { data: setting }] = await Promise.all([
      sb.from('jobs')
        .select('id, quote_number, drd_number, customer_name, site_address, status, data, updated_at, created_at, fergus_job_id, fergus_job_no, archived')
        .eq('company_id', COMPANY_ID).in('status', WIP_STATUSES),
      // Run sheet history: what Fergus says already happened.
      sb.from('run_sheet_stops').select('job_id, fergus_job_id, stop_type, stop_date')
        .eq('company_id', COMPANY_ID).in('stop_type', ['takedown', 'rehang'])
        .lt('stop_date', today).gte('stop_date', melDate(new Date(Date.now() - 120 * DAY))),
      // Forward calendar: what's booked.
      sb.from('schedule_stops').select('job_id, fergus_job_id, fergus_job_no, stop_type, stop_date, title, suburb')
        .eq('company_id', COMPANY_ID).gte('stop_date', today).order('stop_date'),
      sb.from('settings').select('value').eq('company_id', COMPANY_ID).eq('key', 'wip-report-emails').maybeSingle(),
    ]);
    if (e1 || e2 || e3) throw (e1 || e2 || e3);

    const jobs = (jobsRaw || []).filter((j: any) => !j.archived);
    const ref = (j: any) => j.quote_number || j.drd_number || '';
    const byFergus = new Map<number, any>();
    jobs.forEach((j: any) => { if (j.fergus_job_id) byFergus.set(Number(j.fergus_job_id), j); });
    const jobFor = (s: any) => jobs.find((j: any) => j.id === s.job_id) || (s.fergus_job_id ? byFergus.get(Number(s.fergus_job_id)) : null);

    // Latest past takedown/rehang per job, and next booked one.
    const lastStop: Record<string, Record<string, string>> = {};
    (past || []).forEach((s: any) => {
      const j = jobFor(s); if (!j) return;
      const m = (lastStop[j.id] ||= {});
      if (!m[s.stop_type] || s.stop_date > m[s.stop_type]) m[s.stop_type] = s.stop_date;
    });
    const nextStop: Record<string, Record<string, string>> = {};
    (ahead || []).forEach((s: any) => {
      const j = jobFor(s); if (!j) return;
      const m = (nextStop[j.id] ||= {});
      if (!m[s.stop_type] || s.stop_date < m[s.stop_type]) m[s.stop_type] = s.stop_date;
    });

    const rows = jobs.map((j: any) => {
      const accepted = firstAt(j, 'confirmed') || firstAt(j, 'in_progress') || null;
      const since = lastAt(j, j.status) || j.updated_at;
      return {
        j, ref: ref(j), name: j.customer_name || '', value: exGst(j),
        accepted, age: accepted ? daysBetween(accepted, today) : null,
        sinceTouch: daysBetween(j.updated_at || since, today),
        inStage: since ? daysBetween(since, today) : null,
        t: ticks(j), last: lastStop[j.id] || {}, next: nextStop[j.id] || {},
      };
    });
    const jobCell = (r: any) => `<b>${esc(r.ref)}</b> ${esc(r.name)}`;
    const itemsCell = (r: any) => r.t.total ? `${r.t.taken}/${r.t.clean}/${r.t.hung} of ${r.t.total}` : '<span style="color:#b91c1c">No item list</span>';

    // ---- 1. Drapr out of date
    const fix: { r: any; why: string }[] = [];
    rows.forEach((r: any) => {
      const s = r.j.status;
      if (s === 'confirmed' && r.last.takedown)
        fix.push({ r, why: `Fergus run sheet had the takedown on <b>${fmtDay(r.last.takedown)}</b>. Still Confirmed in Drapr: tick items taken / move to In Progress.` });
      else if (s !== 'confirmed' && r.last.rehang && !r.next.rehang)
        fix.push({ r, why: `Fergus run sheet had the rehang on <b>${fmtDay(r.last.rehang)}</b>. Not marked Rehung: tick items hung, or note why it isn't finished.` });
      else if (r.sinceTouch >= STALE_DAYS)
        fix.push({ r, why: `Not updated in Drapr for <b>${r.sinceTouch} days</b>. Where is it up to?` });
      if (!r.j.fergus_job_id && s !== 'invoiced')
        fix.push({ r, why: 'Accepted but not in Fergus, so it can\'t be scheduled.' });
      if (['in_progress', 'complete'].includes(s) && r.t.total && r.t.clean === 0 && !r.last.rehang)
        fix.push({ r, why: `${STAGE[s]} but no items ticked through production.` });
    });
    // One row per job, reasons stacked.
    const merged = new Map<string, { r: any; why: string }>();
    fix.forEach((x) => {
      const m = merged.get(x.r.j.id);
      if (m) m.why += '<br/>' + x.why; else merged.set(x.r.j.id, { ...x });
    });
    fix.length = 0;
    fix.push(...[...merged.values()].sort((a, b) => (b.r.age ?? 0) - (a.r.age ?? 0)));

    // ---- 2. Over / at risk on turnaround (not already rehung on the run sheet)
    const late = rows.filter((r: any) => r.age != null && r.age >= AT_RISK_DAYS && !(r.last.rehang && !r.next.rehang))
      .sort((a: any, b: any) => b.age - a.age);
    const over = late.filter((r: any) => r.age > OVER_DAYS);

    // ---- 3. Needs booking
    const noTakedown = rows.filter((r: any) => r.j.status === 'confirmed' && !r.next.takedown && !r.last.takedown)
      .sort((a: any, b: any) => (b.age ?? 0) - (a.age ?? 0));
    const noRehang = rows.filter((r: any) => r.j.status === 'complete' && !r.next.rehang && !r.last.rehang)
      .sort((a: any, b: any) => (b.age ?? 0) - (a.age ?? 0));

    // ---- 4. Coming week from the Fergus calendar
    const week = (ahead || []).filter((s: any) => ['takedown', 'rehang'].includes(s.stop_type) && s.stop_date < weekEnd);

    // ---- Headline by stage
    const stages = WIP_STATUSES.map((s) => {
      const rs = rows.filter((r: any) => r.j.status === s);
      return { s, n: rs.length, v: rs.reduce((a: number, r: any) => a + r.value, 0) };
    });
    const totalN = rows.length;
    const totalV = rows.reduce((a: number, r: any) => a + r.value, 0);

    const to: string[] = Array.isArray(body.to_emails) && body.to_emails.length
      ? body.to_emails
      : (setting?.value ? String(setting.value).split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_RECIPIENTS);

    const result = {
      ok: true, wip_jobs: totalN, wip_value_ex_gst: Math.round(totalV),
      drapr_fixes: fix.length, over_turnaround: over.length, at_risk: late.length - over.length,
      needs_takedown_booked: noTakedown.length, needs_rehang_booked: noRehang.length,
      booked_this_week: week.length, to,
    };
    if (body.dry_run) return json({ ...result, sent: false, dry_run: true });

    const stageTable = `<table style="border-collapse:collapse;font-size:14px;margin:6px 0 4px">
      ${stages.map((x) => `<tr><td style="padding:4px 14px 4px 0">${esc(STAGE[x.s])}</td><td style="padding:4px 14px 4px 0;text-align:right"><b>${x.n}</b></td><td style="padding:4px 0;text-align:right;color:#555">${money(x.v)}</td></tr>`).join('')}
      <tr><td style="padding:6px 14px 4px 0;border-top:1px solid #ccc"><b>Total WIP</b></td><td style="padding:6px 14px 4px 0;border-top:1px solid #ccc;text-align:right"><b>${totalN}</b></td><td style="padding:6px 0 4px;border-top:1px solid #ccc;text-align:right"><b>${money(totalV)}</b></td></tr>
    </table><p style="margin:0 0 6px;color:#666;font-size:12px">Values ex GST.</p>`;

    const full = WIP_STATUSES.map((s) => {
      const rs = rows.filter((r: any) => r.j.status === s).sort((a: any, b: any) => (b.age ?? 0) - (a.age ?? 0));
      if (!rs.length) return '';
      return `<p style="margin:14px 0 0"><b>${esc(STAGE[s])} (${rs.length})</b></p>` + table(
        ['Job', 'Accepted', 'Age', 'Items taken/clean/hung', 'Next booked', 'Value'],
        rs.map((r: any) => [
          jobCell(r), esc(fmtDay(r.accepted)), ageCell(r.age), itemsCell(r),
          r.next.rehang ? `Rehang ${esc(fmtDay(r.next.rehang))}` : r.next.takedown ? `Takedown ${esc(fmtDay(r.next.takedown))}` : '<span style="color:#999">Nothing booked</span>',
          money(r.value),
        ]));
    }).join('');

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;color:#222;max-width:820px">
        <p style="font-size:15px;margin:0 0 4px"><b>Dr Drapes WIP, week of ${esc(fmtDay(today))}</b></p>
        <p style="margin:0 0 12px;color:#555">${fix.length} Drapr update${fix.length === 1 ? '' : 's'} needed · ${over.length} over 3 weeks · ${noTakedown.length + noRehang.length} to book · ${week.length} stop${week.length === 1 ? '' : 's'} booked this week</p>
        ${stageTable}

        ${h2('1. Update Drapr before the call', 'Drapr is the record. If Fergus or the plant knows something Drapr doesn\'t, fix it first.')}
        ${table(['Job', 'Stage', 'What needs doing'], fix.map((x) => [jobCell(x.r), esc(STAGE[x.r.j.status]), x.why]))}

        ${h2('2. Over or close to the 3-week turnaround', `Days since acceptance. Amber ${AT_RISK_DAYS}+ days, red over ${OVER_DAYS}. Each one needs an owner and a date.`)}
        ${table(['Job', 'Stage', 'Age', 'Next booked', 'Value'], late.map((r: any) => [
          jobCell(r), esc(STAGE[r.j.status]), ageCell(r.age),
          r.next.rehang ? `Rehang ${esc(fmtDay(r.next.rehang))}` : r.next.takedown ? `Takedown ${esc(fmtDay(r.next.takedown))}` : '<b style="color:#b91c1c">Nothing booked</b>',
          money(r.value),
        ]))}

        ${h2('3. Needs booking')}
        <p style="margin:6px 0 0"><b>Takedown not booked (${noTakedown.length})</b></p>
        ${table(['Job', 'Accepted', 'Age', 'Value'], noTakedown.map((r: any) => [jobCell(r), esc(fmtDay(r.accepted)), ageCell(r.age), money(r.value)]))}
        <p style="margin:6px 0 0"><b>Clean and ready, rehang not booked (${noRehang.length})</b></p>
        ${table(['Job', 'Ready since', 'Age', 'Value'], noRehang.map((r: any) => [jobCell(r), esc(fmtDay(lastAt(r.j, 'complete'))), ageCell(r.age), money(r.value)]))}

        ${h2('4. Booked in Fergus this week')}
        ${table(['Day', 'Type', 'Job'], week.map((s: any) => {
          const j = jobFor(s);
          return [esc(fmtDay(s.stop_date)), s.stop_type === 'rehang' ? 'Rehang' : 'Takedown',
            j ? `<b>${esc(ref(j))}</b> ${esc(j.customer_name || '')}` : `${esc(s.fergus_job_no || '')} ${esc(s.title || '')}${s.suburb ? ', ' + esc(s.suburb) : ''}`];
        }))}

        ${h2('5. Full WIP list', 'Oldest first in each stage.')}
        ${full}

        <p style="color:#555;font-size:13px;margin-top:18px">Update jobs in <a href="${APP_URL}">Drapr</a> and they'll drop off sections 1 to 3 next week.</p>
      </div>`;

    const subject = `Dr Drapes WIP: ${totalN} jobs, ${fix.length} Drapr updates, ${over.length} over 3 weeks`;
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
