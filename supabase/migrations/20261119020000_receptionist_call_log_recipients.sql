-- The morning call log gets its own recipient list, separate from the
-- per-call emails: receptionist-call-log-emails (comma-separated). Empty or
-- missing means the send-call-log default (receptionist-notify-email, then
-- drdrapes@).

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
  v_to     jsonb;
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

  select coalesce(jsonb_agg(trim(e)) filter (where trim(e) <> ''), '[]'::jsonb) into v_to
    from public.settings s, unnest(string_to_array(s.value, ',')) e
   where s.key = 'receptionist-call-log-emails'
     and s.company_id = '00000000-0000-0000-0000-000000000001';

  select net.http_post(
    url     := 'https://kspezkqanaqrhbirqmlc.supabase.co/functions/v1/send-call-log',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-report-secret', v_secret
               ),
    body    := jsonb_build_object('dry_run', p_dry_run, 'to_emails', coalesce(v_to, '[]'::jsonb)),
    timeout_milliseconds := 60000
  ) into v_id;

  return v_id;
end;
$function$;

revoke execute on function public.trigger_call_log(boolean, boolean) from anon, authenticated, public;

insert into public.settings (key, value, company_id, updated_at)
select 'receptionist-call-log-emails', 'drdrapes@hudsongroup.com.au,production1@hudsongroup.com.au',
       '00000000-0000-0000-0000-000000000001', now()
 where not exists (select 1 from public.settings where key = 'receptionist-call-log-emails'
                     and company_id = '00000000-0000-0000-0000-000000000001');
