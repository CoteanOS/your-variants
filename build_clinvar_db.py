#!/usr/bin/env python3
"""
build_clinvar_db.py

Build a compact, indexed SQLite database from NCBI ClinVar's
`variant_summary.txt.gz`, intended to be shipped as a STATIC ASSET and
downloaded once by the browser, then queried entirely client-side via
SQLite-WASM over OPFS (see src/clinvarWorker.js).

The whole DB is fetched once and cached locally; queries never hit the
network. This is deliberate — range-request engines (sql.js-httpvfs) would
leak *which* variants were looked up via server access logs, which defeats
the privacy goal. Full download, local query, nothing leaves the browser.

Design goals
------------
- Stream-parse the gzip (never load the whole thing into memory).
- Parse columns BY NAME (robust to ClinVar adding/reordering columns).
- Keep only the columns a lookup tool needs.
- Filter to a single genome assembly (default GRCh38) to halve the size.
- Targeted indexes on the lookup keys (rsid is the hot path).
- Record the ClinVar release date in a `meta` table so the UI can show it.
- VACUUM at the end so the shipped file is tight and contiguous.

Lookup keys supported by the resulting schema/indexes:
  - genomic coordinate: (chromosome, pos, ref, alt)   [VCF-normalized]
  - dbSNP rsid
  - gene symbol
  - ClinVar VariationID

Usage
-----
  # from an already-downloaded file:
  python build_clinvar_db.py --input variant_summary.txt.gz --output clinvar.sqlite

  # or let it download (needs network access to ftp.ncbi.nlm.nih.gov):
  python build_clinvar_db.py --download --output clinvar.sqlite

  # keep both assemblies, or pick GRCh37:
  python build_clinvar_db.py --input variant_summary.txt.gz --assembly all
  python build_clinvar_db.py --input variant_summary.txt.gz --assembly GRCh37
"""

import argparse
import csv
import gzip
import io
import os
import sqlite3
import sys
import time
import urllib.request

CLINVAR_URL = (
    "https://ftp.ncbi.nlm.nih.gov/pub/clinvar/"
    "tab_delimited/variant_summary.txt.gz"
)

# Source column name -> destination column name.
# We address source columns BY NAME so extra/reordered columns don't break us.
COLUMN_MAP = {
    "VariationID": "variation_id",
    "AlleleID": "allele_id",
    "Type": "type",
    "Name": "name",
    "GeneSymbol": "gene_symbol",
    "ClinicalSignificance": "clinical_significance",
    "ClinSigSimple": "clin_sig_simple",
    "ReviewStatus": "review_status",
    "LastEvaluated": "last_evaluated",
    "RS# (dbSNP)": "rsid",
    "PhenotypeList": "phenotypes",
    "Assembly": "assembly",
    "Chromosome": "chromosome",
    "PositionVCF": "pos",
    "ReferenceAlleleVCF": "ref",
    "AlternateAlleleVCF": "alt",
    "NumberSubmitters": "number_submitters",
}

INT_COLS = {"variation_id", "allele_id", "clin_sig_simple",
            "rsid", "pos", "number_submitters"}

DEST_COLS = list(COLUMN_MAP.values())

BATCH = 50_000


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def open_source(path):
    """Yield decoded text lines from a .gz or plain .txt file."""
    if path.endswith(".gz"):
        raw = gzip.open(path, "rb")
    else:
        raw = open(path, "rb")
    return io.TextIOWrapper(raw, encoding="utf-8", newline="")


def download(url, dest):
    log(f"downloading {url}")
    with urllib.request.urlopen(url) as r, open(dest, "wb") as f:
        total = 0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            total += len(chunk)
            log(f"  ...{total/1e6:.1f} MB")
    log(f"saved -> {dest}")


def to_int(v):
    """ClinVar uses '-1' / 'na' / '' for missing numerics."""
    if v is None:
        return None
    v = v.strip()
    if v in ("", "-1", "na", "NA", "-"):
        return None
    try:
        return int(v)
    except ValueError:
        return None


def clean(v):
    if v is None:
        return None
    v = v.strip()
    if v in ("", "na", "NA", "-"):
        return None
    return v


def row_to_tuple(row):
    out = []
    for src, dst in COLUMN_MAP.items():
        val = row.get(src)
        if dst in INT_COLS:
            out.append(to_int(val))
        else:
            out.append(clean(val))
    return tuple(out)


def keep_by_significance(sig, mode):
    """Decide whether a row's ClinicalSignificance survives the chosen filter."""
    if mode == "all":
        return True
    t = (sig or "").lower().strip()
    if mode == "signal":
        # drop pure-benign and uninformative entries
        if not t:
            return False
        if t in ("not provided", "other"):
            return False
        if "no classification" in t:
            return False
        if t in ("benign", "likely benign", "benign/likely benign"):
            return False
        return True
    if mode == "pathogenic":
        # keep only entries flagged pathogenic / likely pathogenic
        return "pathogenic" in t
    return True


