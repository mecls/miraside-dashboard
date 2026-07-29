-- Cold Calls CRM — Phase 2 storage.
-- Additive only: creates two NEW tables (nothing existing is altered or dropped).
--
-- Model (decided 2026-07-28): the "Portugal Leads" Google Sheet owns the ROSTER (the user adds/edits
-- contacts there → pulled in). The dashboard owns the CALL STATE (status, assignment, notes, call
-- history, follow-ups) and writes the summary columns (Call Status / Notes / Assigned User) back to the
-- sheet. Full call history + dispositions + follow-up dates live only here.
--
-- Access pattern mirrors the leads tables: RLS is ON and only the service-role admin client (used by the
-- server components / API routes) touches these — anon/authenticated get no policy, so the anon key can't
-- read them. Tenant-scoped via public.tenants, like every other table.

-- ---------------------------------------------------------------------------
-- Contacts: one row per unique person (deduped by email → phone → linkedin).
-- ---------------------------------------------------------------------------
create table if not exists public.cold_call_contacts (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,

  -- Provenance in the sheet.
  source_tab            text not null default 'A - Leads (nº PT)',
  sheet_row             integer,                 -- last-known 1-based row (reference only; write-back matches by key)
  dedupe_key            text not null,           -- lower(email) | else phone | else linkedin | else 'row-N'

  -- Roster / firmographics — OWNED BY THE SHEET (refreshed on every pull, never written back).
  first_name            text,
  last_name             text,
  full_name             text,
  role                  text,
  tier                  text,
  seniority             text,
  department            text,
  email                 text,
  email_norm            text,
  phone                 text,
  phone_norm            text,
  country               text,
  person_linkedin       text,
  company_name          text,
  company_short_name    text,
  company_linkedin      text,
  website               text,
  industry_group        text,
  industry              text,
  niche                 text,
  employees             integer,
  company_size          text,
  company_about         text,
  company_industry_li   text,

  -- Call state — OWNED BY THE DASHBOARD (edited here, written back to the sheet's row).
  call_status           text not null default 'Not called',
  assigned_user         text,
  notes                 text,

  -- Derived from cold_call_activities (maintained by the app on each logged call).
  attempts              integer not null default 0,
  reached_decision_maker boolean,
  last_outcome          text,
  last_attempt_at       timestamptz,
  next_follow_up_at     timestamptz,

  -- Sync bookkeeping.
  sheet_synced_at       timestamptz,             -- last time roster fields were pulled from the sheet
  pushed_at             timestamptz,             -- last time call-state was written back to the sheet
  deleted_from_sheet_at timestamptz,             -- set if the row disappears from the sheet (soft flag)

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (tenant_id, dedupe_key)
);

create index if not exists cold_call_contacts_tenant_status_idx    on public.cold_call_contacts (tenant_id, call_status);
create index if not exists cold_call_contacts_tenant_assigned_idx  on public.cold_call_contacts (tenant_id, assigned_user);
create index if not exists cold_call_contacts_tenant_followup_idx  on public.cold_call_contacts (tenant_id, next_follow_up_at);
create index if not exists cold_call_contacts_tenant_niche_idx     on public.cold_call_contacts (tenant_id, niche);
create index if not exists cold_call_contacts_email_norm_idx       on public.cold_call_contacts (tenant_id, email_norm);
create index if not exists cold_call_contacts_phone_norm_idx       on public.cold_call_contacts (tenant_id, phone_norm);

-- ---------------------------------------------------------------------------
-- Activities: the full call log (one row per attempt / touch).
-- ---------------------------------------------------------------------------
create table if not exists public.cold_call_activities (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants(id) on delete cascade,
  contact_id             uuid not null references public.cold_call_contacts(id) on delete cascade,

  rep                    text,                    -- who made the call (assigned_user / dashboard user name)
  called_at              timestamptz not null default now(),
  channel                text not null default 'call',  -- call | email | linkedin | whatsapp
  disposition            text,                    -- No answer | Answered | Meeting booked | Not interested | Not a fit | Invalid number | Follow up | OOO ...
  reached_decision_maker boolean,
  objection              text,                    -- verbatim, powers the objections board
  next_step              text,
  follow_up_at           timestamptz,
  notes                  text,

  created_at             timestamptz not null default now(),
  created_by             uuid                     -- auth.users id of the dashboard user who logged it (optional)
);

create index if not exists cold_call_activities_contact_idx        on public.cold_call_activities (contact_id, called_at desc);
create index if not exists cold_call_activities_tenant_called_idx  on public.cold_call_activities (tenant_id, called_at desc);

-- ---------------------------------------------------------------------------
-- updated_at bump on cold_call_contacts.
-- ---------------------------------------------------------------------------
create or replace function public.cold_calls_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists cold_call_contacts_set_updated_at on public.cold_call_contacts;
create trigger cold_call_contacts_set_updated_at
  before update on public.cold_call_contacts
  for each row execute function public.cold_calls_set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: on, service-role only (matches the leads tables; app uses the admin client).
-- ---------------------------------------------------------------------------
alter table public.cold_call_contacts  enable row level security;
alter table public.cold_call_activities enable row level security;

grant all on public.cold_call_contacts  to service_role;
grant all on public.cold_call_activities to service_role;
