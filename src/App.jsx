import { useState } from "react";
import { initDb, matchRsids } from "./clinvarClient.js";
import { parse23andMe, classifyMatches } from "./pyengine.js";
import {
  BASE, sigRank, sigColor, zygInfo, CAT_LABELS, sigCategory,
  confInfo, hasSignal, variantLink, clusterByArea, conditionArea,
} from "./variantUtils.js";
import { explainVariant } from "./explainVariant.js";

/** Map raw failures to something the person can act on, in the app's voice. */
function friendlyError(err) {
  const m = (err && err.message) || String(err);
  if (/download failed|404|Failed to fetch|NetworkError/i.test(m))
    return "Couldn't load the ClinVar database. Make sure clinvar.sqlite is " +
           "present in the public/ folder and reload.";
  if (/OPFS|SAHPool|opfs|SharedAccessHandle/i.test(m))
    return "This browser blocked local database storage (OPFS). Try a recent " +
           "Chrome, Edge, or Safari - and not a private/incognito window, " +
           "which disables it.";
  if (/No rsIDs found/i.test(m)) return m; // already friendly
  if (/variant_logic|Pyodide|pyodide/i.test(m))
    return "Couldn't start the Python engine. Check your connection (Pyodide " +
           "loads once from a CDN) and reload.";
  return `Couldn't finish: ${m}`;
}

function Bases({ seq }) {
  const s = (seq || "").toUpperCase();
  if (!s || s.length > 6 || /[^ACGT]/.test(s))
    return <span className="seq-flat">{seq || "·"}</span>;
  return (
    <span>
      {s.split("").map((b, i) => (
        <span key={i} style={{ color: BASE[b] }}>{b}</span>
      ))}
    </span>
  );
}

async function loadXLSX() {
  if (window.XLSX) return window.XLSX;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("could not load the Excel library"));
    document.head.appendChild(s);
  });
  return window.XLSX;
}

