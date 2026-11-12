# yourvariants

A client-side DNA variant viewer. Drop in a raw genotype file (23andMe or
AncestryDNA), and it matches your variants against a ClinVar-derived database,
shows what public databases record for each match, groups them by condition
area, and can explain any variant (or answer plain-English trait questions)
using an AI model.

**Everything runs in your browser.** The file is read locally, the database is
downloaded once and queried on your machine, and your genotype never leaves the
device. There is no backend that sees your data.

This is a personal portfolio project, not a service. It is informational
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
       |  Explain sends public variant facts only; a trait question also
       |  sends your genotype at that trait's few markers, nothing else
       v
  Gemini API              (the API key stays server-side, never in the browser)
```

The whole database is downloaded once and queried locally. Looking up variants
one by one on a server would show that server which variants you have, through
its access logs.

---

## The parts (what each file does)

### Interface
- **`index.html` + `src/main.jsx`**: the page entry point that loads the app.
- **`src/App.jsx`**: the whole UI: the file drop zone, the results list, the
  condition-area dashboard, the filters, and the AI buttons. It calls every
  other file and displays what they return.

### Reading and interpreting the DNA file (Python in the browser)
- **`src/pyengine.js`**: starts Pyodide (CPython compiled to WebAssembly) and
  passes data between the JavaScript UI and the Python logic.
- **`public/variant_logic.py`**: the genetics logic. Parses 23andMe/Ancestry
  files (tab- or comma-delimited) into rsIDs + genotypes, and classifies each
  matched variant's zygosity, including a strand-flip check so genotype calls
  reported on the opposite DNA strand still line up with ClinVar's alleles.
- **`public/test_variant_logic.py`**: tests for the parsing and zygosity
  logic. Run with `npm run test:py`.

### Matching against ClinVar (a database in the browser)
- **`src/clinvarWorker.js`**: runs SQLite (via `@sqlite.org/sqlite-wasm`) in a
  Web Worker over OPFS (browser-local storage). Downloads the DB once, caches
  it, opens it read-only, and matches all your rsIDs in one query. It also
  reads the DB's `meta` table (release date, row count) for display.
- **`src/clinvarClient.js`**: passes messages between the UI and that worker.

### Turning matches into results (pure helpers)
- **`src/variantUtils.js`**: logic with no UI code: significance colours, mapping
  ClinVar review status to a 0-4 star confidence tier, grouping variants into
  clinical condition areas (the dashboard), and building ClinVar/dbSNP links.
  Kept separate so it can be unit-tested.
- **`src/variantUtils.test.js`**: unit tests for those helpers. Run with
  `npm test`.

### AI features (Sofia)
- **`src/explainVariant.js`**: builds the "Explain with Sofia" request. It
  sends only public facts about the variant (rsID, gene, ClinVar
  classification, condition, frequency), never the genotype, zygosity, or file.
- **`src/askTrait.js`**: the trait-question agent. Takes a plain-English
  question ("am I lactose tolerant?"), resolves it to the relevant rsID(s) via
  a curated map, filters your own variants to those rsIDs, reads the genotype
  (with a strand-flip check), and asks the model to write the answer. This
  request does include your genotype, but only at the few markers of the trait
  you asked about. The rest of the genome is never sent.
- **`src/TraitChat.jsx`**: the chat-box UI for the trait agent.
- **`public/traits.json`**: the list of supported traits
  (lactose, caffeine, alcohol flush, bitter taste, earwax, muscle type,
  warfarin sensitivity, Factor V Leiden). Genotype keys are written on the
  forward strand, the way chips report them. Add entries to support more traits.
- **`vite.config.js`**: besides the normal Vite config, it contains a small
  local proxy. Your API key lives in `.env.local` (git-ignored) and is read
  here, server-side. The browser never sees it. The proxy forwards to Gemini,
  retries when Gemini is overloaded, and falls back to a lighter model if the
  main one stays busy.

### Building the database (offline, run occasionally)
- **`build_clinvar_db.py`**: downloads NCBI's ClinVar dump and reduces it to
  the compact `clinvar.sqlite` the app uses.
- **`add_gnomad.py`**: optionally enriches that DB with gnomAD population
  allele frequencies (how common each variant is).

---

## Features

**Input and parsing**
- Drag and drop a file or click to choose one. It is read on your device.
- 23andMe and AncestryDNA raw formats, tab- or comma-delimited.
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
  condition text. Each area shows a count and bar. Click one to filter the list.
  The areas organise your matches. They are not a ranking of importance.

**AI: Explain with Sofia**
- A button on each variant asks a cloud model to explain it in plain
  language: what the gene does, what the classification means, how often
  carriers are actually affected, and how reliable array calls are. Only public
  variant facts are sent, never your genotype.

**AI: Ask your genome**
- A chat box that answers plain-English trait questions ("am I lactose
  tolerant?", "do I metabolize caffeine fast?"). It maps the question to the
  relevant marker(s), reads your genotype for just those, and answers. If a
  marker isn't in your file it says so. Your genotype at those markers is sent
  to the model. Nothing is sent until you ask a question.

**Filtering and export**
- Filter by confidence (minimum star tier) and by significance category.
- Toggle homozygous-only. Hide 0-star (no-criteria) entries, on by default.
- The list renders up to 300 cards to stay fast. Export always uses the full
  filtered set.
- Export to `.xlsx` (SheetJS, loaded on demand).

---

## Running it

```bash
npm install      # once per copy of the project (creates node_modules)
npm run dev      # start the dev server, then open the printed localhost URL
npm run build    # production build to dist/
```

You need `public/clinvar.sqlite` present for matching to work (see below). At
runtime the app also loads Pyodide, and (only on export) SheetJS, from CDNs.
Fonts come from Google Fonts. Those requests fetch code and fonts. They do not
send your genotype or variant data.

Run `npm install` once per copy of the project, and again when dependencies
change.

### Building the ClinVar database

The app loads `clinvar.sqlite` from the site root (`public/clinvar.sqlite`).

```bash
# download the latest ClinVar dump and build a GRCh38 DB
python3 build_clinvar_db.py --download --output public/clinvar.sqlite \
    --release-date 2026-05-28

