-- Sally's morning call log: weekdays 8:30am Melbourne, ready before Nicole
-- starts at 9. Same pattern as the follow-up digest: cron fires at 21:30 and
-- 22:30 UTC the evening before (Sun-Thu UTC = Mon-Fri local), and the hour
-- guard drops whichever one isn't 8am local, so daylight saving needs no
-- maintenance.

create or replace function public.trigger_call_log(p_dry_run boolean default false, p_force boolean default false)
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
    if extract(isodow from v_local) not between 1 and 5 or extract(hour from v_local) <> 8 then
      return null;
    end if;
  end if;

  select value into v_secret
    from public.integration_secrets
   where key = 'report-trigger-secret';

  if v_secret is null then
    raise exception 'report-trigger-secret is missing from integration_secrets';
  end if;

  select net.http_post(
    url     := 'https://kspezkqanaqrhbirqmlc.supabase.co/functions/v1/send-call-log',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-report-secret', v_secret
               ),
    body    := jsonb_build_object('dry_run', p_dry_run),
    timeout_milliseconds := 60000
  ) into v_id;

  return v_id;
end;
$function$;

revoke execute on function public.trigger_call_log(boolean, boolean) from anon, authenticated, public;

select cron.unschedule(jobid) from cron.job where jobname = 'drdrapes-call-log';
select cron.schedule('drdrapes-call-log', '30 21,22 * * 0-4', 'select public.trigger_call_log()');
