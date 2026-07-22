// ---------------------------------------------------------------------------
// Minimal Supabase PostgREST client for scripts/ — no dependencies
// ---------------------------------------------------------------------------
// This repo has no build step and no node_modules, so the scripts talk to
// PostgREST over plain fetch rather than pulling in @supabase/supabase-js.
//
// Everything here runs under the service_role key, which bypasses Row Level
// Security — necessary because these are cross-database admin operations, and
// the reason the key is read from the environment and never written to a file.
// ---------------------------------------------------------------------------

export const SUPABASE_URL = (
  process.env.SUPABASE_URL || 'https://xgbxwrscbqyreejtoemn.supabase.co'
).replace(/\/$/, '');

export const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const PAGE_SIZE = 1000; // PostgREST silently truncates a single response here

export function requireKey() {
  if (SERVICE_KEY) return;
  console.error('SUPABASE_SERVICE_ROLE_KEY is not set.');
  console.error('Find it in: Supabase dashboard -> Project Settings -> API -> service_role.');
  console.error('Pass it for this one command only — do not put it in config.js or Netlify.');
  console.error('');
  console.error('The role also needs table privileges, which this project does not grant by');
  console.error('default (see the README). Without them PostgREST answers 42501 and nothing');
  console.error('is written:');
  console.error('  grant select, update on public.fare_entries to service_role;');
  process.exit(1);
}

export function headers(extra) {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, ...(extra || {}) };
}

/** SELECT every matching row, paging past PostgREST's 1000-row cap. */
export async function selectAll(table, select, filters, limit = Infinity) {
  const rows = [];
  for (let offset = 0; rows.length < limit; offset += PAGE_SIZE) {
    const url = `${SUPABASE_URL}/rest/v1/${table}?select=${select}&${filters}&limit=${PAGE_SIZE}&offset=${offset}`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw new Error(`select ${table} failed: ${res.status} ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return limit === Infinity ? rows : rows.slice(0, limit);
}

/** PATCH one row by id, with an optional extra filter as a write-time guard. */
export async function patchRow(table, id, body, guard = '') {
  const url =
    `${SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}` + (guard ? `&${guard}` : '');
  const payload = JSON.stringify(body);

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: payload,
    });
    if (res.ok) return;
    if (res.status >= 500 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
      continue;
    }
    throw new Error(`PATCH ${id} failed: ${res.status} ${await res.text()}`);
  }
}

/** Run `worker` over `items` with bounded concurrency. */
export async function mapConcurrent(items, concurrency, worker) {
  const queue = items.slice();
  let done = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let item = queue.pop(); item; item = queue.pop()) {
        await worker(item, ++done);
      }
    }),
  );
}
