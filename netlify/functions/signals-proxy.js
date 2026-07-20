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
//   2. GET /v1/admin/signals    — the full per-zone signal dump, which is
//      then filtered down to just that one zone's entry per source.
// PRICING_MODEL_API_KEY never reaches the browser — set PRICING_MODEL_URL
// and PRICING_MODEL_API_KEY as Netlify environment variables (Site settings
// -> Environment variables).
// ---------------------------------------------------------------------------

const SOURCES = ['weather', 'tfl', 'events', 'sports', 'rail', 'strikes', 'traffic'];

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

    const signals = await getJson(`${base}/v1/admin/signals`, apiKey, 3500);
    const liveSignals = signals.live_signals || {};

    const filtered = { cluster_slug: clusterSlug, cluster_name: pricing.cluster_name || null };
    for (const source of SOURCES) {
      const zones = liveSignals[source] || [];
      const match = zones.find((z) => z.zone === clusterSlug);
      filtered[source] = match ? match.data : null;
    }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(filtered) };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: err.message || 'Pricing model unreachable' }) };
  }
};
