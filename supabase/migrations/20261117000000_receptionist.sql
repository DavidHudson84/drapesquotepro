-- AI receptionist (Retell) — call log and the caller lookup behind it.
--
-- The receptionist Edge Function is the only thing that writes here. Staff
-- read it from the app (company_isolation), so a weekend's calls, the messages
-- taken and the transcripts are all in one place on Monday morning.

create table if not exists public.receptionist_calls (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null default '00000000-0000-0000-0000-000000000001'
                         references public.companies(id),
  call_id              text not null unique,          -- Retell's call id
  from_number          text,
  to_number            text,
  status               text,                          -- registered / ongoing / ended / error
  started_at           timestamptz,
  ended_at             timestamptz,
  duration_s           integer,
  matched_job_ids      uuid[] not null default '{}',
  lookup_attempts      integer not null default 0,    -- job-number + surname tries
  sms_sent             integer not null default 0,
  message              jsonb,                         -- take_message: name, callback number, reason, urgency, best time
  callback_requested   boolean not null default false,
  summary              text,
  sentiment            text,
  transcript           text,
  recording_url        text,
  disconnection_reason text,
  notified_at          timestamptz,                   -- office summary email sent
  sms_alerted_at       timestamptz,                   -- staff text alert sent
  handled_at           timestamptz,                   -- staff have dealt with it
  handled_by           text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on table public.receptionist_calls is
  'Every call answered by the Retell AI receptionist, written by the receptionist Edge Function. Messages, summaries, transcripts and which Drapr jobs the caller was matched to.';

alter table public.receptionist_calls add column if not exists sms_alerted_at timestamptz;

create index if not exists receptionist_calls_company_started_idx
  on public.receptionist_calls (company_id, started_at desc);

alter table public.receptionist_calls enable row level security;

drop policy if exists company_isolation on public.receptionist_calls;
create policy company_isolation on public.receptionist_calls
  for all
  using (company_id = auth_company_id())
  with check (company_id = auth_company_id());

-- Phone numbers are stored every which way (+61 4.., 04.., 03 9..). Reduce
-- them all to the ten-digit local form so a caller ID can be matched.
create or replace function public.au_phone_norm(p text)
returns text
language sql
immutable
as $$
  select case
    when d ~ '^61[2-478][0-9]{8}$' then '0' || substr(d, 3)
    when d ~ '^[2-478][0-9]{8}$'   then '0' || d
    else d
  end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) x
$$;

-- The caller's jobs, newest first, with the next van visit if one is booked.
-- Service role only: this is what lets the receptionist talk about an order,
-- and the phone number it is called with comes from the carrier's caller ID,
-- never from anything the caller says.
create or replace function public.receptionist_jobs_for_phone(p_phone text)
returns table (
  id uuid, quote_number text, drd_number text, customer_name text,
  site_address text, status text, updated_at timestamptz,
  next_stop_type text, next_stop_date date, next_stop_starts timestamptz, next_stop_ends timestamptz
)
language sql
stable
security definer
set search_path to 'public'
as $$
  with p as (select public.au_phone_norm(p_phone) as n)
  select j.id, j.quote_number, j.drd_number, j.customer_name, j.site_address,
         j.status, j.updated_at,
         s.stop_type, s.stop_date, s.starts_at, s.ends_at
    from public.jobs j
    left join public.customers c on c.id = j.customer_id
    cross join p
    left join lateral (
      select ss.stop_type, ss.stop_date, ss.starts_at, ss.ends_at
        from public.schedule_stops ss
       where (ss.job_id = j.id or (j.fergus_job_id is not null and ss.fergus_job_id = j.fergus_job_id))
         and ss.stop_date >= (now() at time zone 'Australia/Melbourne')::date
       order by ss.starts_at
       limit 1
    ) s on true
   where length(p.n) = 10
     and coalesce(j.archived, false) = false
     and (public.au_phone_norm(j.customer_phone) = p.n
          or public.au_phone_norm(c.phone) = p.n
          or c.phone_norm = p.n)
   order by j.updated_at desc nulls last
   limit 5
$$;

revoke execute on function public.receptionist_jobs_for_phone(text) from anon, authenticated, public;

-- Same lookup by the job number a caller reads off their quote or email.
create or replace function public.receptionist_job_by_number(p_number text)
returns table (
  id uuid, quote_number text, drd_number text, customer_name text,
  site_address text, status text, updated_at timestamptz,
  next_stop_type text, next_stop_date date, next_stop_starts timestamptz, next_stop_ends timestamptz
)
language sql
stable
security definer
set search_path to 'public'
as $$
  with p as (select upper(regexp_replace(coalesce(p_number, ''), '[^A-Za-z0-9]', '', 'g')) as n)
  select j.id, j.quote_number, j.drd_number, j.customer_name, j.site_address,
         j.status, j.updated_at,
         s.stop_type, s.stop_date, s.starts_at, s.ends_at
    from public.jobs j
    cross join p
    left join lateral (
      select ss.stop_type, ss.stop_date, ss.starts_at, ss.ends_at
        from public.schedule_stops ss
       where (ss.job_id = j.id or (j.fergus_job_id is not null and ss.fergus_job_id = j.fergus_job_id))
         and ss.stop_date >= (now() at time zone 'Australia/Melbourne')::date
       order by ss.starts_at
       limit 1
    ) s on true
   where length(p.n) >= 3
     and coalesce(j.archived, false) = false
     and (upper(regexp_replace(coalesce(j.quote_number, ''), '[^A-Za-z0-9]', '', 'g')) = p.n
          or upper(regexp_replace(coalesce(j.drd_number, ''), '[^A-Za-z0-9]', '', 'g')) = p.n
          or upper(regexp_replace(coalesce(j.fergus_job_no, ''), '[^A-Za-z0-9]', '', 'g')) = p.n
          -- callers drop the prefix: "four-five-six" for DRD-456
          or regexp_replace(coalesce(j.quote_number, ''), '\D', '', 'g') = p.n
          or regexp_replace(coalesce(j.drd_number, ''), '\D', '', 'g') = p.n)
   order by j.updated_at desc nulls last
   limit 3
$$;

revoke execute on function public.receptionist_job_by_number(text) from anon, authenticated, public;

-- The shared key Retell puts on every request (?key=...). Generated once,
-- kept in the database like the report trigger secret. Read it with:
--   select value from integration_secrets where key = 'receptionist-secret';
insert into public.integration_secrets (key, value, note)
select 'receptionist-secret',
       replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
       'Query-string key on every Retell webhook and function URL for the receptionist Edge Function.'
 where not exists (select 1 from public.integration_secrets where key = 'receptionist-secret');
