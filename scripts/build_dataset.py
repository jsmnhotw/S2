import csv, re, json, sys
from collections import defaultdict

import os
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)

CSV_PATH = sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPO_ROOT, 'data', 'mpd_source.csv')
OUT_ROWS = os.path.join(REPO_ROOT, 'data', 'rows_parsed.json')
OUT_QUEUE = os.path.join(REPO_ROOT, 'data', 'llm_queue.json')

with open(CSV_PATH, newline='', encoding='utf-8') as f:
    reader = csv.reader(f)
    rows = list(reader)

header = rows[1]
data = rows[2:]
idx = {name.strip(): i for i, name in enumerate(header)}

FEE_COLS = {
    'serviceFee': 12, 'setupFee': 13, 'deposit': 14, 'terminationFee': 15,
}
VAT_COL = 16
NOTE_COL = 17

CUR = r'(USD|EUR|GBP|SAR|BD|BHD|INR|JPY|AUD|HKD|PLN|CAD|AED|QAR|THB|MMK|PHP|IDR|EGP|KWD|CNY|TRY|LKR|NZD|SGD|CZK|MYR|NOK|OMR|CHF)'

def clean_num(s):
    return float(s.replace(',', ''))

def norm_cur(c):
    return c.upper().replace('BD', 'BHD')

BASIS_PATTERNS = [
    (r'\bTEC\b', 'TEC'),
    (r'\bCTC\b', 'CTC'),
    (r'total\s+employment\s+cost', 'TEC'),
    (r'gross\s+salary', 'Gross Salary'),
    (r'\bemployee\s+cost\b', 'Employee Cost'),
]

def extract_basis(text):
    """Preserve the vendor's stated basis (TEC/CTC/gross salary) instead of assuming one.
    Returns None if the vendor didn't state a basis at all (caller then defaults display-side)."""
    for pattern, label in BASIS_PATTERNS:
        if re.search(pattern, text, re.I):
            return label
    return None

def try_parse(raw):
    s = raw.strip()
    if not s or s.upper() in ('N/A', 'NONE', 'NA'):
        return {'kind': 'none'}
    if s.upper() in ('TBC', 'TBD', 'TO BE CONFIRMED'):
        return {'kind': 'unknown'}

    first_line = s.split('\n')[0].strip().rstrip('.').strip()
    rest = '\n'.join(s.split('\n')[1:]).strip()

    m = re.fullmatch(CUR + r'\s*([\d,]+(?:\.\d+)?)', first_line)
    if m:
        return {'kind': 'flat', 'currency': norm_cur(m.group(1)), 'amount': clean_num(m.group(2)), 'note': rest or None}

    m = re.fullmatch(CUR + r'\s*([\d,]+(?:\.\d+)?)\s*-\s*([\d,]+(?:\.\d+)?)', first_line)
    if m:
        return {'kind': 'range', 'currency': norm_cur(m.group(1)), 'low': clean_num(m.group(2)), 'high': clean_num(m.group(3)), 'note': rest or None}

    m = re.search(r':\s*' + CUR + r'\s*([\d,]+(?:\.\d+)?)\s*(?:-\s*([\d,]+(?:\.\d+)?))?\s*$', first_line)
    if m and len(first_line) < 120:
        label = first_line[:m.start()].rstrip(': ').strip()
        if m.group(3):
            return {'kind': 'range', 'currency': norm_cur(m.group(1)), 'low': clean_num(m.group(2)), 'high': clean_num(m.group(3)), 'label': label, 'note': rest or None}
        return {'kind': 'flat', 'currency': norm_cur(m.group(1)), 'amount': clean_num(m.group(2)), 'label': label, 'note': rest or None}

    m = re.fullmatch(r'(\d+(?:\.\d+)?)\s*%', first_line)
    if m:
        return {'kind': 'percent', 'pct': float(m.group(1)), 'basis': extract_basis(first_line), 'note': rest or None}

    m = re.search(r'(\d+(?:\.\d+)?)\s*%.*?min(?:imum)?\.?\s*' + CUR + r'\s*([\d,]+(?:\.\d+)?)', first_line, re.I)
    if m and len(first_line) < 150:
        return {'kind': 'percent_min', 'pct': float(m.group(1)), 'basis': extract_basis(first_line), 'min_currency': norm_cur(m.group(2)), 'min_amount': clean_num(m.group(3)), 'raw_context': first_line, 'note': rest or None}

    m = re.fullmatch(r'(\d+(?:\.\d+)?)\s*months?(?:\s+(?:gross\s+)?salary)?(?:\s*\+\s*service\s*fee)?\.?', first_line, re.I)
    if m:
        return {'kind': 'months_salary', 'months': float(m.group(1)), 'note': rest or None}
    m = re.fullmatch(r'(\d+(?:\.\d+)?)\s*x\s*monthly.*', first_line, re.I)
    if m:
        return {'kind': 'months_salary', 'months': float(m.group(1)), 'note': first_line}
    m = re.match(r'(\d+(?:\.\d+)?)[\s-]*months?\b\.?\s*(.*)', first_line, re.I)
    if m:
        return {'kind': 'months_salary', 'months': float(m.group(1)), 'note': (m.group(2).strip() or None)}
    m = re.fullmatch(CUR + r'\s*([\d,]+(?:\.\d+)?)\s*/\s*EE\.?', first_line, re.I)
    if m:
        return {'kind': 'flat', 'currency': norm_cur(m.group(1)), 'amount': clean_num(m.group(2)), 'note': 'per employee'}

    return {'kind': 'needs_llm', 'raw': s}


