-- Structured post-call analysis from Retell (custom analysis fields), so the
-- call email, the morning log and the Calls page can lead with who called,
-- why, what Sally did and what the team needs to do next.
alter table public.receptionist_calls add column if not exists analysis jsonb;
comment on column public.receptionist_calls.analysis is 'Retell post-call analysis custom fields: caller_name, caller_type, reason, outcome, action_needed, job_number, suburb, urgency.';
