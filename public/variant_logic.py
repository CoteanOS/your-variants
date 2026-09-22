import json

COMP = {"A": "T", "T": "A", "C": "G", "G": "C"}


def parse_23andme(text):
    """Parse 23andMe raw text -> {'rsids': [...], 'genotypes': {rsid: geno}}."""
    rsids = []
    genos = {}
    for line in text.splitlines():
        if not line or line[0] == "#":
            continue
        # 23andMe/Ancestry exports are tab-delimited, but some tools re-save
        # them as CSV. Fall back to comma so a CSV doesn't parse to nothing.
        parts = line.split("\t")
        if len(parts) < 4 and "," in line:
            parts = line.split(",")
        if len(parts) < 4:
            continue
        parts = [p.strip().strip('"') for p in parts]
        rs = parts[0].strip()
        if not (rs[:2].lower() == "rs" and rs[2:].isdigit()):
            continue
        rsid = int(rs[2:])
        if len(parts) >= 5:           # AncestryDNA: two allele columns
            geno = parts[3].strip() + parts[4].strip()
        else:                          # 23andMe: single genotype column
            geno = parts[3].strip()
        rsids.append(rsid)
        genos[rsid] = geno
    return json.dumps({"rsids": rsids, "genotypes": genos})


def _verdict(alt_count, total, strand):
    if alt_count == 0:
        status = "ref"
    elif alt_count == total:
        status = "hom_alt"
    else:
        status = "het"
    return {"status": status, "altCount": alt_count, "copies": total, "strand": strand}


def classify(genotype, ref, alt):
    if not genotype:
        return {"status": "nocall"}
    g = "".join(c for c in genotype.upper() if c in "ACGTID-")
    if g == "" or "-" in g:
        return {"status": "nocall"}
    if "I" in g or "D" in g:
        return {"status": "indel"}
    if not ref or not alt:
        return {"status": "noref"}
    R, A = ref.upper(), alt.upper()
    if len(R) != 1 or len(A) != 1 or R not in "ACGT" or A not in "ACGT":
        return {"status": "indel"}

    alleles = list(g)

    def score(arr):
        return (sum(1 for x in arr if x == A), sum(1 for x in arr if x == R))

    a, r = score(alleles)
    if a + r == len(alleles):
        return _verdict(a, len(alleles), "plus")

    flipped = [COMP.get(x, x) for x in alleles]
    a, r = score(flipped)
    if a + r == len(alleles):
        return _verdict(a, len(alleles), "flipped")

    return {"status": "mismatch"}


def classify_matches(matched_json, genotypes_json):
    """matched_json: list of ClinVar rows (each has rsid, ref, alt, ...).
       genotypes_json: {rsid(str): genotype}. Returns annotated rows."""
    matched = json.loads(matched_json)
    genos = json.loads(genotypes_json)
    out = []
    for v in matched:
        geno = genos.get(str(v.get("rsid")))
        cls = classify(geno, v.get("ref"), v.get("alt"))
        row = dict(v)
        row["genotype"] = geno
        row["zygosity"] = cls.get("status")
        row["strand"] = cls.get("strand")
        row["carrier"] = cls.get("status") in ("het", "hom_alt")
        out.append(row)
    return json.dumps(out)
