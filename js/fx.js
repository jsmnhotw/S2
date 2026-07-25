// Live FX rates (ECB reference rates via Frankfurter, no API key required).
// Frankfurter tracks ECB's currency list, which excludes several Gulf-pegged
// and a few other currencies that appear in our vendor data. For those we fall
// back to a static approximate peg, clearly labeled as such in the UI so BD
// knows to double check before quoting a client in one of these currencies.

const FX_STATIC_FALLBACK_USD_BASE = {
  // amount of 1 unit of currency X per 1 USD (i.e. rate to multiply a USD amount by to get X)
  BHD: 0.376, SAR: 3.75, AED: 3.6725, QAR: 3.64, KWD: 0.307, MMK: 2100, EGP: 49.5,
  OMR: 0.3845, // fixed peg since 1986, safe to keep static
  MYR: 4.7, // NOT pegged - floats, this is an approximation only and will drift; verify before quoting
};

const FX_CACHE_KEY = 'slasify_fx_rates_v1';
const FX_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h

async function fetchLiveRates() {
  const cached = readFxCache();
  if (cached) return cached;

  const res = await fetch('https://api.frankfurter.dev/v1/latest?base=USD');
  if (!res.ok) throw new Error('FX rate fetch failed: ' + res.status);
  const data = await res.json();
  const rates = { USD: 1, ...data.rates };
  const payload = { rates, fetchedAt: data.date || new Date().toISOString(), isLive: true };
  try { localStorage.setItem(FX_CACHE_KEY, JSON.stringify({ ...payload, cachedAt: Date.now() })); } catch (e) {}
  return payload;
}

function readFxCache() {
  try {
    const raw = localStorage.getItem(FX_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.cachedAt > FX_CACHE_TTL_MS) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

// FxTable: { rates: {CUR: perUSD}, fetchedAt, isLive, staticCurrencies: Set }
async function loadFxTable() {
  let live = { rates: { USD: 1 }, fetchedAt: null, isLive: false };
  try {
    live = await fetchLiveRates();
  } catch (e) {
    console.warn('Live FX unavailable, using static fallback only.', e);
  }
  const rates = { ...FX_STATIC_FALLBACK_USD_BASE, ...live.rates };
  const staticCurrencies = new Set(
    Object.keys(FX_STATIC_FALLBACK_USD_BASE).filter((c) => !(c in live.rates))
  );
  return { rates, fetchedAt: live.fetchedAt, isLive: live.isLive, staticCurrencies };
}

function toUSD(amount, currency, fxTable) {
  if (currency === 'USD') return amount;
  const rate = fxTable.rates[currency];
  if (!rate) return null;
  return amount / rate;
}

function fromUSD(amountUsd, currency, fxTable) {
  if (currency === 'USD') return amountUsd;
  const rate = fxTable.rates[currency];
  if (!rate) return null;
  return amountUsd * rate;
}
