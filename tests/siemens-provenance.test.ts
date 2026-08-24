import { describe, expect, it } from "vitest";
import { auditResultEvidence } from "../src/server/scrapers/evidence-audit.js";
import { siemensMallStockNumberResult } from "../src/server/scrapers/siemens.js";

describe("Siemens Building Technologies provenance", () => {
  it("marks its exact product datasheet as an official document, not a generated attachment", () => {
    const result = siemensMallStockNumberResult("S55499-D348");
    const audit = auditResultEvidence(result);
    const datasheet = audit.records.find((record) => record.kind === "document");

    expect(datasheet).toMatchObject({
      sourceType: "official",
      parser: "siemens-building-technologies-datasheet",
      tier: "official-document",
      provenance: "direct"
    });
    expect(audit.issues).toEqual([]);
  });
});
