-- The cron kickers are for pg_cron, which runs them as postgres.
--
-- Left executable by PUBLIC they are reachable over the REST API with nothing
-- but the anon key that ships in the page source, so anyone who viewed source
-- could fire a Fergus sync, an activity report or the follow-up digest at
-- will — burning the Fergus rate limit and emailing reports on demand.
--
-- service_role keeps its access; that key is server-side only. pg_cron is
-- unaffected: postgres owns these functions.
revoke execute on function public.trigger_activity_report(text, boolean) from public, anon, authenticated;
revoke execute on function public.trigger_followup_digest(boolean, boolean)  from public, anon, authenticated;
revoke execute on function public.trigger_run_sheet_sync()                   from public, anon, authenticated;
