// sync-schedule
//
// The forward view of the Fergus calendar — today out to three weeks —
// written into schedule_stops. It is what the take-down suggestions on an
// accepted job are worked out from: where is the van already going, and
// where are the holes.
//
// Not to be confused with sync-run-sheet, which is the driver's three-day
// window and pays for a Fergus call per job to carry phone numbers and job
// cards out to a phone. That cost does not survive being stretched over
// three weeks — at 700ms a call a busy fortnight would spend a minute of
// wall clock on addresses alone. So this one resolves the address from the
// DQP job wherever the DRD number matches (about nine in ten of them), keeps
// what it already resolved last run, and only asks Fergus for the rest.
//
// Fergus owns the schedule. Nothing here is ever written back to it.
//
// Called by pg_cron (x-report-secret header) and by the Refresh button on
// the suggestion panel (a logged-in user's bearer token).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const FERGUS_API = 'https://api.fergus.com';
const TZ = 'Australia/Melbourne';
const THROTTLE_MS = 700;   // Fergus allows 100 requests a rolling minute.
const HORIZON_DAYS = 21;   // A fortnight of suggestions plus a week of slack.
const MAX_HYDRATE = 30;    // Fergus job look-ups per run, for the unmatched.

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-report-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

/* ---------- Melbourne time ----------------------------------------------
   The offset moves between +10:00 and +11:00 and the container has no view
   of that, so both the local date and the offset come from Intl. Getting it
   wrong shifts every stop by a day. */

function parts(d: Date): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) if (p.type !== 'literal') out[p.type] = p.value;
  if (out.hour === '24') out.hour = '00';
  return out;
}

