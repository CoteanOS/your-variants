/**
 * variantUtils.js — pure helpers for classifying and presenting ClinVar rows.
 * No React, no DOM: kept separate so it can be unit-tested directly.
 */

/* canonical genome-browser base colors */
export const BASE = { A: "#3FB68B", C: "#4C8DD6", G: "#E0A33E", T: "#D9544D" };

export function sigRank(s) {
  const t = (s || "").toLowerCase();
  if (t.includes("pathogenic") && !t.includes("conflict")) return 0;
  if (t.includes("risk") || t.includes("affects")) return 1;
  if (t.includes("conflict")) return 2;
  if (t.includes("uncertain")) return 3;
  if (t.includes("benign")) return 4;
  return 2;
}

export function sigColor(s) {
  const t = (s || "").toLowerCase();
  if (t.includes("pathogenic") && !t.includes("conflict")) return BASE.T;
  if (t.includes("protective")) return BASE.A;
  if (t.includes("benign")) return BASE.A;
  if (t.includes("drug") || t.includes("response")) return BASE.C;
  if (t.includes("conflict") || t.includes("uncertain") ||
      t.includes("risk") || t.includes("association") || t.includes("affects"))
    return BASE.G;
  return "#7C8A90";
}

export function zygInfo(z) {
  return {
    het:      { label: "Heterozygous · 1 copy",   color: "#E0A33E" },
    hom_alt:  { label: "Homozygous · 2 copies",   color: "#D9544D" },
    ref:      { label: "Reference · not carried", color: "#7C8A90" },
    nocall:   { label: "No call",                 color: "#7C8A90" },
    indel:    { label: "Indel · not compared",    color: "#7C8A90" },
    noref:    { label: "No allele data",          color: "#7C8A90" },
    mismatch: { label: "Allele mismatch",         color: "#7C8A90" },
  }[z] || { label: z, color: "#7C8A90" };
}

export const CAT_LABELS = {
  pathogenic: "Pathogenic / likely",
  conflicting: "Conflicting",
  uncertain: "Uncertain significance",
  risk: "Risk factor",
  drug: "Drug response",
  protective: "Protective",
  association: "Association",
  benign: "Benign",
  other: "Other",
};

export function sigCategory(s) {
  const t = (s || "").toLowerCase();
  if (t.includes("pathogenic") && !t.includes("conflict")) return "pathogenic";
  if (t.includes("conflict")) return "conflicting";
  if (t.includes("uncertain")) return "uncertain";
  if (t.includes("drug") || t.includes("response") || t.includes("sensitivity")) return "drug";
  if (t.includes("protective")) return "protective";
  if (t.includes("risk") || t.includes("affects")) return "risk";
  if (t.includes("association")) return "association";
  if (t.includes("benign")) return "benign";
  return "other";
}

// Confidence mapped to ClinVar's star tiers.
// Green = independently corroborated (2 stars / expert panel / guideline).
// Amber = a single lab's call, or unresolved conflict (1 star).
// Red   = no documented method (0 stars).
export function confInfo(review, subs) {
  const r = (review || "").toLowerCase();
  const n = Number(subs) || 0;
  const subTxt = `${n} submitter${n === 1 ? "" : "s"}`;
  if (r.includes("practice guideline"))
    return { stars: 4, tier: "4★", detail: "practice guideline", color: "#3FB68B", level: 4 };
  if (r.includes("expert panel"))
    return { stars: 3, tier: "3★", detail: "expert panel", color: "#3FB68B", level: 3 };
  if (r.includes("no assertion") || r.includes("no classification"))
    return { stars: 0, tier: "0★", detail: `${subTxt}, no criteria`, color: "#D9544D", level: 0 };
  // NB: check "multiple ... no conflicts" before the bare "conflict" test —
  // "no conflicts" contains "conflict" as a substring and would misfire.
  if (r.includes("multiple") && !r.includes("conflicting"))
    return { stars: 2, tier: "2★", detail: `${subTxt}, no conflicts`, color: "#3FB68B", level: 2 };
  if (r.includes("conflict"))
    return { stars: 1, tier: "1★", detail: `${subTxt}, conflicting`, color: "#E0A33E", level: 1 };
  if (r.includes("single"))
    return { stars: 1, tier: "1★", detail: "single submitter", color: "#E0A33E", level: 1 };
  if (n >= 2) return { stars: 2, tier: "2★", detail: `${subTxt}`, color: "#3FB68B", level: 2 };
  return { stars: 1, tier: "1★", detail: subTxt, color: "#E0A33E", level: 1 };
}

