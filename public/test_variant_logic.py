"""
Tests for variant_logic.py — the parse + classify functions that run in
Pyodide. Pure Python, no browser needed:  python -m pytest public/
(or just: python public/test_variant_logic.py)
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from variant_logic import parse_23andme, classify, classify_matches  # noqa: E402


def _parse(text):
    return json.loads(parse_23andme(text))


def test_parses_23andme_tsv():
    text = "# rsid chrom pos geno\nrs6025\t1\t169549811\tAG\nrs1801133\t1\t11856378\tCC\n"
    r = _parse(text)
    assert r["rsids"] == [6025, 1801133]
    assert r["genotypes"] == {"6025": "AG", "1801133": "CC"}


def test_parses_ancestry_two_allele_columns():
    text = "rs6025\t1\t169549811\tA\tG\n"
    r = _parse(text)
    assert r["genotypes"] == {"6025": "AG"}


def test_parses_csv_fallback():
    text = 'rs6025,1,169549811,"AG"\nrs1801133,1,11856378,CC\n'
    r = _parse(text)
    assert r["rsids"] == [6025, 1801133]
    assert r["genotypes"]["6025"] == "AG"


def test_skips_comments_and_non_rs():
    text = "# header\ni5001234\t1\t100\tAA\nrs42\t1\t200\tGG\n"
    r = _parse(text)
    assert r["rsids"] == [42]


def test_classify_het():
    assert classify("AG", "A", "G")["status"] == "het"


def test_classify_hom_alt():
    assert classify("GG", "A", "G")["status"] == "hom_alt"


def test_classify_ref():
    assert classify("AA", "A", "G")["status"] == "ref"


def test_classify_strand_flip():
    # user reported on the minus strand: TC vs a ref/alt of A/G
    res = classify("TC", "A", "G")
    assert res["status"] == "het"
    assert res["strand"] == "flipped"


def test_classify_nocall_and_indel():
    assert classify("--", "A", "G")["status"] == "nocall"
    assert classify("", "A", "G")["status"] == "nocall"
    assert classify("II", "A", "G")["status"] == "indel"


def test_classify_mismatch():
    # AC fits neither the plus strand (C is neither A nor G) nor the flipped
    # strand (A->T, so TG, and T is neither A nor G) -> genuine mismatch.
    assert classify("AC", "A", "G")["status"] == "mismatch"


def test_classify_matches_sets_carrier_flag():
    matched = json.dumps([{"rsid": 6025, "ref": "A", "alt": "G", "gene_symbol": "F5"}])
    genos = json.dumps({"6025": "AG"})
    out = json.loads(classify_matches(matched, genos))
    assert out[0]["carrier"] is True
    assert out[0]["zygosity"] == "het"
    # a reference genotype is not a carrier
    genos_ref = json.dumps({"6025": "AA"})
    out_ref = json.loads(classify_matches(matched, genos_ref))
    assert out_ref[0]["carrier"] is False


if __name__ == "__main__":
    # allow running without pytest installed
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"ok   {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {fn.__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    sys.exit(1 if failed else 0)