# or build from a dump you already have
python3 build_clinvar_db.py --input variant_summary.txt.gz \
    --output public/clinvar.sqlite
```

Flags: `--assembly GRCh38|GRCh37|all`, `--significance all|signal|pathogenic`,
`--release-date YYYY-MM-DD`, `--page-size N`, `--download`, `--lean` (skips
records with no rsID and builds only the rsID index, for a smaller file).

The database is large and generated, so it is not committed to the repo.

### Adding gnomAD frequencies (optional)

```bash
python3 add_gnomad.py --db public/clinvar.sqlite --freqs gnomad_af.tsv --release v4.1
```

Expects a pre-reduced `rsid<TAB>af` table (the script header documents the
bcftools recipe to produce it from gnomAD's VCFs). The app shows the frequency
when present and works the same without it.

### Enabling the AI features (optional, bring your own key)

The AI features use Google's Gemini API. Get a free key at
<https://aistudio.google.com/apikey>, then:

```bash
cp .env.local.example .env.local     # then edit .env.local and paste your key
```

`.env.local` holds `GEMINI_API_KEY=...`. It is git-ignored, so your key is never
committed. Only the dev server reads it, so the browser never sees it. Without
a key the app runs normally and only the AI features fail. With a key, Explain sends
only public variant facts. A trait question also sends your genotype at the
markers for that one trait. Nothing else from your file leaves the machine.

> The proxy that holds the key lives in the Vite **dev** server. A production
> build is static files with no server, so deploying publicly would need a
> backend endpoint (for example a serverless function) to hold the key. For
> local use the dev server is enough.

If Gemini returns "model no longer available", update `GEMINI_MODEL` at the top
of `vite.config.js` to a current model id from
<https://ai.google.dev/gemini-api/docs/models>. The desktop app has the same
setting at the top of `src-tauri/src/lib.rs`.

---

## Desktop app

The same app also runs as a desktop program for macOS, built with Tauri. The interface is the same React code. A small Rust layer replaces the parts that needed a dev server or browser storage.

What is different from the web version:

- The ClinVar database is not bundled. On first launch the app downloads it once (about 116 MB) from this repo's GitHub Releases, unpacks it into the app's data folder, and queries it natively from Rust. Later launches start straight away.
- The Gemini key is stored in the operating system keychain, not in a file. Click "Set AI key" in the header and paste your own key.
- AI requests go from the Rust side directly to Gemini. There is no proxy and no server.
- Links to NCBI open in your normal browser.
- Pyodide still loads from its CDN, so the first launch needs an internet connection.

Your DNA file is read locally, exactly as in the web version. The download on first launch fetches the database only.

### Build it yourself

You need Node, Rust (install with rustup) and the Xcode command line tools.

```bash
git clone https://github.com/CoteanOS/your-variants.git
cd your-variants
git checkout desktop
npm install
npx tauri dev
```

`npx tauri dev` runs the app in development mode. `npx tauri build` produces the installer under `src-tauri/target/release/bundle/dmg/`.

The build is not signed. macOS will warn that the developer is unidentified. Right-click the app and choose Open the first time. macOS also asks once per launch for permission to read the saved key from the keychain. Choose Always Allow to stop the prompt for that build.

### Where the desktop code lives

- `src-tauri/src/lib.rs`: key storage, the Gemini request, opening links.
- `src-tauri/src/db.rs`: first-launch database download and the rsID matching query.
- `src-tauri/tauri.conf.json`: window, app identifier and the content security policy.
- `src/clinvarClient.js` and `src/aiClient.js`: detect the desktop app and call Rust instead of the browser worker or the dev proxy.

To ship a newer database, build it, gzip it, attach it to a new release, and update `DB_URL` in `src-tauri/src/db.rs`.

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
  individually validated for accuracy at every marker. Array calls can be wrong.
  Each rsID links to its ClinVar/dbSNP record to verify.
- This repo contains no genetic data.

## License

MIT. See the LICENSE file. The software is provided as is, with no warranty.
