const FEE_LABELS = {
  serviceFee: 'Service Fee',
  setupFee: 'Setup Fee',
  deposit: 'Deposit',
  terminationFee: 'Termination Fee',
};
const FEE_ORDER = ['serviceFee', 'setupFee', 'deposit', 'terminationFee'];
const CURRENCY_OPTIONS = ['USD', 'EUR', 'GBP', 'SAR', 'BHD', 'INR', 'JPY', 'AUD', 'HKD', 'PLN', 'CAD', 'AED', 'QAR', 'THB', 'MMK', 'PHP', 'IDR', 'EGP', 'KWD', 'CNY', 'CZK', 'MYR', 'NOK', 'OMR', 'CHF'];

let DATA = [];
let INDEX = {}; // country -> serviceType -> [rows]
let fxTable = null;

let state = { country: null, serviceType: null, vendorRow: null, activeFee: 'serviceFee' };

async function init() {
  const res = await fetch('data/mpd.json');
  DATA = await res.json();
  buildIndex();
  populateCountries();
  wireEvents();
  loadFxTable().then((t) => { fxTable = t; if (state.vendorRow) renderCalculator(); });
}

function buildIndex() {
  INDEX = {};
  for (const row of DATA) {
    INDEX[row.country] = INDEX[row.country] || {};
    INDEX[row.country][row.serviceType] = INDEX[row.country][row.serviceType] || [];
    INDEX[row.country][row.serviceType].push(row);
  }
}

function populateCountries() {
  const sel = document.getElementById('country-select');
  const countries = Object.keys(INDEX).sort();
  for (const c of countries) {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    sel.appendChild(opt);
  }
}

function wireEvents() {
  document.getElementById('country-select').addEventListener('change', onCountryChange);
  document.getElementById('service-select').addEventListener('change', onServiceChange);
  document.getElementById('vendor-select').addEventListener('change', onVendorPicked);
  document.getElementById('vendor-change-btn').addEventListener('click', onChangeVendorClick);
  document.getElementById('salary-input').addEventListener('input', renderCalculator);
  document.getElementById('salary-currency').addEventListener('change', renderCalculator);
  document.getElementById('headcount-input').addEventListener('input', renderCalculator);

  const salaryCur = document.getElementById('salary-currency');
  for (const c of CURRENCY_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    salaryCur.appendChild(opt);
  }
}

function showStep(id, show = true) {
  document.getElementById(id).hidden = !show;
}
function hideFrom(stepIndex) {
  const steps = ['step-service', 'step-vendor', 'step-reference', 'step-calculator', 'step-quote'];
  for (let i = stepIndex; i < steps.length; i++) showStep(steps[i], false);
}

function onCountryChange(e) {
  state.country = e.target.value;
  state.serviceType = null; state.vendorRow = null;
  hideFrom(0);
  if (!state.country) return;

  const svcSelect = document.getElementById('service-select');
  svcSelect.innerHTML = '<option value="">Select a service type…</option>';
  const serviceTypes = Object.keys(INDEX[state.country]).sort(); // Local EOR < Expat EOR alphabetically anyway
  for (const s of serviceTypes) {
    const opt = document.createElement('option');
    opt.value = s; opt.textContent = s;
    svcSelect.appendChild(opt);
  }
  showStep('step-service', true);
}

function onServiceChange(e) {
  state.serviceType = e.target.value;
  state.vendorRow = null;
  hideFrom(1);
  if (!state.serviceType) return;
  resolveVendor();
  showStep('step-vendor', true);
}

function resolveVendor(forceFullList = false) {
  const rows = INDEX[state.country][state.serviceType];
  const preferred = rows.filter((r) => r.preference === 'Preferred Vendor');
  const autoBox = document.getElementById('vendor-auto');
  const select = document.getElementById('vendor-select');
  const tiebreakNote = document.getElementById('vendor-tiebreak-note');

  autoBox.hidden = true; select.hidden = true; tiebreakNote.hidden = true;
  select.innerHTML = '<option value="">Select a vendor…</option>';

  if (!forceFullList && preferred.length === 1) {
    state.vendorRow = preferred[0];
    document.getElementById('vendor-auto-name').textContent = preferred[0].vendor;
    autoBox.hidden = false;
    onVendorResolved();
    return;
  }

  let list = rows;
  if (!forceFullList && preferred.length > 1) {
    list = preferred;
    tiebreakNote.hidden = false;
  }
  for (const r of list.sort((a, b) => a.vendor.localeCompare(b.vendor))) {
    const opt = document.createElement('option');
    opt.value = r.vendor;
    const tag = r.preference === 'Preferred Vendor' ? ' (Preferred)' : r.preference === 'Backup Vendor' ? ' (Backup)' : '';
    opt.textContent = r.vendor + tag;
    select.appendChild(opt);
  }
  select.hidden = false;
}

function onChangeVendorClick() {
  resolveVendor(true);
}

