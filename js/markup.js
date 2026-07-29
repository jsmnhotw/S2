// Deterministic markup engine — applies Slasify's fixed pricing rule to a parsed vendor fee.
// Rule (confirmed by BD lead, 2026-07):
//   Service Fee:      vendor amount + USD 150-250 (Local EOR) / + USD 250-350 (Expat EOR)
//   Setup/Term. Fee:  vendor charges something -> + USD 150 flat (Local) / + USD 250 flat (Expat)
//                     vendor charges nothing    -> standalone USD 0-150 (Local) / USD 0-250 (Expat)
//   Deposit:          pass-through, no markup
//   Messy/free-text fees were pre-transformed offline by an LLM following the same rule
//   (kind "llm"), so this engine just displays that precomputed formula for those rows.

const SERVICE_MARGIN = { 'Local EOR': [150, 250], 'Expat EOR': [250, 350] };
const FLAT_MARGIN = { 'Local EOR': 150, 'Expat EOR': 250 };

function fmtMoney(n) {
  if (n === null || n === undefined || isNaN(n)) return '';
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

// Quotes are rounded up to the nearest 5 (e.g. 452 -> 455) so BD always quotes a clean number.
function roundUpTo5(n) {
  if (n === null || n === undefined || isNaN(n)) return n;
  return Math.ceil(n / 5) * 5;
}

function computeServiceFee(fee, serviceType) {
  const [mLow, mHigh] = SERVICE_MARGIN[serviceType];
  switch (fee.kind) {
    case 'flat':
    case 'none': {
      const amt = fee.kind === 'none' ? 0 : fee.amount;
      const cur = fee.kind === 'none' ? 'USD' : fee.currency;
      return {
        formula: `${cur} ${fmtMoney(amt)} + USD ${mLow}-${mHigh}`,
        requiresInput: [],
        vendorAmount: { currency: cur, low: amt, high: amt },
        marginLow: mLow, marginHigh: mHigh,
      };
    }
    case 'range':
      return {
        formula: `${fee.currency} ${fmtMoney(fee.low)}-${fmtMoney(fee.high)} + USD ${mLow}-${mHigh}`,
        requiresInput: [],
        vendorAmount: { currency: fee.currency, low: fee.low, high: fee.high },
        marginLow: mLow, marginHigh: mHigh,
      };
    case 'percent': {
      const basis = fee.basis || 'Gross Salary';
      return {
        formula: `${fee.pct}% of ${basis} + USD ${mLow}-${mHigh}`,
        requiresInput: ['grossSalary'],
        pct: fee.pct, marginLow: mLow, marginHigh: mHigh,
      };
    }
    case 'percent_min': {
      const basis = fee.basis || 'Gross Salary';
      return {
        formula: `${fee.pct}% of ${basis} (min ${fee.min_currency} ${fmtMoney(fee.min_amount)}) + USD ${mLow}-${mHigh}`,
        requiresInput: ['grossSalary'],
        pct: fee.pct, minCurrency: fee.min_currency, minAmount: fee.min_amount, marginLow: mLow, marginHigh: mHigh,
      };
    }
    case 'unknown':
      return { formula: 'Vendor fee not yet confirmed (TBC) — cannot calculate.', requiresInput: [], uncalculable: true };
    case 'llm':
      return { formula: fee.slasifyFormula, requiresInput: fee.requiresInput || [], isLlmDerived: true };
    default:
      return { formula: fee.raw || 'Unrecognized fee format.', requiresInput: [], uncalculable: true };
  }
}

function computeFlatMarginFee(fee, serviceType) {
  const add = FLAT_MARGIN[serviceType];
  switch (fee.kind) {
    case 'none':
      return { formula: `USD 0-${add}`, requiresInput: [], currency: 'USD', computedLow: 0, computedHigh: add };
    case 'flat':
      return {
        formula: `${fee.currency} ${fmtMoney(fee.amount + add)}`,
        requiresInput: [],
        vendorAmount: { currency: fee.currency, amount: fee.amount },
        currency: fee.currency, computedFlat: fee.amount + add,
      };
    case 'range':
      return {
        formula: `${fee.currency} ${fmtMoney(fee.low + add)}-${fmtMoney(fee.high + add)}`,
        requiresInput: [],
        currency: fee.currency, computedLow: fee.low + add, computedHigh: fee.high + add,
      };
    case 'unknown':
      return { formula: 'Vendor fee not yet confirmed (TBC) — cannot calculate.', requiresInput: [], uncalculable: true };
    case 'llm':
      return { formula: fee.slasifyFormula, requiresInput: fee.requiresInput || [], isLlmDerived: true };
    default:
      return { formula: fee.raw || 'Unrecognized fee format.', requiresInput: [], uncalculable: true };
  }
}

const DEPOSIT_BASIS_PATTERNS = [
  [/\bTEC\b/i, 'TEC'],
  [/\bCTC\b/i, 'CTC'],
  [/total\s+employment\s+cost/i, 'TEC'],
  [/gross\s+salary/i, 'gross salary'],
  [/\bemployment\s+cost\b/i, 'employment cost'],
  [/\binvoice\b/i, 'invoice'],
  [/\bsalary\b/i, 'salary'],
];
function extractDepositBasis(text) {
  if (!text) return null;
  for (const [pattern, label] of DEPOSIT_BASIS_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return null;
}

// Deposit is a plain description, never a dollar figure - it carries no markup, and
// Slasify policy requires quoting at least 1 month regardless of what the vendor itself
// asks for. Vendor's own wording (fee.raw) is preserved verbatim whenever it already meets
// that minimum; only when it's below 1 month or unspecified do we substitute a minimum
// description. `wasBumped`/`vendorRaw` are for internal reference only (see app.js) - the
// client-facing `formula` string never mentions the vendor's original term.
function computeDeposit(fee) {
  switch (fee.kind) {
    case 'months_salary':
      if (fee.months >= 1) {
        return { formula: fee.raw, requiresInput: [] };
      }
      return {
        formula: `1 month ${extractDepositBasis(fee.note) || 'salary'}`,
        requiresInput: [], wasBumped: true, vendorRaw: fee.raw,
      };
    case 'none':
      return { formula: '1 month salary', requiresInput: [], wasBumped: true, vendorRaw: 'No deposit required.' };
    case 'flat':
      return { formula: fee.raw, requiresInput: [] };
    case 'percent':
      return { formula: fee.raw, requiresInput: [] };
    case 'unknown':
      return { formula: 'Deposit terms not yet confirmed (TBC).', requiresInput: [], uncalculable: true };
    case 'llm':
      return { formula: fee.slasifyFormula, requiresInput: [], isLlmDerived: true };
    default:
      return { formula: fee.raw || fee.kind, requiresInput: [] };
  }
}

// Entry point used by app.js
function computeFee(fee, feeKey, serviceType) {
  if (!fee) return { formula: 'No data on file for this vendor/fee.', requiresInput: [], uncalculable: true };
  if (feeKey === 'serviceFee') return computeServiceFee(fee, serviceType);
  if (feeKey === 'setupFee' || feeKey === 'terminationFee') return computeFlatMarginFee(fee, serviceType);
  if (feeKey === 'deposit') return computeDeposit(fee);
  throw new Error('Unknown feeKey ' + feeKey);
}
