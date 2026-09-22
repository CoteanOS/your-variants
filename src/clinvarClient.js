/**
 * clinvarClient.js — import THIS from React (not the worker).
 * Spins up clinvarWorker.js and exposes promise-based functions.
 */

let worker = null;
let nextId = 1;
const pending = new Map();
let progressCb = null;

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./clinvarWorker.js", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === "progress") {
      if (progressCb) progressCb(msg.received, msg.total);
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  };
  return worker;
}

function call(method, args) {
  ensureWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, method, args });
  });
}

export function initDb({ url, onProgress, forceReload = false } = {}) {
  progressCb = onProgress || null;
  return call("init", { url, forceReload });
}

export const lookupByGene = (gene, limit) => call("lookupByGene", { gene, limit });
export const lookupByRsid = (rsid) => call("lookupByRsid", { rsid });
export const matchRsids = (rsids) => call("matchRsids", { rsids });
