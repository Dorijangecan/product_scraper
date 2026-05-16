import { describe, expect, it } from "vitest";
import { normalizeFields } from "../src/server/scrapers/normalizer.js";

describe("normalizer", () => {
  it("extracts common technical fields from arbitrary attributes", () => {
    const normalized = normalizeFields(
      [
        { name: "Product Net Weight", value: "0.25 kg" },
        { name: "Rated Operational Voltage", value: "230 / 400 V AC" },
        { name: "Rated Current", value: "80 A" },
        { name: "IP Rating", value: "IP66" }
      ],
      [{ type: "certificate", label: "Declaration of Conformity - CE", url: "https://example.com/ce.pdf" }]
    );
    expect(normalized.weight).toBe("0.25 kg");
    expect(normalized.voltage).toBe("230 / 400 V AC");
    expect(normalized.current).toBe("80 A");
    expect(normalized.protection).toBe("IP66");
    expect(normalized.certificates).toContain("Declaration of Conformity");
  });
});
