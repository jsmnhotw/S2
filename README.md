# Slasify Quotation Generator

Internal BD tool: pick Country &rarr; Service Type &rarr; Vendor, and get Slasify's
client-facing price computed from the vendor's raw MPD cost plus the standard
markup rule, with live currency conversion and an "original quotation currency"
toggle.

Static site, no backend, no build step. Open `index.html` (via a local server,
not `file://` &mdash; browsers block `fetch()` of local JSON on the file protocol)
or deploy the folder as-is to Netlify/Vercel/GitHub Pages.

```
python3 -m http.server 8000
# open http://localhost:8000
```

## How it works

1. **Country** &rarr; **Service Type** (Local EOR / Expat EOR &mdash; PEO rows are
   excluded from this tool by design).
2. **Vendor resolution**: Inactive and Poor Quality vendors are excluded
   entirely. If exactly one vendor is flagged "Preferred Vendor" for that
   country + service type, it's auto-selected. If none are, BD picks from a
   dropdown of the remaining vendors. If more than one vendor is flagged
   preferred for the same country + service type (this happens for ~58
   countries in the current MPD), the dropdown narrows to just the tied
   preferred vendors and BD picks between them.
3. **Reference card**: shows the selected vendor's literal quoted terms
   (Service Fee, Setup Fee, Deposit, Termination Fee, VAT, notes) exactly as
   written in the MPD, plus a staleness warning if "Pricing Valid Until" has
   passed or a renewal reminder is outstanding.
4. **Calculator**: BD never types the vendor's price. The tool parses the
   vendor's quoted fee and applies the markup rule automatically, showing the
   formula first (not just a final number) so BD can see how it was derived.
   Gross salary and headcount are the only manual inputs, and only when the
   fee is actually salary-percentage-based or headcount-tiered &mdash; that's
   deal-specific information the MPD can't contain.
5. **Currency**: the total is shown in USD and, side by side, converted back
   into the vendor's original quotation currency (best practice is to quote
   the client in the currency they were originally quoted in).

## The markup rule

- **Service Fee**: vendor's fee + USD 150&ndash;250 (Local EOR) or + USD
  250&ndash;350 (Expat EOR). If the vendor charges a percentage of salary/TEC,
  the percentage is a pass-through (not marked up) and the USD range is
  appended as an additive term.
- **Setup Fee / Termination Fee**: if the vendor charges something, add a
  flat single number: +USD 150 (Local) / +USD 250 (Expat). If the vendor
  charges nothing, it's a standalone USD 0&ndash;150 (Local) / USD 0&ndash;250
  (Expat) range.
- **Deposit**: no markup, and shown as a plain description (never a dollar
  figure) &mdash; e.g. "2 months gross salary", "1 month TEC". Slasify policy
  requires quoting at least 1 month regardless of what the vendor asks for,
  so the vendor's own wording is preserved verbatim whenever it already
  meets that minimum; only when it's below 1 month (or the vendor requires
  no deposit at all) does the tool substitute a "1 month [basis]" floor
  description in its place.
- **VAT**: informational only, shown verbatim as entered in the MPD, with no
  computation applied &mdash; on the vendor reference card, in the finalize
  step, and in the client PDF.
- Secondary/incidental fees mentioned alongside a primary fee (reimbursement,
  wet-signing, out-of-cycle, etc.) get a small USD 0&ndash;10 margin.

This is implemented twice, deliberately: deterministically in
`js/markup.js` for cleanly-structured vendor fees (flat amounts, ranges,
plain percentages, percent-with-floor), and once, offline, via an LLM pass
for the ~15% of vendor fee cells that are messy free text (tiered by
headcount/salary band, "X or Y%, whichever greater", multi-line conditional
clauses). The LLM's job there is only to apply this exact rule to unstructured
text and preserve the original structure &mdash; see `data/llm_transformed.json`,
where every row keeps the original vendor text (`raw`) next to the computed
`slasifyFormula` for audit.

## Data pipeline (re-run when the MPD sheet changes)

The MPD lives in a Google Sheet ("quotation generator"). To refresh:

1. Export the main pricing tab as CSV, save it over `data/mpd_source.csv`.
2. `python3 scripts/build_dataset.py` &mdash; parses every vendor fee cell into
   structured data where possible, and writes any new/changed messy cells
   (that don't match a known clean pattern) to `data/llm_queue.json`.
3. If `llm_queue.json` contains entries not already present in
   `data/llm_transformed.json`, those need an LLM pass applying the markup
   rule above (see the prompt/rules in this README's "markup rule" section
   for what to hand to the model) &mdash; append the results to
   `data/llm_transformed.json` in the same `{raw, feeKey, serviceType,
   slasifyFormula, requiresInput}` shape.
4. `python3 scripts/merge_dataset.py` &mdash; merges everything into
   `data/mpd.json`, which is what the front-end actually loads.

## Known limitations (v1)

- FX rates come from [Frankfurter](https://frankfurter.dev) (ECB reference
  rates, no API key, updated daily). A handful of currencies in the MPD
  aren't covered by Frankfurter (Gulf-pegged currencies, MMK, EGP) &mdash; those
  fall back to a static approximate rate hardcoded in `js/fx.js`, clearly
  labeled in the UI as "static reference rate" so BD knows to double-check
  before quoting a client in one of those.
- Vendor rows marked "Poor Quality Vendor" or "Inactive" are excluded
  entirely, not just deprioritized.
- PEO rows are out of scope for this tool (only 12 rows in the current MPD,
  all Local South/Central America PEO partners).
- A small number of vendor fee cells (~40 across the dataset) have no usable
  data at all ("TBC" or truly free-form text an LLM pass couldn't cleanly
  structure) &mdash; the tool shows these as "not yet confirmed" rather than
  guessing.
