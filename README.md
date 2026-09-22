# yourvariants

A client-side DNA variant viewer. Drop in a raw genotype file (23andMe or
AncestryDNA), and it matches the rsIDs against a ClinVar-derived database and
shows what ClinVar records for each match - the classification, the associated
conditions, the review status, and your own genotype at that position.

Everything runs in the browser. The file is read locally, the database is
downloaded once and queried on-device, and no genotype data is ever sent to a
server. There is no backend.

This is a personal / portfolio project, not a service. It is informational
only - not a medical test, not a diagnosis. ClinVar itself is not intended for
diagnostic use without review by a genetics professional, and consumer
genotyping arrays are not clinically validated. Confirm anything meaningful
with a clinician.

## How it works

```
raw file ──► Pyodide (parse) ──► rsIDs ──► SQLite-WASM/OPFS (match) ──► Pyodide (classify) ──► React UI
  local          browser                       browser worker              browser            browser
```

1. **Read locally** - the file is loaded with `file.text()` in the browser.
   Drag-and-drop or click to choose; nothing is uploaded.
2. **Parse (Pyodide)** - `public/variant_logic.py` runs as real CPython in
   WebAssembly. It reads the raw file into rsIDs + genotypes, handling
   23andMe (single genotype column) and AncestryDNA (two allele columns),
   tab- **or** comma-delimited.
3. **Match (SQLite-WASM / OPFS)** - `src/clinvarWorker.js` runs SQLite in a
   Web Worker over OPFS. The ClinVar DB is downloaded once, cached locally,
   opened `query_only`, and matched against all the user's rsIDs in a single
   temp-table JOIN.
4. **Classify (Pyodide)** - each matched ClinVar row is annotated with the
   user's zygosity, with a strand-flip check so plus/minus-strand calls still
   line up with ClinVar's alleles.
5. **Display (React)** - results are rendered with summary stats, client-side
   filters, and an Excel export.

The whole database is fetched once rather than range-requested per query. That
is deliberate: a range-request engine would leak *which* variants were looked
up through server access logs, which would defeat the privacy goal.

## Features

**Input & parsing**
- Drag-and-drop or click-to-choose file input; read entirely on-device.
- 23andMe and AncestryDNA raw formats; tab- or comma-delimited.
- Genotype classification per variant: heterozygous, homozygous-alt,
  reference, no-call, indel, no-ref, and allele-mismatch states.