EXCLUDE_PREF = {'Poor Quality Vendor', 'Inactive'}

out_rows = []
llm_queue = {}  # key: (raw, feeKey, serviceType) -> queue entry

for r in data:
    if len(r) < len(header):
        r = r + [''] * (len(header) - len(r))
    stype = r[idx['Service Type']].strip()
    if stype not in ('Local EOR', 'Expat EOR'):
        continue  # exclude PEO
    pref = r[idx['Preference']].strip()
    if pref in EXCLUDE_PREF:
        continue  # exclude Poor Quality / Inactive

    row = {
        'continent': r[idx['Continent']].strip(),
        'country': r[idx['Country']].strip(),
        'vendor': r[idx['Vendor Name']].strip(),
        'preference': pref or None,
        'serviceType': stype,
        'fees': {},
        'vat': r[VAT_COL].strip() or None,
        'note': r[NOTE_COL].strip() or None,
        'pricingValidUntil': r[idx['Pricing Valid Until']].strip() or None,
        'renewalStatus': r[idx['Renewal Status']].strip() or None,
        'entityRelationship': r[idx['Entity Relationship']].strip() or None,
    }
    for fee_key, col in FEE_COLS.items():
        raw = r[col]
        parsed = try_parse(raw)
        parsed['raw'] = raw.strip() or None
        row['fees'][fee_key] = parsed
        if parsed['kind'] == 'needs_llm':
            qkey = (parsed['raw'], fee_key, stype)
            if qkey not in llm_queue:
                llm_queue[qkey] = {'raw': parsed['raw'], 'feeKey': fee_key, 'serviceType': stype, 'examples': []}
            llm_queue[qkey]['examples'].append({'country': row['country'], 'vendor': row['vendor']})
    out_rows.append(row)

with open(OUT_ROWS, 'w') as f:
    json.dump(out_rows, f, indent=1)

queue_list = list(llm_queue.values())
with open(OUT_QUEUE, 'w') as f:
    json.dump(queue_list, f, indent=1)

print(f"Total rows kept: {len(out_rows)}")
print(f"Unique messy (raw, feeKey, serviceType) combos needing LLM: {len(queue_list)}")
by_fee = defaultdict(int)
for q in queue_list:
    by_fee[q['feeKey']] += 1
for k,v in by_fee.items():
    print(f"  {k}: {v}")
