-- Weekly report on Sally's calls and caller feedback: Monday 8am Melbourne.
-- Same daylight-saving-proof pattern as the other digests: cron fires at
-- 21:00 and 22:00 UTC on Sunday, and the guard keeps only the one that lands
-- on 8am Monday local.

create or replace function public.trigger_feedback_report(p_dry_run boolean default false, p_force boolean default false)
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
    if extract(isodow from v_local) <> 1 or extract(hour from v_local) <> 8 then
      return null;
    end if;
  end if;

  select value into v_secret from public.integration_secrets where key = 'report-trigger-secret';
  if v_secret is null then
    raise exception 'report-trigger-secret is missing from integration_secrets';
  end if;

  select net.http_post(
    url     := 'https://kspezkqanaqrhbirqmlc.supabase.co/functions/v1/send-feedback-report',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-report-secret', v_secret),
    body    := jsonb_build_object('dry_run', p_dry_run),
    timeout_milliseconds := 60000
  ) into v_id;
  return v_id;
end;
$function$;

revoke execute on function public.trigger_feedback_report(boolean, boolean) from anon, authenticated, public;

insert into public.settings (key, value, company_id, updated_at)
select 'receptionist-feedback-report-emails', 'david@hudsongroup.com.au,production1@hudsongroup.com.au,drdrapes@hudsongroup.com.au',
       '00000000-0000-0000-0000-000000000001', now()
 where not exists (select 1 from public.settings where key = 'receptionist-feedback-report-emails'
                     and company_id = '00000000-0000-0000-0000-000000000001');

select cron.unschedule(jobid) from cron.job where jobname = 'drdrapes-feedback-report';
select cron.schedule('drdrapes-feedback-report', '0 21,22 * * 0', 'select public.trigger_feedback_report()');
