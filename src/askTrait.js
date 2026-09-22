/**
 * askTrait.js - natural-language trait querying over the user's variants.
 * Panel traits (several independent markers, e.g. lactase persistence) report
 * each marker found and summarize agreement, rather than forcing one verdict.
 * Privacy: only the trait's public facts + the genotypes for that trait are
 * sent to the model - never the whole genome.
 */

let TRAITS = null;
async function loadTraits() {
  if (TRAITS) return TRAITS;
  const res = await fetch("/traits.json");
  TRAITS = (await res.json()).traits;
  return TRAITS;
}

function normGeno(g) {
  if (!g) return null;
  const bases = g.toUpperCase().replace(/[^ACGT]/g, "");
  if (bases.length < 2) return bases || null;
  return bases.split("").sort().join("");
}
const COMP = { A: "T", T: "A", C: "G", G: "C" };
function flip(geno) {
  return geno ? geno.split("").map((b) => COMP[b] || b).sort().join("") : null;
}

const STOP = new Set(["i", "a", "the", "is", "am", "do", "my", "me", "can",
  "does", "if", "of", "or", "and", "to", "what", "how", "about", "genetically",
  "genetic", "have", "has", "for", "tolerance", "tolerant", "metabolism",
  "metabolize", "type", "taste", "when", "get", "got", "will"]);

export function resolveTrait(question, traits) {
  const q = " " + question.toLowerCase().replace(/[^a-z0-9 ]/g, " ") + " ";
  const qWords = new Set(q.split(/\s+/).filter((w) => w && !STOP.has(w)));
  let best = null, bestScore = 0;
  for (const t of traits) {
    let score = 0;
    for (const rs of t.rsids) if (q.includes(rs.toLowerCase())) score = Math.max(score, 100);
    if (qWords.has(t.gene.toLowerCase())) score = Math.max(score, 50);
    for (const name of t.names) {
      const nameWords = name.toLowerCase().split(/\s+/).filter((w) => !STOP.has(w));
      const hits = nameWords.filter((w) => qWords.has(w)).length;
      if (hits > 0) score = Math.max(score, hits * 10 + name.length * 0.01);
    }
    if (score > bestScore) { best = t; bestScore = score; }
  }
  return bestScore > 0 ? best : null;
}

function collectFindings(trait, genotypes) {
  return trait.rsids.map((rs) => {
    const num = rs.replace(/^rs/i, "");
    const raw = genotypes[num];
    const geno = normGeno(raw);
    const table = trait.effect[rs] || {};
    let meaning = null;
    if (geno) meaning = table[geno] || table[flip(geno)] || null;
    return { rsid: rs, genotype: geno, found: raw != null, meaning };
  });
}

export async function askTrait(question, genotypes) {
  const traits = await loadTraits();
  const trait = resolveTrait(question, traits);

  if (!trait) {
    return {
      trait: null, findings: [],
      answer:
        "I don't have that trait in my knowledge base yet. I can currently answer about: " +
        traits.map((t) => t.names[0]).join(", ") + ".",
    };
  }

  const findings = collectFindings(trait, genotypes);
  const present = findings.filter((f) => f.found && f.meaning);

  if (present.length === 0) {
    const anyRaw = findings.some((f) => f.found);
    return {
      trait, findings,
      answer: anyRaw
        ? `Your file has ${trait.names[0]} marker(s) but not in a form I can read confidently. Check the ClinVar/dbSNP records directly.`
        : `Your file doesn't include the marker${trait.rsids.length > 1 ? "s" : ""} for ${trait.names[0]} (${trait.rsids.join(", ")}), so I can't determine it. Consumer chips don't cover every position.`,
    };
  }

  const facts = {
    trait: trait.panel ? trait.panel_trait : trait.names[0],
    gene: trait.gene,
    is_panel: !!trait.panel,
    summary: trait.summary,
    markers_checked: trait.rsids.length,
    markers_found_in_your_file: present.length,
    your_markers: present.map((f) => ({ rsid: f.rsid, genotype: f.genotype, indicates: f.meaning })),
  };

  const system = trait.panel
    ? "You answer a genetic-trait question where the trait is driven by SEVERAL independent markers (a panel). " +
      "You are given the trait and the person's genotype + meaning for each marker found in their file. " +
      "Do NOT collapse this into a single flat verdict. Explain that multiple markers dictate this trait, " +
      "then report the breakdown: of the markers found in their file, how many point which way. " +
      "For example: 'A few markers dictate this. Of the 3 in your file, 2 are consistent with X and 1 is not.' " +
      "Then give the overall lean if there is one, noting any disagreement and that population background matters. " +
      "Add one line that consumer-array calls aren't clinically validated. Two or three short paragraphs."
    : "You answer a single genetic-trait question for someone looking at their own genotyping data. " +
      "You are given the trait, gene, a one-line summary, and the person's genotype with the established meaning. " +
      "Give a short, direct answer based on that genotype. State the result clearly, but add one line noting " +
      "consumer-array calls aren't clinically validated. Two short paragraphs at most.";

  const prompt = `Question: ${question}\n\nData:\n${JSON.stringify(facts, null, 2)}`;
  const res = await fetch("/api/explain", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system, prompt }),
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try { const j = await res.json(); if (j.error) msg = j.error; } catch { /* keep */ }
    throw new Error(msg);
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return { trait, findings, answer: (data.text || "").trim() };
}
