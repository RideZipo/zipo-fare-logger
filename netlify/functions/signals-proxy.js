// ---------------------------------------------------------------------------
// Zipo Fare Logger — signals proxy
// ---------------------------------------------------------------------------
// Forwards to the Zipo Pricing Model API's GET /v1/admin/signals so the
// browser never sees PRICING_MODEL_API_KEY. Set PRICING_MODEL_URL and
// PRICING_MODEL_API_KEY as Netlify environment variables (Site settings ->
// Environment variables) — never commit them.
// ---------------------------------------------------------------------------

exports.handler = async function () {
  const baseUrl = process.env.PRICING_MODEL_URL;
  const apiKey = process.env.PRICING_MODEL_API_KEY;

  if (!baseUrl || !apiKey) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'PRICING_MODEL_URL / PRICING_MODEL_API_KEY not configured' }),
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/admin/signals`, {
      headers: { 'X-API-Key': apiKey },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: `Pricing model returned ${res.status}` }) };
    }

    const body = await res.text();
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body };
  } catch (err) {
    clearTimeout(timer);
    return { statusCode: 502, body: JSON.stringify({ error: err.message || 'Pricing model unreachable' }) };
  }
};