function onVendorPicked(e) {
  const rows = INDEX[state.country][state.serviceType];
  state.vendorRow = rows.find((r) => r.vendor === e.target.value) || null;
  if (state.vendorRow) onVendorResolved();
  else hideFrom(2);
}

function onVendorResolved() {
  hideFrom(2);
  renderStaleBanner();
  renderReferenceCard();
  renderFeeTabs();
  showStep('step-reference', true);
  showStep('step-calculator', true);
  state.activeFee = FEE_ORDER.find((k) => state.vendorRow.fees[k] && state.vendorRow.fees[k].kind !== 'none') || 'serviceFee';
  renderCalculator();
}

function parseLooseDate(str) {
  if (!str) return null;
  const m = str.match(/(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})/);
  if (m) {
    const d = new Date(`${m[2]} ${m[1]}, ${m[3]}`);
    if (!isNaN(d)) return d;
  }
  const d2 = new Date(str);
  return isNaN(d2) ? null : d2;
}

function renderStaleBanner() {
  const banner = document.getElementById('stale-banner');
  const validUntil = parseLooseDate(state.vendorRow.pricingValidUntil);
  const today = new Date();
  if (validUntil && validUntil < today) {
    banner.hidden = false;
    banner.textContent = `⚠ This vendor's pricing was only confirmed valid until ${state.vendorRow.pricingValidUntil} — that has passed. Confirm current terms before quoting.`;
  } else if (state.vendorRow.renewalStatus && /reminder sent/i.test(state.vendorRow.renewalStatus)) {
    banner.hidden = false;
    banner.textContent = `⚠ A renewal reminder is outstanding for this vendor (status: "${state.vendorRow.renewalStatus}") — rates may be stale.`;
  } else {
    banner.hidden = true;
  }
}

function rawDisplay(fee) {
  if (!fee) return '—';
  if (fee.kind === 'none') return 'N/A';
  if (fee.kind === 'unknown') return 'TBC';
  return fee.raw || '—';
}

