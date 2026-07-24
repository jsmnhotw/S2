import json

import os
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)

ROWS_PATH = os.path.join(REPO_ROOT, 'data', 'rows_parsed.json')
LLM_PATH = os.path.join(REPO_ROOT, 'data', 'llm_transformed.json')
OUT_PATH = os.path.join(REPO_ROOT, 'data', 'mpd.json')

rows = json.load(open(ROWS_PATH))
llm_results = json.load(open(LLM_PATH))

lookup = {}
for item in llm_results:
    key = (item['raw'], item['feeKey'], item['serviceType'])
    lookup[key] = item

missing = 0
for row in rows:
    for fee_key, fee in row['fees'].items():
        if fee.get('kind') == 'needs_llm':
            key = (fee['raw'], fee_key, row['serviceType'])
            item = lookup.get(key)
            if item is None:
                missing += 1
                fee['kind'] = 'unknown'  # safe fallback: show as TBC-style rather than crash
                continue
            fee['kind'] = 'llm'
            fee['slasifyFormula'] = item['slasifyFormula']
            fee['requiresInput'] = item.get('requiresInput', [])

if missing:
    print(f"WARNING: {missing} fee cells had no matching LLM result — fell back to 'unknown'.")

with open(OUT_PATH, 'w') as f:
    json.dump(rows, f, indent=1)

print(f"Wrote {OUT_PATH} with {len(rows)} rows.")
