import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { readMarker, resolveTrait } from "./askTrait.js";

const traits = JSON.parse(readFileSync("public/traits.json", "utf8")).traits;
const lactose = traits.find((t) => t.id === "lactose");

describe("readMarker", () => {
  it("reads a forward-strand genotype directly", () => {
    expect(readMarker(lactose.effect.rs4988235, "GG").meaning).toMatch(/non-persistence/);
    expect(readMarker(lactose.effect.rs4988235, "AG").meaning).toMatch(/^persistence/);
  });
  it("flips a reverse-strand genotype on an unambiguous marker", () => {
    // rs182549 is C/T forward; a file reporting the reverse strand shows G/A
    expect(readMarker(lactose.effect.rs182549, "GG").meaning).toMatch(/non-persistence/);
    expect(readMarker(lactose.effect.rs182549, "AA").meaning).toMatch(/^persistence/);
  });
  it("never flips a C/G marker", () => {
    // reference genotype on the forward strand must read as non-persistence
    expect(readMarker(lactose.effect.rs41525747, "GG").meaning).toMatch(/non-persistence/);
    expect(readMarker(lactose.effect.rs145946881, "CC").meaning).toMatch(/non-persistence/);
  });
  it("returns no meaning for an unreadable genotype", () => {
    expect(readMarker(lactose.effect.rs4988235, "--").meaning).toBeNull();
    expect(readMarker(lactose.effect.rs4988235, "AT").meaning).toBeNull();
  });
});

describe("traits.json", () => {
  it("writes every genotype key sorted, so lookups can match", () => {
    for (const t of traits)
      for (const table of Object.values(t.effect))
        for (const k of Object.keys(table))
          expect(k).toBe(k.split("").sort().join(""));
  });
});

describe("resolveTrait", () => {
  it("matches natural phrasing", () => {
    expect(resolveTrait("am I lactose tolerant?", traits).id).toBe("lactose");
    expect(resolveTrait("will coffee keep me up", traits).id).toBe("caffeine");
    expect(resolveTrait("random nonsense question", traits)).toBeNull();
  });
});
