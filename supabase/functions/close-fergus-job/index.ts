// close-fergus-job
//
// Called by Drapr when a job is marked Rehung / Completed. Every phase still
// open on the linked Fergus job is moved to "To Invoice" (the partner API's
// readyForInvoice). Fergus then closes the job as Completed by itself once
// Nicole invoices the last phase, so the job is never archived from here:
// archiving deletes its calendar history and hides uninvoiced phases.
//
// One safety rule. A phase with a visit still booked after today is left open
// and reported back as held, because that is a real follow-up ("cording was
// not fixed", "Install new track") and closing it would lose the visit. A
// booking with no phase on it holds every open phase, for the same reason.
//
// Phases already at To Invoice, To Be Approved or Invoiced are left alone.
// Nothing is ever created, voided, re-priced or deleted in Fergus.
//
// POST { job_id: "<uuid>", dry_run?: boolean }
//   dry_run reports what would happen and writes nothing anywhere.
//
// Auth: a signed-in, active Drapr user (bearer token).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const FERGUS_API = 'https://api.fergus.com';
const TZ = 'Australia/Melbourne';
const THROTTLE_MS = 700;
const OPEN = new Set(['To Schedule', 'To Start', 'In Progress', 'Labour Complete']);

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

/* ---------- Melbourne time ---------------------------------------------- */

function parts(d: Date): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) if (p.type !== 'literal') out[p.type] = p.value;
  if (out.hour === '24') out.hour = '00';
  return out;
}

function offsetAt(d: Date): string {
  const p = parts(d);
  const asIfUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const mins = Math.round((asIfUtc - d.getTime()) / 60000);
  const abs = Math.abs(mins);
  return `${mins >= 0 ? '+' : '-'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

const localDate = (d: Date) => { const p = parts(d); return `${p.year}-${p.month}-${p.day}`; };

// Midnight at the end of today in Melbourne, as an instant. A visit booked
// later today is taken to be the rehang being ticked off, not a follow-up.
function endOfToday(now: Date): number {
  const off = offsetAt(now);
  return new Date(`${localDate(now)}T23:59:59${off}`).getTime();
}

/* ---------- Fergus ------------------------------------------------------ */

let lastCall = 0;

async function fergus(token: string, path: string, method = 'GET'): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = Math.max(0, THROTTLE_MS - (Date.now() - lastCall));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    const res = await fetch(`${FERGUS_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }
    const text = await res.text();
    let body: any = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    if (!res.ok) {
      const msg = (body && (body.message || body.error)) || text || '';
      throw new Error(`Fergus ${res.status}${msg ? ': ' + String(msg).slice(0, 200) : ''}`);
    }
    return body;
  }
  throw new Error(`Fergus kept failing on ${path}`);
}

// Every active booking on the job from today onwards. MONTH covers the month
// containing filterDateFrom, so this month plus next is roughly 4-8 weeks out.
async function futureBookings(token: string, fergusJobId: number, now: Date) {
  const out: any[] = [];
  const seen = new Set<number>();
  for (const when of [now, new Date(now.getTime() + 32 * 86400000)]) {
    const qs = new URLSearchParams({
      filterJobId: String(fergusJobId),
      filterActiveOnly: 'true',
      filterDateFrom: `${localDate(when)}T00:00:00${offsetAt(when)}`,
      filterCalendarRange: 'MONTH',
      pageSize: '100',
    });
    const res = await fergus(token, `/calendarEvents?${qs}`);
    for (const e of res?.data || []) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
  }
  const cutoff = endOfToday(now);
  return out.filter((e) => e.isActive !== false && new Date(e.startTime).getTime() > cutoff);
}

/* ---------- Handler ----------------------------------------------------- */

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!bearer) return json({ ok: false, error: 'unauthorised' }, 401);
  const { data: userData } = await admin.auth.getUser(bearer);
  if (!userData?.user) return json({ ok: false, error: 'unauthorised' }, 401);
  const { data: profile } = await admin
    .from('app_users').select('id, name, active').eq('id', userData.user.id).maybeSingle();
  if (!profile || profile.active === false) return json({ ok: false, error: 'unauthorised' }, 401);

  const token = Deno.env.get('FERGUS_API_TOKEN');
  if (!token) return json({ ok: false, error: 'FERGUS_API_TOKEN is not set' }, 500);

  let payload: any;
  try { payload = await req.json(); } catch { return json({ ok: false, error: 'Body must be JSON' }, 400); }
  const jobId = payload?.job_id;
  const dryRun = !!payload?.dry_run;
  if (!jobId) return json({ ok: false, error: 'job_id is required' }, 400);

  const { data: job, error } = await admin.from('jobs').select('id, status, fergus_job_id, data').eq('id', jobId).single();
  if (error || !job) return json({ ok: false, error: 'Job not found in Drapr' }, 404);
  if (!job.fergus_job_id) return json({ ok: true, skipped: 'not_linked' });
  // Only a finished job is closed off. A dry run may look at any job.
  if (!dryRun && job.status !== 'rehung') {
    return json({ ok: false, error: 'Job is not marked Rehung / Completed in Drapr' }, 409);
  }

  const fergusJobId = Number(job.fergus_job_id);
  const now = new Date();

  try {
    const phases: any[] = (await fergus(token, `/jobs/${fergusJobId}/phases`))?.data || [];
    const bookings = await futureBookings(token, fergusJobId, now);

    const jobLevel = bookings.filter((b) => !b.jobPhaseId);
    const byPhase = new Map<number, any>();
    for (const b of bookings) {
      if (!b.jobPhaseId) continue;
      const prev = byPhase.get(b.jobPhaseId);
      if (!prev || new Date(b.startTime) < new Date(prev.startTime)) byPhase.set(b.jobPhaseId, b);
    }

    const closed: any[] = [], held: any[] = [], failed: any[] = [], untouched: any[] = [];

    for (const p of phases) {
      const row = { id: p.id, title: p.title || p.description || '', status: p.status };
      if (!OPEN.has(p.status)) { untouched.push(row); continue; }

      const next = byPhase.get(p.id) || jobLevel[0];
      if (next) {
        held.push({ ...row, next_visit: next.startTime, with: next.userName || null });
        continue;
      }
      if (dryRun) { closed.push({ ...row, would_close: true }); continue; }
      try {
        await fergus(token, `/jobs/${fergusJobId}/phases/${p.id}/readyForInvoice`, 'POST');
        closed.push(row);
      } catch (e) {
        failed.push({ ...row, error: (e as Error).message });
      }
    }

    const result = {
      at: now.toISOString(),
      by: profile.name || 'Drapr',
      fergus_job_id: fergusJobId,
      closed, held, failed,
      already_closed: untouched.length,
    };

    if (!dryRun) {
      // Re-read and merge so a save made meanwhile in the browser is kept.
      const { data: fresh } = await admin.from('jobs').select('data').eq('id', jobId).single();
      await admin.from('jobs').update({
        data: { ...(fresh?.data || {}), fergus_closeout: result },
        fergus_synced_at: now.toISOString(),
      }).eq('id', jobId);
    }

    return json({ ok: failed.length === 0, dry_run: dryRun, ...result });
  } catch (e) {
    const message = (e as Error).message || 'Fergus close-off failed';
    if (!dryRun) {
      const { data: fresh } = await admin.from('jobs').select('data').eq('id', jobId).single();
      await admin.from('jobs').update({
        data: { ...(fresh?.data || {}), fergus_closeout: { at: now.toISOString(), by: profile.name || 'Drapr', error: message } },
      }).eq('id', jobId);
    }
    return json({ ok: false, error: message }, 502);
  }
});
