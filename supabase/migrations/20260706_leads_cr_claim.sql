-- CompleteRegistration single-winner claim: the flagged payload that wins this claim (cr_fired_at IS NULL)
-- is the only one allowed to send the CAPI CompleteRegistration for the lead. cr_event_id records the
-- browser-pixel event id it was sent with (audit + retry-safe release).
alter table public.leads
  add column if not exists cr_fired_at timestamptz,
  add column if not exists cr_event_id text;
