import { describe, expect, it } from "vitest";
import { classifyDocument, cleanText, mergeResults, normalizeAbbFields, normalizeFields, splitNameValue } from "../src/server/scrapers/normalizer.js";

describe("splitNameValue (Phase A4)", () => {
  it("splits on colon and equals", () => {
    expect(splitNameValue("Weight: 1.2 kg")).toEqual({ name: "Weight", value: "1.2 kg" });
    expect(splitNameValue("Weight = 1.2 kg")).toEqual({ name: "Weight", value: "1.2 kg" });
    expect(splitNameValue("R = 10 Ω")).toEqual({ name: "R", value: "10 Ω" });
  });

  it("rejects value fragments masquerading as labels", () => {
    expect(splitNameValue("120 W: something")).toBeUndefined();
    expect(splitNameValue("(1.65 lb): x")).toBeUndefined();
    expect(splitNameValue("6 kA: x")).toBeUndefined();
  });

  it("keeps a legitimate 'W x H x D' dimensions label", () => {
    expect(splitNameValue("W x H x D: 39 x 124 x 117 mm")).toEqual({
      name: "W x H x D",
      value: "39 x 124 x 117 mm"
    });
  });
});

describe("normalizer", () => {
  it("uses Balluff's published supply current draw instead of a switch output-current limit", () => {
    const normalized = normalizeFields([
      { group: "PDF datasheet - Electrical data", name: "Current draw max.", value: "70 mA", sourceType: "generated", parser: "pdf-table-extractor", matchLevel: "exact", sourceUrl: "https://publications.balluff.com/pdfengine/pdf?type=pdb&id=264658&con=en" },
      { group: "PDF datasheet - Electrical data", name: "Switching current", value: "400 mA", sourceType: "generated", parser: "pdf-table-extractor", matchLevel: "exact", sourceUrl: "https://publications.balluff.com/pdfengine/pdf?type=pdb&id=264658&con=en" },
      { group: "Balluff Technical", name: "Housing material", value: "1.4571 stainless steel", sourceType: "official" }
    ], [], "balluff");

    expect(normalized.current).toBe("max. 70 mA");
    expect(normalized.material).toBe("1.4571 stainless steel");
  });

  it("keeps Balluff analog signal current separate from rated device operating current", () => {
    const pageOnly = normalizeFields([
      { group: "Balluff Key features", name: "Analog output", value: "Analog, current 4…20 mA", sourceUrl: "https://www.balluff.com/en-gb/products/BTS0003" }
    ], [], "balluff");
    const withDatasheet = normalizeFields([
      { group: "Balluff Key features", name: "Analog output", value: "Analog, current 4…20 mA", sourceUrl: "https://www.balluff.com/en-gb/products/BTS0003" },
      { group: "PDF datasheet - Electrical data", name: "Rated operating current Ie", value: "100 mA", sourceType: "generated", parser: "pdf-table-extractor", matchLevel: "exact", sourceUrl: "https://publications.balluff.com/pdfengine/pdf?type=pdb&id=283125&con=en" }
    ], [], "balluff");

    expect(pageOnly.current).toBeUndefined();
    expect(withDatasheet.current).toBe("100 mA");
  });

  it("uses Balluff no-load current for supply consumption instead of analog output current", () => {
    const normalized = normalizeFields([
      { group: "PDF datasheet - Electrical data", name: "Output current max. (Analog V)", value: "5 mA", sourceType: "generated", parser: "pdf-table-extractor", matchLevel: "exact", sourceUrl: "https://publications.balluff.com/pdfengine/pdf?id=304319" },
      { group: "PDF datasheet - Electrical data", name: "No-load current Io max. at Ue", value: "25 mA", sourceType: "generated", parser: "pdf-table-extractor", matchLevel: "exact", sourceUrl: "https://publications.balluff.com/pdfengine/pdf?id=304319" },
      { group: "PDF datasheet - Electrical data", name: "Current load capacity in SIO-mode", value: "≤100mA", sourceType: "generated", parser: "pdf-table-extractor", matchLevel: "exact", sourceUrl: "https://publications.balluff.com/pdfengine/pdf?id=304319" }
    ], [], "balluff");

    expect(normalized.current).toBe("max. 25 mA");
  });

  it("normalizes Balluff housing material from the official product page URL", () => {
    const normalized = normalizeFields([
      { group: "Balluff Summary Features", name: "Housing material", value: "Metal", sourceUrl: "https://www.balluff.com/en-gb/products/BAE0007" },
      { group: "External source", name: "Housing material", value: "Plastic", sourceUrl: "https://example.com/products/BAE0007" }
    ], [], "balluff");

    expect(normalized.material).toBe("Metal");
  });

  it("combines Balluff probe diameter and installation length without duplicating the length", () => {
    const normalized = normalizeFields([
      { group: "PDF datasheet - Mechanical data", name: "Probe diameter", value: "7.3 mm", sourceType: "generated", parser: "pdf-table-extractor", matchLevel: "exact", sourceUrl: "https://publications.balluff.com/pdfengine/pdf?id=264658" },
      { group: "Balluff Key features", name: "Installation length from contact surface", value: "31 mm", sourceUrl: "https://www.balluff.com/en-gb/products/BFF0001" },
      { group: "Balluff PDT Derived", name: "Net depth", value: "31 mm", sourceType: "generated", parser: "balluff-pdt-derivation", confidence: 0.7 }
    ], [], "balluff");

    expect(normalized.dimensions).toBe("Ø 7.3 mm x 31 mm");
  });

  it("does not promote a linear position sensor measuring length into physical dimensions", () => {
    const normalized = normalizeFields([
      { group: "PDF Ontology Spec Miner", name: "Length", value: "457 mm", sourceType: "generated", parser: "pdf-table-extractor", confidence: 0.78 },
      { group: "PDF datasheet - Mechanical data", name: "Measuring length", value: "457 mm", sourceType: "generated", parser: "pdf-table-extractor", confidence: 0.78 },
      { group: "Balluff Key features", name: "Measuring range", value: "457 mm", sourceUrl: "https://www.balluff.com/en-gb/products/BTL0W9F" },
      { group: "Balluff Key features", name: "Cable", value: "5.00 m, PUR", sourceUrl: "https://www.balluff.com/en-gb/products/BTL0W9F" }
    ], [], "balluff");

    expect(normalized.dimensions).toBeUndefined();
  });

  it("prefers exact Balluff datasheet protection evidence over sibling comparison rows", () => {
    const normalized = normalizeFields([
      { group: "Balluff Key features", name: "IP rating", value: "IP67", sourceUrl: "https://www.balluff.com/en-gb/products/BMF00PA" },
      { group: "PDF datasheet - Environmental conditions", name: "IP rating", value: "IP67", sourceType: "generated", parser: "pdf-table-extractor", matchLevel: "exact", sourceUrl: "https://publications.balluff.com/pdfengine/pdf?id=297691" },
      { group: "PDF datasheet - Environmental conditions", name: "IP rating", value: "IP68, IP69K", sourceType: "generated", parser: "pdf-table-extractor", sourceUrl: "https://publications.balluff.com/pdfengine/pdf?id=305908" }
    ], [], "balluff");

    expect(normalized.protection).toBe("IP67");
  });

  it("extracts Balluff finish from the housing-material phrase without carrying trailing material text", () => {
    const normalized = normalizeFields([
      { group: "Balluff Key features", name: "Housing material", value: "Stainless steel, Aluminum, black anodized, Aluminum (3.3206)", sourceUrl: "https://www.balluff.com/en-gb/products/BTS0003" }
    ], [], "balluff");

    expect(normalized.finish).toBe("black anodized");
  });

  it("normalizes the published CP620 nominal input voltage range", () => {
    const normalized = normalizeAbbFields([
      { group: "ABB Product Data", name: "Extended Product Type", value: "CP620", sourceType: "official", parser: "abb-product-model" },
      { group: "ABB Product Data", name: "Power Supply", value: "24 (18 ... 30) V DC", sourceType: "official", parser: "abb-product-model" }
    ], []);

    expect(normalized.voltage).toBe("18...30 V DC");
  });

  it("uses ABB contactor AC-3 current at 400 V instead of conventional thermal current", () => {
    const exactPage = "https://new.abb.com/products/1SBL136201R2100";
    const normalized = normalizeAbbFields([
      { group: "ABB Product Data", name: "Catalog Description", value: "AF09Z-40-00-21 Contactor", sourceType: "official", parser: "abb-product-model", sourceUrl: exactPage },
      { group: "ABB Product Data", name: "Product ID", value: "1SBL136201R2100", sourceType: "official", parser: "abb-product-model", sourceUrl: exactPage },
      { group: "ABB Technical", name: "Conventional Free-air Thermal Current", value: "35 A", sourceType: "official", parser: "abb-product-model", sourceUrl: exactPage },
      { group: "ABB Technical", name: "Rated Operational Current AC-3", value: "(415 V) 60 °C 9 A; (440 V) 60 °C 9 A; (500 V) 60 °C 9.5 A; (690 V) 60 °C 7 A; (380 / 400 V) 60 °C 9 A", sourceType: "official", parser: "abb-product-model", sourceUrl: exactPage }
    ], []);

    expect(normalized.current).toBe("9 A");
  });

  it("uses ABB switch-disconnector AC-23A table instead of UL current and insulation voltage", () => {
    const exactPage = "https://new.abb.com/products/1SCA104811R1001";
    const normalized = normalizeAbbFields([
      { group: "ABB Product Data", name: "Catalog Description", value: "OT16F3 SWITCH-DISCONNECTOR", sourceType: "official", parser: "abb-product-model", sourceUrl: exactPage },
      { group: "ABB Product Data", name: "Rated Operational Voltage", value: "750 V", sourceType: "official", parser: "abb-product-model", sourceUrl: exactPage },
      { group: "ABB Product Data", name: "Ampere Rating", value: "20 A", sourceType: "official", parser: "abb-product-model", sourceUrl: exactPage },
      { group: "ABB Product Data", name: "Rated Operational Current AC-23A", value: "(380 ... 415 V) 16 A; (500 V) 16 A; (690 V) 10 A", sourceType: "official", parser: "abb-product-model", sourceUrl: exactPage }
    ], []);

    expect(normalized.voltage).toBe("380...415 V");
    expect(normalized.current).toBe("16 A");
  });

  it("uses ABB command-device LED supply voltage instead of its contact insulation voltage", () => {
    const normalized = normalizeAbbFields([
      { group: "ABB Product Data", name: "Catalog Description", value: "CP1-31G-10 Pushbutton", sourceType: "official" },
      { group: "ABB Product Data", name: "Lamp Type", value: "LED 24V AC/DC", sourceType: "official" },
      { group: "ABB Product Data", name: "Rated Insulation Voltage", value: "300 V", sourceType: "official" },
      { group: "ABB Product Data", name: "Rated Operational Voltage", value: "24 V AC/DC; 300 V; Supply Circuit 24 V AC/DC", sourceType: "official" }
    ], []);

    expect(normalized.voltage).toBe("24 V AC/DC");
  });

  it("does not take electrical ratings from related Eaton products", () => {
    const exactPage = "https://www.eaton.com/us/en-us/skuPage.102087.html";
    const normalized = normalizeFields([
      { group: "Product specifications", name: "Amperage Rating", value: "10 A", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Designed to work together", name: "Related Product", value: "102088 - MCB, rated current In: 13 A (https://www.eaton.com/us/en-us/skuPage.102088.html)", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage }
    ], [], "eaton");

    expect(normalized.current).toBe("10 A");
  });

  it("prefers Eaton rated operational current over a distinct maximum supply-current row", () => {
    const exactPage = "https://www.eaton.com/us/en-us/skuPage.116308.html";
    const normalized = normalizeFields([
      { group: "Product specifications", name: "Product Type", value: "Communication module", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Catalog Number", value: "116308", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Rated operational current (Ie)", value: "0.7 A", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Supply current - max", value: "0.7 mA", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Rated operational current for specified heat dissipation (In)", value: "0 A", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage }
    ], [], "eaton");

    expect(normalized.current).toBe("0.7 A");
  });

  it("uses exact Eaton contactor AC-3 ratings instead of unrelated switching capacity", () => {
    const exactPage = "https://www.eaton.com/us/en-us/skuPage.277268.html";
    const normalized = normalizeFields([
      { group: "General specifications", name: "Product Type", value: "Contactor", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Electrical rating", name: "Rated operational current (Ie) at AC-3, 380 V, 400 V, 415 V", value: "32 A", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Electrical rating", name: "Rated operational current (Ie) at AC-3, 660 V, 690 V", value: "18 A", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Switching capacity", name: "Switching capacity (main contacts, general use)", value: "40 A, Maximum motor rating (UL/CSA)", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage }
    ], [], "eaton");

    expect(normalized.current).toBe("18...32 A");
  });

  it("uses the exact Eaton contactor operational-voltage ceiling instead of its coil voltage", () => {
    const exactPage = "https://www.eaton.com/us/en-us/skuPage.277268.html";
    const normalized = normalizeFields([
      { group: "General specifications", name: "Product Type", value: "Contactor", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Electrical rating", name: "Rated operational voltage (Ue) at AC - max", value: "690 V", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Operating voltage at AC, 60 Hz - min", value: "24 V", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Magnet system", name: "Rated control supply voltage (Us) at AC, 50 Hz - min", value: "230 V", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Magnet system", name: "Rated control supply voltage (Us) at AC, 50 Hz - max", value: "230 V", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Eaton description", name: "Voltage rating", value: "380 V", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Voltage rating", value: "230 V", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage }
    ], [], "eaton");

    expect(normalized.voltage).toBe("690 V");
  });

  it("uses the exact Eaton electronic overload relay overload range", () => {
    const exactPage = "https://www.eaton.com/us/en-us/skuPage.XTOE020CCSS.html";
    const normalized = normalizeFields([
      { group: "General specifications", name: "Product Type", value: "Electronic overload relay", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Overload range", value: "4-20A", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Trip type", value: "Selectable 10 A, class 10, 20, 30", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage }
    ], [], "eaton");

    expect(normalized.current).toBe("4...20 A");
  });

  it("keeps Eaton MCB voltage ratings distinct from the operational-voltage ceiling", () => {
    const exactPage = "https://www.eaton.com/us/en-us/skuPage.278561.html";
    const normalized = normalizeFields([
      { group: "General specifications", name: "Product Type", value: "MCB", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Physical Attributes", name: "Type", value: "FAZ Miniature circuit breaker", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Voltage rating", value: "240 V AC / 415 V AC", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Voltage rating (UL)", value: "277 V", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Electrical rating", name: "Rated operational voltage (Ue) - max", value: "230 V", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Degree of protection", value: "IP20 UL/CSA Type: - IP40 (when fitted) IP20 (IEC)", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Construction", name: "Busbar material thickness", value: "0.8 mm", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage }
    ], [], "eaton");

    expect(normalized.voltage).toBe("240 V AC / 415 V AC");
    expect(normalized.protection).toBe("IP20; IP40 (when fitted); IP20 (IEC)");
    expect(normalized.wallThickness).toBeUndefined();
  });

  it("leaves an implausible power-supply mass blank for review", () => {
    const exactPage = "https://www.eaton.com/us/en-us/skuPage.PSG120E24RM.html";
    const normalized = normalizeFields([
      { group: "General specifications", name: "Product Type", value: "General purpose power supply", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "General specifications", name: "Product Weight", value: "1.59 g", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Power consumption", value: "120 W", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Input voltage", value: "100-240 Vac", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Output voltage", value: "24 V", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage }
    ], [], "eaton");

    expect(normalized.weight).toBeUndefined();
    expect(normalized.voltage).toBe("Input: 100...240 V AC; Output: 24 V");
  });

  it("preserves Eaton UPS input and output nominal voltage contexts", () => {
    const exactPage = "https://www.eaton.com/us/en-us/skuPage.5SC1000.html";
    const normalized = normalizeFields([
      { group: "General specifications", name: "Product Type", value: "UPS", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Input voltage range", value: "96-144 Vac", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Output nominal voltage", value: "100/110/120V", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage }
    ], [], "eaton");

    expect(normalized.voltage).toBe("Input: 96...144 V AC; Output: 100/110/120 V");
  });

  it("leaves conflicting exact Eaton overload-relay protection codes blank", () => {
    const exactPage = "https://www.eaton.com/us/en-us/skuPage.278431.html";
    const normalized = normalizeFields([
      { group: "General specifications", name: "Product Type", value: "Thermal overload relay", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Degree of protection", value: "IP00", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "General specifications", name: "Description", value: "Thermal overload relay, IP20", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage }
    ], [], "eaton");

    expect(normalized.protection).toBeUndefined();
  });

  it("uses an Eaton thermal overload relay trip adjustment range instead of auxiliary contact Ith", () => {
    const exactPage = "https://www.eaton.com/us/en-us/skuPage.278431.html";
    const normalized = normalizeFields([
      { group: "General specifications", name: "Product Type", value: "Thermal overload relay", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Adjustable current range - min", value: "0.1 A", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Adjustable current range - max", value: "0.16 A", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Electrical ratings", name: "Conventional thermal current Ith of auxiliary contacts (1-pole, open)", value: "6 A", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage }
    ], [], "eaton");

    expect(normalized.current).toBe("0.1...0.16 A");
  });

  it("uses Eaton surge current only when an official family row names the exact model token", () => {
    const exactPage = "https://www.eaton.com/us/en-us/skuPage.SP1-240S.html";
    const exactFamilyPdf = "https://www.eaton.com/content/dam/eaton/products/backup-power-ups-surge-it-power-distribution/surge/sp-series/eaton-sp-series-brochure-pa01005006e.pdf";
    const exactEvidence: Parameters<typeof normalizeFields>[0] = [
      { group: "General specifications", name: "Product Type", value: "Surge protective device", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "General specifications", name: "Catalog Number", value: "SP1-240S", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "PDF table", name: "Nominal discharge current", value: "20 kA for 240S, 208Y, 480Y, 240D and 480D; 10 kA for 600Y and 600D", parser: "pdf-table-extractor", sourceType: "generated", matchLevel: "exact", sourceUrl: exactFamilyPdf }
    ];

    expect(normalizeFields(exactEvidence, [], "eaton").current).toBe("20 kA");
    expect(normalizeFields([
      ...exactEvidence.slice(0, 2),
      { ...exactEvidence[2], value: "10 kA for 600Y and 600D" }
    ], [], "eaton").current).toBeUndefined();
  });

  it("preserves both primary and secondary exact Eaton transformer ratings", () => {
    const exactPage = "https://www.eaton.com/us/en-us/skuPage.C0350E2A.html";
    const normalized = normalizeFields([
      { group: "General specifications", name: "Product Type", value: "Industrial control transformer", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Performance Ratings", name: "Primary voltage", value: "220 x 440 V, 230 x 460 V, 240 x 480 V", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Performance Ratings", name: "Secondary voltage", value: "120/115/110 V", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Eaton description", name: "Voltage rating", value: "480 V", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage }
    ], [], "eaton");

    expect(normalized.voltage).toContain("Primary voltage: 220 x 440 V, 230 x 460 V, 240 x 480 V");
    expect(normalized.voltage).toContain("Secondary voltage: 120/115/110 V");
  });

  it("collapses identical Eaton operational-voltage min/max values", () => {
    const exactPage = "https://www.eaton.com/us/en-us/skuPage.072738.html";
    const normalized = normalizeFields([
      { group: "General specifications", name: "Product Type", value: "Motor-protective circuit-breaker", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Electrical rating", name: "Rated operational voltage (Ue) - min", value: "690 V", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Electrical rating", name: "Rated operational voltage (Ue) - max", value: "690 V", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage }
    ], [], "eaton");

    expect(normalized.voltage).toBe("690 V");
  });

  it("uses exact Eaton operational-voltage min/max rows ahead of a description shorthand", () => {
    const exactPage = "https://www.eaton.com/us/en-us/skuPage.118969.html";
    const normalized = normalizeFields([
      { group: "General specifications", name: "Product Type", value: "MCCB", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Electrical rating", name: "Rated operational voltage (Ue) - min", value: "690 V", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Electrical rating", name: "Rated operational voltage (Ue) - max", value: "690 V", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Eaton description", name: "Voltage rating", value: "690 V", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage }
    ], [], "eaton");

    expect(normalized.voltage).toBe("690 V");
  });

  it("normalizes the exact Eaton easyE4 supply voltage without confusing it with its DC maximum", () => {
    const exactPage = "https://www.eaton.com/us/en-us/skuPage.197506.html";
    const normalized = normalizeFields([
      { group: "General specifications", name: "Product Type", value: "Control relay", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Eaton description", name: "Voltage rating", value: "24 V DC", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage, scope: "variant", matchLevel: "exact" },
      { group: "Electrical rating", name: "Rated operational voltage", value: "Power supply: 24 V DC (-15 %/+ 20 %) Power supply transistor outputs: 24 V DC (-15 %/+ 20 %) Inputs: shall be identical to the power supply voltage", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Electrical rating", name: "Supply voltage at DC - max", value: "28.8 VDC", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage }
    ], [], "eaton");

    expect(normalized.voltage).toBe("24 V DC");
  });

  it("preserves both exact Eaton monitored-system voltage ranges by current type", () => {
    const exactPage = "https://www.eaton.com/us/en-us/skuPage.184775.html";
    const normalized = normalizeFields([
      { group: "General specifications", name: "Product Type", value: "Voltage monitoring relay", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Rated operational voltage of monitored supply system", value: "0 - 1000 V DC 0 - 690 V AC", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Rated operational voltage (Ue) - max", value: "690 V", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage }
    ], [], "eaton");

    expect(normalized.voltage).toBe("0...1000 V DC or 0...690 V AC");
  });

  it("collapses duplicate voltage bounds already combined in one exact Eaton attribute", () => {
    const exactPage = "https://www.eaton.com/us/en-us/skuPage.118969.html";
    const normalized = normalizeFields([
      { group: "General specifications", name: "Product Type", value: "MCCB", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Technical data - electrical", name: "Operating voltage", value: "690 V - 690 V", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage }
    ], [], "eaton");

    expect(normalized.voltage).toBe("690 V");
  });

  it("does not treat certification standards or replacement part numbers as rated current", () => {
    const normalized = normalizeFields([
      { group: "PDF datasheet - General specifications", name: "Feature", value: "UL 508A", sourceType: "generated", parser: "pdf-table-extractor" },
      { group: "PDF datasheet - Construction", name: "Replacement fan", value: "SP039010-0019A", sourceType: "generated", parser: "pdf-table-extractor" }
    ], [], "eaton");

    expect(normalized.current).toBeUndefined();
  });

  it("prefers Eaton exact-SKU voltage ratings and NAC output current over unrelated fields", () => {
    const exactPage = "https://www.eaton.com/us/en-us/skuPage.PS-8-LP.html";
    const normalized = normalizeFields([
      { group: "General specifications", name: "Product Type", value: "Power supply", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Type", value: "NAC power supply", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Voltage rating", value: "120 V", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Input voltage", value: "8 to 33 VDC", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Input current", value: "0.005 A", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "NAC power", value: "8 A", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "PDF datasheet", name: "Rated voltage", value: "115 V", parser: "pdf-table-extractor", sourceType: "generated", sourceUrl: "https://www.eaton.com/content/dam/family.pdf" }
    ], [], "eaton");

    expect(normalized.voltage).toBe("120 V");
    expect(normalized.current).toBe("8 A");
  });

  it("uses the exact Eaton soft starter operating-voltage range over its control voltage rating", () => {
    const exactPage = "https://www.eaton.com/us/en-us/skuPage.S811%2BR10N3S.html";
    const normalized = normalizeFields([
      { group: "General specifications", name: "Product Type", value: "Soft starter", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Voltage rating", value: "24 V", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Operating voltage", value: "200-600 V", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage }
    ], [], "eaton");

    expect(normalized.voltage).toBe("200...600 V");
  });

  it("does not infer Eaton soft starter supply voltage from motor horsepower points", () => {
    const exactPage = "https://www.eaton.com/us/en-us/skuPage.DS7-340SX004N0-N.html";
    const normalized = normalizeFields([
      { group: "General specifications", name: "Product Type", value: "Soft start controller", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Eaton description", name: "Voltage rating", value: "200 V", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage }
    ], [], "eaton");

    expect(normalized.voltage).toBeUndefined();
  });

  it("uses an exact Eaton protective-relay power-supply range instead of a voltage parsed from its title", () => {
    const exactPage = "https://www.eaton.com/us/en-us/skuPage.DT3030.html";
    const normalized = normalizeFields([
      { group: "General specifications", name: "Product Type", value: "Relay", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Product Category", value: "Three-phase and ground overcurrent protective relay", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Eaton description", name: "Voltage rating", value: "48 V DC", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage, scope: "variant", matchLevel: "exact" },
      { group: "Product specifications", name: "Power supply", value: "24/48 Vdc", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "PDF Electrical Text", name: "Output current", value: "42 mA", parser: "pdf-table-extractor", sourceType: "generated", sourceUrl: "https://www.eaton.com/content/dam/eaton/family.pdf", scope: "variant" }
    ], [], "eaton");

    expect(normalized.voltage).toBe("24/48 V DC");
    expect(normalized.current).toBeUndefined();
  });

  it("keeps Eaton built-in LED ratings out of generic device voltage and current", () => {
    const exactPage = "https://www.eaton.com/us/en-us/skuPage.257064.html";
    const normalized = normalizeFields([
      { group: "General specifications", name: "Product Type", value: "Emergency stop pushbutton", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Included built-in LED", name: "LED voltage", value: "24 V DC", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Included built-in LED", name: "LED rated current", value: "15 mA", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Accessories", value: "With built-in multiple LED, 24 V DC, Ie = 15 mA", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage }
    ], [], "eaton");

    expect(normalized.voltage).toBeUndefined();
    expect(normalized.current).toBeUndefined();
  });

  it("does not let an unscoped Eaton family-PDF current table override the exact PDP rating", () => {
    const exactPage = "https://www.eaton.com/us/en-us/skuPage.XTAE065D00C065.html";
    const normalized = normalizeFields([
      { group: "General specifications", name: "Product Type", value: "Electronic motor starter", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "Product specifications", name: "Amperage Rating", value: "65A", parser: "eaton-product-page", sourceType: "official-fallback", sourceUrl: exactPage },
      { group: "PDF datasheet", name: "Rated uninterrupted current = rated output current", value: "Iu = I e | 12 A | 32 A | 65 A", parser: "pdf-table-extractor", sourceType: "generated", sourceUrl: "https://www.eaton.com/content/dam/family.pdf" }
    ], [], "eaton");

    expect(normalized.current).toBe("65 A");
  });

  it("prefers explicit product ratings in official descriptions over generic parsed PDF values", () => {
    const normalized = normalizeFields([
      { group: "Product Page", name: "Long Description", value: "This power supply has a rated output current of 10 A at 24 V DC.", sourceType: "official" },
      { group: "PDF table", name: "Current", value: "5 A", sourceType: "generated", parser: "pdf-table-extractor" },
      { group: "Product Page", name: "Description", value: "Rated supply voltage is 100...500 V AC.", sourceType: "official" },
      { group: "PDF table", name: "Voltage", value: "24 V DC", sourceType: "generated", parser: "pdf-table-extractor" }
    ], []);
    expect(normalized.current).toBe("10 A");
    expect(normalized.voltage).toBe("100...500 V AC");
  });

  it("decodes HTML entities while cleaning text", () => {
    expect(cleanText("Switch- &amp; Controlgear&nbsp;Enclosure &#40;IP66&#41; &micro;m &sup2;")).toBe("Switch- & Controlgear Enclosure (IP66) \u00b5m \u00b2");
  });

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

  it("derives a rated current from an explicit product description for any manufacturer", () => {
    // Real ABB PIS wording for 1SBL131001R5501, deliberately under a neutral group: the
    // fallback must be driven by the semantic description/current evidence, not the vendor name.
    const normalized = normalizeFields(
      [
        {
          group: "Manufacturer Product Data",
          name: "Long Description",
          value:
            "The AFC09-30-01-55 is a 3-pole contactor, mainly controlling power circuits up to 4 kW / 400 V AC (AC-3) or 5 hp / 480 V AC UL and 25 A (AC-1) or 25 A UL general use."
        }
      ],
      []
    );

    expect(normalized.current).toBe("25 A");
  });

  it("does not promote a fault-current-only product description into rated current", () => {
    const normalized = normalizeFields(
      [{ group: "Manufacturer Product Data", name: "Long Description", value: "Circuit breaker with short-circuit breaking capacity of 25 kA." }],
      []
    );

    expect(normalized.current).toBeUndefined();
  });

  it("fills voltage/current/weight from Italian labels via the multilingual ontology fallback (Phase 4 U1b)", () => {
    // These labels are not in FIELD_LABEL_PATTERNS (EN/DE); only the multilingual ontology
    // recognises them. Before wiring the ontology gap-fill for these fields, they stayed empty.
    const normalized = normalizeFields(
      [
        { name: "Tensione nominale", value: "400 V" },
        { name: "Corrente nominale", value: "16 A" },
        { name: "Peso", value: "0.5 kg" }
      ],
      []
    );
    expect(normalized.voltage).toBe("400 V");
    expect(normalized.current).toBe("16 A");
    expect(normalized.weight).toBe("0.5 kg");
  });

  it("fills voltage/current/weight from completely unknown-language labels via unit inference", () => {
    // Polish labels that neither FIELD_LABEL_PATTERNS nor the ontology synonyms cover —
    // the value's unit is the only evidence, which inferPropertyFromQuantities classifies.
    const normalized = normalizeFields(
      [
        { name: "Napięcie znamionowe", value: "400 V" },
        { name: "Prąd znamionowy", value: "16 A" },
        { name: "Masa netto", value: "0.5 kg" },
        // dangerous qualifiers must stay OUT of the rated fields even when unmapped
        { name: "Napięcie izolacji", value: "690 V" },
        { name: "Prąd zwarciowy", value: "6 kA" }
      ],
      []
    );
    expect(normalized.voltage).toBe("400 V");
    expect(normalized.current).toBe("16 A");
    expect(normalized.weight).toBe("0.5 kg");
  });

  it("does not let breaking/switching capacity or impulse voltage populate the rated current/voltage fields (Phase A2)", () => {
    const normalized = normalizeFields(
      [
        { name: "Rated Current", value: "16 A" },
        { name: "Rated operational voltage Ue", value: "400 V" },
        { name: "Switching capacity", value: "6 kA" },
        { name: "Rated short-circuit breaking capacity Icu", value: "10 kA" },
        { name: "Rated impulse withstand voltage Uimp", value: "6 kV" },
        { name: "Rated insulation voltage Ui", value: "690 V" }
      ],
      []
    );
    expect(normalized.current).toBe("16 A");
    expect(normalized.voltage).toBe("400 V");
  });

  it("keeps rated current/voltage empty when ONLY surge/fault attributes exist (never wrong)", () => {
    const normalized = normalizeFields(
      [
        { name: "Rated short-circuit breaking capacity Icu", value: "10 kA" },
        { name: "Nominal discharge current In", value: "5 kA" },
        { name: "Impulse current Iimp", value: "12.5 kA" },
        { name: "Rated impulse withstand voltage Uimp", value: "6 kV" },
        { name: "Rated insulation voltage Ui", value: "690 V" }
      ],
      []
    );
    // These surge/fault ratings must NOT be promoted into rated current/voltage.
    expect(normalized.current).not.toBe("10 kA");
    expect(normalized.current).not.toBe("5 kA");
    expect(normalized.current).not.toBe("12.5 kA");
    expect(normalized.voltage).not.toBe("6 kV");
    expect(normalized.voltage).not.toBe("690 V");
  });

  it("keeps an exact Eaton SPD's surge current only when the same exact SKU page identifies it", () => {
    const exactPage = "https://www.eaton.com/us/en-us/skuPage.SPM250240D4T.html";
    const exact = [
      { group: "General specifications", name: "Product Type", value: "Surge protection device", parser: "eaton-product-page", sourceType: "official-fallback" as const, sourceUrl: exactPage },
      { group: "General specifications", name: "Catalog Number", value: "SPM250240D4T", parser: "eaton-product-page", sourceType: "official-fallback" as const, sourceUrl: exactPage },
      { group: "Electrical properties", name: "Surge current", value: "250kA per phase", parser: "eaton-product-page", sourceType: "official-fallback" as const, sourceUrl: exactPage }
    ];
    expect(normalizeFields(exact, [], "eaton").current).toBe("250 kA per phase");
    expect(normalizeFields(exact.map((attribute) => ({ ...attribute, value: attribute.name === "Catalog Number" ? "OTHER-SKU" : attribute.value })), [], "eaton").current).toBeUndefined();
  });

  it("assembles Eaton product dimensions from Polish localized SKU labels", () => {
    const normalized = normalizeFields(
      [
        { name: "Wysoko\u015b\u0107 produktu", value: "2000 mm" },
        { name: "Szeroko\u015b\u0107 produktu", value: "65.5 mm" },
        { name: "D\u0142ugo\u015b\u0107/g\u0142\u0119boko\u015b\u0107 produktu", value: "40 mm" }
      ],
      []
    );

    expect(normalized.dimensions).toBe("2000 x 65.5 x 40 mm");
  });

  it("uses Eaton product dimensions instead of enclosure suitability and module-unit fields", () => {
    const normalized = normalizeFields(
      [
        { name: "Number of height units", value: "0" },
        { name: "Suitable for enclosure building width", value: "850 mm" },
        { name: "Suitable for enclosure building length/depth", value: "2000 mm" },
        { name: "Product Height", value: "15 mm" },
        { name: "Product Width", value: "760 mm" },
        { name: "Product Length/Depth", value: "1910 mm" }
      ],
      []
    );

    expect(normalized.dimensions).toBe("15 x 760 x 1910 mm");
  });

  it("maps German Eaton product dimension labels from the localized SKU page", () => {
    const normalized = normalizeFields(
      [
        { name: "Produkthöhe", value: "15 mm" },
        { name: "Produktbreite", value: "760 mm" },
        { name: "Produkt Länge/Tiefe", value: "1910 mm" }
      ],
      []
    );

    expect(normalized.dimensions).toBe("15 x 760 x 1910 mm");
  });

  it("uses the central field registry as a generic fallback for unfamiliar spec labels", () => {
    const normalized = normalizeFields(
      [
        { name: "Size", value: "120 x 80 x 55 mm" },
        { name: "Cover material", value: "polycarbonate" },
        { name: "UKCA", value: "UKCA" }
      ],
      []
    );

    expect(normalized.dimensions).toBe("120 x 80 x 55 mm");
    expect(normalized.material).toBe("polycarbonate");
    expect(normalized.certificates).toBe("UKCA");
  });

  it("normalizes verbose certification labels into compact certificate tokens", () => {
    const normalized = normalizeFields(
      [
        { name: "Certification", value: "CE Marked" },
        { name: "Certification", value: "CSA Listed" },
        { name: "Certification", value: "Registro Italiano Navale" },
        { name: "Certification", value: "UL Listed" },
        { name: "Certification", value: "UL Recognized" },
        { name: "Certification", value: "Australian RCM" },
        { name: "Certification", value: "Korean KC" },
        { name: "Certification", value: "UKCA DOC" },
        { name: "Certification", value: "Certificate Programs" }
      ],
      []
    );

    expect(normalized.certificates).toBe("UL Listed, UL Recognized, CSA Listed, CE, UKCA, KC, RCM, RINA");
  });

  it("keeps certificate cells to recognized tokens instead of copied declaration prose", () => {
    const normalized = normalizeFields(
      [
        {
          name: "Certificates",
          value:
            "UL 508, UL Recognized, cULus, cURus, CSA, CE, Lloyds, described above is in conformity with the relevant Union harmonization legislation, of conformity is issued under the sole responsibility of the manufacturer., on this Certificate.",
          sourceType: "official"
        }
      ],
      []
    );

    expect(normalized.certificates).toBe("cULus, cURus, CSA, CE, Lloyds");
    expect(normalized.certificates).not.toContain("described above");
    expect(normalized.certificates).not.toContain("UL 508");
    expect(normalized.certificates).not.toContain("UL Recognized");
  });

  it("keeps prose mined out of a compliance-declaration PDF out of the certificates column", () => {
    // `fieldMatchesLabel` matches on group + name, so EVERY attribute mined from a RoHS/REACH
    // declaration PDF — group "PDF certificate" — qualified as a certificate whatever its name was.
    // These are the real values that reached ABB 1SAP180400R0001's exported Certificates cell.
    const normalized = normalizeFields(
      [
        { group: "PDF certificate", name: "Feature", value: "(w/w)" },
        { group: "PDF certificate", name: ". RoHS", value: "compliance certificate" },
        { group: "PDF certificate", name: "REACH SVHC-253", value: "declaration" },
        { group: "PDF certificate", name: "Category", value: "II declaration" },
        { group: "PDF certificate", name: "ATEX", value: "No declaration needed" },
        { group: "PDF certificate", name: "Header", value: "CERTIFICATE Revision No" },
        { group: "PDF certificate", name: "Feature", value: "except for some part types listed in Table 1 that" },
        { group: "PDF certificate", name: ". REACH", value: "SVHC compliance certificate" },
        { group: "PDF certificate", name: "Feature", value: "II declaration for Power Supplies" },
        { group: "PDF certificate", name: "Marking", value: "CE" }
      ],
      []
    );

    // Only the one real mark in the batch survives.
    expect(normalized.certificates).toBe("CE");
  });

  it("keeps marks that are spelled from roman-numeral letters, like CCC", () => {
    // A numeral-shaped rejection eats a real certification mark; the bar is "names a mark", so CCC
    // passes on its own while a bare "II declaration" fragment names nothing and does not.
    expect(normalizeFields([{ name: "Certification", value: "CCC" }], []).certificates).toBe("CCC");
    expect(normalizeFields([{ name: "Certification", value: "II declaration" }], []).certificates).toBeUndefined();
  });

  it("recognizes DNV GL Marine, Class I Div 2, and NEC Class 2 certificate tokens", () => {
    // Real Rockwell 1606-td002 "Standards Compliance and Certifications" checkmark-matrix
    // values (see pdf-compliance-matrix.ts) — these column headers used to fall through every
    // certificate-token regex in this file and get silently dropped.
    const normalized = normalizeFields(
      [
        {
          group: "PDF Compliance Matrix",
          name: "Certifications",
          value: "CE, UL 61010-2-201, IECEx, ATEX, Class I Div. 2 HazLoc, DNV GL Marine, EAC Registration, NEC Class 2",
          sourceType: "official"
        }
      ],
      []
    );

    expect(normalized.certificates).toContain("DNV GL Marine");
    expect(normalized.certificates).toContain("Class I Div. 2 HazLoc");
    expect(normalized.certificates).toContain("NEC Class 2");
    expect(normalized.certificates).toContain("IECEx");
    expect(normalized.certificates).toContain("ATEX");
  });

  it("understands an operating temperature range into min/max", () => {
    const normalized = normalizeFields([{ name: "Operating temperature", value: "-40 to +80 °C" }], []);
    expect(normalized.operatingTemperatureMin).toBe("-40");
    expect(normalized.operatingTemperatureMax).toBe("80");
  });

  it("keeps the minus sign from unicode operating temperature ranges", () => {
    const normalized = normalizeFields([{ name: "Operating temperature", value: "\u20135 \u00b0C ... +40 \u00b0C" }], []);
    expect(normalized.operatingTemperatureMin).toBe("-5");
    expect(normalized.operatingTemperatureMax).toBe("40");
  });

  it("keeps the minus sign from mojibake operating temperature ranges", () => {
    const normalized = normalizeFields([{ name: "Operating temperature", value: "\u00e2\u20ac\u00935 ?C ... +40 ?C" }], []);
    expect(normalized.operatingTemperatureMin).toBe("-5");
    expect(normalized.operatingTemperatureMax).toBe("40");
  });

  it("understands a German Umgebungstemperatur 'bis' range", () => {
    const normalized = normalizeFields([{ name: "Umgebungstemperatur", value: "-20 °C bis +55 °C" }], []);
    expect(normalized.operatingTemperatureMin).toBe("-20");
    expect(normalized.operatingTemperatureMax).toBe("55");
  });

  it("does not read a current de-rating row as operating temperature", () => {
    const normalized = normalizeFields(
      [{ name: "Rated Operational Current AC-1", value: "(690 V) 40 C 70 A; (690 V) 60 C 60 A" }],
      []
    );
    expect(normalized.operatingTemperatureMin).toBeUndefined();
    expect(normalized.operatingTemperatureMax).toBeUndefined();
  });

  it("does not treat color temperature as operating temperature", () => {
    const normalized = normalizeFields([{ group: "Balluff Key features", name: "Color temperature", value: "4000 K" }], []);
    expect(normalized.operatingTemperatureMin).toBeUndefined();
    expect(normalized.operatingTemperatureMax).toBeUndefined();
  });

  it("understands German material names and steel grades", () => {
    expect(normalizeFields([{ name: "Construction", value: "Edelstahl 1.4301" }], []).material).toBe("stainless steel Type 304");
    expect(normalizeFields([{ name: "Construction", value: "Gehäuse aus Edelstahl" }], []).material).toBe("stainless steel");
    expect(normalizeFields([{ name: "Construction", value: "verzinkter Stahl" }], []).material).toBe("galvanized steel");
    expect(normalizeFields([{ name: "Construction", value: "Kunststoff" }], []).material).toBe("plastic");
  });

  it("ignores accessory cable order-warning text as product material", () => {
    const normalized = normalizeFields(
      [
        {
          name: "Material",
          value: "Ethylene Propylene Diene Monomer (EPDM). Do not order part number CP-USB-B, as it is made of silicone rubber.",
          sourceType: "official"
        },
        {
          name: "Product Description",
          value: "ControlLogix 5580 Controller with 5 MB User Memory, USB Port, 1 gigabit Ethernet port",
          sourceType: "official"
        }
      ],
      []
    );

    expect(normalized.material).toBeUndefined();
  });

  it("ignores a generic DIN/ISO thread-tolerance standard's steel-vs-plastic scope text as product material", () => {
    // Real Ganter "Metric ISO Thread DIN 13" reference document: a shared bolt/nut thread tolerance
    // table with NO catalog number anywhere in its text (confirmed via a raw pdftotext dump) —
    // attached to many product pages, steel and plastic ones alike. Its "Feature" prose explains
    // which thread TYPE the tolerance table covers, not this specific product's construction.
    const normalized = normalizeFields(
      [
        {
          name: "Feature",
          value: "The metric steel / metal threads specified in this catalog are based on these tolerance fields.",
          sourceType: "official"
        },
        {
          name: "Feature",
          value: "For threads in plastic standard parts (without steel or metallic thread insert), these tolerances can usually not be maintained.",
          sourceType: "official"
        }
      ],
      []
    );

    expect(normalized.material).toBeUndefined();
  });

  it("understands German colours and RAL codes from finish text", () => {
    expect(normalizeFields([{ name: "Finish", value: "hellgrau pulverbeschichtet" }], []).color).toBe("light gray");
    expect(normalizeFields([{ name: "Finish", value: "powder coated, RAL 7035" }], []).color).toBe("RAL 7035");
  });

  it("gap-fills material from a French label the field patterns miss (via ontology)", () => {
    expect(normalizeFields([{ name: "Matériau", value: "acier inoxydable" }], []).material).toBe("stainless steel");
  });

  it("gap-fills colour (RAL) from a French label (via ontology)", () => {
    expect(normalizeFields([{ name: "Couleur", value: "RAL 7035" }], []).color).toBe("RAL 7035");
  });

  it("understands French/Italian materials via the expanded lexicon", () => {
    expect(normalizeFields([{ name: "Matériau", value: "fonte" }], []).material).toBe("cast iron");
    expect(normalizeFields([{ name: "Materiale", value: "ottone" }], []).material).toBe("brass");
  });

  it("understands French/Italian colours via the expanded lexicon", () => {
    expect(normalizeFields([{ name: "Couleur", value: "gris" }], []).color).toBe("gray");
    expect(normalizeFields([{ name: "Colore", value: "nero" }], []).color).toBe("black");
  });

  it("mines product colour from explicit prose without treating display colour as housing colour", () => {
    expect(
      normalizeFields(
        [{ name: "Long Description", value: "Painted steel enclosure. Color is ANSI-61 gray for the housing." }],
        []
      ).color
    ).toBe("ANSI-61 gray");
    expect(
      normalizeFields(
        [{ name: "Product Description", value: "Operator panel with TFT display colour 16 million colours and color temperature controls." }],
        []
      ).color
    ).toBeUndefined();
  });

  it("mines colour and material from messy prose when colour is attached to the housing material", () => {
    const normalized = normalizeFields(
      [{ name: "Long Description", value: "Gray powder-coated steel enclosure with clear polycarbonate viewing window." }],
      []
    );

    expect(normalized.material).toBe("powder-coated steel");
    expect(normalized.color).toBe("gray");
  });

  it("understands reinforced polymer and component colour from prose", () => {
    const normalized = normalizeFields(
      [{ name: "Product Description", value: "Housing made from PA6 GF30, black; terminals are nickel plated brass." }],
      []
    );

    expect(normalized.material).toBe("polyamide GF30");
    expect(normalized.color).toBe("black");
  });

  it("understands die-cast aluminium material and foreign colour from prose", () => {
    const normalized = normalizeFields(
      [{ name: "Overview", value: "Robust aluminium die-cast body, schwarz pulverbeschichtet, IP67." }],
      []
    );

    expect(normalized.material).toBe("die-cast aluminum");
    expect(normalized.color).toBe("black");
  });

  it("rejects a physically impossible operating temperature range", () => {
    const normalized = normalizeFields([{ name: "Operating temperature", value: "-40 to 5000 °C" }], []);
    expect(normalized.operatingTemperatureMin).toBeUndefined();
    expect(normalized.operatingTemperatureMax).toBeUndefined();
  });

  it("mines operating temperature buried in a long description, ignoring current de-rating", () => {
    const normalized = normalizeFields(
      [{ name: "Long Description", value: "3-pole contactor, 24 V coil, ambient temperature -25 to +60 °C, rated current 16 A at 40 °C." }],
      []
    );
    expect(normalized.operatingTemperatureMin).toBe("-25");
    expect(normalized.operatingTemperatureMax).toBe("60");
  });

  it("does not invent operating temperature from a description without temperature", () => {
    const normalized = normalizeFields(
      [{ name: "Long Description", value: "Compact 3-pole contactor, 24 V coil, rated current 16 A." }],
      []
    );
    expect(normalized.operatingTemperatureMin).toBeUndefined();
    expect(normalized.operatingTemperatureMax).toBeUndefined();
  });

  it("normalizes units and prefers official evidence over distributor values", () => {
    const normalized = normalizeFields(
      [
        { name: "Product Net Weight", value: "2 lb", sourceType: "distributor", parser: "fallback" },
        { name: "Product Net Weight", value: "900 g", sourceType: "official-fallback", parser: "api" },
        { name: "Dimensions", value: "2 x 3 x 4 in", sourceType: "official-fallback", parser: "api" }
      ],
      []
    );

    expect(normalized.weight).toBe("900 g (0.90 kg)");
    expect(normalized.dimensions).toBe("2 x 3 x 4 in (50.8 x 76.2 x 101.6 mm)");
  });

  it("rejects a weight value that concatenates several different models' measurements and falls through to a clean candidate", () => {
    const normalized = normalizeFields(
      [
        {
          group: "PDF datasheet - Dimensions",
          name: "Weight",
          value: "930 g (2.05 lb) 440 g (0.97 lb) 620 g (1.37 lb) 620 g (1.37 lb) 900 g",
          sourceType: "generated",
          parser: "pdf-table-extractor"
        },
        {
          group: "PDF Positioned Table",
          name: "Weight",
          value: "620 g (1.37 lb)",
          sourceType: "official",
          parser: "pdf-positioned-table"
        }
      ],
      []
    );

    expect(normalized.weight).toBe("620 g (1.37 lb) (0.62 kg)");
  });

  it("rejects a weight with two same-unit readings glued together even without a separator", () => {
    const normalized = normalizeFields(
      [{ group: "PDF datasheet - Dimensions", name: "Weight", value: "600 g 700 g", sourceType: "generated", parser: "pdf-table-extractor" }],
      []
    );

    expect(normalized.weight).toBeUndefined();
  });

  it("rejects dimensions that concatenate several different models' H x W x D triplets", () => {
    const normalized = normalizeFields(
      [
        {
          group: "PDF datasheet - Dimensions",
          name: "Dimensions",
          value: "90 x 106 x 70 mm 39 x 124 x 117 mm 65 x 124 x 127 mm",
          sourceType: "generated",
          parser: "pdf-table-extractor"
        },
        { group: "PDF Positioned Table", name: "Dimensions", value: "65 x 124 x 127 mm", sourceType: "official", parser: "pdf-positioned-table" }
      ],
      []
    );

    expect(normalized.dimensions).toBe("65 x 124 x 127 mm");
  });

  it("prefers real Balluff DPP weight over certificate contact text", () => {
    const normalized = normalizeFields(
      [
        {
          group: "PDF certificate",
          name: "weight",
          value: "Please contact support.de@balluff.de for more information.",
          sourceType: "generated",
          parser: "pdf-table-extractor"
        },
        {
          group: "Balluff Digital Product Passport",
          name: "Weight",
          value: "59 g",
          sourceType: "official",
          parser: "balluff-browser-expanded-product-page"
        }
      ],
      []
    );

    expect(normalized.weight).toBe("59 g (0.059 kg)");
  });

  it("does not treat Balluff MTTF years or cable cross-section as current/dimensions", () => {
    const normalized = normalizeFields(
      [
        {
          group: "PDF datasheet - Environmental conditions",
          name: "MTTF (40 °C)",
          value: "1000 a",
          sourceType: "generated",
          parser: "pdf-table-extractor"
        },
        {
          group: "Balluff Digital Product Passport",
          name: "Resolution",
          value: "multi turn [bit]; PVC grey, 4x2x0.14 mm²",
          sourceType: "official-fallback",
          parser: "balluff-browser-expanded-product-page"
        },
        {
          group: "PDF datasheet",
          name: "Dimensions",
          value: "4x2x0.14 mm²",
          sourceType: "generated",
          parser: "pdf-table-extractor"
        },
        {
          group: "Specs",
          name: "Current",
          value: "12 A",
          sourceType: "official"
        }
      ],
      []
    );

    expect(normalized.current).toBe("12 A");
    expect(normalized.dimensions).toBeUndefined();
  });

  it("summarizes Schneider environmental certificate documents without product-title noise", () => {
    const normalized = normalizeFields(
      [],
      [
        {
          type: "certificate",
          label: "Motor circuit breaker,TeSys Deca,push-button",
          url: "https://download.schneider-electric.com/files?p_enDocType=Environmental+Disclosure&p_Doc_Ref=ENVPEP1210004EN"
        },
        {
          type: "certificate",
          label: "Circularity Profile",
          url: "https://download.se.com/files?p_enDocType=Circularity+Profile&p_Doc_Ref=ENVEOLI121004"
        }
      ]
    );

    expect(normalized.certificates).toContain("Environmental Disclosure");
    expect(normalized.certificates).toContain("Circularity Profile");
    expect(normalized.certificates).not.toContain("Motor circuit breaker");
  });

  it("summarizes Telemecanique declaration documents without long product-title noise", () => {
    const normalized = normalizeFields(
      [],
      [
        {
          type: "certificate",
          label: "TESEDEC1000EN - REACH Declaration - for XS618B1PAL2 - 03112026 (pdf)",
          url: "https://telemecaniquesensors.com/global/en/download/dam/TESEDEC1000EN"
        },
        {
          type: "certificate",
          label: "XS5••B1/BL/BS… and XS6••B1/B2/B3/B4/B5… inductive proximity switches with discrete output - EU declaration of conformity (PDF)",
          url: "https://telemecaniquesensors.com/global/en/download/dam/TESEDEC0000EN_EU"
        }
      ]
    );

    expect(normalized.certificates).toContain("REACH Regulation");
    expect(normalized.certificates).toContain("EU Declaration of Conformity");
    expect(normalized.certificates).not.toContain("XS5");
  });

  it("derives Schneider reader-title electrical ratings when the full page is blocked", () => {
    const powerSupply = normalizeFields(
      [
        {
          group: "Plain Text",
          name: "Title: ABL8REM24030 - regulated power supply, Phaseo, 100 to 240 V, 24 V, 3 A",
          value: "Schneider Electric USA",
          sourceType: "official-fallback",
          parser: "Schneider reader"
        }
      ],
      []
    );
    expect(powerSupply.voltage).toBe("100...240 V");
    expect(powerSupply.current).toBe("3 A");

    const enclosure = normalizeFields(
      [
        {
          group: "Plain Text",
          name: "Title",
          value: "NSYS3D3215 - Wall mounted steel enclosure, 300x200x150mm, IP66, IK10 | Schneider Electric USA",
          sourceType: "official-fallback",
          parser: "Schneider reader"
        }
      ],
      []
    );
    expect(enclosure.protection).toContain("IP66");
    expect(enclosure.dimensions).toBe("300x200x150mm");

    const analogModule = normalizeFields(
      [
        {
          group: "Schneider Product Info",
          name: "Description",
          value: "IO analog module; Modicon TM3; 4 inputs; 2 output; spring; 24V DC TM3AM6G",
          sourceType: "official-fallback",
          parser: "schneider-datasheet-reader"
        }
      ],
      []
    );
    expect(analogModule.voltage).toBe("24 V DC");
  });

  it("prefers output voltage for source-backed power supplies from unseen manufacturers", () => {
    const normalized = normalizeFields(
      [
        {
          group: "Product Data",
          name: "Product Type",
          value: "DIN rail power supply",
          sourceType: "official",
          sourceUrl: "https://example.test/products/PSU-24-5"
        },
        {
          group: "Electrical Data",
          name: "Input voltage",
          value: "100...240 V AC",
          sourceType: "official",
          sourceUrl: "https://example.test/products/PSU-24-5"
        },
        {
          group: "Electrical Data",
          name: "Rated output voltage",
          value: "24 V DC",
          sourceType: "official",
          sourceUrl: "https://example.test/products/PSU-24-5"
        },
        {
          group: "Electrical Data",
          name: "Output current",
          value: "5 A",
          sourceType: "official",
          sourceUrl: "https://example.test/products/PSU-24-5"
        }
      ],
      []
    );

    expect(normalized.voltage).toBe("24 V DC");
    expect(normalized.current).toBe("5 A");
  });

  it("derives SCE enclosure material, wall thickness, finish, and color from page sections", () => {
    const normalized = normalizeFields(
      [
        { group: "Construction", name: "Construction Detail", value: "0.075 In. carbon steel." },
        { group: "Finish", name: "Finish", value: "ANSI-61 gray powder coating inside and out. Optional sub-panels are powder coated white." },
        {
          group: "PDF manual",
          name: "Material",
          value: "so they resent an explosion hazard.",
          sourceType: "generated",
          parser: "pdf-table-extractor",
          stage: "enrich-documents"
        }
      ],
      []
    );

    expect(normalized.material).toBe("carbon steel");
    expect(normalized.wallThickness).toBe("0.075 in (1.91 mm)");
    expect(normalized.finish).toBe("ANSI-61 gray powder coating inside and out. Optional sub-panels are powder coated white.");
    expect(normalized.color).toBe("ANSI-61 gray (optional sub-panels white)");
  });

  it("keeps SCE stainless material grades from construction text", () => {
    const normalized = normalizeFields(
      [
        { group: "Construction", name: "Construction Detail", value: "0.075 In. stainless steel Type 316/316L." },
        { group: "Product Specifications", name: "Description", value: "S.S. EL Enclosure" }
      ],
      []
    );

    expect(normalized.material).toBe("stainless steel Type 316/316L");
    expect(normalized.wallThickness).toBe("0.075 in (1.91 mm)");
  });

  it("does not mistake SCE stainless fasteners for the main product material", () => {
    const normalized = normalizeFields(
      [
        {
          group: "Application",
          name: "Application",
          value: "Protects door hardware against dripping water. Stainless steel screws are supplied with each kit. Made of steel and finished with ANSI-61 gray powder coating."
        }
      ],
      []
    );

    expect(normalized.material).toBe("steel");
  });

  it("extracts SCE voltage from short Volt fields and product descriptions", () => {
    const heater = normalizeFields([{ group: "Product Specifications", name: "Volt", value: "120 VAC" }], []);
    expect(heater.voltage).toBe("120 V AC");

    const blower = normalizeFields(
      [
        { group: "Product Specifications", name: "Volt", value: "115", sourceType: "official" },
        { group: "Similar Part Numbers", name: "Similar Part", value: "SCE-BP230 Blower Package 230 V", sourceType: "official" }
      ],
      []
    );
    expect(blower.voltage).toBe("115 V");

    const airConditioner = normalizeFields(
      [
        {
          group: "Product Specifications",
          name: "Description",
          value: "Conditioner, NG Air - 1195 BTU/Hr. 120 Volt"
        }
      ],
      []
    );
    expect(airConditioner.voltage).toBe("120 V");

    const light = normalizeFields([{ group: "SCE Product Data", name: "Product Type", value: "Fixture, LED Light 24VDC" }], []);
    expect(light.voltage).toBe("24 V DC");
  });

  it("normalizes SCE input power and numeric max current fields", () => {
    const ethernetConverter = normalizeFields(
      [
        { group: "Product Specifications", name: "Input Power", value: "85 to 264 VDC" },
        { group: "Product Specifications", name: "Max. Current", value: "2.5" }
      ],
      []
    );

    expect(ethernetConverter.voltage).toBe("85...264 V DC");
    expect(ethernetConverter.current).toBe("2.5 A");
  });

  it("does not infer SCE wall thickness from lead wires or mounting flanges", () => {
    const fan = normalizeFields(
      [
        {
          group: "Application",
          name: "Application",
          value:
            "Consists of a washable aluminum filter, steel air plenum, removable stainless steel grille, single phase fan, and approximately 14 inch of lead wire."
        }
      ],
      []
    );
    expect(fan.wallThickness).toBeUndefined();

    const light = normalizeFields(
      [
        {
          group: "Application",
          name: "Application",
          value: "SCE-LFMTGK light fixture mounting kit is required for enclosures with a 3.5 inch flange, when top mounted."
        }
      ],
      []
    );
    expect(light.wallThickness).toBeUndefined();
  });

  it("prefers SCE base and cover materials over secondary filters or fasteners", () => {
    const regulator = normalizeFields(
      [
        { group: "Construction", name: "Construction Detail", value: "Base material - Techpolymer" },
        { group: "Construction", name: "Construction Detail", value: "Stainless Steel Ports" },
        { group: "Construction", name: "Construction Detail", value: "Stainless Steel Mounting Bracket" }
      ],
      []
    );
    expect(regulator.material).toBe("Techpolymer");

    const airConditioner = normalizeFields(
      [
        { group: "Construction", name: "Construction Detail", value: "Washable, reusable aluminum mesh filters included" },
        { group: "Finish", name: "Finish", value: "Powder coated steel Cover RAL 7035 River Texture over Aluzinc coated steel" }
      ],
      []
    );
    expect(airConditioner.material).toBe("aluzinc coated steel");
  });

  it("derives SCE finish and color from application or construction text when no Finish section exists", () => {
    const normalized = normalizeFields(
      [
        {
          group: "Application",
          name: "Application",
          value: "LED bulb with PVC frosted white protective diffuser included. Housing made from steel and powder coated white."
        }
      ],
      []
    );

    expect(normalized.material).toBe("steel");
    expect(normalized.finish).toBe("powder coated white");
    expect(normalized.color).toBe("white");
  });

  it("keeps SCE galvanized panel material separate from white powder coat color", () => {
    const standardPanel = normalizeFields(
      [
        {
          group: "Application",
          name: "Application",
          value:
            "Panels for single-door enclosures, can be positioned anywhere along the horizontal mounting channels. Mounting hardware is included. Made of heavy gauge steel and powder coated white. GALV panels made of galvanized steel. GALV Part numbers are Galvanized."
        }
      ],
      []
    );
    expect(standardPanel.material).toBe("steel");
    expect(standardPanel.finish).toBe("powder coated white");
    expect(standardPanel.color).toBe("white");

    const galvPanel = normalizeFields(
      [
        {
          group: "Application",
          name: "Application",
          value:
            "Panels for single-door enclosures, can be positioned anywhere along the horizontal mounting channels. Mounting hardware is included. Made of heavy gauge steel and powder coated white. GALV panels made of galvanized steel. GALV Part numbers are Galvanized."
        },
        { group: "Finish", name: "Finish", value: "powder coated white", sourceType: "official", parser: "sce-product-page", confidence: 0.9 },
        { group: "SCE Catalog Variant", name: "Material", value: "galvanized steel", sourceType: "official" },
        { group: "SCE Catalog Variant", name: "Finish", value: "galvanized", sourceType: "official" }
      ],
      []
    );
    expect(galvPanel.material).toBe("galvanized steel");
    expect(galvPanel.finish).toBe("galvanized");
    expect(galvPanel.color).toBeUndefined();
  });

  it("does not turn SCE not-applicable standards into real UL or CSA certificates", () => {
    const normalized = normalizeFields(
      [
        { group: "Industry Standards - (IS17)", name: "Standard", value: "NEMA Not Applicable" },
        { group: "Industry Standards - (IS17)", name: "Standard", value: "UL Not Applicable" },
        { group: "Industry Standards - (IS17)", name: "Standard", value: "CSA N/A" }
      ],
      []
    );

    expect(normalized.certificates).toContain("NEMA Not Applicable");
    expect(normalized.certificates).toContain("UL Not Applicable");
    expect(normalized.certificates).toContain("CSA N/A");
    expect(normalized.certificates?.split(";").map((item) => item.trim())).not.toContain("UL");
    expect(normalized.certificates?.split(";").map((item) => item.trim())).not.toContain("CSA");
  });

  it("keeps SCE industry standard certificate bullets literal", () => {
    const normalized = normalizeFields(
      [
        { group: "Industry Standards - (IS4)", name: "Standard", value: "NEMA Type 3R, 4, 12 and Type 13" },
        { group: "Industry Standards - (IS4)", name: "Standard", value: "UL Listed Type 3R, 4 and 12" },
        { group: "Industry Standards - (IS4)", name: "Standard", value: "CSA Type 3R, 4 and 12" },
        { group: "Industry Standards - (IS6)", name: "Standard", value: "IEC 60529" },
        { group: "Industry Standards - (IS6)", name: "Standard", value: "IP 66" }
      ],
      []
    );

    expect(normalized.certificates).toBe("NEMA Type 3R, 4, 12 and Type 13, UL Listed Type 3R, 4 and 12, CSA Type 3R, 4 and 12, IEC 60529, IP 66");
    expect(normalized.certificates).not.toContain("UL Listed Type 4X");
  });

  it("keeps detailed SCE UL/cULus file certificates without redundant standalone UL", () => {
    const normalized = normalizeFields(
      [
        { group: "SCE Certification Details", name: "Certification Detail", value: "cULus File Component Recognized SA32278" },
        { group: "SCE Certification Details", name: "Certification Detail", value: "cULus Listed E498756" },
        { group: "SCE Certification Details", name: "Certification Detail", value: "UL File E319779" }
      ],
      []
    );

    expect(normalized.certificates).toContain("cULus File Component Recognized SA32278");
    expect(normalized.certificates).toContain("cULus Listed E498756");
    expect(normalized.certificates).toContain("UL File E319779");
    expect(normalized.certificates?.split(";").map((item) => item.trim())).not.toContain("UL");
  });

  it("extracts SCE thermostat switch ratings from application text", () => {
    const normalized = normalizeFields(
      [
        {
          group: "Application",
          name: "Application",
          value:
            "This mechanical bi-metallic thermostat has a set point range of 30° to 140° F, switch capacity 10 amp 120-250 VAC Resistive load and 1 amp 120-250VAC Inductive load, 1.25 amp 24VDC."
        }
      ],
      []
    );

    expect(normalized.voltage).toBe("120...250 V AC");
    expect(normalized.current).toBe("10 A");
  });

  it("does not treat SCE stainless cleaner descriptions as product material", () => {
    const normalized = normalizeFields([{ group: "Product Specifications", name: "Description", value: "Stainless Steel Cleaner" }], []);

    expect(normalized.material).toBeUndefined();
  });

  it("does not infer wall thickness from generic material descriptions with unrelated dimensions", () => {
    const normalized = normalizeFields(
      [
        {
          group: "Meta",
          name: "description",
          value: "Linear position sensor - Housing material: Aluminium, Anodized, Measuring range: 200 mm"
        },
        { group: "Balluff Key features", name: "Housing material", value: "Aluminium, Anodized" },
        { group: "Balluff Key features", name: "Measuring range", value: "200 mm" }
      ],
      []
    );

    expect(normalized.material).toBe("Aluminium, Anodized");
    expect(normalized.wallThickness).toBeUndefined();
  });

  it("does not infer current from Balluff catalog fragments that contain an A suffix", () => {
    const normalized = normalizeFields(
      [
        {
          group: "Meta",
          name: "description",
          value: "BGL0001 (BGL 10A-001-S49) - Standard fork light barriers made of metal, Operating voltage Ub: 10...30 VDC"
        },
        { group: "Balluff Key features", name: "Operating voltage Ub", value: "10...30 VDC" },
        { group: "Balluff Key features", name: "Principle of operation", value: "Fork sensor" }
      ],
      []
    );

    expect(normalized.voltage).toBe("10...30 V DC");
    expect(normalized.current).toBeUndefined();
  });

  it("normalizes Balluff datasheet US/UA supply voltage labels", () => {
    const normalized = normalizeFields(
      [
        { group: "PDF datasheet - Electrical data", name: "US, sensor", value: "18...30 VDC", sourceType: "generated", parser: "pdf-table-extractor" },
        { group: "PDF datasheet - Electrical data", name: "UA, actuator", value: "18...30 VDC", sourceType: "generated", parser: "pdf-table-extractor" },
        { group: "PDF datasheet - Electrical data", name: "Current sum US, sensor", value: "1.2 A", sourceType: "generated", parser: "pdf-table-extractor" }
      ],
      []
    );

    expect(normalized.voltage).toBe("18...30 V DC");
    expect(normalized.current).toBe("1.2 A");
  });

  it("normalizes Balluff cable length and keeps CE with material compliance documents", () => {
    const normalized = normalizeFields(
      [
        { group: "Balluff Key features", name: "Cable", value: "PUR black, 0.3 m, drag chain compatible" },
        { group: "Balluff Key features", name: "Approval/Conformity", value: "CE; cULus; WEEE" }
      ],
      [{ type: "certificate", label: "Material compliance declaration", url: "https://publications.balluff.com/pdfengine/pdf?id=PV156653&type=mcd&language=en" }]
    );

    expect(normalized.dimensions).toBe("Cable length 0.3 m (300 mm)");
    expect(normalized.material).toBe("PUR black");
    expect(normalized.color).toBe("black");
    expect(normalized.certificates).toContain("CE");
    expect(normalized.certificates).toContain("cULus");
    expect(normalized.certificates).toContain("Material compliance declaration");
  });

  it("keeps explicit Balluff polymer material codes", () => {
    const normalized = normalizeFields([{ group: "Meta Specs", name: "Material", value: "PA" }], []);

    expect(normalized.material).toBe("PA");
  });

  it("recognizes PBTP and other engineering polymer codes from Balluff datasheets", () => {
    for (const code of ["PBTP", "PETP", "PEEK", "PPS", "TPU", "ASA"]) {
      const normalized = normalizeFields([{ group: "PDF datasheet", name: "Housing material", value: code }], []);
      expect(normalized.material).toBe(code);
    }
  });

  it("uses explicit Balluff lens dimensions instead of focal length as a product dimension", () => {
    const normalized = normalizeFields(
      [
        { group: "Balluff Key features", name: "Focal length", value: "8 mm" },
        { group: "Balluff Key features", name: "Minimum object distance (MOD)", value: "200 mm" },
        { group: "Balluff Key features", name: "Max. Sensor size", value: '1"' },
        { group: "Balluff Key features", name: "Dimension", value: "Ø 58 x 79.5 mm" },
        { group: "Balluff Key features", name: "Material", value: "Aluminum, black anodized" },
        { group: "Balluff Key features", name: "Weight", value: "235 g" }
      ],
      []
    );

    expect(normalized.dimensions).toBe("Ø 58 x 79.5 mm");
    expect(normalized.weight).toBe("235 g (0.235 kg)");
    expect(normalized.finish).toBe("black anodized");
    expect(normalized.color).toBe("black");
  });

  it("does not infer Schneider wall thickness from product dimensions or 22 mm operator size", () => {
    const enclosure = normalizeFields(
      [
        {
          group: "Schneider Description",
          name: "Long Description",
          value:
            "Spacial S3D wall mounted steel enclosure with plain door. 300 x 200 x 150 mm. Single piece body, without mounting plate. Gutter shaped front rail double sheet thickness."
        },
        { group: "Schneider Main", name: "Enclosure nominal depth", value: "5.9 in (150 mm)" },
        { group: "Schneider Complementary", name: "Material", value: "steel" }
      ],
      []
    );
    const pushButton = normalizeFields(
      [
        {
          group: "Schneider Description",
          name: "Long Description",
          value: "Harmony 22 mm modular push buttons with a snap fit head and body."
        },
        { group: "Schneider Main", name: "Mounting diameter", value: "0.9 in (22.5 mm)" },
        { group: "Schneider Main", name: "Bezel material", value: "Chromium plated metal" }
      ],
      []
    );

    expect(enclosure.wallThickness).toBeUndefined();
    expect(pushButton.wallThickness).toBeUndefined();
  });

  it("does not turn package dimensions or threaded length into the product's dimensions", () => {
    const normalized = normalizeFields([
      { group: "PDF datasheet", name: "Length", value: "74 mm", sourceType: "generated" },
      { group: "PDF datasheet", name: "Threaded length", value: "52 mm", sourceType: "generated" },
      { group: "PDF datasheet", name: "Package 1 Height", value: "4.700 cm", sourceType: "generated" },
      { group: "PDF datasheet", name: "Package 1 Width", value: "5.900 cm", sourceType: "generated" },
      { group: "PDF datasheet", name: "Package 1 Length", value: "10.200 cm", sourceType: "generated" },
      { group: "PDF Ontology Spec Miner", name: "Height", value: "4.700 cm", sourceType: "generated" },
      { group: "PDF Ontology Spec Miner", name: "Width", value: "5.900 cm", sourceType: "generated" },
      { group: "PDF Ontology Spec Miner", name: "Length", value: "52 mm", sourceType: "generated" }
    ], [], "schneider");
    expect(normalized.dimensions).toBe("L 74 mm");
  });

  it("does not treat Schneider HMI display colour or inrush current as product color/current", () => {
    const normalized = normalizeFields(
      [
        { group: "Schneider Complementary", name: "[Us] rated supply voltage", value: "24 V DC +/- 20 %", sourceType: "official" },
        { group: "Schneider Complementary", name: "Power Consumption in W", value: "9 W", sourceType: "official" },
        { group: "Schneider Complementary", name: "Inrush current", value: "30 A", sourceType: "official" },
        { group: "Schneider Complementary", name: "Display colour", value: "16 million colours", sourceType: "official" }
      ],
      []
    );

    expect(normalized.voltage).toBe("24 V DC +/- 20 %");
    expect(normalized.current).toBeUndefined();
    expect(normalized.color).toBeUndefined();
  });

  it("handles Eaton cable materials and avoids secondary voltage or mounting thickness noise", () => {
    const normalized = normalizeFields(
      [
        { group: "Eaton Product specifications", name: "Material", value: "Nickel plated brass", sourceType: "official-fallback" },
        { group: "Eaton Product specifications", name: "Cable Length", value: "6 Foot", sourceType: "official-fallback" },
        { group: "Eaton Product specifications", name: "Rated impulse withstand voltage", value: "8 kV", sourceType: "official-fallback" },
        {
          group: "Eaton Product specifications",
          name: "Mounting method",
          value: "Screw fixing using fixing brackets. Top-hat rail fixing according to IEC/EN 60715, 35 mm. Wall mounting/direct mounting.",
          sourceType: "official-fallback"
        }
      ],
      []
    );

    expect(normalized.material).toBe("Nickel plated brass");
    expect(normalized.dimensions).toBe("Cable length 6 ft (1828.8 mm)");
    expect(normalized.voltage).toBeUndefined();
    expect(normalized.wallThickness).toBeUndefined();
  });

  it("prefers Schneider supply voltage over secondary output voltage labels", () => {
    const servo = normalizeFields(
      [
        { group: "Schneider Product Info", name: "Description", value: "This drive works at a rated supply voltage from 380V to 480V AC." , sourceType: "official" },
        { group: "Schneider Main", name: "Product or Component Type", value: "Servo drive", sourceType: "official" },
        { group: "Schneider Main", name: "[Us] rated supply voltage", value: "200...240 V; 380...480 V", sourceType: "official" },
        { group: "Schneider Complementary", name: "Discrete output voltage", value: "<= 30 V DC", sourceType: "official" },
        { group: "Schneider Complementary", name: "Output voltage limits", value: "<= power supply voltage", sourceType: "official" }
      ],
      []
    );
    expect(servo.voltage).toBe("200...240 V; 380...480 V");

    const safetyRelay = normalizeFields(
      [
        { group: "Schneider Main", name: "Product or Component Type", value: "Safety module", sourceType: "official" },
        { group: "Schneider Main", name: "[Us] rated supply voltage", value: "24 V AC/DC", sourceType: "official" },
        { group: "Schneider Complementary", name: "Minimum output voltage", value: "16 V for relay output", sourceType: "official" },
        { group: "Schneider Complementary", name: "Maximum output voltage", value: "30 V for relay output", sourceType: "official" },
        { group: "Schneider Complementary", name: "[Ith] conventional free air thermal current", value: "10.5 A", sourceType: "official" },
        { group: "Schneider Complementary", name: "Current consumption", value: "40 mA at 24 V DC on power supply; 90 mA at 24 V AC on power supply", sourceType: "official" }
      ],
      []
    );
    expect(safetyRelay.voltage).toBe("24 V AC/DC");
    expect(safetyRelay.current).toBe("40 mA at 24 V DC on power supply; 90 mA at 24 V AC on power supply");
  });

  it("keeps Schneider power-supply output voltage as the primary product voltage", () => {
    const normalized = normalizeFields(
      [
        { group: "Schneider Main", name: "Product or Component Type", value: "Power supply", sourceType: "official-fallback", parser: "schneider-datasheet-reader" },
        { group: "Schneider Main", name: "Rated supply voltage", value: "100...500 V AC", sourceType: "official" },
        { group: "Schneider Main", name: "Nominal input voltage", value: "100...240 V AC", sourceType: "official-fallback", parser: "schneider-datasheet-reader" },
        { group: "Schneider Main", name: "Output voltage", value: "24 V DC", sourceType: "official-fallback", parser: "schneider-datasheet-reader" }
      ],
      []
    );

    expect(normalized.voltage).toBe("24 V DC");
  });

  it("does not normalize display wording or LED status colors as device housing color", () => {
    const hmi = normalizeFields([
      { group: "PDF datasheet", name: "2 A 7 inch Wide color", value: "touch screen for HMIGXU3512", sourceType: "generated", matchLevel: "exact" },
      { group: "PDF datasheet", name: "Display colour", value: "65536 colours", sourceType: "generated", matchLevel: "exact" }
    ], [], "schneider");
    const switchDevice = normalizeFields([
      { group: "PDF datasheet", name: "Local signalling", value: "1 dual colour LED (green/yellow) for ring manager", sourceType: "generated", matchLevel: "exact" }
    ], [], "schneider");
    const lightCurtain = normalizeFields([
      { group: "PDF datasheet", name: "Colour", value: "Red", sourceType: "generated", matchLevel: "exact" }
    ], [], "schneider");

    expect(hmi.color).toBeUndefined();
    expect(switchDevice.color).toBeUndefined();
    expect(lightCurtain.color).toBe("Red");
  });

  it("uses the exact secondary voltage and transparently derives a single-secondary transformer's rated current", () => {
    const sourceUrl = "https://download.se.com/files?p_Doc_Ref=ABL6TS06B";
    const exact = { sourceType: "generated" as const, parser: "pdf-table-extractor", matchLevel: "exact" as const, sourceUrl };
    const normalized = normalizeFields([
      { group: "PDF datasheet", name: "Product or component type", value: "Safety and isolation transformer", ...exact },
      { group: "PDF datasheet", name: "Input voltage", value: "230 V AC single phase, terminal(s): N-L1", ...exact },
      { group: "PDF datasheet", name: "Output voltage", value: "24 V AC", ...exact },
      { group: "PDF datasheet", name: "Rated power in VA", value: "63 VA", ...exact },
      { group: "PDF datasheet", name: "Secondary winding", value: "Single", ...exact }
    ], [], "schneider");

    expect(normalized.voltage).toBe("24 V AC");
    expect(normalized.current).toBe("2.63 A");
  });

  it("leaves a Schneider light curtain's single current field blank when the PDP lists separate operating-state currents", () => {
    const normalized = normalizeFields([
      { group: "Schneider Main", name: "Product or Component Type", value: "Safety light curtain type 4", sourceType: "official" },
      { group: "Schneider Complementary", name: "Current consumption", value: "42 mA no-load transmitter, 83 mA no-load receiver, 42 mA transmitter, 900 mA with maximum load receiver", sourceType: "official" },
      { group: "PDF datasheet", name: "[Ie] rated operational current", value: "2 A", sourceType: "generated", matchLevel: "exact" }
    ], [], "schneider");

    expect(normalized.current).toBeUndefined();
  });

  it("does not restore the light curtain's ambiguous current when merging scraper candidates", () => {
    const attributes = [
      { group: "Schneider Main", name: "Product or Component Type", value: "Safety light curtain type 4", sourceType: "official" as const },
      { group: "PDF datasheet", name: "[Ie] rated operational current", value: "2 A", sourceType: "generated" as const, matchLevel: "exact" as const }
    ];
    const primary = {
      manufacturerId: "schneider", catalogNumber: "XUSL4E30H091N", status: "found" as const, confidence: 0.9,
      title: "Safety light curtain", normalized: { current: "2 A" }, attributes, documents: [], sources: []
    };
    const fallback = { ...primary, normalized: {} };

    expect(mergeResults(primary, fallback).normalized.current).toBeUndefined();
  });

  it("prefers a Schneider contactor's operational current to its thermal test current", () => {
    const normalized = normalizeFields(
      [
        { group: "Schneider Main", name: "Product or Component Type", value: "Contactor", sourceType: "official" },
        { group: "Schneider Main", name: "[Ie] rated operational current", value: "12 A", sourceType: "official" },
        { group: "Schneider Complementary", name: "[Ith] conventional free air thermal current", value: "25 A", sourceType: "official" }
      ],
      []
    );

    expect(normalized.current).toBe("12 A");
  });

  it("uses the Schneider contactor AC-3 motor rating when an AC-1 rating is also present", () => {
    const normalized = normalizeFields(
      [
        { group: "PDF datasheet", name: "Product or Component Type", value: "Contactor", sourceType: "generated" },
        { group: "PDF datasheet", name: "[Ie] rated operational current", value: "25 A at <= 440 V AC AC-1", sourceType: "generated" },
        { group: "Schneider Product Info", name: "Description", value: "Contactor for motor control applications up to 12A/690V AC-3/3e.", sourceType: "official" }
      ],
      []
    );

    expect(normalized.current).toBe("12 A");
  });

  it("keeps Schneider terminal and certificate materials out of the device material field", () => {
    const normalized = normalizeFields([
      { group: "Schneider Main", name: "Product or Component Type", value: "Miniature circuit breaker", sourceType: "official" },
      { group: "PDF datasheet - Specifications", name: "Connections - terminals", value: "Single terminal, rigid copper conductor", sourceType: "generated" },
      { group: "PDF certificate", name: "Material", value: "1,28E+01 1,28E+01 0* 0* 0*", sourceType: "generated" }
    ], [], "schneider");
    expect(normalized.material).toBeUndefined();
  });

  it("preserves a Schneider power module's complete rated voltage range", () => {
    const normalized = normalizeFields([
      { group: "Schneider Main", name: "Product or Component Type", value: "Power supply module", sourceType: "official" },
      { group: "PDF datasheet", name: "Rated voltage", value: "100...240 V AC", sourceType: "generated" }
    ], [], "schneider");
    expect(normalized.voltage).toBe("100...240 V AC");
  });

  it("uses a Schneider soft starter's power circuit rating ahead of its 24 V control rating", () => {
    const normalized = normalizeFields([
      { group: "Schneider Main", name: "Product or Component Type", value: "Soft starter", sourceType: "official" },
      { group: "PDF datasheet", name: "[Uc] control circuit voltage", value: "24 V DC", sourceType: "generated" },
      { group: "PDF datasheet", name: "Ue power supply voltage", value: "200...480 V - 15...10 %", sourceType: "generated" }
    ], [], "schneider");
    expect(normalized.voltage).toContain("200...480 V");
  });

  it("uses a power supply module's available secondary current, not its input current", () => {
    const normalized = normalizeFields([
      { group: "Schneider Main", name: "Product or Component Type", value: "Power supply module", sourceType: "official" },
      { group: "PDF datasheet", name: "Current at secondary voltage", value: "0.9 A 24 V DC sensor power supply", sourceType: "generated" },
      { group: "PDF datasheet", name: "Input current", value: "0.52 A / 1.04 A", sourceType: "generated" }
    ], [], "schneider");
    expect(normalized.current).toBe("0.9 A");
  });

  it("does not treat Schneider communication bus length as a physical product dimension", () => {
    const normalized = normalizeFields(
      [
        { group: "Schneider Complementary", name: "Height", value: "103.7 mm", sourceType: "official" },
        { group: "Schneider Complementary", name: "Width", value: "50 mm", sourceType: "official" },
        { group: "Schneider Complementary", name: "Bus length", value: "1000 m", sourceType: "official" },
        { group: "Schneider Complementary", name: "Tap links length", value: "15 m", sourceType: "official" }
      ],
      []
    );

    expect(normalized.dimensions).toBe("H 103.7 mm x W 50 mm");
    expect(normalized.dimensions).not.toContain("1000 m");
  });

  it("normalizes drawing dimensions when each axis repeats the unit", () => {
    const normalized = normalizeFields(
      [
        {
          group: "PDF Dimension Text",
          name: "Dimensions",
          value: "34.5 mm x 27.5 mm x 19 mm",
          sourceType: "official"
        }
      ],
      []
    );

    expect(normalized.dimensions).toBe("34.5 mm x 27.5 mm x 19 mm");
  });

  it("does not use Schneider package or timer pulse fields as product dimensions", () => {
    const normalized = normalizeFields(
      [
        { group: "Schneider Complementary", name: "Width", value: "0.9 in (22.5 mm)", sourceType: "official" },
        { group: "Schneider Complementary", name: "Control signal pulse width", value: "100 ms with load in parallel; 30 ms", sourceType: "official" },
        { group: "Schneider Packing Units", name: "Package 1 Height", value: "1.02 in (2.6 cm)", sourceType: "official" },
        { group: "Schneider Packing Units", name: "Package 1 Length", value: "3.7 in (9.5 cm)", sourceType: "official" }
      ],
      []
    );

    expect(normalized.dimensions).toBe("W 0.9 in (22.5 mm)");
    expect(normalized.dimensions).not.toContain("100 ms");
    expect(normalized.dimensions).not.toContain("1.02 in");
  });

  it("does not infer Schneider drive material from connected cable type", () => {
    const normalized = normalizeFields(
      [
        { group: "Schneider Product Info", name: "Description", value: "motion servo drive, Lexium 32", sourceType: "official" },
        { group: "Schneider Complementary", name: "Type of cable", value: "Single-strand IEC cable 122 °F (50 °C)) copper 90 °C XLPE/EPR", sourceType: "official" }
      ],
      []
    );

    expect(normalized.material).toBeUndefined();
  });

  it("cleans unmatched Schneider protection context parentheses", () => {
    const normalized = normalizeFields(
      [
        {
          group: "Schneider Environment",
          name: "IP degree of protection",
          value: "IP20 IEC 61131-2 rear panel); IP65 IEC 61131-2 front panel; NEMA 4 front panel (indoor use)",
          sourceType: "official"
        }
      ],
      []
    );

    expect(normalized.protection).toContain("IP20 IEC 61131-2 rear panel");
    expect(normalized.protection).not.toContain("panel)");
    expect(normalized.protection).toContain("NEMA 4 front panel (indoor use)");
  });

  it("does not derive current from Balluff product codes embedded in descriptions", () => {
    const normalized = normalizeFields(
      [
        {
          group: "Meta",
          name: "description",
          value: "BIS01FR (BIS V-6113-03A-C007) - RFID evaluation unit - Operating voltage Ub: 24 VDC"
        },
        { group: "Balluff Key features", name: "Operating voltage Ub", value: "24 VDC" }
      ],
      []
    );

    expect(normalized.voltage).toBe("24 V DC");
    expect(normalized.current).toBeUndefined();
  });

  it("does not treat UL labels as voltage evidence", () => {
    const normalized = normalizeFields(
      [
        { group: "ABB Product Data", name: "Product Upgrades UL", value: "ABB" },
        { group: "ABB Product Data", name: "Current Type", value: "AC" }
      ],
      []
    );

    expect(normalized.voltage).toBeUndefined();
    expect(normalized.current).toBeUndefined();
  });

  it("derives ABB electrical ratings from title and description text", () => {
    const normalized = normalizeFields(
      [
        { group: "Structured Data", name: "name", value: "RRD Motor 110 - 220Vac/dc E1.3" },
        { group: "ABB Product Data", name: "Long Description", value: "REMOTE RACKING DEVICE FOR Emax3 E1.3...E6.3 110...220V ac/dc" },
        { group: "ABB Product Data", name: "Catalog Description", value: "Current sensor for external neutral E2.3 2500A" }
      ],
      []
    );

    expect(normalized.voltage).toBe("110...220 V AC/DC");
    expect(normalized.current).toBe("2500 A");
  });

  it("does not derive current from ABB key-count text", () => {
    const normalized = normalizeFields(
      [
        { group: "Structured Data", name: "name", value: "KLP-D Bl.Ins/Sez E1.3 1aCh" },
        { group: "ABB Product Data", name: "Catalog Description", value: "KEY LOCK WITH DIFFERENT KEYS IN CONNECTED-ISOLATED POSITION 1a KEY E1.3" }
      ],
      []
    );

    expect(normalized.current).toBeUndefined();
  });

  it("normalizes ABB switch-disconnector ratings from ampere and AC utilization codes", () => {
    const normalized = normalizeFields(
      [
        { group: "ABB Product Data", name: "Rated Operational Voltage", value: "Main Circuit 1000 V", sourceType: "official" },
        { group: "ABB Product Data", name: "Ampere Rating", value: "200 A", sourceType: "official" },
        { group: "ABB Product Data", name: "Rated Operational Current AC-23A", value: "(380 ... 415 V) 250 A; (690 V) 250 A", sourceType: "official" },
        { group: "ABB Product Data", name: "Maximum Operating Voltage UL/CSA", value: "600 V", sourceType: "official" },
        { group: "ABB Product Data", name: "Current Type", value: "AC/DC", sourceType: "official" }
      ],
      []
    );

    expect(normalized.voltage).toBe("Main Circuit 1000 V");
    expect(normalized.current).toBe("200 A");
  });

  it("prefers ABB product net depth over installation wire lengths", () => {
    const normalized = normalizeFields(
      [
        { group: "ABB Product Data", name: "Product Net Height", value: "88 mm", sourceType: "official" },
        { group: "ABB Product Data", name: "Product Net Width", value: "52.5 mm", sourceType: "official" },
        { group: "ABB Product Data", name: "Wire Stripping Length", value: "12.5 mm", sourceType: "official" },
        { group: "ABB Product Data", name: "Product Net Depth / Length", value: "69 mm", sourceType: "official" }
      ],
      []
    );

    expect(normalized.dimensions).toBe("88 x 52.5 x 69 mm");
  });

  it("keeps electrical standards intact while normalizing ABB voltage ranges", () => {
    const normalized = normalizeFields(
      [
        { group: "ABB Product Data", name: "Rated Operational Voltage", value: "acc. to IEC 60898-1 400 V AC; acc. to IEC 60947-2 440 V AC", sourceType: "official" },
        { group: "ABB Product Data", name: "Extended Product Type", value: "RRD Motor 110 - 220Vac/dc E1.3", sourceType: "official" }
      ],
      []
    );

    expect(normalized.voltage).toContain("IEC 60898-1");
    expect(normalized.voltage).not.toContain("IEC 60898...1");
  });

  it("prefers ABB AC-23 switch current over AC-21 when no ampere rating exists", () => {
    const normalized = normalizeFields(
      [
        { group: "ABB Product Data", name: "Rated Operational Current AC-21A", value: "(400 V) 25 A", sourceType: "official" },
        { group: "ABB Product Data", name: "Rated Operational Current AC-23A", value: "(400 V) 16 A", sourceType: "official" }
      ],
      []
    );

    expect(normalized.current).toBe("(400 V) 16 A");
  });

  it("selects the AC-15 current paired with the product's main-circuit voltage", () => {
    // Ground truth from ABB's product-data table: current must be read from the same voltage row,
    // not from the first AC-15 entry or the conventional thermal-current line.
    const normalized = normalizeFields(
      [
        { group: "ABB Product Data", name: "Rated Operational Voltage", value: "Auxiliary Circuit 690 V\nMain Circuit 690 V", sourceType: "official" },
        { group: "ABB Product Data", name: "Conventional Free-air Thermal Current (Ith)", value: "acc. to IEC 60947-5-1, Θ = 40 °C 16 A", sourceType: "official" },
        {
          group: "ABB Product Data",
          name: "Rated Operational Current AC-15 (Ie)",
          value: "(500 V) 2 A; (690 V) 2 A; (24 / 27 V) 6 A; (220 / 240 V) 4 A; (400 / 440 V) 3 A",
          sourceType: "official"
        }
      ],
      []
    );

    expect(normalized.voltage).toContain("Main Circuit 690 V");
    expect(normalized.current).toBe("2 A");
  });

  it("does not take the first AC-15 entry when it belongs to another voltage", () => {
    const normalized = normalizeFields(
      [
        { group: "Product Data", name: "Rated Operational Voltage", value: "Main Circuit 690 V", sourceType: "official" },
        { group: "Product Data", name: "Rated Operational Current AC-15", value: "(500 V) 9 A; (690 V) 2 A", sourceType: "official" }
      ],
      []
    );

    expect(normalized.current).toBe("2 A");
  });

  it("prefers a Schneider drive's nominal output current over relay contact ratings", () => {
    const normalized = normalizeFields(
      [
        { group: "Schneider Main", name: "[Us] rated supply voltage", value: "380...480 V", sourceType: "generated" },
        { group: "PDF datasheet - Explicit ratings", name: "Nominal output current", value: "31.7 A", sourceType: "generated" },
        { group: "PDF datasheet", name: "Minimum switching current", value: "Relay output R1, R2, R3 5 mA 24 V DC", sourceType: "generated" }
      ],
      []
    );

    expect(normalized.voltage).toBe("380...480 V");
    expect(normalized.current).toBe("31.7 A");
  });

  it("extracts labeled dimensions and weight from an exact Schneider product description", () => {
    const normalized = normalizeFields(
      [{
        group: "Schneider Product Info",
        name: "Description",
        value: "This drive weighs 13.6kg and its dimensions are, 211mm wide, 546mm high, 232mm deep."
      }],
      []
    );

    expect(normalized.weight).toBe("13.6 kg");
    expect(normalized.dimensions).toBe("546 x 211 x 232 mm");
  });

  it("aligns ABB AC-15 current with the rated operational voltage field even without a main-circuit qualifier", () => {
    const normalized = normalizeFields(
      [
        { group: "ABB Product Data", name: "Rated Operational Voltage", value: "Auxiliary Circuit 690 V", sourceType: "official" },
        { group: "ABB Product Data", name: "Rated Operational Current AC-15", value: "(500 V) 9 A; (690 V) 2 A", sourceType: "official" }
      ],
      []
    );
    expect(normalized.current).toBe("2 A");
  });

  it("keeps ABB certificates as compact names only", () => {
    const normalized = normalizeAbbFields(
      [{ group: "Certificates and Declarations", name: "Certificates", value: "A2L Certificate; BV Certificate; CB Certificate; CCC Certificate; CCS Certificate; CE Declaration; UKCA Declaration; RoHS Declaration; REACH Declaration; WEEE", sourceType: "official" }],
      []
    );
    expect(normalized.certificates).toBe("A2L, BV, CB, CCC, CCS, CE, UKCA");
  });

  it("uses the monitored supply range for ABB three-phase monitoring relays", () => {
    const normalized = normalizeAbbFields(
      [
        { group: "ABB Product Data", name: "Catalog Description", value: "CM-MPS.43S Three-phase monitoring relay", sourceType: "official" },
        { group: "ABB Product Data", name: "Rated Control Supply Voltage (Us)", value: "(L-L) 300 ... 500 V AC", sourceType: "official" },
        { group: "ABB Product Data", name: "Maximum Operating Voltage UL/CSA", value: "Output Circuit 300 V AC", sourceType: "official" }
      ],
      []
    );

    expect(normalized.voltage).toBe("(L-L) 300...500 V AC");
  });

  it("keeps the ABB M4M rated measurement voltages and rejects PDF prose as color or material", () => {
    const normalized = normalizeAbbFields(
      [
        { group: "ABB Product Data", name: "Display Name", value: "M4M 20", sourceType: "official" },
        { group: "ABB Electrical", name: "Rated Voltage (U r )", value: "46 … 400 (Un) N-L V; 80 ... 690 (Un) L-L V", sourceType: "official" },
        { group: "ABB Electrical", name: "Voltage Range", value: "50 … 400 V", sourceType: "official" },
        { group: "PDF datasheet", name: "Color", value: "Graphic", sourceType: "generated" },
        { group: "PDF datasheet", name: "Material", value: "Copper", sourceType: "generated" }
      ],
      []
    );

    expect(normalized.voltage).toBe("46...400 (Un) N-L V; 80...690 (Un) L-L V");
    expect(normalized.color).toBeUndefined();
    expect(normalized.material).toBeUndefined();
  });

  it("uses the ABB product's protection rating instead of an optional accessory rating", () => {
    const normalized = normalizeAbbFields(
      [
        { group: "ABB Product Data", name: "Catalog Description", value: "PSE18-600-70 Softstarter", sourceType: "official" },
        { group: "ABB Technical", name: "Degree of Protection", value: "Main Terminals IP00", sourceType: "official" },
        { group: "PDF datasheet", name: "Degree of protection", value: "IP66", sourceType: "generated" },
        { group: "PDF datasheet", name: "Feature", value: "External keypad rated IP66 as an option", sourceType: "generated" }
      ],
      []
    );

    expect(normalized.protection).toBe("Main Terminals IP00");
  });

  it("prefers ABB power-supply input/output voltage over insulation voltage", () => {
    const normalized = normalizeFields(
      [
        { group: "ABB Product Data", name: "Rated Input Voltage", value: "100 ... 240 V AC", sourceType: "official" },
        { group: "ABB Product Data", name: "Input Voltage", value: "85 ... 264 V AC; 90 ... 375 V DC", sourceType: "official" },
        { group: "ABB Product Data", name: "Rated Output Voltage", value: "24 V DC", sourceType: "official" },
        { group: "ABB Product Data", name: "Rated Output Current", value: "2.5 A", sourceType: "official" },
        { group: "ABB Product Data", name: "Rated Insulation Voltage", value: "Input Circuit / Output Circuit 300 V", sourceType: "official" }
      ],
      []
    );

    expect(normalized.voltage).toBe("100...240 V AC");
    expect(normalized.current).toBe("2.5 A");
  });

  it("derives ABB drive current and protection from compact title text", () => {
    const normalized = normalizeFields(
      [
        { group: "Structured Data", name: "description", value: "ACS355-03E-08A8-4 Pn 4,0kW, I2n 8,8A IP20." }
      ],
      []
    );

    expect(normalized.current).toBe("8,8 A");
    expect(normalized.protection).toBe("IP20");
  });

  it("does not treat nVent conductor cross-section as wall thickness", () => {
    const normalized = normalizeFields(
      [
        { group: "Embedded Spec Rows", name: "Material", value: "Copper", sourceType: "official-fallback" },
        { group: "Embedded Spec Rows", name: "Conductor Size", value: "240 mm² Stranded;500 kcmil Stranded", sourceType: "official-fallback" },
        { group: "Features", name: "Feature", value: "Consistent material thickness, precise diameter and accurate cable fit; DIN46235", sourceType: "official-fallback" }
      ],
      []
    );

    expect(normalized.material).toBe("Copper");
    expect(normalized.wallThickness).toBeUndefined();
  });

  it("keeps nVent Raychem depth and length when no width axis exists", () => {
    const normalized = normalizeFields(
      [
        { group: "Embedded Product Table", name: "Depth (D)", value: "85 mm", sourceType: "official-fallback" },
        { group: "Embedded Product Table", name: "Height (H)", value: "110 mm", sourceType: "official-fallback" },
        { group: "Embedded Product Table", name: "Length (L)", value: "210 mm", sourceType: "official-fallback" }
      ],
      []
    );

    expect(normalized.dimensions).toBe("H 110 mm x D 85 mm x L 210 mm");
  });

  it("does not classify nVent CADDY catalog documents as CAD just because of the brand name", () => {
    expect(classifyDocument("nVent CADDY Wire Basket Tray 6.55 MB English", "https://www.nvent.com/sites/default/files/dam/catalog.pdf")).toBe("datasheet");
    expect(classifyDocument("A12126T1PP 3D Step CAD File", "https://www.nvent.com/file.step")).toBe("cad");
  });

  it("keeps nVent protection ratings out of certificate tokens and ignores lowercase asset IDs", () => {
    const normalized = normalizeFields(
      [
        { group: "Certifications", name: "Certification", value: "rohs", sourceType: "official-fallback" },
        { group: "Certifications", name: "Certification", value: "RoHS", sourceType: "official-fallback" },
        { group: "Certifications", name: "Certification", value: "UL", sourceType: "official-fallback" },
        { group: "Certifications", name: "Certification", value: "ip8062", sourceType: "official-fallback" },
        { group: "Industry Standards", name: "Industry Standard", value: "IEC 60529, IP30", sourceType: "official-fallback" }
      ],
      [{ type: "certificate", label: "nVent RoHS Declaration EFS", url: "https://www.nvent.com/rohs.pdf" }]
    );

    expect(normalized.certificates).toContain("RoHS");
    expect(normalized.certificates?.match(/RoHS/g)).toHaveLength(1);
    expect(normalized.certificates).toContain("UL");
    expect(normalized.certificates).not.toContain("IP30");
    expect(normalized.certificates).not.toContain("ip8062");
    expect(normalized.protection).toContain("IP30");
  });

  it("cleans nVent compliance resource labels while preserving real standards", () => {
    const normalized = normalizeFields(
      [
        { group: "Certifications", name: "Certification", value: "UL 2269", sourceType: "official-fallback" },
        { group: "Certifications", name: "Certification", value: "CSA C22.2 No. 18.2", sourceType: "official-fallback" },
        { group: "Certifications", name: "Certification", value: "NEMA BI 50015 UL CYNW.E324325 188.54 KB English", sourceType: "official-fallback" },
        { group: "Declarations", name: "Declaration", value: "Declaration of Conformity: Industrial Enclosure Accessories 91.78 KB English", sourceType: "official-fallback" }
      ],
      [
        {
          type: "certificate",
          label: "Declaration of Conformity: Type 12 Semiconductor Heater 97.94 KB English",
          url: "https://www.nvent.com/sites/default/files/dam/declaration.pdf"
        }
      ]
    );

    expect(normalized.certificates).toContain("UL 2269");
    expect(normalized.certificates).toContain("CSA C22.2 No. 18.2");
    expect(normalized.certificates).toContain("NEMA BI 50015");
    expect(normalized.certificates).toContain("Declaration of Conformity: Type 12 Semiconductor Heater");
    expect(normalized.certificates).not.toContain("97.94 KB");
    expect(normalized.certificates).not.toContain("English");
    expect(normalized.certificates).not.toContain("CSA File no");
  });

  it("normalizes nVent thermostat switching capacity as a current rating", () => {
    const normalized = normalizeFields(
      [
        {
          group: "PDF datasheet - Electrical Data",
          name: "Minimum switching capacity",
          value: "10 mA",
          sourceType: "official-fallback",
          parser: "pdf-table-extractor"
        },
        {
          group: "PDF datasheet - Electrical Data",
          name: "Maximum switching capacity, NC",
          value: "10 A resistive / 4 A inductive @ AC 115V",
          sourceType: "official-fallback",
          parser: "pdf-table-extractor"
        },
        {
          group: "PDF datasheet - Electrical Data",
          name: "Switching Capacity (Normally Open)",
          value: "5 A resistive/2 A inductive @250 VAC, DC 30 W",
          sourceType: "official-fallback",
          parser: "pdf-table-extractor"
        }
      ],
      []
    );

    expect(normalized.current).toBe("10 A resistive / 4 A inductive @ AC 115 V");
  });

  it("prefers a low-confidence-flagged Height/Width/Length assembly's rival combined 'Dimensions' attribute when it is better evidenced", () => {
    // Mirrors Rockwell's 1606-XLSBAT5 live bug: the digital product passport's Height/Width/Length
    // (dppAttributeConfidence in rockwell.ts deliberately drops these to 0.7 because they read like
    // rounded PACKAGING-box dimensions, not the actual battery module) used to win outright and
    // assemble into a full W x H x D string before a much better evidenced combined "Dimensions"
    // attribute from the datasheet PDF's own catalog table (confidence 0.85) ever got a say.
    const normalized = normalizeFields(
      [
        { group: "Rockwell Dimensions", name: "Height", value: "15.189 cm", confidence: 0.7, sourceType: "official" },
        { group: "Rockwell Dimensions", name: "Length", value: "18.999 cm", confidence: 0.7, sourceType: "official" },
        { group: "Rockwell Dimensions", name: "Weight", value: "2.062 kg", confidence: 0.92, sourceType: "official" },
        { group: "Rockwell Dimensions", name: "Width", value: "15.697 cm", confidence: 0.7, sourceType: "official" },
        {
          group: "PDF Catalog Table Row",
          name: "Dimensions",
          value: "90 x 106 x 70 mm (3.54 x 4.17 x 2.76 in.)",
          confidence: 0.85,
          sourceType: "generated",
          parser: "pdf-table-extractor"
        }
      ],
      []
    );

    expect(normalized.dimensions).toBe("90 x 106 x 70 mm (3.54 x 4.17 x 2.76 in.)");
  });

  it("keeps a complete dimension tuple over a lone PDF ontology axis", () => {
    const normalized = normalizeFields(
      [
        { group: "PDF Ontology Spec Miner", name: "Width", value: "10 mm", confidence: 0.78, sourceType: "generated", parser: "pdf-table-extractor" },
        { group: "PDF Dimension Text", name: "Dimensions", value: "10 x 25 x 35 mm", confidence: 0.78, sourceType: "generated", parser: "pdf-table-extractor" }
      ],
      []
    );

    expect(normalized.dimensions).toBe("10 x 25 x 35 mm");
  });

  it("does not normalize an HMI panel cut-out as the product's external dimensions", () => {
    const normalized = normalizeFields(
      [
        { group: "PDF datasheet", name: "Cut-out dimensions", value: "190 x 135 mm", confidence: 0.78, sourceType: "generated", parser: "pdf-table-extractor" }
      ],
      []
    );

    expect(normalized.dimensions).toBeUndefined();
  });

  it("still assembles Height/Width/Length when neither side states an explicit confidence (unchanged default behavior)", () => {
    const normalized = normalizeFields(
      [
        { group: "Product Table", name: "Height", value: "110 mm" },
        { group: "Product Table", name: "Width", value: "50 mm" },
        { group: "Product Table", name: "Depth", value: "85 mm" },
        { group: "Product Table", name: "Dimensions", value: "some other combined reading 999 x 999 x 999 mm" }
      ],
      []
    );

    expect(normalized.dimensions).toBe("110 x 50 x 85 mm");
  });

  it("does not let an unrelated same-group attribute (e.g. Weight) masquerade as the combined 'Dimensions' reading", () => {
    // "Rockwell Dimensions"/"Weight" sits in a dimensions-named GROUP but its own value is a weight
    // reading, not a dimension — it must not out-score and steal the combined-attribute comparison
    // from the genuine "PDF Catalog Table Row"/"Dimensions" attribute just because FIELD_LABEL_PATTERNS
    // matches on group text too and a higher raw confidence happens to sit on the wrong attribute.
    const normalized = normalizeFields(
      [
        { group: "Rockwell Dimensions", name: "Height", value: "15.189 cm", confidence: 0.7, sourceType: "official" },
        { group: "Rockwell Dimensions", name: "Width", value: "15.697 cm", confidence: 0.7, sourceType: "official" },
        { group: "Rockwell Dimensions", name: "Weight", value: "2.062 kg", confidence: 0.92, sourceType: "official" },
        {
          group: "PDF Catalog Table Row",
          name: "Dimensions",
          value: "90 x 106 x 70 mm (3.54 x 4.17 x 2.76 in.)",
          confidence: 0.85,
          sourceType: "generated",
          parser: "pdf-table-extractor"
        }
      ],
      []
    );

    expect(normalized.dimensions).toBe("90 x 106 x 70 mm (3.54 x 4.17 x 2.76 in.)");
  });
});
