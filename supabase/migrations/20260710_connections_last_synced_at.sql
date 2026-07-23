-- Real timestamp of the last completed Facebook sync (last_completed_date is only a DATE, useless for a
-- "synced Nm ago" freshness indicator). Set by runFacebookSync on every successful pull; read by the app
-- shell to render the sidebar Refresh control's relative time and surface a stalled scheduler.
alter table public.connections add column if not exists last_synced_at timestamptz;
