import { useState } from "react";
import { askTrait } from "./askTrait.js";

/**
 * TraitChat — ask your genome a plain-English trait question.
 * Pass the parsed genotypes map (rsid-number -> genotype) as `genotypes`.
 * Reuses the same /api/explain proxy (bring-your-own-key) as Sofia.
 *
 * Usage in App.jsx, once you have genotypes from parsing:
 *   import TraitChat from "./TraitChat.jsx";
 *   {genotypes && <TraitChat genotypes={genotypes} />}
 */
export default function TraitChat({ genotypes }) {
  const [q, setQ] = useState("");
  const [log, setLog] = useState([]);       // {role, text}
  const [busy, setBusy] = useState(false);

  const suggestions = [
    "Am I lactose tolerant?",
    "Do I metabolize caffeine fast?",
    "Do I get alcohol flush?",
    "Wet or dry earwax?",
  ];

  async function ask(question) {
    const text = (question ?? q).trim();
    if (!text || busy) return;
    setLog((l) => [...l, { role: "you", text }]);
    setQ("");
    setBusy(true);
    try {
      const { answer } = await askTrait(text, genotypes || {});
      setLog((l) => [...l, { role: "sofia", text: answer }]);
    } catch (e) {
      setLog((l) => [...l, { role: "sofia", text: `Couldn't answer: ${e.message}` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tc">
      <div className="tc-head">Ask your genome</div>

      {log.length === 0 && (
        <div className="tc-suggest">
          {suggestions.map((s) => (
            <button key={s} className="tc-chip" onClick={() => ask(s)}>{s}</button>
          ))}
        </div>
      )}

      <div className="tc-log">
        {log.map((m, i) => (
          <div key={i} className={`tc-msg tc-${m.role}`}>
            {m.text.split("\n").filter(Boolean).map((p, k) => <p key={k}>{p}</p>)}
          </div>
        ))}
        {busy && <div className="tc-msg tc-sofia tc-typing">Sofia is checking your variants…</div>}
      </div>

      <div className="tc-input">
        <input
          value={q}
          placeholder="e.g. Am I genetically lactose tolerant?"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask()}
          disabled={busy}
        />
        <button onClick={() => ask()} disabled={busy || !q.trim()}>Ask</button>
      </div>

      <p className="tc-foot">
        Answers well-known single-marker traits from your file. Informational only, not medical advice.
      </p>

      <style>{`
        .tc{ background:#0E1619; border:1px solid #1B2A2E; border-radius:12px; padding:16px 18px; margin:0 0 18px; }
        .tc-head{ font-size:13px; color:#8FA0A5; text-transform:uppercase; letter-spacing:.06em; margin-bottom:12px; }
        .tc-suggest{ display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px; }
        .tc-chip{ font-size:12px; background:#12211C; color:#8FE3C8; border:1px solid #2A5B50; border-radius:16px; padding:5px 12px; cursor:pointer; }
        .tc-chip:hover{ background:#15302A; }
        .tc-log{ display:flex; flex-direction:column; gap:10px; }
        .tc-msg{ font-size:13.5px; line-height:1.5; border-radius:9px; padding:9px 12px; max-width:90%; }
        .tc-msg p{ margin:0 0 6px; } .tc-msg p:last-child{ margin:0; }
        .tc-you{ align-self:flex-end; background:#15302A; color:#DCEFE9; }
        .tc-sofia{ align-self:flex-start; background:#111A1D; color:#C7D2D6; border:1px solid #1B2A2E; }
        .tc-typing{ opacity:.7; font-style:italic; }
        .tc-input{ display:flex; gap:8px; margin-top:12px; }
        .tc-input input{ flex:1; background:#0B1214; border:1px solid #24343A; border-radius:8px; padding:9px 12px; color:#DCEFE9; font-size:13.5px; }
        .tc-input input:focus{ outline:none; border-color:#3FB68B; }
        .tc-input button{ background:#2E8B6B; color:#EAFFF7; border:none; border-radius:8px; padding:9px 16px; cursor:pointer; font-size:13.5px; }
        .tc-input button:disabled{ opacity:.5; cursor:default; }
        .tc-foot{ font-size:11px; color:#5E6B70; margin:10px 0 0; }
      `}</style>
    </div>
  );
}
