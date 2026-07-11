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
-- Each Supabase Auth account is one "database" (see section 4). RLS scopes
-- every read/write to rows the signed-in account itself created, so one
-- account's observations are never visible to another. Anonymous
-- (logged-out) requests match no policy and are therefore denied.

alter table public.fare_entries enable row level security;

-- Drop existing policies first so this script is safe to re-run.
drop policy if exists "authenticated can read all"   on public.fare_entries;
drop policy if exists "authenticated can insert"     on public.fare_entries;
drop policy if exists "authenticated can update all" on public.fare_entries;
drop policy if exists "authenticated can delete all" on public.fare_entries;
drop policy if exists "authenticated can read own"   on public.fare_entries;
drop policy if exists "authenticated can update own" on public.fare_entries;
drop policy if exists "authenticated can delete own" on public.fare_entries;

-- READ: an account only sees the rows it created.
create policy "authenticated can read own"
  on public.fare_entries
  for select
  to authenticated
  using (created_by = auth.uid());

-- INSERT: any logged-in account may add rows. The check pins created_by to
-- the caller so rows are always attributed to whoever inserted them.
create policy "authenticated can insert"
  on public.fare_entries
  for insert
  to authenticated
  with check (created_by = auth.uid());

-- UPDATE: an account may only edit its own rows.
create policy "authenticated can update own"
  on public.fare_entries
  for update
  to authenticated
  using (created_by = auth.uid())
  with check (created_by = auth.uid());

-- DELETE: an account may only delete its own rows.
create policy "authenticated can delete own"
  on public.fare_entries
  for delete
  to authenticated
  using (created_by = auth.uid());

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

-- ---------------------------------------------------------------------------
-- 4. Database picker directory
-- ---------------------------------------------------------------------------
-- Each "database" on the login screen is really just one Supabase Auth
-- account behind the scenes. This table is only a name -> backing-email
-- directory so login.html can (a) list the databases that already exist and
-- (b) look up which real auth email to sign in with, given the friendly name
-- typed/picked in the UI. The email is a deterministic slug of the name
-- (e.g. "Alice" -> db-alice@zipo.internal) with no real inbox behind it, so
-- it isn't sensitive — the actual account password is what protects the data.

create table if not exists public.databases (
  name        text primary key,
  email       text not null unique,
  created_at  timestamptz not null default now()
);

alter table public.databases enable row level security;

drop policy if exists "anyone can list databases"       on public.databases;
drop policy if exists "authenticated can add a database" on public.databases;

-- READ: the picker needs this list before anyone is signed in.
create policy "anyone can list databases"
  on public.databases
  for select
  using (true);

-- INSERT: only once signed in (i.e. right after creating the backing auth
-- account via sign-up) may a database's directory entry be added.
create policy "authenticated can add a database"
  on public.databases
  for insert
  to authenticated
  with check (true);

-- ===========================================================================
-- Done. Reads/writes now require a signed-in user; every account only ever
-- sees the fare_entries rows it created (its own "database"), while
-- app_config (the route/tier catalogue and fare defaults) stays shared
-- across all of them.
--
-- IMPORTANT one-time manual step: in Supabase dashboard -> Authentication ->
-- Providers -> Email, turn OFF "Confirm email". The picker's "create a new
-- database" flow signs up accounts with synthetic emails (no real inbox), so
-- they can never click a confirmation link — leaving confirmation ON would
-- lock every new database out after creation. Public sign-up itself can stay
-- restricted/invite-only as before; this app creates accounts through the
-- authenticated signUp call, not public self-registration.
-- ===========================================================================