function localDate(d: Date): string {
  const p = parts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

function offsetAt(d: Date): string {
  const p = parts(d);
  const asIfUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const mins = Math.round((asIfUtc - d.getTime()) / 60000);
  const sign = mins >= 0 ? '+' : '-';
  const abs = Math.abs(mins);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/* ---------- Fergus ------------------------------------------------------ */

let lastCall = 0;

async function fergus(path: string, token: string): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = Math.max(0, THROTTLE_MS - (Date.now() - lastCall));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();

    const res = await fetch(`${FERGUS_API}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(45000),
    });

    // Fergus throws intermittent 504s on longer sweeps; 429 is the rate limit.
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`Fergus ${res.status} on ${path}: ${await res.text()}`);
    return await res.json();
  }
  throw new Error(`Fergus kept failing on ${path}`);
}

/* ---------- Shaping ----------------------------------------------------- */

// The letter suffix on a Fergus job number is the phase and it is the most
// reliable signal: 'a' is always the first visit, so it is the take-down even
// when the title also mentions rehanging on return. Same rule as the run
// sheet, deliberately — the two views should never disagree about a stop.
function stopType(title: string): 'takedown' | 'rehang' | 'other' {
  const t = (title || '').toLowerCase();
  const phase = t.match(/drd-?\d{3,5}\s*([a-z])/)?.[1];
  if (phase === 'a') return 'takedown';
  // "Re Hang - 3 windows", "Re Hang Curtain + Swags" and "Reinstall track"
  // are all typed by hand, so the space is optional everywhere.
  if (/re\s*-?\s*hang|reinstall|drop\s?off|deliver/.test(t)) return 'rehang';
  if (/pick\s?up|take\s?down|takedown|collect|cleaning/.test(t)) return 'takedown';
  return 'other';
}

const digitsOf = (s: string | null | undefined) => (s || '').replace(/\D/g, '');

/* ---------- Handler ----------------------------------------------------- */

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const FERGUS_TOKEN = Deno.env.get('FERGUS_API_TOKEN');

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  /* Auth: either the cron secret, or a signed-in DQP user. */
  let caller = 'cron';
  const presented = req.headers.get('x-report-secret');
  const { data: secretRow } = await admin
    .from('integration_secrets').select('value').eq('key', 'report-trigger-secret').maybeSingle();

  if (!presented || !secretRow?.value || presented !== secretRow.value) {
    const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!bearer) return json({ error: 'unauthorised' }, 401);
    const { data: userData } = await admin.auth.getUser(bearer);
    if (!userData?.user) return json({ error: 'unauthorised' }, 401);
    const { data: profile } = await admin
      .from('app_users').select('id, name, active').eq('id', userData.user.id).maybeSingle();
    if (!profile || profile.active === false) return json({ error: 'unauthorised' }, 401);
    caller = profile.name || 'user';
  }

  if (!FERGUS_TOKEN) return json({ error: 'no_token', message: 'FERGUS_API_TOKEN is not set' }, 500);

  const { data: companies, error: coErr } = await admin.from('companies').select('id');
  if (coErr) return json({ error: 'db', message: coErr.message }, 500);
  if (!companies || companies.length !== 1) {
    return json({ error: 'ambiguous_company', message: `expected one company, found ${companies?.length ?? 0}` }, 500);
  }
  const companyId = companies[0].id;

  try {
    const now = new Date();
    const firstDay = localDate(now);
    const lastDay = localDate(new Date(now.getTime() + HORIZON_DAYS * 86400000));

    /* 1. Pull the events.

          filterDateTo is silently ignored by the partner API, so the window
          is controlled by filterCalendarRange alone. MONTH covers the whole
          month containing filterDateFrom, so this month plus next month is
          always a superset of the three weeks wanted, whichever day of the
          month it happens to be. Anything outside is dropped below. */
    const windows = [now, new Date(now.getTime() + 32 * 86400000)];
    const seen = new Set<number>();
    const events: any[] = [];

    for (const when of windows) {
      let cursor: string | null = null;
      do {
        const qs = new URLSearchParams({
          filterDateFrom: `${localDate(when)}T00:00:00${offsetAt(when)}`,
          filterCalendarRange: 'MONTH',
          filterActiveOnly: 'true',
          pageSize: '200',
        });
        if (cursor) qs.set('pageCursor', cursor);
        const page = await fergus(`/calendarEvents?${qs}`, FERGUS_TOKEN);
        for (const e of page.data || []) {
          if (seen.has(e.id)) continue;   // the two months overlap at the seam
          seen.add(e.id);
          events.push(e);
        }
        cursor = page?.pagination?.nextCursor || page?.paging?.nextCursor || null;
      } while (cursor);
    }

    /* 2. Who still works here. Fergus keeps disabled users on old recurring
          bookings — the standing Kingsville run is still assigned to three
          people who left — so a stop nobody active is on is not a stop. */
    const activeUsers = new Set<number>();
    try {
      let uc: string | null = null;
      do {
        const uq = new URLSearchParams({ filterStatus: 'active', pageSize: '100' });
        if (uc) uq.set('pageCursor', uc);
        const page = await fergus(`/users?${uq}`, FERGUS_TOKEN);
        for (const u of page.data || []) activeUsers.add(Number(u.id));
        uc = page?.pagination?.nextCursor || page?.paging?.nextCursor || null;
      } while (uc);
    } catch (_) {
      // If the user list fails, keep every stop rather than hiding work.
    }

    /* 3. Collapse the per-user duplicates. Fergus stores one copy of an
          event per assigned person and they collapse on groupId. Without
          this, a job two people are on looks like two stops and the day
          looks fuller than it is. */
    const stops = new Map<number, any>();
    for (const e of events) {
      const stopDate = e.startTime ? localDate(new Date(e.startTime)) : null;
      if (!stopDate || stopDate < firstDay || stopDate > lastDay) continue;

      const key = e.groupId ?? e.id;
      const existing = stops.get(key);
      if (existing) {
        if (e.userId && !existing.assigned.includes(e.userId)) existing.assigned.push(e.userId);
        continue;
      }
      stops.set(key, { ...e, stopDate, assigned: e.userId ? [e.userId] : [] });
    }

    for (const [key, s] of stops) {
      if (!activeUsers.size || !s.assigned.length) continue;
      if (!s.assigned.some((u: number) => activeUsers.has(Number(u)))) stops.delete(key);
    }

    /* 4. Addresses.

          Cheapest first: whatever this table already resolved on an earlier
          run, then the DQP job matched on DRD number, and only then Fergus.
          Two DRD numbers map to two DQP jobs each, so an ambiguous match is
          left unlinked rather than guessed — a wrong address here would put
          the van in the wrong suburb. */
    const { data: known } = await admin
      .from('schedule_stops')
      .select('run_key, address_line, suburb, state, postcode')
      .eq('company_id', companyId);
    const kept = new Map<number, any>();
    for (const k of known || []) if (k.address_line || k.suburb) kept.set(Number(k.run_key), k);

    const { data: dqpJobs } = await admin
      .from('jobs')
      .select('id, drd_number, fergus_job_id, site_address')
      .eq('company_id', companyId);

    const byFergusId = new Map<number, any>();
    const byDigits = new Map<string, any>();
    for (const j of dqpJobs || []) {
      if (j.fergus_job_id) byFergusId.set(Number(j.fergus_job_id), j);
      const d = digitsOf(j.drd_number);
      if (!d) continue;
      byDigits.set(d, byDigits.has(d) ? null : j);   // null marks ambiguous
    }

    const needsFergus: any[] = [];
    const resolved = new Map<number, any>();

    for (const [key, s] of stops) {
      const ref = (s.title || '').match(/DRD-?(\d{3,5})/i)?.[1] || null;
      const dqp = (s.jobId && byFergusId.get(Number(s.jobId)))
        || (ref ? byDigits.get(ref) : null)
        || null;

      if (kept.has(key)) {
        resolved.set(key, { ...kept.get(key), job_id: dqp?.id || null, ref });
      } else if (dqp?.site_address) {
        resolved.set(key, { address_line: dqp.site_address, job_id: dqp.id, ref });
      } else {
        resolved.set(key, { job_id: dqp?.id || null, ref });
        if (s.jobId) needsFergus.push({ key, jobId: s.jobId });
      }
    }

    // Whatever is left — jobs raised straight in Fergus that never went
    // through DQP. Capped, because a cron run has a budget; the ones that
    // miss out get picked up next time and stick once resolved.
    let hydrated = 0;
    const jobCache = new Map<number, any>();
    for (const { key, jobId } of needsFergus.slice(0, MAX_HYDRATE)) {
      try {
        if (!jobCache.has(jobId)) {
          const got = await fergus(`/jobs/${jobId}`, FERGUS_TOKEN);
          jobCache.set(jobId, got.data || got);
          hydrated++;
        }
        const addr = jobCache.get(jobId)?.siteAddress || {};
        const line = [addr.address1, addr.address2].filter(Boolean).join(', ') || null;
        if (line || addr.addressSuburb || addr.addressCity) {
          resolved.set(key, {
            ...resolved.get(key),
            address_line: line,
            suburb: addr.addressSuburb || addr.addressCity || null,
            state: addr.addressRegion || null,
            postcode: addr.addressPostcode || null,
          });
        }
      } catch (_) {
        // A stop without its address still belongs on the calendar — it
        // just can't be ranked on distance.
      }
    }

    /* 5. Write. */
    const rows = [...stops].map(([key, s]) => {
      const r = resolved.get(key) || {};
      return {
        company_id: companyId,
        run_key: key,
        fergus_event_id: s.id,
        fergus_job_id: s.jobId || null,
        fergus_job_no: r.ref ? `DRD-${r.ref}` : null,
        fergus_phase_id: s.jobPhaseId || null,
        title: s.title || '',
        description: s.description || null,
        starts_at: s.startTime || null,
        ends_at: s.endTime || null,
        stop_date: s.stopDate,
        assigned_user_ids: s.assigned,
        stop_type: s.eventType === 'OTHER' ? 'other' : stopType(s.title || ''),
        address_line: r.address_line || null,
        suburb: r.suburb || null,
        state: r.state || null,
        postcode: r.postcode || null,
        job_id: r.job_id || null,
        synced_at: new Date().toISOString(),
      };
    });

    if (rows.length) {
      const { error } = await admin
        .from('schedule_stops').upsert(rows, { onConflict: 'company_id,run_key' });
      if (error) throw new Error(`upsert failed: ${error.message}`);
    }

    /* Drop anything Fergus no longer has — that is how a cancelled booking
       disappears — and anything that has fallen out the back of the horizon.

       Guarded on having seen any events at all. If Fergus ever answers with
       an empty page rather than an error, an unguarded delete would empty
       the table and the office would open a job to a blank panel. Keeping
       yesterday's fortnight is the better failure. */
    let cleared = 0;
    if (events.length) {
      const keep = rows.map((r) => r.run_key);
      // count: 'exact' or the row count comes back null and this always
      // reports nought cleared, which is worse than not reporting it.
      let del = admin.from('schedule_stops')
        .delete({ count: 'exact' }).eq('company_id', companyId);
      if (keep.length) del = del.not('run_key', 'in', `(${keep.join(',')})`);
      const { error: delErr, count } = await del;
      if (delErr) throw new Error(`cleanup failed: ${delErr.message}`);
      cleared = count || 0;
    }

    return json({
      ok: true,
      caller,
      from: firstDay,
      to: lastDay,
      events_seen: events.length,
      stops_written: rows.length,
      with_address: rows.filter((r) => r.address_line || r.suburb).length,
      matched_to_dqp: rows.filter((r) => r.job_id).length,
      hydrated_from_fergus: hydrated,
      still_unresolved: Math.max(0, needsFergus.length - MAX_HYDRATE),
      cleared,
    });
  } catch (err) {
    return json({ error: 'sync_failed', message: String((err as any)?.message || err) }, 500);
  }
});
