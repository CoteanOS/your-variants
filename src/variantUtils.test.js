import { describe, it, expect } from "vitest";
import {
  sigRank, sigCategory, confInfo, hasSignal,
  dbsnpUrl, clinvarUrl, variantLink, zygInfo, BASE,
  conditionArea, clusterByArea,
} from "./variantUtils.js";

describe("sigRank", () => {
  it("ranks pathogenic first and benign last", () => {
    expect(sigRank("Pathogenic")).toBeLessThan(sigRank("Uncertain significance"));
    expect(sigRank("Uncertain significance")).toBeLessThan(sigRank("Benign"));
  });
  it("does not treat conflicting-pathogenic as top rank", () => {
    expect(sigRank("Conflicting interpretations of pathogenicity")).toBeGreaterThan(sigRank("Pathogenic"));
  });
});

describe("sigCategory", () => {
  it("maps the common ClinVar labels", () => {
    expect(sigCategory("Pathogenic")).toBe("pathogenic");
    expect(sigCategory("Likely pathogenic")).toBe("pathogenic");
    expect(sigCategory("Conflicting interpretations of pathogenicity")).toBe("conflicting");
    expect(sigCategory("Uncertain significance")).toBe("uncertain");
    expect(sigCategory("drug response")).toBe("drug");
    expect(sigCategory("protective")).toBe("protective");
    expect(sigCategory("risk factor")).toBe("risk");
    expect(sigCategory("Benign")).toBe("benign");
    expect(sigCategory("")).toBe("other");
  });
});

describe("confInfo — star tiers", () => {
  it("practice guideline = 4 stars", () => {
    expect(confInfo("practice guideline", 5).stars).toBe(4);
  });
  it("expert panel = 3 stars", () => {
    expect(confInfo("reviewed by expert panel", 2).stars).toBe(3);
  });
  it("multiple submitters no conflicts = 2 stars", () => {
    expect(confInfo("criteria provided, multiple submitters, no conflicts", 3).stars).toBe(2);
  });
  it("single submitter = 1 star", () => {
    expect(confInfo("criteria provided, single submitter", 1).stars).toBe(1);
  });
  it("conflicting = 1 star", () => {
    expect(confInfo("criteria provided, conflicting classifications", 4).stars).toBe(1);
  });
  it("no assertion criteria = 0 stars", () => {
    expect(confInfo("no assertion criteria provided", 1).stars).toBe(0);
  });
  it("pluralizes submitter detail", () => {
    expect(confInfo("no assertion criteria provided", 1).detail).toContain("1 submitter,");
    expect(confInfo("no assertion criteria provided", 3).detail).toContain("3 submitters");
  });
});

describe("hasSignal", () => {
  it("keeps meaningful classifications", () => {
    expect(hasSignal("Pathogenic")).toBe(true);
    expect(hasSignal("Uncertain significance")).toBe(true);
    expect(hasSignal("drug response")).toBe(true);
  });
  it("drops benign and empty/uninformative", () => {
    expect(hasSignal("Benign")).toBe(false);
    expect(hasSignal("Likely benign")).toBe(false);
    expect(hasSignal("Benign/Likely benign")).toBe(false);
    expect(hasSignal("not provided")).toBe(false);
    expect(hasSignal("")).toBe(false);
    expect(hasSignal(null)).toBe(false);
  });
});

describe("links", () => {
  it("builds a dbSNP url from an rsid", () => {
    expect(dbsnpUrl(6025)).toBe("https://www.ncbi.nlm.nih.gov/snp/rs6025");
  });
  it("builds a ClinVar url from a variation id", () => {
    expect(clinvarUrl(642)).toBe("https://www.ncbi.nlm.nih.gov/clinvar/variation/642/");
    expect(clinvarUrl(null)).toBeNull();
  });
  it("prefers ClinVar variation id, falls back to dbSNP", () => {
    expect(variantLink({ variation_id: 642, rsid: 6025 })).toContain("/clinvar/variation/642/");
    expect(variantLink({ rsid: 6025 })).toContain("/snp/rs6025");
    expect(variantLink({})).toBeNull();
  });
});

describe("zygInfo", () => {
  it("labels het and hom_alt by copy count", () => {
    expect(zygInfo("het").label).toContain("1 copy");
    expect(zygInfo("hom_alt").label).toContain("2 copies");
  });
  it("has a base palette for all four bases", () => {
    expect(Object.keys(BASE).sort()).toEqual(["A", "C", "G", "T"]);
  });
});

describe("conditionArea", () => {
  it("maps cancer conditions", () => {
    expect(conditionArea("Hereditary breast and ovarian cancer")).toBe("Cancer & tumor predisposition");
    expect(conditionArea("Lynch syndrome")).toBe("Cancer & tumor predisposition");
  });
  it("maps cardiac", () => {
    expect(conditionArea("Long QT syndrome")).toBe("Cardiac & vascular");
    expect(conditionArea("Factor V Leiden thrombophilia")).toBe("Cardiac & vascular");
  });
  it("maps pharmacogenomic", () => {
    expect(conditionArea("Warfarin response")).toBe("Metabolism of drugs (pharmacogenomic)");
  });
  it("maps sensory", () => {
    expect(conditionArea("Nonsyndromic hearing loss")).toBe("Hearing, vision & sensory");
  });
  it("falls back to other for empty/unknown", () => {
    expect(conditionArea("")).toBe("Unclassified / other");
    expect(conditionArea("not provided")).toBe("Unclassified / other");
    expect(conditionArea("some rare thing with no keyword")).toBe("Unclassified / other");
  });
});

describe("clusterByArea", () => {
  it("groups and counts, sorted by count desc", () => {
    const rows = [
      { phenotypes: "Hereditary breast cancer" },
      { phenotypes: "Colorectal cancer" },
      { phenotypes: "Long QT syndrome" },
    ];
    const c = clusterByArea(rows);
    expect(c[0].area).toBe("Cancer & tumor predisposition");
    expect(c[0].count).toBe(2);
    expect(c.find((x) => x.area === "Cardiac & vascular").count).toBe(1);
  });
  it("returns empty for no rows", () => {
    expect(clusterByArea([])).toEqual([]);
  });
});
