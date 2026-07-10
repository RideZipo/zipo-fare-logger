-- ===========================================================================
-- Zipo Fare Logger — Supabase schema + Row Level Security
-- Run this whole file once in: Supabase dashboard → SQL Editor → New query.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------
-- One row per logged tier observation, mirroring the fields the data-entry
-- form collects. Numeric fields are nullable: an empty input (or a "skipped"
-- tier) is stored as NULL rather than a sentinel string, which keeps the data
-- clean for later analysis of when fares are highest.

create table if not exists public.fare_entries (
  id                    uuid primary key default gen_random_uuid(),
  created_at            timestamptz not null default now(),
  created_by            uuid not null default auth.uid() references auth.users (id) on delete set null,

  -- observation timing (as captured on the device)
  obs_date              date,          -- e.g. 2026-07-10
  obs_time              text,          -- HH:MM:SS as captured locally

  -- route / location (from the route "pair" the user was logging)
  pair_id               text,
  pair_type             text,
  origin                text,
  destination           text,
  origin_lat            double precision,
  origin_lng            double precision,
  dest_lat              double precision,
  dest_lng              double precision,

  -- vehicle tier + whether this tier was unavailable/skipped
  vehicle               text,
  skipped               boolean not null default false,

  -- the price + fare breakdown (all nullable)
  price_gbp             numeric,
  wait_for_driver_min   numeric,
  driver_eta            text,          -- clock time like "13:20"
  journey_min           numeric,
  base_fare             numeric,
  minimum_fare          numeric,
  per_minute            numeric,
  per_mile              numeric,
  operating_fee         numeric,
  tolls_surcharges      numeric,

  notes                 text default ''
);

-- Helpful indexes for the shared feed and for time-of-day analysis.
create index if not exists fare_entries_created_at_idx on public.fare_entries (created_at desc);
create index if not exists fare_entries_obs_idx        on public.fare_entries (obs_date, obs_time);
create index if not exists fare_entries_pair_idx       on public.fare_entries (pair_id);


-- ---------------------------------------------------------------------------
-- 2. Row Level Security
-- ---------------------------------------------------------------------------
-- Turn RLS on, then grant a shared-feed policy: any *authenticated* user may
-- read every row and insert/update/delete rows. Anonymous (logged-out)
-- requests match no policy and are therefore denied.

alter table public.fare_entries enable row level security;

-- Drop existing policies first so this script is safe to re-run.
drop policy if exists "authenticated can read all"   on public.fare_entries;
drop policy if exists "authenticated can insert"     on public.fare_entries;
drop policy if exists "authenticated can update all" on public.fare_entries;
drop policy if exists "authenticated can delete all" on public.fare_entries;

-- READ: every logged-in user sees everyone's entries (shared feed).
create policy "authenticated can read all"
  on public.fare_entries
  for select
  to authenticated
  using (true);

-- INSERT: any logged-in user may add rows. The check pins created_by to the
-- caller so rows are always attributed to whoever inserted them.
create policy "authenticated can insert"
  on public.fare_entries
  for insert
  to authenticated
  with check (created_by = auth.uid());

-- UPDATE: any logged-in user may edit any row (matches the app's edit UI).
-- If you'd rather restrict edits to the row's author, replace `using (true)`
-- with `using (created_by = auth.uid())` and do the same for delete below.
create policy "authenticated can update all"
  on public.fare_entries
  for update
  to authenticated
  using (true)
  with check (true);

-- DELETE: any logged-in user may delete any row (matches the app's delete UI).
create policy "authenticated can delete all"
  on public.fare_entries
  for delete
  to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- 3. Shared app config
-- ---------------------------------------------------------------------------
-- The route/tier catalogue, weights, sampling mode and fare defaults are now
-- shared across all users instead of living in each browser. It's a single
-- JSON blob in one row (id = 'shared'); the app upserts it on any config edit
-- (last-write-wins) and reads it on startup.

create table if not exists public.app_config (
  id          text primary key,          -- always 'shared' for this app
  data        jsonb not null,            -- the whole cfg object
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users (id) on delete set null
);

alter table public.app_config enable row level security;

drop policy if exists "authenticated can read config"  on public.app_config;
drop policy if exists "authenticated can write config" on public.app_config;

-- READ: any logged-in user reads the shared config.
create policy "authenticated can read config"
  on public.app_config
  for select
  to authenticated
  using (true);

-- WRITE (insert + update via upsert): any logged-in user may change the shared
-- config. `for all` covers insert/update/delete; the checks keep it permissive
-- since it's a single shared row the whole team maintains together.
create policy "authenticated can write config"
  on public.app_config
  for all
  to authenticated
  using (true)
  with check (true);

-- ===========================================================================
-- Done. Reads/writes now require a signed-in user; all signed-in users share
-- one feed AND one config. Public sign-up is disabled separately in
-- Authentication settings (see the README).
-- ===========================================================================
