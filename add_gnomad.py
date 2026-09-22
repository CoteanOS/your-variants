#!/usr/bin/env python3
"""
add_gnomad.py - enrich an existing clinvar.sqlite with gnomAD allele
frequencies, so the viewer can show how common each variant is (rarity is
half the story a ClinVar classification doesn't tell you).

Design, consistent with build_clinvar_db.py:
- Everything ends up in the SAME SQLite file, shipped as one static asset and
  queried fully locally. No extra runtime network calls, no per-variant
  lookups leaving the browser.
- gnomAD's full VCFs are enormous, so this expects a PRE-REDUCED frequency
  table keyed by rsID: a TSV with columns  rsid<TAB>af  (global allele
  frequency). Producing that reduced table from gnomAD is a one-time offline
  step (see NOTES); this script just joins it in.

Usage:
    python add_gnomad.py --db public/clinvar.sqlite --freqs gnomad_af.tsv[.gz]

After running, the `variants` table has a new `gnomad_af` column (REAL, NULL
where gnomAD has no entry for that rsID).

NOTES - producing gnomad_af.tsv from gnomAD:
    gnomAD publishes per-chromosome sites VCFs. The reduced table you want is
    just (rsID, global AF). A rough recipe with bcftools:

        bcftools query -f '%ID\\t%INFO/AF\\n' gnomad.genomes.v4.sites.chr*.vcf.bgz \\
          | awk -F'\\t' '$1 ~ /^rs/ {print substr($1,3)"\\t"$2}' > gnomad_af.tsv

    That keeps only rsID-keyed rows (which is all a consumer-array tool can
    match anyway) and drops the coordinate/annotation bulk.
"""
import argparse
import gzip
import os
import sqlite3
import sys
import time


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", file=sys.stderr, flush=True)


def open_maybe_gz(path):
    return gzip.open(path, "rt") if path.endswith(".gz") else open(path, "r")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True, help="clinvar.sqlite to enrich")
    ap.add_argument("--freqs", required=True,
                    help="reduced gnomAD table: rsid<TAB>af per line")
    ap.add_argument("--release", help="gnomAD version, recorded in meta "
                    "(e.g. v4.1)")
    args = ap.parse_args()

    if not os.path.exists(args.db):
        sys.exit(f"error: {args.db} not found - build the ClinVar DB first")

    con = sqlite3.connect(args.db)
    cur = con.cursor()

    # add the column if it isn't there yet
    cols = [r[1] for r in cur.execute("PRAGMA table_info(variants)")]
    if "gnomad_af" not in cols:
        log("adding gnomad_af column")
        cur.execute("ALTER TABLE variants ADD COLUMN gnomad_af REAL")

    # load reduced freqs into a temp table, then join-update
    cur.execute("CREATE TEMP TABLE _freq (rsid INTEGER PRIMARY KEY, af REAL)")
    n = 0
    with open_maybe_gz(args.freqs) as fh:
        batch = []
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 2:
                continue
            rs, af = parts[0], parts[1]
            try:
                batch.append((int(rs), float(af)))
            except ValueError:
                continue
            if len(batch) >= 50_000:
                cur.executemany("INSERT OR REPLACE INTO _freq VALUES (?,?)", batch)
                n += len(batch); batch = []
        if batch:
            cur.executemany("INSERT OR REPLACE INTO _freq VALUES (?,?)", batch)
            n += len(batch)
    log(f"loaded {n:,} gnomAD frequencies")

    log("joining into variants")
    cur.execute("""
        UPDATE variants
           SET gnomad_af = (SELECT af FROM _freq WHERE _freq.rsid = variants.rsid)
         WHERE rsid IN (SELECT rsid FROM _freq)
    """)
    updated = con.total_changes

    # record the gnomAD version in meta
    if args.release:
        cur.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('gnomad_release',?)",
                    (args.release,))
    cur.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('gnomad_added',?)",
                (time.strftime("%Y-%m-%d"),))

    con.commit()
    log(f"annotated {updated:,} variants with gnomAD AF")
    log("VACUUM")
    con.execute("VACUUM")
    con.commit()
    con.close()
    log("done")


if __name__ == "__main__":
    main()
