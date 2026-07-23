-- Audit-intake forward (instant-form leads → miraside.co/api/audit-intake, which generates + emails the
-- ROI audit). audit_pushed_at = durable delivery stamp (null → the scheduled sync retries recent leads);
-- audit_url = the generated audit's public URL, shown on the lead.
alter table public.leads
  add column if not exists audit_pushed_at timestamptz,
  add column if not exists audit_url text;
