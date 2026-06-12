import { describe, expect, it } from "vitest";
import { buildScamePdfCandidates, extractScameDownloadKinds, parseScameInfoText, scamePdfSlug } from "../src/server/scrapers/scame.js";
import { normalizeFields } from "../src/server/scrapers/normalizer.js";

describe("SCAME scraper helpers", () => {
  it("builds SCAME PDF slugs without hard-coding catalog samples", () => {
    expect(scamePdfSlug("245.1698/S")).toBe("245.1698_s");
    expect(scamePdfSlug(" SCM430MI12W-C ")).toBe("scm430mi12w-c");

    const candidates = buildScamePdfCandidates("245.1698/S");
    expect(candidates.infoData).toContain("https://techsheet.scame.com/infodata/en/245.1698_s.pdf");
    expect(candidates.infoData).toContain("https://techsheet.scame.com/infodata/en-US/245.1698_s.pdf");
    expect(candidates.infoData).toContain("https://techsheet.scame.com/infodata/fr/245.1698_s.pdf");
    expect(candidates.drawings).toContain("https://techsheet.scame.com/Download/dms/cad/pdf/245.1698_s.pdf");
    expect(candidates.cadDocuments.map((candidate) => candidate.url)).toEqual(expect.arrayContaining([
      "https://techsheet.scame.com/Download/dms/cad/dwg/245.1698_s.dwg",
      "https://techsheet.scame.com/Download/dms/cad/step/245.1698_s.zip"
    ]));
  });

  it("detects advertised SCAME technical drawing download formats", () => {
    expect([...extractScameDownloadKinds(`
DOWNLOAD
Technical drawing [PDF]
Technical drawing [DWG]
Technical drawing [STP]
`)]).toEqual(["pdf", "dwg", "step"]);
  });

  it("parses SCAME product-info PDF text into normalized product facts", () => {
    const parsed = parseScameInfoText(
      "657.5035-039",
      "https://techsheet.scame.com/infodata/en/657.5035-039.pdf",
      `
657.5035-039
DISTRIBUTION ASSEMBLY (ACS)
IP66 3P+N+E 70A 400V
475x520x380mm
* Product image may be indicative
GENERAL CHARACTERISTICS
Commercial Series \tMBOX3 Series
Synthetical description \tDISTRIBUTION ASSEMBLY (ACS)
Mounting version \tSURFACE MOUNTING
TECHNICAL CHARACTERISTICS
Rated current \t70A
Rated voltage \t400V
Working frequency \t50Hz
Poles \t3P+N+E
PHYSICAL CHARACTERISTICS
Protection degree IP \tIP66
Material \tTHERMOPLASTIC
DIMENSIONAL CHARACTERISTICS
Dimensions \t475x520x380mm
DOWNLOAD
Technical drawing [PDF]
Technical drawing [DWG]
Technical drawing [STP]
`
    );

    const normalized = normalizeFields(parsed.attributes, []);
    expect(parsed.title).toBe("DISTRIBUTION ASSEMBLY (ACS)");
    expect(parsed.description).toContain("IP66 3P+N+E 70A 400V");
    expect([...parsed.downloadKinds]).toEqual(["pdf", "dwg", "step"]);
    expect(parsed.attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Commercial Series", value: "MBOX3 Series" }),
      expect.objectContaining({ name: "Rated current", value: "70A" }),
      expect.objectContaining({ name: "Protection degree IP", value: "IP66" })
    ]));
    expect(normalized.current).toMatch(/70\s*A/i);
    expect(normalized.voltage).toMatch(/400\s*V/i);
    expect(normalized.protection).toBe("IP66");
    expect(normalized.material).toBe("THERMOPLASTIC");
    expect(normalized.dimensions).toContain("475");
  });
});
