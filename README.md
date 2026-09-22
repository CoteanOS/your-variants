# yourvariants

A client-side DNA variant viewer. Drop in a raw genotype file (23andMe or
AncestryDNA), and it matches your variants against a ClinVar-derived database,
shows what public databases record for each match, groups them by condition
area, and can explain any variant (or answer plain-English trait questions)
using an AI model.

**Everything runs in your browser.** The file is read locally, the database is
downloaded once and queried on your machine, and your genotype never leaves the
device. There is no backend that sees your data.

This is a personal / portfolio project, not a service. It is informational
only, not a medical test or a diagnosis. ClinVar itself is not intended for
diagnostic use without review by a genetics professional, and consumer
genotyping arrays are not clinically validated. Confirm anything meaningful
with a clinician.

---

## How it works, end to end

```
  raw DNA file
       |  (read locally with the File API, never uploaded)
       v
  Pyodide  --------------  Python running inside the browser
       |  parses the file into rsIDs + genotypes           (public/variant_logic.py)
       v
  SQLite-WASM over OPFS  -  a database engine in a browser worker
       |  matches your rsIDs against the ClinVar database  (src/clinvarWorker.js)
       v
  Pyodide again
       |  works out zygosity (0/1/2 copies) + strand flips (public/variant_logic.py)
       v
  React UI  -------------  the interface you see           (src/App.jsx)
       |  list . dashboard . filters . ClinVar links . xlsx export
       v
  AI features (optional)   "Explain with Sofia" and "Ask your genome"
       |  send only PUBLIC variant facts, never your genotype
       v
  Gemini API              (the API key stays server-side, never in the browser)
```

The whole database is downloaded once and queried locally rather than fetched
piece by piece per lookup. That is deliberate: a per-lookup approach would leak
which variants were looked up through server access logs, defeating the privacy
goal.

---

## The parts (what each file does)

### Interface
- **`index.html` + `src/main.jsx`** - the page entry point; boilerplate that
  loads the app.
- **`src/App.jsx`** - the whole UI and the conductor: the file drop zone, the
  results list, the condition-area dashboard, the filters, and the AI buttons.
  It calls every other piece and displays what they return.

### Reading and interpreting the DNA file (Python in the browser)
- **`src/pyengine.js`** - starts Pyodide (CPython compiled to WebAssembly) and
  is the bridge between the JavaScript UI and the Python logic.
- **`public/variant_logic.py`** - the genetics logic. Parses 23andMe/Ancestry
  files (tab- or comma-delimited) into rsIDs + genotypes, and classifies each
  matched variant's zygosity, including a strand-flip check so genotype calls
  reported on the opposite DNA strand still line up with ClinVar's alleles.
- **`public/test_variant_logic.py`** - tests for the parsing and zygosity
  logic. Run with `npm run test:py`.

### Matching against ClinVar (a database in the browser)
- **`src/clinvarWorker.js`** - runs SQLite (via `@sqlite.org/sqlite-wasm`) in a
  Web Worker over OPFS (browser-local storage). Downloads the DB once, caches
  it, opens it read-only, and matches all your rsIDs in one query. It also
  reads the DB's `meta` table (release date, row count) for display.
- **`src/clinvarClient.js`** - the thin message-passing layer between the UI
  and that worker.

### Turning matches into results (pure helpers)
- **`src/variantUtils.js`** - UI-free logic: significance colours, mapping
  ClinVar review status to a 0-4 star confidence tier, grouping variants into
  clinical condition areas (the dashboard), and building ClinVar/dbSNP links.
  Kept separate so it can be unit-tested.
- **`src/variantUtils.test.js`** - unit tests for those helpers. Run with
  `npm test`.

### AI features (Sofia)
- **`src/explainVariant.js`** - builds the "Explain with Sofia" request. It
  sends only public facts about the variant (rsID, gene, ClinVar
  classification, condition, frequency), never the genotype, zygosity, or file.
  The model explains the variant, not the person.
- **`src/askTrait.js`** - the trait-question agent. Takes a plain-English
  question ("am I lactose tolerant?"), resolves it to the relevant rsID(s) via
  a curated map, filters your own variants to those rsIDs, reads the genotype
  (strand-flip aware), and asks the model to phrase a calibrated answer. Only
  the single trait's data is sent, never the whole genome.
- **`src/TraitChat.jsx`** - the chat-box UI for the trait agent.
- **`public/traits.json`** - the curated knowledge base of well-known
  single-marker traits (lactose, caffeine, alcohol flush, bitter taste, earwax,
  muscle type). Grow it by adding entries.
- **`vite.config.js`** - besides the normal Vite config, it contains a small
  local proxy. Your API key lives in `.env.local` (git-ignored) and is read
  here, server-side; the browser never sees it. The proxy forwards to Gemini,
  retries transient overloads, and times out cleanly.

### Building the database (offline, run occasionally)
- **`build_clinvar_db.py`** - downloads NCBI's ClinVar dump and reduces it to
  the compact `clinvar.sqlite` the app uses.
- **`add_gnomad.py`** - optionally enriches that DB with gnomAD population
  allele frequencies (how common each variant is).

---

## Features

