-- Fergus close-off and invoice pull-back (26 Nov 2026).
--
-- close-fergus-job is called from the browser when a job is marked Rehung, so
-- it needs no schedule. sync-fergus-invoices runs every 20 minutes across the
-- working day, same UTC window as the run sheet sync (covers AEST and AEDT),
-- offset by 10 minutes so the two don't share Fergus's rate limit.

create or replace function public.trigger_fergus_invoice_sync(p_days int default 21, p_dry_run boolean default false)
 returns bigint
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_secret text;
  v_id     bigint;
begin
  select value into v_secret
    from public.integration_secrets
   where key = 'report-trigger-secret';

  if v_secret is null then
    raise exception 'report-trigger-secret is missing from integration_secrets';
  end if;

  select net.http_post(
    url     := 'https://kspezkqanaqrhbirqmlc.supabase.co/functions/v1/sync-fergus-invoices',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-report-secret', v_secret
               ),
    body    := jsonb_build_object('days', p_days, 'dry_run', p_dry_run),
    timeout_milliseconds := 120000
  ) into v_id;

  return v_id;
end;
$function$;

revoke execute on function public.trigger_fergus_invoice_sync(int, boolean) from anon, authenticated, public;

select cron.unschedule(jobid) from cron.job where jobname = 'drdrapes-fergus-invoice-sync';
select cron.schedule('drdrapes-fergus-invoice-sync', '10-59/20 19-23,0-8 * * *', 'select public.trigger_fergus_invoice_sync()');
