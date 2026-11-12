/**
 * aiClient.js - one entry point for the Gemini call, used by both the web and
 * desktop builds.
 *
 * - Web (Vite dev server): posts to the /api/explain proxy in vite.config.js,
 *   which holds the key server-side.
 * - Desktop (Tauri): calls the Rust `explain` command, which holds the key in
 *   the OS keychain. Detected by the presence of window.__TAURI_INTERNALS__.
 *
 * Either way the browser never holds the key, and only the public facts passed
 * in `system`/`prompt` leave the machine - never the user's genotype.
 */
export async function askModel(system, prompt) {
  const isTauri =
    typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    const text = await invoke("explain", { system, prompt });
    return (text || "").trim();
  }

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
  return (data.text || "").trim();
}