**Input and parsing**
- Drag-and-drop or click-to-choose file input; read entirely on-device.
- 23andMe and AncestryDNA raw formats; tab- or comma-delimited.
- Zygosity classification (heterozygous, homozygous, reference, no-call, etc.),
  with strand-aware matching.

**Results**
- Header shows the loaded database's ClinVar release date and record count.
- Summary counters: variants in file, matched in ClinVar, carried, carried with
  a meaningful classification, pathogenic.
- Per-variant cards: gene, rsID (linked to its ClinVar/dbSNP record so you can
  verify at the source), significance, variant name, ref/alt with base
  colouring, your genotype, zygosity, conditions, gnomAD frequency (if present),
  and a 0-4 star confidence tier reflecting ClinVar's review status.

**Dashboard (condition areas)**
- Matched variants are grouped into clinical areas (cancer, cardiac, metabolic,
  neurological, pharmacogenomic, etc.), parsed offline from ClinVar's own
  condition text. Each area shows a count and bar; click one to filter the list.
  It organises your matches; it is not a ranking of importance.

**AI: Explain with Sofia**
- A button on each variant asks a cloud model for a plain, calibrated
  explanation: what the gene does, what the classification means, penetrance
  context, and the array-reliability caveat. Privacy-preserving: only public
  variant facts are sent, never your genotype.

**AI: Ask your genome**
- A chat box that answers plain-English trait questions ("am I lactose
  tolerant?", "do I metabolize caffeine fast?"). It maps the question to the
  relevant marker(s), reads your genotype for just those, and answers. If a
  marker isn't in your file it says so rather than guessing.

**Filtering and export**
- Filter by confidence (minimum star tier) and by significance category.
- Toggle homozygous-only; hide 0-star (no-criteria) entries, on by default.
- The list renders up to 300 cards for performance; export always uses the full
  filtered set.
- Export to `.xlsx` (SheetJS, loaded on demand).

---

## Running it

```bash
npm install      # once per copy of the project (creates node_modules)
npm run dev      # start the dev server; open the printed localhost URL
npm run build    # production build to dist/
```

You need `public/clinvar.sqlite` present for matching to work (see below). At
runtime the app also loads Pyodide, and (only on export) SheetJS, from CDNs;
fonts come from Google Fonts. Your genotype and variant data never leave the
browser; those requests fetch code and fonts, not your data.

> `npm install` is a one-time step per copy. After that, just `npm run dev`.
> You only re-run `npm install` for a fresh copy, or when dependencies change.

### Building the ClinVar database

The app loads `clinvar.sqlite` from the site root (`public/clinvar.sqlite`).

```bash
# download the latest ClinVar dump and build a GRCh38 DB
python build_clinvar_db.py --download --output public/clinvar.sqlite \
    --release-date 2026-05-28

# or build from a dump you already have
python build_clinvar_db.py --input variant_summary.txt.gz \
    --output public/clinvar.sqlite
```

Flags: `--assembly GRCh38|GRCh37|all`, `--significance all|signal|pathogenic`,
`--release-date YYYY-MM-DD`, `--page-size N`, `--download`.

The DB is a large generated artifact and is **not** committed to the repo.

### Adding gnomAD frequencies (optional)

```bash
python add_gnomad.py --db public/clinvar.sqlite --freqs gnomad_af.tsv --release v4.1
```

Expects a pre-reduced `rsid<TAB>af` table (the script header documents the
bcftools recipe to produce it from gnomAD's VCFs). The app shows the frequency
when present and works unchanged when it isn't.

### Enabling the AI features (optional, bring your own key)

The AI features use Google's Gemini API. Get a free key at
<https://aistudio.google.com/apikey>, then:

```bash
cp .env.local.example .env.local     # then edit .env.local and paste your key
```

`.env.local` holds `GEMINI_API_KEY=...`. It is git-ignored: your key is never
committed and never shipped to anyone who clones this repo, and it is read only
server-side by the dev server, so the browser never sees it. Without a key the
app runs normally; only the AI buttons are disabled. Even with a key, requests
contain only public variant facts, never your genotype.

> The proxy that holds the key lives in the Vite **dev** server. A production
> build is static files with no server, so deploying publicly would need a real
> backend endpoint (e.g. a serverless function) to hold the key. For local use
> the dev server is all you need.

If Gemini returns "model no longer available", update `GEMINI_MODEL` at the top
of `vite.config.js` to a current model id from
<https://ai.google.dev/gemini-api/docs/models>. That one line is the only change.

---

## Tests

```bash
npm test           # JS: star tiers, category mapping, condition clustering, links
npm run test:py    # Python: parsing (TSV/CSV/Ancestry), zygosity, strand flips
```

---

## Stack

React 19, Vite, `@sqlite.org/sqlite-wasm` (OPFS), Pyodide, SheetJS, Google
Gemini (optional). Data from NCBI ClinVar and gnomAD.

## Notes

- 23andMe/AncestryDNA raw calls are for research and educational use and are not
  individually validated for accuracy at every marker. Array calls can be wrong;
  each rsID links to its ClinVar/dbSNP record to verify.
- This repo intentionally contains no genetic data of any kind.
