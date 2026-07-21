// ---------------------------------------------------------------------------
// Zipo Fare Logger — signals proxy
// ---------------------------------------------------------------------------
// Given a pickup lat/lng, returns only the live signals (weather, tfl,
// events, sports, rail, strikes, traffic) for that location's H3 res-6
// signal zone — not the whole-London dump. Two calls to the Zipo Pricing
// Model API:
//   1. GET /v1/pricing?lat&lng  — resolve which signal zone (`cluster`) the
//      coordinate falls in. Only the `cluster`/`cluster_name` fields are
//      used; everything price-related in that response is discarded, never
//      stored.
//   2. GET /v1/admin/signals?include_inactive=true — the full per-zone signal
//      dump (including zones the pricing model doesn't consider "active", e.g.
//      fair-weather days where demand_pressure is 0 — PM1), filtered down to
//      just that one zone's entry per source, then stripped to raw reported
//      fields only (see stripComputed) — Zipo's own computed demand
//      scores/severities/estimates are not returned or stored.
// PRICING_MODEL_API_KEY never reaches the browser — set PRICING_MODEL_URL
// and PRICING_MODEL_API_KEY as Netlify environment variables (Site settings
// -> Environment variables).
// ---------------------------------------------------------------------------

const SOURCES = ['weather', 'tfl', 'events', 'sports', 'rail', 'strikes', 'traffic'];

// Each pricing-model signal source mixes raw/reported fields with Zipo's own
// computed demand scores (weights, severity mappings, decayed hex maps,
// estimated attendance). This app wants the raw inputs only — keep in sync
// with the pipeline source modules in Zipo-Pricing-Model (pipeline/sources/*)
// if their payload shapes change.
function stripComputed(source, data) {
  if (!data) return null;
  switch (source) {
    case 'weather':
      return { rain_mm: data.rain_mm, temp_c: data.temp_c, wind_ms: data.wind_ms };
    case 'tfl':
      return { affected_lines: data.affected_lines || [] };
    case 'events':
      return {
        events: (data.events || []).map((e) => ({
          title: e.title, category: e.category, venue: e.venue, start_iso: e.start_iso, end_iso: e.end_iso,
        })),
      };
    case 'sports':
      return {
        fixtures: (data.fixtures || []).map((f) => ({
          title: f.title, venue: f.venue, start_iso: f.start_iso, end_iso: f.end_iso, source: f.source,
        })),
      };
    case 'strikes':
      return { active: data.active, struck_lines: data.struck_lines || [], description: data.description };
    case 'traffic':
      return {
        disruptions: (data.disruptions || []).map((d) => ({
          severity: d.severity, category: d.category, comment: d.comment,
        })),
      };
    case 'rail':
      return { summary: data.summary };
    default:
      return data;
  }
}

async function getJson(url, apiKey, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'X-API-Key': apiKey }, signal: controller.signal });
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async function (event) {
  const baseUrl = process.env.PRICING_MODEL_URL;
  const apiKey = process.env.PRICING_MODEL_API_KEY;
  if (!baseUrl || !apiKey) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'PRICING_MODEL_URL / PRICING_MODEL_API_KEY not configured' }),
    };
  }

  const { lat, lng } = (event && event.queryStringParameters) || {};
  if (!lat || !lng) {
    return { statusCode: 400, body: JSON.stringify({ error: 'lat and lng query params are required' }) };
  }

  const base = baseUrl.replace(/\/$/, '');

  try {
    const pricing = await getJson(
      `${base}/v1/pricing?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`,
      apiKey,
      3500,
    );
    const clusterSlug = pricing.cluster;

    const signals = await getJson(`${base}/v1/admin/signals?include_inactive=true`, apiKey, 3500);
    const liveSignals = signals.live_signals || {};

    const filtered = { cluster_slug: clusterSlug, cluster_name: pricing.cluster_name || null };
    for (const source of SOURCES) {
      const zones = liveSignals[source] || [];
      const match = zones.find((z) => z.zone === clusterSlug);
      filtered[source] = match ? stripComputed(source, match.data) : null;
    }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(filtered) };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: err.message || 'Pricing model unreachable' }) };
  }
};
