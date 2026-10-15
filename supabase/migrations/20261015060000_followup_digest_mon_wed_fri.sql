-- Chase list moves from Monday 9:30am to Monday, Wednesday and Friday 8:30am
-- Melbourne time, ready before Nicole starts at 9.
-- Cron fires at 21:30 and 22:30 UTC on Sun/Tue/Thu (the evening before in UTC).
-- Exactly one of the pair lands on 8am-hour local in both AEST and AEDT, and the
-- guard below drops the other, so no daylight-saving maintenance is needed.
create or replace function public.trigger_followup_digest(p_dry_run boolean default false, p_force boolean default false)
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
    -- isodow 1 = Monday, 3 = Wednesday, 5 = Friday. The hour check makes the
    -- pair of cron entries idempotent.
    if extract(isodow from v_local) not in (1, 3, 5) or extract(hour from v_local) <> 8 then
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
    url     := 'https://kspezkqanaqrhbirqmlc.supabase.co/functions/v1/send-followup-digest',
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

select cron.alter_job(
  job_id   := (select jobid from cron.job where jobname = 'drdrapes-followup-digest'),
  schedule := '30 21,22 * * 0,2,4'
);
