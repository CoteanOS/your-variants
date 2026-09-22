/**
 * pyengine.js — loads Pyodide (Python in the browser) and runs variant_logic.py.
 *
 * No npm install: Pyodide is pulled from the CDN. If the version below 404s,
 * bump PYODIDE_VERSION to a current release (see pyodide.org/downloads).
 *
 * variant_logic.py must live in public/ so it's fetchable at /variant_logic.py.
 */

const PYODIDE_VERSION = "0.27.2";
const CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

let pyodidePromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("failed to load Pyodide script"));
    document.head.appendChild(s);
  });
}

async function getPyodide() {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      await loadScript(CDN + "pyodide.js");
      // window.loadPyodide is provided by the CDN script.
      const py = await window.loadPyodide({ indexURL: CDN });
      const src = await fetch("/variant_logic.py").then((r) => {
        if (!r.ok) throw new Error("could not fetch /variant_logic.py");
        return r.text();
      });
      py.runPython(src); // defines parse_23andme + classify_matches
      return py;
    })();
  }
  return pyodidePromise;
}

/** Parse raw 23andMe text -> { rsids:[...], genotypes:{rsid: geno} }. */
export async function parse23andMe(text) {
  const py = await getPyodide();
  py.globals.set("_input_text", text);
  const out = py.runPython("parse_23andme(_input_text)");
  return JSON.parse(out);
}

/** Annotate matched ClinVar rows with the user's genotype + carrier status. */
export async function classifyMatches(matchedRows, genotypes) {
  const py = await getPyodide();
  py.globals.set("_matched_json", JSON.stringify(matchedRows));
  py.globals.set("_genos_json", JSON.stringify(genotypes));
  const out = py.runPython("classify_matches(_matched_json, _genos_json)");
  return JSON.parse(out);
}
