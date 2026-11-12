import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import process from "node:process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Local explain proxy (Google Gemini).
 *
 * The browser must never hold your API key (anyone could read it in devtools).
 * So the key lives in a git-ignored .env.local file, and this middleware -
 * running inside the Vite dev server - reads it and forwards explanation
 * requests to the Gemini API. The frontend calls /api/explain with
 * { system, prompt }; only this server-side code ever sees the key.
 *
 * Set it up:  copy .env.local.example to .env.local and put your key in it:
 *   GEMINI_API_KEY=AIza...
 * Get a free key at https://aistudio.google.com/apikey
 * Then `npm run dev` as usual. If the key is missing, /api/explain returns a
 * clear error and the rest of the app works normally.
 */
const GEMINI_MODEL = "gemini-3.5-flash";
// Used when the main model is overloaded or too slow.
const GEMINI_FALLBACK_MODEL = "gemini-3.5-flash-lite";

function explainProxy(env) {
  return {
    name: "explain-proxy",
    configureServer(server) {
      server.middlewares.use("/api/explain", async (req, res) => {
        const json = (code, obj) => {
          res.statusCode = code;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(obj));
        };
        if (req.method !== "POST") return json(405, { error: "POST only" });

        const key = env.GEMINI_API_KEY;
        if (!key) {
          return json(500, {
            error: "No GEMINI_API_KEY set. Put it in .env.local (see .env.local.example). Free key: https://aistudio.google.com/apikey",
          });
        }
        try {
          let raw = "";
          for await (const chunk of req) raw += chunk;
          const { system, prompt } = JSON.parse(raw || "{}");

          const body = {
            systemInstruction: system ? { parts: [{ text: system }] } : undefined,
            contents: [{ role: "user", parts: [{ text: prompt || "" }] }],
            generationConfig: { maxOutputTokens: 2048 },
          };

          // Gemini returns 503 (overloaded) / 429 (rate limit) transiently,
          // especially on the free tier. Try the main model twice, then the
          // lighter fallback twice. Any other error stops at once.
          let data = {};
          let status = 504;
          let ok = false;
          attempts: for (const model of [GEMINI_MODEL, GEMINI_FALLBACK_MODEL]) {
            const url =
              `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
            for (let attempt = 0; attempt < 2; attempt++) {
              const ctrl = new AbortController();
              const t = setTimeout(() => ctrl.abort(), 45000); // 45s per try
              try {
                const upstream = await fetch(url, {
                  method: "POST",
                  headers: { "content-type": "application/json", "x-goog-api-key": key },
                  body: JSON.stringify(body),
                  signal: ctrl.signal,
                });
                status = upstream.status;
                data = await upstream.json().catch(() => ({}));
                ok = upstream.ok;
              } catch (e) {
                console.error(`[explain] ${model} failed:`, e.name || String(e));
                status = 504;
                data = { error: { message: "Gemini is slow right now and did not answer. Try again in a moment." } };
                ok = false;
              } finally {
                clearTimeout(t);
              }
              if (ok) break attempts;
              console.error(`[explain] ${model} ${status}:`, JSON.stringify(data).slice(0, 300));
              if (status !== 503 && status !== 429 && status !== 504) break attempts;
              await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
            }
          }
          if (!ok) {
            const msg = data?.error?.message ||
              (status === 503
                ? "Gemini is temporarily overloaded (503). Try again in a moment."
                : `Gemini error ${status}`);
            return json(status, { error: msg });
          }
          const text = (data?.candidates?.[0]?.content?.parts || [])
            .map((p) => p.text || "")
            .join("")
            .trim();
          return json(200, { text });
        } catch (e) {
          return json(502, { error: String(e) });
        }
      });
    },
  };
}

/**
 * Desktop build only: the app downloads the database on first launch, so the
 * local copy in public/ must not be packed into the installer.
 */
function leaveDatabaseOut() {
  return {
    name: "leave-database-out",
    apply: "build",
    closeBundle() {
      if (!process.env.TAURI_ENV_PLATFORM) return;
      for (const f of ["clinvar.sqlite", "test_variant_logic.py"]) {
        rmSync(resolve("dist", f), { force: true });
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), explainProxy(env), leaveDatabaseOut()],
    optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  };
});