- Strand-aware matching (checks the complement when alleles don't line up).

**Results view**
- Header shows the loaded database's ClinVar release date and record count,
  read from the DB's `meta` table.
- Summary counters: variants in file, matched in ClinVar, carried, carried
  with a meaningful classification ("with signal"), and pathogenic.
- Per-variant cards showing gene, rsID (linked to its ClinVar/dbSNP record so
  you can verify the call at the source), ClinVar significance, variant name,
  ref→alt with base coloring, the user's genotype, zygosity, associated
  conditions (phenotypes), and a confidence tier.
- Confidence tiers mapped to ClinVar review stars: 4★ practice guideline,
  3★ expert panel, 2★ multiple submitters no conflicts, 1★ single submitter
  or conflicting, 0★ no assertion criteria - color-coded green/amber/red.
- Significance is both color-coded (onto canonical genome-browser base colors)
  and grouped into categories (pathogenic, conflicting, uncertain, risk,
  drug response, protective, association, benign, other).

**Dashboard (condition areas)**
- Matched variants are grouped into clinical areas (cancer, cardiac, metabolic,
  neurological, pharmacogenomic, etc.) parsed from ClinVar's own condition text
  - offline, no extra data source. Each area shows a count and bar; click one
  to filter the list to it. It's a way to navigate a large result set, not a
  ranking of importance.

**AI explanations (Sofia)**
- An "Explain with Sofia" button on each variant asks a cloud model to explain
  it in plain, calibrated language - what the gene does, what the ClinVar
  classification means, penetrance context, and the array-reliability caveat.
- Privacy-preserving by design: the request sends only *public* facts about
  the variant (rsID, gene, ClinVar classification, condition, frequency). It
  never sends the user's genotype, zygosity, or file - the model explains the
  *variant*, not the *person*, so nothing personal leaves the browser.

**Filtering & export**
- Filter by confidence (minimum star tier).
- Filter by significance category (only the categories present in your data).
- Toggle to show homozygous-only.
- Hide 0★ entries (no assertion criteria - a lone unreviewed claim); on by
  default, with a count of what's hidden.
- Live count of shown rows; the list renders up to 300 cards for performance,
  while export always uses the full filtered set.
- Export the filtered set to `.xlsx` (SheetJS, loaded on demand) with gene,
  rsID, significance, genotype, zygosity, carrier flag, variant name,
  phenotypes, ClinVar review status, submitter count, and coordinates.

**Design**
- Dark, genome-browser-inspired UI; reduced-motion aware; responsive.

## Building the ClinVar database

The app loads `clinvar.sqlite` from the site root (`public/clinvar.sqlite`).
Build it from NCBI's ClinVar dump with the included script:

```bash
# download the latest ClinVar dump and build a GRCh38 DB
python build_clinvar_db.py --download --output public/clinvar.sqlite \
    --release-date 2026-05-28

# or build from a file you already have
python build_clinvar_db.py --input variant_summary.txt.gz \
    --output public/clinvar.sqlite
```

What the build script does:
- Stream-parses `variant_summary.txt.gz` (never loads it all into memory).
- Reads columns **by name**, so ClinVar adding or reordering columns won't
  break it.
- Keeps only the columns the lookup needs.
- Filters to one genome assembly (default GRCh38) to roughly halve the size.
- Builds indexes on coordinate, rsID, gene symbol, and ClinVar variation ID.
- Writes a `meta` table recording the ClinVar release date, build date, row
  count, and source - so the shipped DB is self-describing.
- `VACUUM`s the result so the file is tight and contiguous.

Flags:
- `--assembly GRCh38|GRCh37|all` - genome build (default GRCh38).
- `--significance all|signal|pathogenic` - `all` ships the full mirror;
  `signal` drops pure-benign/uninformative rows; `pathogenic` keeps only
  pathogenic/likely-pathogenic.
- `--release-date YYYY-MM-DD` - recorded in the `meta` table; defaults to the
  source file's modification date.
- `--page-size N` - SQLite page size (default 4096).
- `--download` - fetch `variant_summary.txt.gz` from NCBI first.

The DB is a large generated artifact and is **not** committed to the repo.
Build it locally, or serve it from a CDN.

### Adding gnomAD frequencies (optional)

`add_gnomad.py` enriches an existing `clinvar.sqlite` with gnomAD global
allele frequencies (rarity is context a ClinVar classification alone doesn't
give). It adds a `gnomad_af` column, keyed by rsID, into the same DB - still
one static asset, still queried fully locally.

```bash
python add_gnomad.py --db public/clinvar.sqlite --freqs gnomad_af.tsv --release v4.1
```

It expects a pre-reduced `rsid<TAB>af` table (producing that from gnomAD's
VCFs is a one-time offline step - the script's header documents the bcftools
recipe). The app shows the frequency automatically when the column is present,
and works unchanged when it isn't.

## Running

```bash
npm install
npm run dev      # dev server (Vite)
npm run build    # production build to dist/
```

You need `public/clinvar.sqlite` present for matching to work. At runtime the
app also loads Pyodide, and (only on export) SheetJS, from CDNs; fonts come
from Google Fonts. Your genotype and variant data never leave the browser -
those requests fetch code and fonts, not your data.

### Enabling AI explanations (optional)

The "Explain with Sofia" button needs an Anthropic API key. It is read
server-side by the dev server and never exposed to the browser, so bring your
own key:

```bash
cp .env.local.example .env.local     # then edit .env.local and paste your key
```

`.env.local` is git-ignored - your key is never committed and never shipped to
anyone who clones this repo. Without a key the app runs normally; only the
Explain button is disabled. Even with a key, requests contain only public
variant facts (rsID, gene, ClinVar classification, frequency), never your
genotype.

## Stack

React 19, Vite, `@sqlite.org/sqlite-wasm` (OPFS), Pyodide, SheetJS. Data from
NCBI ClinVar.

## Tests

Pure logic is unit-tested - no browser or database needed.

```bash
npm test           # JS: classification, star tiers, category mapping, links
npm run test:py    # Python: parsing (TSV/CSV/Ancestry), zygosity, strand flips
```

## Notes

- 23andMe/AncestryDNA raw calls are for research/educational use and are not
  individually validated for accuracy at every marker. Array calls can be
  wrong; each rsID links to its ClinVar/dbSNP record so you can verify.
- The DB's `meta` table (ClinVar release date, build date, row count) is read
  on load and shown in the header.
- This repo intentionally contains no genetic data of any kind.
