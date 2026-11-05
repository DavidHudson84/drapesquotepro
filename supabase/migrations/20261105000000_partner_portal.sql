-- ============================================================================
-- PARTNER PORTAL
--
-- Lets a trade partner (Haven Window Furnishings and the like) log in, raise a
-- quote against our price list, do a pre-inspection, and send the quote to
-- their customer. The job lands in Drapr like any other, tagged to the partner,
-- and the partner earns a commission on the cleaning.
--
-- SECURITY MODEL. Every staff table is locked to auth_company_id(), which is
-- looked up from app_users. Partner logins are deliberately NOT app_users, so
-- auth_company_id() is null for them and every existing RLS policy returns
-- nothing. A partner can't read a single job, customer or price through the
-- REST API. All partner reads and writes go through the partner-portal Edge
-- Function, which runs as service role and scopes every query to the
-- partner's own account.
-- ============================================================================

-- ---------------------------------------------------------------- accounts
-- A partner is an account with the portal switched on. Two commission rates:
-- referral only (we do the takedown and rehang) and partner installs (they do
-- it). Commission is paid on the cleaning and repair lines only, ex GST.
alter table public.accounts
  add column if not exists is_partner               boolean not null default false,
  add column if not exists commission_referral_pct  numeric(5,2) not null default 30,
  add column if not exists commission_install_pct   numeric(5,2) not null default 50,
  add column if not exists partner_invoice_default  text not null default 'drdrapes',
  add column if not exists partner_rehang_fee       numeric(10,2),
  add column if not exists partner_transport_fee    numeric(10,2),
  add column if not exists partner_notify_email     text;

do $$ begin
  alter table public.accounts
    add constraint accounts_partner_invoice_default_chk
    check (partner_invoice_default in ('drdrapes', 'partner'));
exception when duplicate_object then null; end $$;

comment on column public.accounts.is_partner is
  'Partner portal switched on for this account. Its partner_users can log in at partner.html.';
comment on column public.accounts.commission_referral_pct is
  'Commission % when Dr Drapes does the takedown and rehang. Paid on cleaning + repair lines, ex GST.';
comment on column public.accounts.commission_install_pct is
  'Commission % when the partner does the takedown and rehang themselves.';
comment on column public.accounts.partner_rehang_fee is
  'Takedown & rehang charge (ex GST) added to a partner quote when Dr Drapes does the install. Blank = none.';
comment on column public.accounts.partner_transport_fee is
  'Transport charge (ex GST) added to every partner quote. Blank = none.';
comment on column public.accounts.partner_notify_email is
  'Where job updates go. Blank = every active login on the account.';

-- ------------------------------------------------------------ partner_users
create table if not exists public.partner_users (
  id          uuid primary key references auth.users(id) on delete cascade,
  company_id  uuid not null references public.companies(id),
  account_id  uuid not null references public.accounts(id) on delete cascade,
  name        text not null,
  email       text not null,
  phone       text,
  active      boolean not null default true,
  invited_at  timestamptz,
  last_login  timestamptz,
  -- Set-password link. Our own token, not GoTrue's, because GoTrue's recovery
  -- link dies after an hour and a partner opens an invite whenever they get to
  -- it. Stored hashed; redeemed once, then cleared.
  invite_token_hash  text,
  invite_expires_at  timestamptz,
  created_at  timestamptz not null default now()
);

-- For a table created by an earlier run of this file before the invite columns existed.
alter table public.partner_users
  add column if not exists invite_token_hash text,
  add column if not exists invite_expires_at timestamptz;

create index if not exists partner_users_account_idx on public.partner_users (account_id);
create unique index if not exists partner_users_email_key on public.partner_users (lower(email));

alter table public.partner_users enable row level security;

-- Staff can see and switch off partner logins. Partners can't reach this table
-- at all through the API; the portal function reads it as service role.
drop policy if exists company_isolation on public.partner_users;
create policy company_isolation on public.partner_users
  for all
  using (company_id = auth_company_id())
  with check (company_id = auth_company_id());

