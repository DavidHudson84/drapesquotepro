-- schedule_stops
--
-- The forward view of the Fergus calendar — today out to three weeks —
-- so the office can be told where the van is already going when a job
-- is accepted and a take-down has to be booked.
--
-- This is deliberately NOT run_sheet_stops. That table is the driver's
-- day: three days wide, rebuilt every twenty minutes, and it pays for a
-- per-job Fergus call to carry the customer's phone number and job card
-- out to a phone at somebody's front door. None of that survives being
-- stretched over three weeks of calendar at one API call a job.
--
-- Fergus owns the schedule. Nothing here is ever written back to it.

create table if not exists public.schedule_stops (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,

  -- Fergus stores one copy of an event per assigned person; they collapse
  -- on groupId, so run_key is groupId where there is one and the event id
  -- otherwise. Same convention as run_sheet_stops.
  run_key           bigint not null,
  fergus_event_id   bigint,
  fergus_job_id     bigint,
  fergus_job_no     text,
  fergus_phase_id   bigint,

  title             text not null default '',
  description       text,
  starts_at         timestamptz,
  ends_at           timestamptz,
  stop_date         date not null,
  assigned_user_ids bigint[] not null default '{}',
  stop_type         text not null default 'other',

  -- Where the stop is. Resolved from the DQP job where the DRD number
  -- matches, and only pulled from Fergus for the ones it doesn't.
  address_line      text,
  suburb            text,
  state             text,
  postcode          text,

  job_id            uuid references public.jobs(id) on delete set null,
  synced_at         timestamptz not null default now(),

  constraint schedule_stops_company_run_key_key unique (company_id, run_key)
);

comment on table public.schedule_stops is
  'Forward view of the Fergus calendar (today to +21 days), synced by the sync-schedule Edge Function. Read-only mirror — Fergus is the source of truth. Drives the take-down slot suggestions on an accepted job.';

create index if not exists schedule_stops_company_date_idx
  on public.schedule_stops (company_id, stop_date);

alter table public.schedule_stops enable row level security;

drop policy if exists company_isolation on public.schedule_stops;
create policy company_isolation on public.schedule_stops
  for all
  using (company_id = auth_company_id())
  with check (company_id = auth_company_id());
