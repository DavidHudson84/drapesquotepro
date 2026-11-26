// sync-fergus-invoices
//
// Reads invoices raised in Fergus and marks the matching Drapr job Invoiced,
// so the office no longer has to tick that step in Drapr as well.
//
// Read-only against Fergus. The only writes are to Drapr jobs.
//
// Fergus gives no reliable "sent" flag (most paid invoices read isSent=false)
// and never sets isFinal, so any invoice that isn't voided counts. Deposits
// and call-out fees are invoiced before the work is done, so an invoice only
// counts against a job that has reached Complete (or Rehung without ever being
// marked Invoiced), and only if it was raised no earlier than three days
// before the job reached that point. Anything earlier is left for a person.
//
//   complete -> status becomes invoiced, history entry dated the invoice date
//   rehung, no Invoiced entry -> history entry added, status stays rehung
//
// The history entry is dated with the Fergus invoice date because Reports
// files invoiced revenue under that date.
//
// POST { days?: number (default 21), dry_run?: boolean }
// Auth: cron secret (x-report-secret) or a signed-in Drapr user.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const FERGUS_API = 'https://api.fergus.com';
const THROTTLE_MS = 700;
const GRACE_MS = 3 * 86400000;
const MAX_PAGES = 6;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-report-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

let lastCall = 0;
async function fergus(token: string, path: string): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = Math.max(0, THROTTLE_MS - (Date.now() - lastCall));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    const res = await fetch(`${FERGUS_API}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(45000),
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`Fergus ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
    return await res.json();
  }
  throw new Error(`Fergus kept failing on ${path}`);
}

// When the job first reached Complete or Rehung, whichever came first.
function finishedAt(history: any[]): number | null {
  const ts = history
    .filter((h) => h.status === 'complete' || h.status === 'rehung')
    .map((h) => new Date(h.changed_at).getTime())
    .filter((t) => !isNaN(t));
  return ts.length ? Math.min(...ts) : null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const token = Deno.env.get('FERGUS_API_TOKEN');

  const presented = req.headers.get('x-report-secret');
  const { data: secretRow } = await admin
    .from('integration_secrets').select('value').eq('key', 'report-trigger-secret').maybeSingle();
  if (!presented || !secretRow?.value || presented !== secretRow.value) {
    const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!bearer) return json({ error: 'unauthorised' }, 401);
    const { data: userData } = await admin.auth.getUser(bearer);
    if (!userData?.user) return json({ error: 'unauthorised' }, 401);
    const { data: profile } = await admin
      .from('app_users').select('id, active').eq('id', userData.user.id).maybeSingle();
    if (!profile || profile.active === false) return json({ error: 'unauthorised' }, 401);
  }
  if (!token) return json({ error: 'FERGUS_API_TOKEN is not set' }, 500);

  let payload: any = {};
  try { payload = await req.json(); } catch { /* empty body is fine */ }
  const days = Math.min(Math.max(Number(payload?.days) || 21, 1), 120);
  const dryRun = !!payload?.dry_run;
  const since = Date.now() - days * 86400000;

  try {
    // 1. Recent invoices, newest first, until we pass the window.
    const invoices: any[] = [];
    let cursor = '0';
    for (let page = 0; page < MAX_PAGES && cursor; page++) {
      const qs = new URLSearchParams({ pageSize: '100', sortOrder: 'desc', sortField: 'createdAt', pageCursor: cursor });
      const res = await fergus(token, `/customerInvoices?${qs}`);
      const rows = res?.data || [];
      invoices.push(...rows);
      const oldest = rows.length ? new Date(rows[rows.length - 1].createdAt).getTime() : 0;
      const next = res?.paging?.links?.next as string | null;
      cursor = next && oldest >= since ? (new URL(next, FERGUS_API).searchParams.get('pageCursor') || '') : '';
    }

    const live = invoices.filter((i) => i.status !== 'voided' && new Date(i.createdAt).getTime() >= since);
    const byJob = new Map<number, any[]>();
    for (const i of live) {
      if (!byJob.has(i.jobId)) byJob.set(i.jobId, []);
      byJob.get(i.jobId)!.push(i);
    }
    if (!byJob.size) return json({ ok: true, invoices: 0, updated: [] });

    // 2. Drapr jobs those invoices belong to that could still need the step.
    const { data: jobs, error } = await admin
      .from('jobs').select('id, status, fergus_job_id, drd_number, data')
      .in('fergus_job_id', [...byJob.keys()])
      .in('status', ['complete', 'rehung']);
    if (error) throw new Error(error.message);

    const updated: any[] = [], skipped: any[] = [];

    for (const job of jobs || []) {
      const history: any[] = job.data?.status_history || [];
      if (history.some((h) => h.status === 'invoiced')) continue;

      const done = finishedAt(history);
      const label = job.drd_number || job.fergus_job_id;
      if (done == null) { skipped.push({ job: label, reason: 'no Complete or Rehung date' }); continue; }

      const fresh = (byJob.get(Number(job.fergus_job_id)) || [])
        .filter((i) => new Date(i.createdAt).getTime() >= done - GRACE_MS)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      if (!fresh.length) { skipped.push({ job: label, reason: 'only invoices raised before the work was finished' }); continue; }

      const inv = fresh[0];
      const when = inv.invoiceDate || inv.createdAt;
      const entry = {
        status: 'invoiced',
        changed_by: 'Fergus',
        changed_at: new Date(when).toISOString(),
        note: `Invoiced in Fergus as ${inv.invoiceNumber || inv.id}`,
      };
      const newStatus = job.status === 'complete' ? 'invoiced' : job.status;
      updated.push({ job: label, from: job.status, to: newStatus, invoice: inv.invoiceNumber, subtotal: inv.subtotal, dated: entry.changed_at });
      if (dryRun) continue;

      const data = {
        ...(job.data || {}),
        status_history: [...history, entry],
        fergus_invoice: { id: inv.id, number: inv.invoiceNumber, subtotal: inv.subtotal, status: inv.status, invoice_date: when },
      };
      // Guard on the status we read, so a click in Drapr meanwhile wins.
      const { error: upErr } = await admin.from('jobs')
        .update({ status: newStatus, data, updated_at: new Date().toISOString() })
        .eq('id', job.id).eq('status', job.status);
      if (upErr) updated[updated.length - 1].error = upErr.message;
    }

    return json({ ok: true, dry_run: dryRun, invoices: live.length, updated, skipped });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 502);
  }
});
