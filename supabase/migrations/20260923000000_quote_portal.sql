-- ============================================================================
-- QUOTE ACCEPTANCE PORTAL
--
-- Lets a customer accept, decline or query their quote from a link in the
-- quote email, without a login and without anyone here chasing them.
--
-- The link carries a token, not a job id. A job id appears in staff URLs and
-- in logs; a token does not, it can be rotated on its own, and it grants
-- exactly one job and nothing else. Nothing in this schema gives the anon role
-- any read of jobs — the quote-portal Edge Function is the only thing that
-- ever resolves a token, and it runs as service role.
-- ============================================================================

alter table public.jobs
  add column if not exists accept_token           text,
  add column if not exists accept_token_issued_at timestamptz;

-- Partial, so the 404 jobs that have never been emailed don't all collide on null.
create unique index if not exists jobs_accept_token_key
  on public.jobs (accept_token)
  where accept_token is not null;

comment on column public.jobs.accept_token is
  'Capability token for the customer acceptance page. Minted by ensure_accept_token() the first time a quote is emailed. Anyone holding it can accept or decline this one job, so it is never logged or displayed beyond the send dialog.';

-- ----------------------------------------------------------------------------
-- ensure_accept_token(job) -> token
--
-- Mints on first call, returns the same token on every call after, so the link
-- in a follow-up is the link in the original quote email. Definer rights,
-- because minting has to write a column the caller is otherwise only reading —
-- hence the explicit company check, which mirrors the jobs RLS policy exactly.
-- ----------------------------------------------------------------------------
create or replace function public.ensure_accept_token(p_job_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token   text;
  v_company uuid;
begin
  select accept_token, company_id into v_token, v_company
  from public.jobs where id = p_job_id;

  if v_company is null then
    raise exception 'Job not found';
  end if;
  if v_company is distinct from auth_company_id() then
    raise exception 'Not your job';
  end if;

  if v_token is not null then
    return v_token;
  end if;

  -- 24 random bytes, base64url. Unguessable at any rate a bot could attempt,
  -- and short enough that the whole link still fits one line in an email.
  v_token := translate(encode(gen_random_bytes(24), 'base64'), '+/=', '-_');

  update public.jobs
     set accept_token = v_token,
         accept_token_issued_at = now()
   where id = p_job_id;

  return v_token;
end;
$$;

revoke all on function public.ensure_accept_token(uuid) from public, anon;
grant execute on function public.ensure_accept_token(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Portal event log.
--
-- Two jobs: rate limiting (a token that is being hammered stops answering) and
-- evidence (what the customer was shown, from where, when they accepted).
-- Service role only — the anon key must never be able to read it back.
-- ----------------------------------------------------------------------------
create table if not exists public.quote_portal_events (
  id         bigserial primary key,
  job_id     uuid references public.jobs(id) on delete cascade,
  token_hash text        not null,
  action     text        not null,
  ip         text,
  user_agent text,
  detail     jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists quote_portal_events_token_idx
  on public.quote_portal_events (token_hash, created_at desc);
create index if not exists quote_portal_events_job_idx
  on public.quote_portal_events (job_id, created_at desc);

alter table public.quote_portal_events enable row level security;

comment on table public.quote_portal_events is
  'Every hit on the customer acceptance page. Service role only: it is the rate limiter and the evidence trail for an online acceptance. The token is stored hashed so the log itself can never hand anyone a working link.';

-- ----------------------------------------------------------------------------
-- Storage: the exact PDF that was emailed.
--
-- The portal shows the quote as HTML, but the Download button has to hand back
-- the same document the customer already has in their inbox, not a second
-- rendering of it that might differ. So the app uploads the PDF it just
-- attached, and the portal serves a short-lived signed URL for it.
-- Private bucket; no policies, so only service role reaches it.
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('quote-pdfs', 'quote-pdfs', false)
on conflict (id) do nothing;
