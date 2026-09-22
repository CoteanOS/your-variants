import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Local explain proxy (Google Gemini).
 *
 * The browser must never hold your API key (anyone could read it in devtools).
 * So the key lives in a git-ignored .env.local file, and this middleware,
 * running inside the Vite dev server, reads it and forwards explanation
 * requests to the Gemini API. The frontend calls /api/explain with
 * { system, prompt }; only this server-side code ever sees the key.
 *
 * Set it up:  copy .env.local.example to .env.local and put your key in it:
 *   GEMINI_API_KEY=AIza...
 * Get a free key at https://aistudio.google.com/apikey
 * Then `npm run dev` as usual. If the key is missing, /api/explain returns a
 * clear error and the rest of the app works normally.
 */
const GEMINI_MODEL = "gemini-3.7-flash";

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

          const url =
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
          const body = {
            systemInstruction: system ? { parts: [{ text: system }] } : undefined,
            contents: [{ role: "user", parts: [{ text: prompt || "" }] }],
            generationConfig: { maxOutputTokens: 1024 },
          };

          const upstream = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await upstream.json();
          if (!upstream.ok) {
            const msg = data?.error?.message || `Gemini error ${upstream.status}`;
            return json(upstream.status, { error: msg });
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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), explainProxy(env)],
    optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  };
});
