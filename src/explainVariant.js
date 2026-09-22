/**
 * explainVariant.js — ask a cloud model to explain a variant in plain language.
 *
 * PRIVACY: this sends ONLY public annotation data about the variant (rsID,
 * gene, ClinVar classification, condition, frequency). It never sends the
 * user's genotype, zygosity, carrier status, or file. The model explains the
 * *variant*, not the *person* — so nothing personal leaves the browser, and
 * the "your DNA never leaves your machine" promise holds.
 */

const SYSTEM_PROMPT = `You explain human genetic variants to an informed layperson, accurately and without alarmism.

You will be given PUBLIC database facts about a single variant. Explain only those facts. Do not recall variant details from memory — if a field is absent, say so rather than inventing it. Never guess a classification or frequency.

Cover, briefly:
- what the gene does, in one or two plain sentences
- what the ClinVar classification actually means (e.g. "pathogenic" describes the variant's effect in affected individuals, not this person's risk)
- penetrance / context: most variants are risk-modifiers or carrier states, not diagnoses; mention base rates when relevant
- the reliability caveat: consumer-genotyping arrays are not clinically validated, so any meaningful call should be confirmed by a clinical lab

Rules:
- Do NOT diagnose. Do NOT say "you have" or "you carry" — you are not told the person's genotype and must not assume it.
- Do NOT dramatize. No "cancer risk!" framing. Calibrate to what the classification and review status actually support.
- Weigh the ClinVar review status: a 1-star single-submitter call is far weaker evidence than a 3-star expert-panel one. Say so when the status is low.
- Keep it to a few short paragraphs. End by pointing to the ClinVar record for the source.`;

/**
 * @param {object} v  a variant row from the app (public fields only)
 * @returns {Promise<string>} the explanation text
 */
export async function explainVariant(v) {
  // Whitelist exactly the public fields we send. Note what is NOT here:
  // no genotype, no zygosity, no carrier flag.
  const publicFacts = {
    rsid: v.rsid ? `rs${v.rsid}` : null,
    gene: v.gene_symbol || null,
    variant_name: v.name || null,
    clinical_significance: v.clinical_significance || null,
    condition: v.phenotypes || null,
    review_status: v.review_status || null,
    number_of_submitters: v.number_submitters ?? null,
    gnomad_allele_frequency: v.gnomad_af ?? null,
    clinvar_variation_id: v.variation_id || null,
  };

  const userMessage =
    "Explain this variant using only these public facts:\n\n" +
    JSON.stringify(publicFacts, null, 2) +
    (publicFacts.clinvar_variation_id
      ? `\n\nClinVar record: https://www.ncbi.nlm.nih.gov/clinvar/variation/${publicFacts.clinvar_variation_id}/`
      : "");

  // Calls the local proxy (see vite.config.js), which holds the API key
  // server-side and talks to Gemini. The browser never sees the key. Only
  // public variant facts are in this request — never the user's genotype.
  const res = await fetch("/api/explain", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system: SYSTEM_PROMPT,
      prompt: userMessage,
    }),
  });

  if (!res.ok) {
    let msg = `Explainer request failed (${res.status})`;
    try { const j = await res.json(); if (j.error) msg = j.error; } catch { /* keep default */ }
    throw new Error(msg);
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return (data.text || "").trim();
}
