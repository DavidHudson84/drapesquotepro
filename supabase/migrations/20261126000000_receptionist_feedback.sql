-- Feedback texts after Sally's calls (trial until receptionist-feedback-until).
-- A call from a mobile gets a feedback_due_at when Retell's analysis lands;
-- pg_cron sweeps every 15 minutes and the receptionist function sends those
-- that are due, between 8am and 8pm Melbourne only. Replies come back through
-- Twilio's inbound webhook to the same function and are stored on the call.
-- STOP replies go into receptionist_sms_optout and are never texted again.

alter table public.receptionist_calls
  add column if not exists feedback_due_at   timestamptz,
  add column if not exists feedback_sent_at  timestamptz,
  add column if not exists feedback_reply    text,
  add column if not exists feedback_score    smallint,
  add column if not exists feedback_at       timestamptz;

create index if not exists receptionist_calls_feedback_due_idx
  on public.receptionist_calls (feedback_due_at) where feedback_sent_at is null and feedback_due_at is not null;

create table if not exists public.receptionist_sms_optout (
  phone      text primary key,
  created_at timestamptz not null default now()
);
comment on table public.receptionist_sms_optout is 'Mobiles that replied STOP to a receptionist text. Never texted again. Service role only.';
alter table public.receptionist_sms_optout enable row level security;

insert into public.settings (key, value, company_id, updated_at)
select 'receptionist-feedback-until', '2026-12-26', '00000000-0000-0000-0000-000000000001', now()
 where not exists (select 1 from public.settings where key = 'receptionist-feedback-until'
                     and company_id = '00000000-0000-0000-0000-000000000001');

create or replace function public.trigger_receptionist_feedback()
 returns bigint
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_key text;
  v_id  bigint;
begin
  if not exists (select 1 from public.receptionist_calls
                  where feedback_sent_at is null and feedback_due_at is not null and feedback_due_at <= now()) then
    return null;
  end if;
  select value into v_key from public.integration_secrets where key = 'receptionist-secret';
  if v_key is null then return null; end if;
  select net.http_post(
    url     := 'https://kspezkqanaqrhbirqmlc.supabase.co/functions/v1/receptionist?key=' || v_key,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := jsonb_build_object('event', 'feedback_tick'),
    timeout_milliseconds := 60000
  ) into v_id;
  return v_id;
end;
$function$;

revoke execute on function public.trigger_receptionist_feedback() from anon, authenticated, public;

select cron.unschedule(jobid) from cron.job where jobname = 'drdrapes-receptionist-feedback';
select cron.schedule('drdrapes-receptionist-feedback', '*/15 * * * *', 'select public.trigger_receptionist_feedback()');