export function hasSignal(s) {
  const t = (s || "").toLowerCase().trim();
  if (!t) return false;
  if (t === "not provided" || t === "other") return false;
  if (t.includes("no classification")) return false;
  if (/^(benign|likely benign|benign\/likely benign)$/.test(t)) return false;
  return true;
}

/** dbSNP page for an rsID — lists the ClinVar entries and is stable by number. */
export function dbsnpUrl(rsid) {
  return `https://www.ncbi.nlm.nih.gov/snp/rs${rsid}`;
}

/** Direct ClinVar variation page when we have the ClinVar VariationID. */
export function clinvarUrl(variationId) {
  return variationId
    ? `https://www.ncbi.nlm.nih.gov/clinvar/variation/${variationId}/`
    : null;
}

/** Best available external link for a variant row: ClinVar if we have the
 *  VariationID, else the dbSNP rs page. */
export function variantLink(v) {
  return clinvarUrl(v.variation_id) || (v.rsid != null ? dbsnpUrl(v.rsid) : null);
}

/* ---- condition-area clustering ----
 * Groups variants by the clinical area named in ClinVar's own condition
 * (phenotype) text. This is organizational, not a ranking: it clusters by
 * *what ClinVar says the condition is*, using only data already in the DB.
 * Order matters — first matching area wins. */
const AREA_RULES = [
  ["Cancer & tumor predisposition", /cancer|carcinoma|tumou?r|neoplas|lynch|li-fraumeni|adenomatous|melanoma|leukemia|lymphoma|blastoma/i],
  ["Cardiac & vascular",            /cardio|cardiac|heart|arrhythmi|qt |brugada|aort|thrombo|coagul|factor v|hypertension|myopathy of the heart/i],
  ["Metabolic & mitochondrial",     /metaboli|mitochondri|glycogen|lipid|cholesterol|phenylketon|galactos|diabet|maple syrup|urea cycle|fabry|gaucher|pompe/i],
  ["Neurological & developmental",  /neuro|epilep|seizure|ataxia|parkinson|alzheimer|dystonia|intellectual disability|developmental|autism|leukodystrophy|charcot|neuropathy/i],
  ["Hearing, vision & sensory",     /deaf|hearing|retin|macular|blind|vision|usher|optic|glaucoma|cataract/i],
  ["Hematologic & immune",          /anemia|hemoglobin|thalassem|sickle|immunodefic|hemophil|platelet|neutropen|complement/i],
  ["Connective tissue & skeletal",  /marfan|ehlers|collagen|skeletal|osteogenesis|dysplasia|dwarf|craniosynostosis|joint/i],
  ["Metabolism of drugs (pharmacogenomic)", /drug|response|metaboli[sz]er|warfarin|clopidogrel|statin|codeine|thiopurine|cyp2|dpyd|tpmt|slco1b1/i],
  ["Kidney, liver & GI",            /renal|kidney|nephro|hepat|liver|polycystic|pancrea|cystic fibrosis|intestin|bowel/i],
];

/** Return the clinical area label for a variant's condition text. */
export function conditionArea(phenotypes) {
  const t = (phenotypes || "").toLowerCase();
  if (!t || t === "not provided" || t === "not specified") return "Unclassified / other";
  for (const [label, re] of AREA_RULES) if (re.test(t)) return label;
  return "Unclassified / other";
}

/** Cluster a list of variant rows into { area, count, variants } buckets,
 *  sorted by count descending. */
export function clusterByArea(rows) {
  const map = new Map();
  for (const v of rows) {
    const area = conditionArea(v.phenotypes);
    if (!map.has(area)) map.set(area, []);
    map.get(area).push(v);
  }
  return [...map.entries()]
    .map(([area, variants]) => ({ area, count: variants.length, variants }))
    .sort((a, b) => b.count - a.count);
}
