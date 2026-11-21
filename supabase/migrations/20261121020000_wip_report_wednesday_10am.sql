-- WIP report sends Wednesday 10am Melbourne, as the call starts.
-- Cron fires 23:00 Tue and 00:00 Wed UTC (plus two out-of-day firings);
-- the Wednesday + 10am-hour guard keeps exactly one in AEST and AEDT.
create or replace function public.trigger_wip_report(p_dry_run boolean default false, p_force boolean default false)
 returns bigint
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_secret text;
  v_id     bigint;
  v_local  timestamp;
begin
  v_local := now() at time zone 'Australia/Melbourne';
  if not p_force then
    if extract(isodow from v_local) <> 3 or extract(hour from v_local) <> 10 then
      return null;
    end if;
  end if;
  select value into v_secret from public.integration_secrets where key = 'report-trigger-secret';
  if v_secret is null then
    raise exception 'report-trigger-secret is missing from integration_secrets';
  end if;
  select net.http_post(
    url     := 'https://kspezkqanaqrhbirqmlc.supabase.co/functions/v1/send-wip-report',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-report-secret', v_secret),
    body    := jsonb_build_object('dry_run', p_dry_run),
    timeout_milliseconds := 60000
  ) into v_id;
  return v_id;
end;
$function$;

revoke execute on function public.trigger_wip_report(boolean, boolean) from anon, authenticated, public;

select cron.alter_job(
  job_id   := (select jobid from cron.job where jobname = 'drdrapes-wip-report'),
  schedule := '0 0,23 * * 2,3'
);