export default function App() {
  const [status, setStatus] = useState("");
  const [results, setResults] = useState([]);
  const [summary, setSummary] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [homOnly, setHomOnly] = useState(false);
  const [minStars, setMinStars] = useState(0);
  const [category, setCategory] = useState("all");
  const [hideZero, setHideZero] = useState(true);
  const [area, setArea] = useState("all");
  const [dbMeta, setDbMeta] = useState(null);
  const [explain, setExplain] = useState({});   // key -> {loading, text, error}

  async function runExplain(key, v) {
    setExplain((e) => ({ ...e, [key]: { loading: true } }));
    try {
      const text = await explainVariant(v);
      setExplain((e) => ({ ...e, [key]: { text } }));
    } catch (err) {
      setExplain((e) => ({ ...e, [key]: { error: err.message } }));
    }
  }

  async function processFile(file) {
    if (!file) return;
    setBusy(true); setResults([]); setSummary(null);
    try {
      setStatus("Reading file");
      const text = await file.text();

      setStatus("Parsing genotypes (Python)");
      const { rsids, genotypes } = await parse23andMe(text);
      if (!rsids.length) {
        throw new Error(
          "No rsIDs found in this file. Expected raw 23andMe or AncestryDNA " +
          "data - a tab- or comma-separated file with an rsID in the first " +
          "column. This doesn't look like that."
        );
      }

      setStatus("Loading ClinVar database");
      const { meta } = await initDb({
        url: "/clinvar.sqlite",
        onProgress: (g, t) =>
          setStatus(`Loading database · ${(g / 1e6).toFixed(0)}${t ? " / " + (t / 1e6).toFixed(0) : ""} MB`),
      });
      setDbMeta(meta || null);

      setStatus(`Matching ${rsids.length.toLocaleString()} positions`);
      const matched = await matchRsids(rsids);

      setStatus("Interpreting (Python)");
      const annotated = await classifyMatches(matched, genotypes);
      annotated.sort((a, b) => sigRank(a.clinical_significance) - sigRank(b.clinical_significance));

      const carriers = annotated.filter((a) => a.carrier);
      const informative = carriers.filter((a) => hasSignal(a.clinical_significance));
      const pathogenic = carriers.filter((a) => {
        const t = (a.clinical_significance || "").toLowerCase();
        return t.includes("pathogenic") && !t.includes("conflict");
      });

      setResults(annotated);
      setSummary({
        fileVariants: rsids.length, matched: annotated.length,
        carriers: carriers.length, informative: informative.length,
        pathogenic: pathogenic.length,
      });
      setStatus("");
    } catch (err) {
      setStatus(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  const base = results.filter((r) => r.carrier && hasSignal(r.clinical_significance));
  const categories = [...new Set(base.map((r) => sigCategory(r.clinical_significance)))];
  // clusters computed over the confidence/type-filtered set (not the area
  // filter itself), so the dashboard always shows the full breakdown.
  const preArea = base
    .filter((r) => !homOnly || r.zygosity === "hom_alt")
    .filter((r) => {
      const stars = confInfo(r.review_status, r.number_submitters).stars;
      if (hideZero && stars === 0) return false;
      return stars >= minStars;
    })
    .filter((r) => category === "all" || sigCategory(r.clinical_significance) === category);
  const clusters = clusterByArea(preArea);
  const shown = preArea.filter((r) => area === "all" || conditionArea(r.phenotypes) === area);
  const hiddenZeroCount = hideZero
    ? base.filter((r) => confInfo(r.review_status, r.number_submitters).stars === 0).length
    : 0;
  // Render cap: keep the DOM light even when a file matches thousands of rows.
  // The Export .xlsx button always uses the full filtered set, not this slice.
  const RENDER_CAP = 300;
  const capped = shown.slice(0, RENDER_CAP);

  async function downloadExcel() {
    try {
      const XLSX = await loadXLSX();
      const rows = shown.map((v) => ({
        Gene: v.gene_symbol, rsID: "rs" + v.rsid, Significance: v.clinical_significance,
        Genotype: v.genotype, Zygosity: v.zygosity, Carrier: v.carrier ? "yes" : "no",
        Variant: v.name, Phenotypes: v.phenotypes, "ClinVar review": v.review_status,
        Submitters: v.number_submitters, Chr: v.chromosome, Pos: v.pos, Ref: v.ref, Alt: v.alt,
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "variants");
      XLSX.writeFile(wb, "yourvariants.xlsx");
    } catch (err) { setStatus(friendlyError(err)); }
  }

  return (
    <div className="yv">
      <style>{CSS}</style>

      <header className="yv-head">
        <div className="yv-mark">
          <span className="yv-name">Your Variants</span>
          <span className="yv-local"><i className="dot" />local · nothing uploaded</span>
        </div>
        <p className="yv-tag">Your DNA, matched against ClinVar - computed entirely in this browser.</p>
        {dbMeta && (dbMeta.clinvar_release || dbMeta.built) && (
          <p className="yv-dbmeta">
            ClinVar release {dbMeta.clinvar_release || "unknown"}
            {dbMeta.rows ? ` · ${Number(dbMeta.rows).toLocaleString()} records` : ""}
          </p>
        )}
        <div className="yv-track" aria-hidden="true" />
      </header>

      <label className={`yv-drop${dragging ? " drag" : ""}${busy ? " busy" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); processFile(e.dataTransfer.files?.[0]); }}>
        <input type="file" accept=".txt,.csv,.tsv" disabled={busy}
          onChange={(e) => processFile(e.target.files?.[0])} />
        <span className="yv-drop-main">{busy ? (status || "Working…") : "Drop your 23andMe raw data"}</span>
        <span className="yv-drop-sub">{busy ? "" : "or click to choose a file · stays on this device"}</span>
        {busy && <span className="yv-bar" />}
      </label>

      {!busy && status && <p className="yv-err">{status}</p>}

      {summary && (
        <div className="yv-stats">
          <Stat n={summary.fileVariants} label="in file" />
          <Stat n={summary.matched} label="in ClinVar" />
          <Stat n={summary.carriers} label="carried" />
          <Stat n={summary.informative} label="with signal" accent={BASE.G} />
          <Stat n={summary.pathogenic} label="pathogenic"
            accent={summary.pathogenic ? BASE.T : BASE.A} />
        </div>
      )}

      {clusters.length > 0 && (
        <div className="yv-dash">
          <div className="yv-dash-head">
            <span>Grouped by condition area</span>
            {area !== "all" && (
              <button className="yv-dash-clear" onClick={() => setArea("all")}>clear ✕</button>
            )}
          </div>
          <div className="yv-dash-rows">
            {clusters.map((cl) => {
              const max = clusters[0].count || 1;
              const on = area === cl.area;
              return (
                <button key={cl.area}
                  className={`yv-dash-row${on ? " on" : ""}`}
                  onClick={() => setArea(on ? "all" : cl.area)}>
                  <span className="yv-dash-label">{cl.area}</span>
                  <span className="yv-dash-bar-wrap">
                    <span className="yv-dash-bar" style={{ width: `${(cl.count / max) * 100}%` }} />
                  </span>
                  <span className="yv-dash-count">{cl.count}</span>
                </button>
              );
            })}
          </div>
          <p className="yv-dash-note">Organized by the condition ClinVar lists - a way to navigate your matches, not a ranking of importance. Click an area to filter.</p>
        </div>
      )}

      {results.length > 0 && (
        <div className="yv-controls">
          <button className="yv-btn" onClick={downloadExcel} disabled={busy}>Export .xlsx</button>
          <label className="yv-toggle">
            <input type="checkbox" checked={homOnly} onChange={(e) => setHomOnly(e.target.checked)} />
            homozygous only
          </label>
          <label className="yv-toggle" title="0★ entries have no assertion criteria - a lone submitter's unreviewed claim.">
            <input type="checkbox" checked={hideZero} onChange={(e) => setHideZero(e.target.checked)} />
            hide 0★{hiddenZeroCount ? ` (${hiddenZeroCount})` : ""}
          </label>
          <label className="yv-select">
            confidence
            <select value={minStars} onChange={(e) => setMinStars(Number(e.target.value))}>
              <option value={0}>any (0★+)</option>
              <option value={1}>1★+ - has criteria</option>
              <option value={2}>2★+ - corroborated</option>
              <option value={3}>3★+ - expert panel</option>
              <option value={4}>4★ - guideline</option>
            </select>
          </label>
          <label className="yv-select">
            type
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="all">all types</option>
              {categories.map((c) => (
                <option key={c} value={c}>{CAT_LABELS[c] || c}</option>
              ))}
            </select>
          </label>
          <span className="yv-count">{shown.length.toLocaleString()} shown</span>
        </div>
      )}

      <div className="yv-list">
        {capped.map((v, i) => {
          const c = sigColor(v.clinical_significance);
          const href = variantLink(v);
          return (
            <article className="yv-card" key={i} style={{ "--rail": c, animationDelay: `${Math.min(i, 14) * 22}ms` }}>
              <div className="yv-card-top">
                <span className="yv-gene">{v.gene_symbol || "-"}</span>
                {href ? (
                  <a className="yv-rs yv-rs-link" href={href} target="_blank" rel="noopener noreferrer"
                     title="Open the source record on NCBI - verify this call yourself">
                    rs{v.rsid} ↗
                  </a>
                ) : (
                  <span className="yv-rs">rs{v.rsid}</span>
                )}
                <span className="yv-sig" style={{ color: c, borderColor: c }}>
                  {v.clinical_significance || "unclassified"}
                </span>
              </div>
              {v.name && <div className="yv-vname">{v.name}</div>}
              <div className="yv-data">
                <span className="yv-chip">
                  <Bases seq={v.ref} /><span className="arr">→</span><Bases seq={v.alt} />
                </span>
                <span className="yv-chip">{v.genotype || "?"}</span>
                {v.gnomad_af != null && (
                  <span className="yv-chip" title="gnomAD global allele frequency">
                    gnomAD {(v.gnomad_af * 100 < 0.01)
                      ? "<0.01%"
                      : (v.gnomad_af * 100).toFixed(2) + "%"}
                  </span>
                )}
                {(() => { const z = zygInfo(v.zygosity); return (
                  <span className="yv-chip zyg" style={{ color: z.color, borderColor: z.color }}>
                    {z.label}{v.strand === "flipped" ? " ⟲" : ""}
                  </span>
                ); })()}
              </div>
              {v.phenotypes && v.phenotypes.toLowerCase() !== "not provided" && (
                <div className="yv-phen">
                  <span className="yv-phen-label">Associated conditions</span>
                  <div className="yv-phen-tags">
                    {[...new Set(v.phenotypes.split("|").map((p) => p.trim())
                      .filter((p) => p && p.toLowerCase() !== "not provided" && p.toLowerCase() !== "not specified"))]
                      .slice(0, 6).map((p, k) => <span className="yv-tag" key={k}>{p}</span>)}
                  </div>
                </div>
              )}
              {(() => { const c = confInfo(v.review_status, v.number_submitters); return (
                <div className="yv-rev">
                  <span className="yv-conf-dot" style={{ background: c.color }} />
                  <span className="yv-conf-tier" style={{ color: c.color }}>{c.tier}</span>
                  <span className="yv-conf-detail">({c.detail})</span>
                </div>
              ); })()}
              {(() => {
                const key = `${v.rsid}-${v.variation_id || i}`;
                const st = explain[key] || {};
                return (
                  <div className="yv-explain">
                    <button className="yv-explain-btn" disabled={st.loading}
                      onClick={() => runExplain(key, v)}>
                      {st.loading ? "Asking Sofia…" : st.text ? "↻ Re-explain" : "✦ Explain with Sofia"}
                    </button>
                    {st.error && <div className="yv-explain-err">Couldn't explain: {st.error}</div>}
                    {st.text && (
                      <div className="yv-explain-body">
                        {st.text.split("\n").filter(Boolean).map((p, k) => <p key={k}>{p}</p>)}
                        <div className="yv-explain-foot">AI-generated from public ClinVar/gnomAD data - not medical advice.</div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </article>
          );
        })}
        {shown.length > RENDER_CAP && (
          <p className="yv-empty">
            Showing the first {RENDER_CAP.toLocaleString()} of {shown.length.toLocaleString()}.
            Narrow with the filters above, or use Export .xlsx for the full set.
          </p>
        )}
        {results.length > 0 && shown.length === 0 && (
          <p className="yv-empty">Nothing matches these filters. Loosen the confidence tier, clear the type filter, or turn off “hide 0★”.</p>
        )}
        {results.length === 0 && !busy && (
          <p className="yv-empty">No file loaded. Everything is read and analyzed here, on your device - nothing is uploaded.</p>
        )}
      </div>

      <footer className="yv-foot">
        Informational only · not a medical test or diagnosis · confirm anything meaningful with a clinician.
      </footer>
    </div>
  );
}

function Stat({ n, label, accent }) {
  return (
    <div className="yv-stat">
      <span className="yv-stat-n" style={accent ? { color: accent } : undefined}>{n.toLocaleString()}</span>
      <span className="yv-stat-l">{label}</span>
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=JetBrains+Mono:wght@400;500;700&display=swap');
:root{ color-scheme: dark; }
html,body,#root{ margin:0; background:#0B0F12; min-height:100%; }
.yv{
  --ink:#E8EDEE; --muted:#7C8A90; --line:#202A2F; --panel:#121A1E; --panel2:#0F1619;
  max-width:880px; margin:0 auto; padding:40px 22px 80px;
  font-family:'Space Grotesk',system-ui,sans-serif; color:var(--ink);
  background:#0B0F12;
}
.yv *{ box-sizing:border-box; }
.mono,.yv-rs,.yv-chip,.yv-stat-n,.yv-rev{ font-family:'JetBrains Mono',ui-monospace,monospace; }

.yv-head{ margin-bottom:30px; }
.yv-mark{ display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
.yv-name{ font-size:30px; font-weight:700; letter-spacing:-.01em; }
.yv-local{ font-family:'JetBrains Mono',monospace; font-size:11px; color:var(--muted);
  border:1px solid var(--line); border-radius:999px; padding:3px 9px; display:inline-flex; align-items:center; gap:6px; }
.yv-local .dot{ width:6px; height:6px; border-radius:50%; background:#3FB68B; box-shadow:0 0 8px #3FB68B; animation:pulse 2.4s ease-in-out infinite; }
.yv-tag{ color:var(--muted); margin:10px 0 16px; font-size:15px; max-width:48ch; }
.yv-track{ height:6px; border-radius:2px;
  background:repeating-linear-gradient(90deg,#3FB68B 0 3px,#0B0F12 3px 6px,#4C8DD6 6px 9px,#0B0F12 9px 12px,#E0A33E 12px 15px,#0B0F12 15px 18px,#D9544D 18px 21px,#0B0F12 21px 24px);
  opacity:.85; }

.yv-drop{ display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px;
  position:relative; overflow:hidden; text-align:center; cursor:pointer;
  border:1px dashed var(--line); border-radius:14px; padding:34px 20px; background:var(--panel2);
  transition:border-color .18s, background .18s; }
.yv-drop:hover{ border-color:#39474D; }
.yv-drop.drag{ border-color:#4C8DD6; background:#0E171D; }
.yv-drop.busy{ cursor:progress; border-style:solid; }
.yv-drop input{ position:absolute; inset:0; opacity:0; cursor:inherit; }
.yv-drop-main{ font-size:16px; font-weight:500; }
.yv-drop-sub{ font-size:12.5px; color:var(--muted); }
.yv-bar{ position:absolute; left:0; bottom:0; height:2px; width:35%; background:#4C8DD6;
  animation:scan 1.1s ease-in-out infinite; }

.yv-err{ color:#D9544D; font-size:13px; margin:12px 2px; font-family:'JetBrains Mono',monospace; }

.yv-stats{ display:grid; grid-template-columns:repeat(5,1fr); gap:1px; background:var(--line);
  border:1px solid var(--line); border-radius:12px; overflow:hidden; margin:22px 0 6px; }
.yv-stat{ background:var(--panel); padding:14px 12px; display:flex; flex-direction:column; gap:3px; }
.yv-stat-n{ font-size:22px; font-weight:700; line-height:1; }
.yv-stat-l{ font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }

.yv-controls{ display:flex; align-items:center; gap:16px; margin:18px 2px 14px; flex-wrap:wrap; }
.yv-btn{ font:500 13px 'Space Grotesk',sans-serif; color:#0B0F12; background:var(--ink);
  border:none; border-radius:8px; padding:8px 14px; cursor:pointer; transition:opacity .15s; }
.yv-btn:hover:not(:disabled){ opacity:.85; }
.yv-btn:disabled{ opacity:.4; cursor:default; }
.yv-toggle{ display:flex; align-items:center; gap:7px; font-size:13px; color:var(--muted); cursor:pointer; }
.yv-toggle input{ accent-color:#4C8DD6; }
.yv-count{ margin-left:auto; font-family:'JetBrains Mono',monospace; font-size:12px; color:var(--muted); }

.yv-list{ display:flex; flex-direction:column; gap:10px; }
.yv-card{ position:relative; background:var(--panel); border:1px solid var(--line);
  border-left:3px solid var(--rail); border-radius:10px; padding:13px 15px 12px;
  animation:rise .3s ease both; }
.yv-card-top{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.yv-gene{ font-size:16px; font-weight:700; letter-spacing:-.01em; }
.yv-rs{ font-size:12px; color:var(--muted); }
.yv-rs-link{ text-decoration:none; border-bottom:1px dotted #3B4A50; transition:color .15s, border-color .15s; }
.yv-rs-link:hover{ color:#4C8DD6; border-color:#4C8DD6; }
.yv-dbmeta{ font-family:'JetBrains Mono',monospace; font-size:11px; color:#5E6B70; margin:2px 0 14px; }
.yv-dash{ background:#0E1619; border:1px solid #1B2A2E; border-radius:12px; padding:16px 18px; margin:0 0 18px; }
.yv-dash-head{ display:flex; justify-content:space-between; align-items:center; font-size:13px; color:#8FA0A5; text-transform:uppercase; letter-spacing:.06em; margin-bottom:12px; }
.yv-dash-clear{ background:transparent; border:none; color:#5FE3C0; font-size:12px; cursor:pointer; }
.yv-dash-rows{ display:flex; flex-direction:column; gap:6px; }
.yv-dash-row{ display:grid; grid-template-columns:200px 1fr 40px; align-items:center; gap:12px;
  background:transparent; border:none; cursor:pointer; padding:5px 8px; border-radius:7px; text-align:left; transition:background .15s; }
.yv-dash-row:hover{ background:#12211C; }
.yv-dash-row.on{ background:#15302A; }
.yv-dash-label{ font-size:13px; color:#C7D2D6; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.yv-dash-bar-wrap{ height:10px; background:#16232700; border-radius:5px; overflow:hidden; }
.yv-dash-bar{ display:block; height:100%; border-radius:5px; background:linear-gradient(90deg,#2E8B6B,#5FE3C0); }
.yv-dash-count{ font-family:'JetBrains Mono',monospace; font-size:13px; color:#8FA0A5; text-align:right; }
.yv-dash-note{ font-size:11px; color:#5E6B70; margin:12px 0 0; }
.yv-explain{ margin-top:12px; border-top:1px solid #1B2A2E; padding-top:10px; }
.yv-explain-btn{ font-size:12px; background:transparent; color:#5FE3C0; border:1px solid #2A5B50;
  border-radius:6px; padding:5px 12px; cursor:pointer; transition:background .15s,border-color .15s; }
.yv-explain-btn:hover:not(:disabled){ background:#12241F; border-color:#3FB68B; }
.yv-explain-btn:disabled{ opacity:.6; cursor:default; }
.yv-explain-err{ font-size:12px; color:#D9544D; margin-top:8px; }
.yv-explain-body{ margin-top:10px; font-size:13.5px; line-height:1.5; color:#C7D2D6; }
.yv-explain-body p{ margin:0 0 8px; }
.yv-explain-foot{ font-size:11px; color:#5E6B70; font-style:italic; margin-top:6px; }
.yv-sig{ margin-left:auto; font-size:11px; font-weight:500; border:1px solid; border-radius:999px; padding:2px 9px; }
.yv-vname{ font-size:12.5px; color:var(--muted); margin-top:4px; word-break:break-word; }
.yv-data{ display:flex; gap:7px; margin-top:9px; flex-wrap:wrap; }
.yv-chip{ font-size:13px; background:var(--panel2); border:1px solid var(--line); border-radius:6px;
  padding:3px 9px; letter-spacing:.02em; }
.yv-chip .arr{ color:var(--muted); margin:0 5px; }
.yv-chip.zyg{ color:var(--muted); font-weight:500; }
.seq-flat{ color:var(--muted); }
.yv-phen{ margin-top:12px; }
.yv-phen-label{ font-size:9.5px; letter-spacing:.1em; text-transform:uppercase; color:#5E6B70; }
.yv-phen-tags{ display:flex; flex-wrap:wrap; gap:5px; margin-top:6px; }
.yv-tag{ font-size:11.5px; color:#C5D0D4; background:var(--panel2); border:1px solid var(--line);
  border-radius:5px; padding:3px 8px; line-height:1.3; }
.yv-rev{ display:flex; align-items:center; gap:8px; font-size:13px; color:#5E6B70;
  margin-top:11px; letter-spacing:.02em; flex-wrap:wrap; }
.yv-conf-dot{ width:12px; height:12px; border-radius:50%; flex:none; box-shadow:0 0 0 3px rgba(255,255,255,.04); }
.yv-conf-tier{ font-weight:700; font-family:'JetBrains Mono',monospace; font-size:13px; }
.yv-conf-detail{ color:#8A979C; font-size:13px; }
.yv-select{ display:flex; align-items:center; gap:7px; font-size:13px; color:var(--muted); }
.yv-select select{ font:500 13px 'Space Grotesk',sans-serif; color:var(--ink);
  background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:6px 9px; cursor:pointer; }
.yv-empty{ color:var(--muted); font-size:14px; padding:18px 2px; }

.yv-foot{ margin-top:42px; padding-top:16px; border-top:1px solid var(--line);
  font-size:11.5px; color:#5E6B70; }

@keyframes pulse{ 0%,100%{opacity:1} 50%{opacity:.35} }
@keyframes scan{ 0%{left:-35%} 100%{left:100%} }
@keyframes rise{ from{opacity:0; transform:translateY(6px)} to{opacity:1; transform:none} }
@media (max-width:620px){ .yv-stats{ grid-template-columns:repeat(2,1fr); } }
@media (prefers-reduced-motion:reduce){ *{ animation:none !important; } }
:focus-visible{ outline:2px solid #4C8DD6; outline-offset:2px; }
`;
