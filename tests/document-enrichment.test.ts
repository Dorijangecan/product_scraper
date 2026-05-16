import { describe, expect, it } from "vitest";
import { extractDocumentTextAttributes } from "../src/server/scrapers/document-enrichment.js";
import { normalizeFields } from "../src/server/scrapers/normalizer.js";

describe("document enrichment", () => {
  it("extracts PDF table specs for datasheets", () => {
    const attributes = extractDocumentTextAttributes({
      catalogNumber: "BCC039H",
      document: {
        type: "datasheet",
        label: "Datasheet",
        url: "https://example.test/bcc039h.pdf"
      },
      text: `
Basic features
Approval/Conformity \tCE
cULus
WEEE
Electrical data
Operating voltage Ub \t250 VDC / 250 VAC
Rated current (40 °C) \t4.0 A
Material
Cable jacket, material \tPUR
Mechanical data
Cable length L \t0.30 m
      `
    });
    const normalized = normalizeFields(attributes, []);
    expect(attributes.some((attr) => attr.name === "Operating voltage Ub" && attr.value === "250 VDC / 250 VAC")).toBe(true);
    expect(normalized.voltage).toBe("250 VDC / 250 VAC");
    expect(normalized.current).toBe("4.0 A");
    expect(normalized.material).toBe("PUR");
  });

  it("extracts Siemens VSG dimensions and weight from dimension tables", () => {
    const attributes = extractDocumentTextAttributes({
      catalogNumber: "BPZ:VSG519K15-5",
      document: {
        type: "datasheet",
        label: "VSG519K15-5 datasheet",
        url: "https://example.test/vsg519k15-5.pdf"
      },
      text: `
Material Valve body Spheroidal cast iron GJS-400-15
Standards, directives and approvals
EU conformity (CE) DN 50 A5W00023883
Dimensions
DN D
[Inches]
B
[mm]
L1
[mm]
L3
[mm]
H
[mm]
W
[kg]
15 G 1 9 100 254 100 4.5
      `
    });
    const normalized = normalizeFields(attributes, []);
    expect(normalized.dimensions).toContain("DN 15");
    expect(normalized.weight).toBe("4.5 kg");
    expect(normalized.material).toBe("Valve body Spheroidal cast iron GJS-400-15");
    expect(normalized.certificates).toContain("CE");
  });
});
