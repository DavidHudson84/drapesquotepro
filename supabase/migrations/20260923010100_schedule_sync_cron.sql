-- Kick sync-schedule the same way the run sheet is kicked: the cron secret is
-- read straight out of integration_secrets so it never leaves the database.
create or replace function public.trigger_schedule_sync()
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
    url     := 'https://kspezkqanaqrhbirqmlc.supabase.co/functions/v1/sync-schedule',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-report-secret', v_secret
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) into v_id;

  return v_id;
end;
$function$;

-- Only pg_cron needs to fire this. Left executable by the API roles it would
-- let anyone holding the public anon key force a Fergus sync and burn the
-- rate limit; the app refreshes through the Edge Function, never this.
revoke execute on function public.trigger_schedule_sync() from anon, authenticated, public;

-- Hourly across the working day in Melbourne. The fortnight ahead does not
-- move minute to minute the way the driver's day does, and the panel has a
-- Refresh button for a booking made moments ago.
select cron.unschedule('drdrapes-schedule-sync')
  where exists (select 1 from cron.job where jobname = 'drdrapes-schedule-sync');

select cron.schedule('drdrapes-schedule-sync', '5 19-23,0-8 * * *',
                     'select public.trigger_schedule_sync()');
