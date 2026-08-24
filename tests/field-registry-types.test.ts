import { describe, expect, it } from "vitest";
import {
  FIELD_REGISTRY,
  fieldMatchesLabel,
  normalizerFieldLabelPatterns,
  registryFieldQuantityKind,
  type NormalizedRegistryFieldKey
} from "../src/server/scrapers/field-registry.js";

/**
 * These are compile-time assertions with a runtime shell. `tsc --noEmit` covers `tests/`, so a
 * `@ts-expect-error` that stops being an error FAILS the typecheck — which is the point: the guarantee is
 * that a future edit cannot quietly reintroduce the hazard.
 */
describe("registry field keys", () => {
  it("rejects a normalized field the registry has no entry for", () => {
    // `operatingTemperatureMin` is a legal `keyof NormalizedProductFields`, so it used to be accepted by
    // registryFieldValue and then return undefined forever — the registry matches by label and has no
    // entry for it (the value is derived from a parsed range instead).
    // @ts-expect-error operatingTemperatureMin has no FIELD_REGISTRY entry
    const unrouted: NormalizedRegistryFieldKey = "operatingTemperatureMin";
    expect(unrouted).toBe("operatingTemperatureMin");
  });

  it("accepts the normalized fields the registry does route", () => {
    const routed: NormalizedRegistryFieldKey[] = ["weight", "dimensions", "voltage", "current", "protection"];
    for (const key of routed) {
      expect(FIELD_REGISTRY.some((field) => field.key === key), key).toBe(true);
    }
  });

  it("gives every quantity-carrying field exactly one kind, and text fields none", () => {
    expect(registryFieldQuantityKind("voltage")).toBe("voltage");
    expect(registryFieldQuantityKind("current")).toBe("current");
    expect(registryFieldQuantityKind("weight")).toBe("mass");
    expect(registryFieldQuantityKind("operatingTemperature")).toBe("temperature");
    expect(registryFieldQuantityKind("wallThickness")).toBe("length");
    // A finish or a certificate is not a measurement, so no guard keyed on a quantity may apply to it.
    expect(registryFieldQuantityKind("finish")).toBeUndefined();
    expect(registryFieldQuantityKind("certificates")).toBeUndefined();
    expect(registryFieldQuantityKind("material")).toBeUndefined();
  });

  it("routes enclosure protection to protection rather than material", () => {
    // Recorded document-enrichment input: `Enclosure protection` has the value IP65. A broad
    // material alias for `enclosure` made the registry disagree with the ontology and could expose
    // the same label as two unrelated final fields.
    expect(fieldMatchesLabel("protection", "Enclosure protection")).toBe(true);
    expect(fieldMatchesLabel("material", "Enclosure protection")).toBe(false);
  });

  it("routes material and body thickness to wall thickness rather than material", () => {
    for (const label of ["Material thickness", "Body thickness"]) {
      expect(fieldMatchesLabel("wallThickness", label), label).toBe(true);
      expect(fieldMatchesLabel("material", label), label).toBe(false);
    }
  });

  it("does not route frame, stripping, or stroke measurements into product dimensions", () => {
    for (const label of ["Frame size", "Stripping length", "Stroke length"]) {
      expect(fieldMatchesLabel("dimensions", label), label).toBe(false);
    }
  });

  it("does not route non-nameplate electrical ratings into voltage or current", () => {
    for (const label of ["Rated insulation voltage", "Rated impulse withstand voltage", "Voltage drop"]) {
      expect(fieldMatchesLabel("voltage", label), label).toBe(false);
    }
    for (const label of [
      "Inrush current",
      "Starting / locked-rotor current ratio",
      "Rated residual current (RCD)",
      "Let-through current / I²t",
      "Leakage / off-state current"
    ]) {
      expect(fieldMatchesLabel("current", label), label).toBe(false);
    }
  });

  it("exposes the normalizer's context-sensitive label vocabulary from the registry owner", () => {
    const matches = (field: NormalizedRegistryFieldKey, label: string) =>
      normalizerFieldLabelPatterns(field).some((pattern) => pattern.test(label.toLowerCase()));

    // These are normalizer-specific broad forms (not raw registry admission rules): they keep
    // established multilingual/group-context coverage while removing normalizer.ts as a second owner.
    expect(matches("dimensions", "Cable length")).toBe(true);
    expect(matches("voltage", "Ua")).toBe(true);
    expect(matches("current", "Switching capacity")).toBe(true);
    expect(matches("weight", "重量")).toBe(true);
  });
});
