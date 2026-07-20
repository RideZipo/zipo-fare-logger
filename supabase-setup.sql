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

  notes                 text default '',

  -- Zipo Pricing Model live signals for this entry's *pickup* H3 signal zone
  -- only (not the whole-London dump), one column per signal source
  -- (GET /v1/admin/signals, filtered to the pickup zone by the Netlify
  -- signals-proxy function). Each is NULL when either no snapshot was
  -- captured (fetch failed, or the row predates these columns) or that
  -- source had no active signal in this entry's zone at logging time — the
  -- two cases aren't distinguished; re-derive the pickup zone from
  -- origin_lat/origin_lng if that distinction matters later. Captured once
  -- at insert time; never refreshed by edits.
  signals_weather       jsonb,
  signals_tfl           jsonb,
  signals_events        jsonb,
  signals_sports        jsonb,
  signals_rail          jsonb,
  signals_strikes       jsonb,
  signals_traffic       jsonb
);

-- Additive migration for installs created before the signals_* columns
-- existed. Safe to re-run.
alter table public.fare_entries add column if not exists signals_weather jsonb;
alter table public.fare_entries add column if not exists signals_tfl jsonb;
alter table public.fare_entries add column if not exists signals_events jsonb;
alter table public.fare_entries add column if not exists signals_sports jsonb;
alter table public.fare_entries add column if not exists signals_rail jsonb;
alter table public.fare_entries add column if not exists signals_strikes jsonb;
alter table public.fare_entries add column if not exists signals_traffic jsonb;
-- Drop the earlier single-blob column if this install had it from a prior
-- iteration of this feature (never shipped, so most installs won't).
alter table public.fare_entries drop column if exists signals_snapshot;

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
-- 3. Per-account app config
-- ---------------------------------------------------------------------------
-- The route/tier catalogue, weights, sampling mode and fare defaults are one
-- JSON blob per account (one row per auth user, keyed by user_id). The app
-- upserts the caller's own row on any config edit and reads only its own row
-- on startup — changing defaults on one account never touches another's.

-- One-time migration for installs created before this change: the old
-- schema had a single row (id = 'shared') read/written by every account.
-- This copies that row's data into a fresh per-account row for each existing
-- auth user (so nobody's current catalogue/fare-defaults are lost), then
-- drops the old text `id` column in favour of `user_id` as the primary key.
-- Safe to re-run: it only fires while the legacy `id` column still exists.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'app_config' and column_name = 'id'
  ) then
    alter table public.app_config add column if not exists user_id uuid references auth.users (id) on delete cascade;

    insert into public.app_config (id, user_id, data, updated_at)
    select gen_random_uuid()::text, u.id, coalesce(s.data, '{}'::jsonb), now()
    from auth.users u
    left join (select data from public.app_config where id = 'shared' limit 1) s on true
    where not exists (select 1 from public.app_config a2 where a2.user_id = u.id);

    delete from public.app_config where id = 'shared' or user_id is null;
    alter table public.app_config drop constraint if exists app_config_pkey;
    alter table public.app_config drop column id;
    alter table public.app_config drop column if exists updated_by;
    alter table public.app_config add primary key (user_id);
  end if;
end $$;

create table if not exists public.app_config (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  data        jsonb not null,            -- the whole cfg object, owned by this account
  updated_at  timestamptz not null default now()
);

alter table public.app_config enable row level security;

drop policy if exists "authenticated can read config"      on public.app_config;
drop policy if exists "authenticated can write config"     on public.app_config;
drop policy if exists "authenticated can read own config"  on public.app_config;
drop policy if exists "authenticated can write own config" on public.app_config;

-- READ: an account only sees its own config row.
create policy "authenticated can read own config"
  on public.app_config
  for select
  to authenticated
  using (user_id = auth.uid());

-- WRITE (insert + update via upsert): an account may only create/change its
-- own config row. `for all` covers insert/update/delete.
create policy "authenticated can write own config"
  on public.app_config
  for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

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

-- RLS policies alone aren't enough — Postgres also requires the base table
-- privilege for a role before its policies are even considered. The anon
-- role (used for the logged-out login picker) has no default grants on
-- tables you create, so this must be explicit.
grant select on public.databases to anon, authenticated;
grant insert on public.databases to authenticated;

drop policy if exists "anyone can list databases"       on public.databases;
drop policy if exists "authenticated can add a database" on public.databases;

-- READ: the picker needs this list before anyone is signed in.
create policy "anyone can list databases"
  on public.databases
  for select
  to anon, authenticated
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
-- sees the fare_entries rows it created (its own "database"), and app_config
-- (the route/tier catalogue and fare defaults) is likewise private per
-- account — changing one account's defaults never affects another's.
--
-- IMPORTANT one-time manual step: in Supabase dashboard -> Authentication ->
-- Providers -> Email, turn OFF "Confirm email". The picker's "create a new
-- database" flow signs up accounts with synthetic emails (no real inbox), so
-- they can never click a confirmation link — leaving confirmation ON would
-- lock every new database out after creation. Public sign-up itself can stay
-- restricted/invite-only as before; this app creates accounts through the
-- authenticated signUp call, not public self-registration.
-- ===========================================================================
