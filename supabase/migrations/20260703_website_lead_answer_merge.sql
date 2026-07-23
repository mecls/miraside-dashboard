-- Website-lead partial-answer capture.
-- Applied to the live DB on 2026-07-03 (project sybpedxhmbalfzvntzcd). Kept here so the merge semantics
-- are reviewable/reproducible. Called from app/api/leads/website/route.ts on every non-first fire.
--
-- Purpose: a multi-step landing-page audit fires per-step (started → progress… → completed). Each fire
-- POSTs the answers-so-far; this function atomically UNIONs them into the lead's stored answers by question
-- label (incoming value wins, an earlier answer is NEVER dropped, an empty incoming set never wipes), under
-- a row lock so two concurrent per-step fires can't lost-update each other. This is what makes a lead who
-- abandons before the last step keep everything they already typed.

CREATE OR REPLACE FUNCTION public.merge_website_lead_answers(p_tenant uuid, p_key text, p_incoming jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  v_existing jsonb;
  v_result jsonb;
begin
  -- Row lock serializes concurrent merges for the same lead.
  select coalesce(answers, '[]'::jsonb) into v_existing
  from public.leads
  where tenant_id = p_tenant and meta_lead_id = p_key
  for update;

  if not found then
    return coalesce(p_incoming, '[]'::jsonb); -- no row yet; caller's insert handles first-fire answers
  end if;

  with all_rows as (
    select value as v, 0 as pref, ord
      from jsonb_array_elements(v_existing) with ordinality as t(value, ord)
    union all
    select value as v, 1 as pref, ord
      from jsonb_array_elements(coalesce(p_incoming, '[]'::jsonb)) with ordinality as t(value, ord)
  ),
  valid as (
    select v, pref, ord, lower(btrim(coalesce(v->>'label',''))) as k
      from all_rows
     where btrim(coalesce(v->>'label','')) <> ''
  ),
  picked as (
    select distinct on (k) v, ord
      from valid
     order by k, pref desc, ord desc   -- per label: incoming (pref 1), latest, wins
  )
  select coalesce(jsonb_agg(v order by ord), '[]'::jsonb) into v_result from picked;

  -- Abuse cap: keep the first 30.
  if jsonb_array_length(v_result) > 30 then
    select coalesce(jsonb_agg(value order by ord), '[]'::jsonb) into v_result
      from (select value, ord from jsonb_array_elements(v_result) with ordinality as t(value, ord) order by ord limit 30) s;
  end if;

  update public.leads
     set answers = v_result, synced_at = now()
   where tenant_id = p_tenant and meta_lead_id = p_key;

  return v_result;
end $$;

-- Only the service-role admin client (the website-lead route) may call it.
REVOKE EXECUTE ON FUNCTION public.merge_website_lead_answers(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_website_lead_answers(uuid, text, jsonb) TO service_role;