function renderReferenceCard() {
  const row = state.vendorRow;
  const card = document.getElementById('reference-card');
  const fields = [
    ['Vendor', row.vendor],
    ['Preference', row.preference || '—'],
    ['Service Fee (vendor)', rawDisplay(row.fees.serviceFee)],
    ['Setup Fee (vendor)', rawDisplay(row.fees.setupFee)],
    ['Deposit (vendor)', rawDisplay(row.fees.deposit)],
    ['Termination Fee (vendor)', rawDisplay(row.fees.terminationFee)],
    ['VAT', row.vat || 'N/A'],
    ['Pricing valid until', row.pricingValidUntil || '—'],
    ['Note', row.note || '—'],
  ];
  card.innerHTML = fields.map(([label, val]) => `
    <div class="ref-field">
      <dt>${label}</dt>
      <dd>${escapeHtml(val)}</dd>
    </div>`).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderFeeTabs() {
  const row = state.vendorRow;
  const tabsEl = document.getElementById('fee-tabs');
  tabsEl.innerHTML = '';
  for (const key of FEE_ORDER) {
    const fee = row.fees[key];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fee-tab' + (state.activeFee === key ? ' active' : '');
    btn.textContent = FEE_LABELS[key];
    btn.addEventListener('click', () => { state.activeFee = key; renderFeeTabs(); renderCalculator(); });
    if (!fee) btn.disabled = true;
    tabsEl.appendChild(btn);
  }
}

function renderCalculator() {
  const row = state.vendorRow;
  if (!row) return;
  const feeKey = state.activeFee;
  const fee = row.fees[feeKey];
  const result = computeFee(fee, feeKey, row.serviceType);

  document.getElementById('salary-field').hidden = !result.requiresInput.includes('grossSalary');
  document.getElementById('headcount-field').hidden = !result.requiresInput.includes('headcount');

  const out = document.getElementById('calc-result');
  let html = `<div class="formula-line">${escapeHtml(result.formula)}</div>`;

  if (result.uncalculable) {
    html += `<p class="hint">No computed figure — vendor terms aren't confirmed yet for this fee.</p>`;
  } else if (result.isLlmDerived) {
    html += renderFiguresIfPossible(result, fxTable);
    html += `<p class="hint">Derived from a complex vendor fee structure — double-check against the raw vendor terms above before quoting.</p>`;
  } else {
    html += renderFiguresIfPossible(result, fxTable);
  }

  out.innerHTML = html;
  renderQuoteSummary();
}

function getSalaryUsd() {
  const val = parseFloat(document.getElementById('salary-input').value);
  if (!val || !fxTable) return null;
  const cur = document.getElementById('salary-currency').value || 'USD';
  return toUSD(val, cur, fxTable);
}

function renderFiguresIfPossible(result) {
  if (!fxTable) return `<p class="hint">Loading live FX rates…</p>`;

  let low = null, high = null, currency = 'USD';

  if (result.vendorAmount) {
    currency = result.vendorAmount.currency;
    const vLow = toUSD(result.vendorAmount.low ?? result.vendorAmount.amount, currency, fxTable);
    const vHigh = toUSD(result.vendorAmount.high ?? result.vendorAmount.amount, currency, fxTable);
    if (vLow === null) return `<p class="hint">No FX rate available for ${currency} — cannot convert.</p>`;
    low = vLow + (result.marginLow ?? 0);
    high = vHigh + (result.marginHigh ?? 0);
  } else if (result.computedLow !== undefined) {
    currency = result.currency;
    low = toUSD(result.computedLow, currency, fxTable);
    high = toUSD(result.computedHigh, currency, fxTable);
  } else if (result.computedFlat !== undefined) {
    currency = result.currency;
    low = high = toUSD(result.computedFlat, currency, fxTable);
  } else if (result.pct !== undefined) {
    const salaryUsd = getSalaryUsd();
    if (salaryUsd === null) return `<p class="hint">Enter gross salary above to compute a figure.</p>`;
    const base = Math.max((salaryUsd * result.pct) / 100, result.minAmount ? toUSD(result.minAmount, result.minCurrency, fxTable) : 0);
    low = base + (result.marginLow ?? 0);
    high = base + (result.marginHigh ?? 0);
  } else if (result.months !== undefined) {
    const salaryUsd = getSalaryUsd();
    if (salaryUsd === null) return `<p class="hint">Enter gross salary above to compute a figure.</p>`;
    low = high = salaryUsd * result.months;
  } else {
    return '';
  }

  if (low === null) return `<p class="hint">No FX rate available — cannot convert.</p>`;

  const origCur = state.vendorRow.fees[state.activeFee].currency || currency;
  const origLowRaw = fromUSD(low, origCur, fxTable);
  const origHighRaw = fromUSD(high, origCur, fxTable);

  // Round each currency's own figure up to the nearest 5 independently (a clean
  // number to quote in that currency), rather than deriving one from the other's rounding.
  low = roundUpTo5(low);
  high = roundUpTo5(high);
  const origLow = roundUpTo5(origLowRaw);
  const origHigh = roundUpTo5(origHighRaw);

  const isRange = Math.abs(high - low) > 0.01;
  const origIsRange = origLow !== null && Math.abs(origHigh - origLow) > 0.01;

  let html = `<div class="result-figures">
    <div class="result-figure"><div class="label">USD</div><div class="value">$${fmtMoney(low)}${isRange ? '–$' + fmtMoney(high) : ''}</div></div>`;
  if (origCur !== 'USD' && origLow !== null) {
    html += `<div class="result-figure"><div class="label">${origCur} (original currency)</div><div class="value">${origCur} ${fmtMoney(origLow)}${origIsRange ? '–' + fmtMoney(origHigh) : ''}</div></div>`;
  }
  html += `</div>`;
  html += fxFootnote(origCur);
  return html;
}

function fxFootnote(currency) {
  if (!fxTable) return '';
  const isStatic = fxTable.staticCurrencies && fxTable.staticCurrencies.has(currency);
  if (currency === 'USD') return '';
  if (isStatic) {
    return `<p class="fx-note">Static reference rate used for ${currency} (not covered by the live feed) — verify before quoting.</p>`;
  }
  return `<p class="fx-note">Live rate as of ${fxTable.fetchedAt || 'today'} (ECB reference, via Frankfurter).</p>`;
}

function renderQuoteSummary() {
  const row = state.vendorRow;
  const wrap = document.getElementById('quote-summary');
  showStep('step-quote', true);
  const salary = document.getElementById('salary-input').value;
  const salaryCur = document.getElementById('salary-currency').value;
  const headcount = document.getElementById('headcount-input').value;

  const rowsHtml = FEE_ORDER.map((key) => {
    const fee = row.fees[key];
    const r = computeFee(fee, key, row.serviceType);
    return `<tr><th>${FEE_LABELS[key]}</th><td>${escapeHtml(r.formula)}</td></tr>`;
  }).join('');

  wrap.innerHTML = `
    <table>
      <tr><th>Country</th><td>${escapeHtml(row.country)}</td></tr>
      <tr><th>Service type</th><td>${escapeHtml(row.serviceType)}</td></tr>
      <tr><th>Vendor</th><td>${escapeHtml(row.vendor)}</td></tr>
      ${rowsHtml}
      ${salary ? `<tr><th>Gross salary (input)</th><td>${escapeHtml(salaryCur)} ${escapeHtml(salary)}</td></tr>` : ''}
      ${headcount ? `<tr><th>Headcount (input)</th><td>${escapeHtml(headcount)}</td></tr>` : ''}
      <tr><th>Pricing valid until</th><td>${escapeHtml(row.pricingValidUntil || '—')}</td></tr>
    </table>`;
}

init();