-- ---------------------------------------------------------------------- jobs
-- partner_account_id is who brought the job in, whoever ends up billing it.
-- account_id stays what it has always meant: who Fergus bills. When the
-- partner bills their own customer, both point at the partner; when we bill
-- the customer, account_id is null and Fergus raises it against the customer.
alter table public.jobs
  add column if not exists partner_account_id   uuid references public.accounts(id),
  add column if not exists partner_user_id      uuid references public.partner_users(id) on delete set null,
  add column if not exists commission_pct       numeric(5,2),
  add column if not exists commission_paid_at   timestamptz,
  add column if not exists commission_paid_ref  text;

create index if not exists jobs_partner_account_idx
  on public.jobs (partner_account_id, created_at desc)
  where partner_account_id is not null;

comment on column public.jobs.partner_account_id is
  'The partner who raised or referred this job. Drives commission and partner notifications. Independent of account_id (who Fergus bills).';
comment on column public.jobs.commission_pct is
  'Commission % owed to the partner on this job. Set from the partner rates at quote time; staff can override.';

-- ------------------------------------------------- partner status emails
-- Every status change on a partner job tells the partner, from wherever it
-- happened: the staff app, the customer accept page, or the Fergus sync. A
-- trigger catches all of them; doing it in the app would miss two of three.
create or replace function public.notify_partner_status()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_secret text;
begin
  if new.partner_account_id is null or new.status is not distinct from old.status then
    return new;
  end if;

  select value into v_secret
    from public.integration_secrets
   where key = 'report-trigger-secret';
  if v_secret is null then
    return new;   -- never block a status change over a missing email secret
  end if;

  perform net.http_post(
    url     := 'https://kspezkqanaqrhbirqmlc.supabase.co/functions/v1/partner-portal',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-report-secret', v_secret),
    body    := jsonb_build_object('action', 'notify_status', 'job_id', new.id,
                                  'old_status', old.status, 'new_status', new.status),
    timeout_milliseconds := 30000
  );
  return new;
exception when others then
  -- An email that fails to queue must never roll back the job update.
  raise warning 'notify_partner_status: %', sqlerrm;
  return new;
end;
$function$;

revoke execute on function public.notify_partner_status() from public, anon, authenticated;

drop trigger if exists jobs_notify_partner_status on public.jobs;
create trigger jobs_notify_partner_status
  after update of status on public.jobs
  for each row
  when (new.partner_account_id is not null)
  execute function public.notify_partner_status();

-- ------------------------------------------- monthly commission statements
-- First business morning of each month, Melbourne time: each partner gets
-- their statement for last month, the office gets the payables summary.
create or replace function public.trigger_partner_statements(p_dry_run boolean default false)
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
  -- Same paired-cron trick as the follow-up digest: one of the two UTC runs
  -- lands at 8am local in both AEST and AEDT, the other is dropped here.
  if extract(day from v_local) <> 1 or extract(hour from v_local) <> 8 then
    return null;
  end if;

  select value into v_secret from public.integration_secrets where key = 'report-trigger-secret';
  if v_secret is null then
    raise exception 'report-trigger-secret is missing from integration_secrets';
  end if;

  select net.http_post(
    url     := 'https://kspezkqanaqrhbirqmlc.supabase.co/functions/v1/partner-portal',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-report-secret', v_secret),
    body    := jsonb_build_object('action', 'statements', 'dry_run', p_dry_run),
    timeout_milliseconds := 60000
  ) into v_id;
  return v_id;
end;
$function$;

revoke execute on function public.trigger_partner_statements(boolean) from public, anon, authenticated;

select cron.unschedule('drdrapes-partner-statements')
  where exists (select 1 from cron.job where jobname = 'drdrapes-partner-statements');

-- 21:00 and 22:00 UTC on the last day of the previous month and the 1st:
-- cron can't say "last day", so run both evenings the guard might need.
select cron.schedule('drdrapes-partner-statements', '0 21,22 * * *',
                     'select public.trigger_partner_statements()');
