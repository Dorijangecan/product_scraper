import { describe, expect, it } from "vitest";
import { listTechnicalAttributeAliases } from "../src/server/scrapers/technical-attribute-aliases.js";
import { normalizeTechnicalAttributes } from "../src/server/scrapers/technical-attributes.js";
import type { AttributeRecord, SourceRecord } from "../src/shared/types.js";

describe("technical attribute normalization", () => {
  it("maps different manufacturer labels for power loss to one canonical property while preserving originals", () => {
    const attributes: AttributeRecord[] = [
      { group: "ABB Product Data", name: "Power Loss at Rated Operating Conditions per Pole", value: "1.1 ... 2.0 W", sourceType: "official" },
      { group: "Schneider Complementary", name: "Power dissipation per pole", value: "5 W", sourceType: "official" },
      { group: "Siemens General technical data", name: "power loss [W] / for rated value of the current / at AC / in hot operating state / per pole", value: "64.3 W", sourceType: "official" },
      { group: "Eaton Product specifications", name: "Static heat dissipation, non-current-dependent Pvs", value: "1 W", sourceType: "official-fallback" }
    ];

    const mapped = normalizeTechnicalAttributes("test-manufacturer", attributes);

    expect(mapped).toHaveLength(4);
    expect(new Set(mapped.map((item) => item.canonicalKey))).toEqual(new Set(["powerLoss"]));
    expect(mapped.map((item) => item.originalName)).toContain("Power dissipation per pole");
    expect(mapped.map((item) => item.originalName)).toContain("Static heat dissipation, non-current-dependent Pvs");
    expect(mapped.every((item) => item.originalValue && item.confidence >= 0.9)).toBe(true);
  });

  it("uses global aliases for unknown manufacturers before falling back to manufacturer-specific knowledge", () => {
    const mapped = normalizeTechnicalAttributes("unknown-maker", [
      { name: "Dissipation power", value: "3.2 W", sourceType: "official" },
      { name: "Power loss", value: "2 W", sourceType: "official" },
      { name: "Verlustleistung", value: "4 W", sourceType: "official" },
      { name: "Pv", value: "1.5 W", sourceType: "official" }
    ]);

    expect(mapped).toHaveLength(4);
    expect(new Set(mapped.map((item) => item.canonicalKey))).toEqual(new Set(["powerLoss"]));
    expect(new Set(mapped.map((item) => item.matchType))).toEqual(new Set(["global_alias"]));
    expect(mapped.every((item) => item.matchedAliasManufacturerId === "global")).toBe(true);
  });

  it("uses conservative fuzzy aliases for unknown manufacturers when labels are misspelled or reordered", () => {
    const mapped = normalizeTechnicalAttributes("unknown-maker", [
      { name: "Dissipaton power", value: "3.2 W", sourceType: "official" },
      { name: "Loss of power", value: "2 W", sourceType: "official" }
    ]);

    expect(mapped).toHaveLength(2);
    expect(new Set(mapped.map((item) => item.canonicalKey))).toEqual(new Set(["powerLoss"]));
    expect(mapped.map((item) => item.matchType)).toEqual(["fuzzy_global_alias", "fuzzy_global_alias"]);
    expect(mapped.every((item) => item.matchScore && item.matchScore >= 0.84)).toBe(true);
  });

  it("keeps source evidence and parsed quantities for mapped technical attributes", () => {
    const sources: SourceRecord[] = [
      {
        url: "https://example.test/product",
        sourceType: "official",
        parser: "official-page",
        stage: "direct",
        fetchedAt: "2026-06-10T00:00:00.000Z"
      }
    ];
    const mapped = normalizeTechnicalAttributes(
      "rockwell",
      [{ group: "Rockwell Product Data", name: "SCCR", value: "10 kA", sourceUrl: "https://example.test/product" }],
      sources
    );

    expect(mapped[0]).toMatchObject({
      manufacturerId: "rockwell",
      canonicalKey: "breakingCapacity",
      canonicalLabel: "Breaking / short-circuit capacity",
      originalName: "SCCR",
      sourceType: "official",
      parser: "official-page",
      stage: "direct"
    });
    expect(mapped[0].quantities?.[0]).toMatchObject({ kind: "current", value: 10, unit: "kA" });
  });

  it("does not guess when a label is not in the ontology", () => {
    const mapped = normalizeTechnicalAttributes("abb", [{ name: "Eigenfrequenz", value: "50 Hz" }]);

    expect(mapped).toEqual([]);
  });

  it("keeps the manufacturer alias catalog executable, not just documented", () => {
    const aliases = listTechnicalAttributeAliases().filter((alias) => alias.scope === "manufacturer");
    const manufacturers = new Set(aliases.map((alias) => alias.manufacturerId));

    expect(manufacturers).toEqual(new Set(["abb", "schneider", "siemens", "eaton", "rockwell"]));
    for (const alias of aliases) {
      const mapped = normalizeTechnicalAttributes(alias.manufacturerId, [
        { name: alias.originalName, value: sampleValueForCanonicalKey(alias.canonicalKey), sourceType: "official" }
      ]);
      expect(mapped[0]?.canonicalKey, `${alias.manufacturerId} ${alias.originalName}`).toBe(alias.canonicalKey);
      expect(mapped[0]?.reason).toContain("Known manufacturer alias");
    }
  });

  it("keeps the global alias catalog executable for any manufacturer", () => {
    const aliases = listTechnicalAttributeAliases().filter((alias) => alias.scope === "global");

    expect(aliases.length).toBeGreaterThan(20);
    for (const alias of aliases) {
      const mapped = normalizeTechnicalAttributes("any-new-manufacturer", [
        { name: alias.originalName, value: sampleValueForCanonicalKey(alias.canonicalKey), sourceType: "official" }
      ]);
      expect(mapped[0]?.canonicalKey, alias.originalName).toBe(alias.canonicalKey);
      expect(mapped[0]?.matchType, alias.originalName).toBe("global_alias");
    }
  });
});

function sampleValueForCanonicalKey(canonicalKey: string): string {
  if (/voltage/i.test(canonicalKey)) return "400 V AC";
  if (/current|capacity/i.test(canonicalKey)) return "10 kA";
  if (/powerLoss/i.test(canonicalKey)) return "5 W";
  if (/temperature/i.test(canonicalKey)) return "-25 ... 60 °C";
  if (canonicalKey === "poles") return "3";
  return "published";
}