def create_schema(con, page_size):
    # page_size must be set before any table is created.
    con.execute(f"PRAGMA page_size = {page_size};")
    con.execute("PRAGMA journal_mode = OFF;")
    con.execute("PRAGMA synchronous = OFF;")
    cols = ",\n  ".join(f"{c} {'INTEGER' if c in INT_COLS else 'TEXT'}"
                        for c in DEST_COLS)
    con.execute(f"CREATE TABLE variants (\n  {cols}\n);")


def write_meta(con, source_path, kept, release_date):
    """Self-describe the DB: ClinVar release date, build date, row count.
    The UI reads this so the displayed 'last updated' can't drift out of sync
    with the shipped data."""
    if not release_date and source_path and os.path.exists(source_path):
        # ClinVar doesn't stamp the release inside the file; fall back to the
        # source file's modification date (usually the NCBI publish date).
        release_date = time.strftime(
            "%Y-%m-%d", time.gmtime(os.path.getmtime(source_path)))
    con.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);")
    con.executemany(
        "INSERT INTO meta (key, value) VALUES (?, ?)",
        [
            ("clinvar_release", release_date or "unknown"),
            ("built", time.strftime("%Y-%m-%d")),
            ("rows", str(kept)),
            ("source", "NCBI ClinVar variant_summary.txt.gz"),
        ],
    )


def create_indexes(con):
    log("building indexes")
    # Exact coordinate match is the primary path; composite covers it fully.
    con.execute("CREATE INDEX idx_coord ON variants"
                "(chromosome, pos, ref, alt);")
    con.execute("CREATE INDEX idx_rsid ON variants(rsid);")
    con.execute("CREATE INDEX idx_gene ON variants(gene_symbol);")
    con.execute("CREATE INDEX idx_varid ON variants(variation_id);")


def build(args):
    if args.download:
        if not args.input:
            args.input = "variant_summary.txt.gz"
        download(CLINVAR_URL, args.input)

    if not args.input or not os.path.exists(args.input):
        sys.exit("error: no input file (use --input PATH or --download)")

    if os.path.exists(args.output):
        os.remove(args.output)

    con = sqlite3.connect(args.output)
    create_schema(con, args.page_size)

    placeholders = ",".join("?" * len(DEST_COLS))
    insert_sql = f"INSERT INTO variants VALUES ({placeholders})"

    want_assembly = None if args.assembly == "all" else args.assembly

    src = open_source(args.input)
    # Header line begins with '#'; strip it so DictReader keys are clean.
    header = src.readline().lstrip("#").rstrip("\n")
    fieldnames = header.split("\t")
    missing = [c for c in COLUMN_MAP if c not in fieldnames]
    if missing:
        sys.exit(f"error: expected columns missing from header: {missing}")

    reader = csv.DictReader(src, fieldnames=fieldnames, delimiter="\t")

    batch, read, kept = [], 0, 0
    t0 = time.time()
    for row in reader:
        read += 1
        if want_assembly and row.get("Assembly") != want_assembly:
            continue
        if not keep_by_significance(row.get("ClinicalSignificance"), args.significance):
            continue
        batch.append(row_to_tuple(row))
        kept += 1
        if len(batch) >= BATCH:
            con.executemany(insert_sql, batch)
            batch.clear()
            log(f"  read {read:,}  kept {kept:,}")
    if batch:
        con.executemany(insert_sql, batch)
    con.commit()
    log(f"inserted {kept:,} rows (from {read:,}) in {time.time()-t0:.1f}s")

    create_indexes(con)
    write_meta(con, args.input, kept, args.release_date)
    con.commit()

    log("VACUUM")
    con.execute("VACUUM;")
    con.commit()
    con.close()

    size = os.path.getsize(args.output)
    log(f"done -> {args.output} ({size/1e6:.1f} MB)")


def parse_args():
    p = argparse.ArgumentParser(description="Build ClinVar SQLite for client-side lookup")
    p.add_argument("--input", help="path to variant_summary.txt(.gz)")
    p.add_argument("--download", action="store_true",
                   help="download variant_summary.txt.gz from NCBI first")
    p.add_argument("--output", default="clinvar.sqlite")
    p.add_argument("--assembly", default="GRCh38",
                   choices=["GRCh38", "GRCh37", "all"])
    p.add_argument("--page-size", type=int, default=4096,
                   help="SQLite page size; 4096 is SQLite's default and fine "
                        "for a fully-downloaded OPFS database")
    p.add_argument("--release-date",
                   help="ClinVar release date (YYYY-MM-DD) to record in the "
                        "meta table; defaults to the source file's mod date")
    p.add_argument("--significance", default="all",
                   choices=["all", "signal", "pathogenic"],
                   help="all = full mirror; signal = drop pure-benign/uninformative; "
                        "pathogenic = keep only pathogenic/likely-pathogenic")
    return p.parse_args()


if __name__ == "__main__":
    build(parse_args())
