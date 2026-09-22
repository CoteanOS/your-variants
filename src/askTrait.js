/**
 * askTrait.js — natural-language trait querying over the user's variants.
 *
 * Flow (agentic, with a lookup tool):
 *   question ─► resolve to a trait + its rsIDs   (traits.json, fuzzy match)
 *            ─► filter the user's OWN variants to those rsIDs
 *            ─► read the genotype, map to a plain meaning
 *            ─► ask the model to phrase a calibrated answer
 *
 * Privacy: only the specific trait's public facts + the single genotype for
 * that trait are sent to the model — never the whole genome.
 */

let TRAITS = null;

async function loadTraits() {
  if (TRAITS) return TRAITS;
  const res = await fetch("/traits.json");
  TRAITS = (await res.json()).traits;
  return TRAITS;
}

/** Normalize a genotype string ("A;G", "AG", "G/A") to sorted "AG". */
function normGeno(g) {
  if (!g) return null;
  const bases = g.toUpperCase().replace(/[^ACGT]/g, "");
  if (bases.length < 2) return bases || null;
  return bases.split("").sort().join("");
}

/** Complement for strand-flip fallback. */
const COMP = { A: "T", T: "A", C: "G", G: "C" };
function flip(geno) {
  return geno ? geno.split("").map((b) => COMP[b] || b).sort().join("") : null;
}

// words too generic to identify a trait on their own
const STOP = new Set(["i", "a", "the", "is", "am", "do", "my", "me", "can",
  "does", "if", "of", "or", "and", "to", "what", "how", "about", "genetically",
  "genetic", "have", "has", "for", "tolerance", "tolerant", "metabolism",
  "metabolize", "type", "taste", "when"]);

/** Find the best-matching trait for a free-text question.
 *  Matches on shared meaningful words, so "am I lactose tolerant?" still
 *  finds the "lactose tolerance" trait even though the phrase differs. */
export function resolveTrait(question, traits) {
  const q = " " + question.toLowerCase().replace(/[^a-z0-9 ]/g, " ") + " ";
  const qWords = new Set(q.split(/\s+/).filter((w) => w && !STOP.has(w)));
  let best = null, bestScore = 0;

  for (const t of traits) {
    let score = 0;
    // a bare rsID or gene symbol is a definitive match
    for (const rs of t.rsids) if (q.includes(rs.toLowerCase())) score = Math.max(score, 100);
    if (qWords.has(t.gene.toLowerCase())) score = Math.max(score, 50);
    // otherwise, count meaningful words shared with any of the trait's names
    for (const name of t.names) {
      const nameWords = name.toLowerCase().split(/\s+/).filter((w) => !STOP.has(w));
      const hits = nameWords.filter((w) => qWords.has(w)).length;
      if (hits > 0) score = Math.max(score, hits * 10 + name.length * 0.01);
    }
    if (score > bestScore) { best = t; bestScore = score; }
  }
  return bestScore > 0 ? best : null;
}

/**
 * Answer a trait question.
 * @param {string} question
 * @param {Object<string,string>} genotypes  map of rsid-number -> genotype, from the parsed file
 * @returns {Promise<{trait, findings, answer}>}
 */
export async function askTrait(question, genotypes) {
  const traits = await loadTraits();
  const trait = resolveTrait(question, traits);

  if (!trait) {
    return {
      trait: null,
      findings: [],
      answer:
        "I don't have that trait in my knowledge base yet. I can currently answer about: " +
        traits.map((t) => t.names[0]).join(", ") + ".",
    };
  }

  // look up the user's genotype at each of the trait's rsIDs
  const findings = trait.rsids.map((rs) => {
    const num = rs.replace(/^rs/i, "");
    const raw = genotypes[num];
    const geno = normGeno(raw);
    const table = trait.effect[rs] || {};
    let meaning = null;
    if (geno) {
      meaning = table[geno] || table[flip(geno)] || null;
    }
    return { rsid: rs, genotype: geno, found: raw != null, meaning };
  });

  const anyFound = findings.some((f) => f.found);
  if (!anyFound) {
    return {
      trait, findings,
      answer:
        `Your file doesn't include the marker${trait.rsids.length > 1 ? "s" : ""} for ${trait.names[0]} ` +
        `(${trait.rsids.join(", ")}), so I can't determine it. Consumer chips don't cover every position.`,
    };
  }

  // Build the public facts to send — only this trait's data, plus the
  // genotype(s) for it. Not the rest of the genome.
  const facts = {
    trait: trait.names[0],
    gene: trait.gene,
    summary: trait.summary,
    your_results: findings
      .filter((f) => f.found)
      .map((f) => ({ rsid: f.rsid, genotype: f.genotype, known_meaning: f.meaning })),
  };

  const system =
    "You answer a single genetic-trait question for someone looking at their own genotyping data. " +
    "You are given the trait, the gene, a one-line summary, and the person's genotype with the established meaning of that genotype. " +
    "Give a short, direct, plain-language answer to their question based on that genotype. " +
    "State the result clearly (these are well-established common-trait associations, so you can be direct), " +
    "but add one line noting consumer-array calls aren't clinically validated. Two short paragraphs at most.";

  const prompt =
    `Question: ${question}\n\nData:\n${JSON.stringify(facts, null, 2)}`;

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
