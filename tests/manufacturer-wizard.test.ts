import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LearnedExtractorProposal, ManufacturerTestResult, ManufacturerTestSampleResult } from "../src/shared/types.js";
import { approveWizardLearnedExtractor, buildWizardAliasSuggestions, captureWizardFixture, confirmedLearnedExtractorSuggestions, downloadWizardDocument, requiredManufacturerSamplePasses } from "../src/server/manufacturer-wizard.js";

describe("manufacturer wizard acceptance", () => {
  it("requires two official identity-confirmed products out of three samples", () => {
    expect(requiredManufacturerSamplePasses(3)).toBe(2);
    expect(requiredManufacturerSamplePasses(5)).toBe(2);
  });

  it("refuses an undersized validation sample", () => {
    expect(() => requiredManufacturerSamplePasses(2)).toThrow(/three sample/i);
  });

  it("offers a learned recipe for saving only after two identity-confirmed samples reproduce it", () => {
    const recipe: LearnedExtractorProposal = { manufacturerId: "test", host: "example.test", kind: "dom-pattern", pattern: "css:table-row:tr.spec-row", sourceUrl: "https://example.test/products/ABC-123", parserKind: "wizard-test" };
    const sample = (catalogNumber: string, passed: boolean, selectorSuggestions: LearnedExtractorProposal[] = passed ? [recipe] : []): ManufacturerTestSampleResult => ({
      catalogNumber,
      status: passed ? "found" : "failed",
      passed,
      identityConfirmed: passed,
      confidence: passed ? 0.9 : 0,
      attributes: 0,
      documents: 0,
      evidence: 0,
      missing: [],
      attemptedUrls: [],
      selectorSuggestions,
      reason: passed ? "Official product identity confirmed." : "No product."
    });

    expect(confirmedLearnedExtractorSuggestions([
      sample("ABC-123", true),
      sample("ABC-456", true),
      sample("ABC-789", false)
    ])).toEqual([recipe]);
    expect(confirmedLearnedExtractorSuggestions([
      sample("ABC-123", true),
      sample("ABC-456", true, []),
      sample("ABC-789", true, [{ ...recipe, pattern: "json:script:#product-data", kind: "json-path" }])
    ])).toEqual([]);
  });

  it("captures only identity-confirmed HTML below the wizard test output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wizard-fixture-"));
    try {
      const fixture = await captureWizardFixture({
        runDir: root,
        manufacturerId: "test",
        catalogNumber: "ABC-123",
        productUrl: "https://example.test/products/ABC-123",
        html: "<html><title>ABC-123 controller</title></html>"
      });
      expect(fixture).toContain(path.join("fixtures", "ABC-123", "page.html"));
      expect(await fs.readFile(fixture!, "utf8")).toContain("ABC-123");
      await expect(captureWizardFixture({ ...{ runDir: root, manufacturerId: "test", catalogNumber: "ABC-123", productUrl: "https://example.test/products/ABC-123" }, html: "<html>other product</html>" })).resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("offers unmapped labels as review-only mapping suggestions", () => {
    expect(buildWizardAliasSuggestions(["Nominal Voltge", "Nominal Voltge", "Mystery field"])).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Nominal Voltge", canonicalKey: "ratedVoltage" })])
    );
  });

  it("persists only an operator-approved replayable recipe on an official host", () => {
    const persisted: unknown[] = [];
    const manufacturer = { id: "test", canonicalName: "Test", shortName: "TST", rateLimitMs: 0, officialBaseUrls: ["https://example.test"], fallbackSources: [] };
    const proposal = { manufacturerId: "test", host: "example.test", kind: "dom-pattern" as const, pattern: "css:table-row:tr.spec-row", sourceUrl: "https://example.test/products/ABC-123", parserKind: "wizard-test" };
    const validation: ManufacturerTestResult = { passed: true, foundCount: 2, sampleCount: 3, samples: [], confirmedSelectorSuggestions: [proposal], warnings: [] };
    expect(() => approveWizardLearnedExtractor(proposal, manufacturer, { upsertLearnedExtractor: () => undefined })).toThrow(/confirmed wizard test/i);
    expect(approveWizardLearnedExtractor(proposal, manufacturer, { upsertLearnedExtractor: (value) => persisted.push(value) }, validation)).toMatchObject(proposal);
    const jsonProposal = { ...proposal, kind: "json-path" as const, pattern: "json:script:#product-payload" };
    expect(approveWizardLearnedExtractor(jsonProposal, manufacturer, { upsertLearnedExtractor: (value) => persisted.push(value) }, { ...validation, confirmedSelectorSuggestions: [jsonProposal] })).toMatchObject(jsonProposal);
    const htmlTableProposal = {
      ...proposal,
      pattern: "html-table:header-column:table#product-specs:Catalog%20Number"
    };
    expect(approveWizardLearnedExtractor(
      htmlTableProposal,
      manufacturer,
      { upsertLearnedExtractor: (value) => persisted.push(value) },
      { ...validation, confirmedSelectorSuggestions: [htmlTableProposal] }
    )).toMatchObject(htmlTableProposal);
    expect(persisted).toHaveLength(3);
    expect(() => approveWizardLearnedExtractor({ ...proposal, pattern: "body *" }, manufacturer, { upsertLearnedExtractor: () => undefined }, validation)).toThrow(/replayable/i);
    expect(() => approveWizardLearnedExtractor({ ...jsonProposal, pattern: "json:script:script[data-anything]" }, manufacturer, { upsertLearnedExtractor: () => undefined }, validation)).toThrow(/replayable/i);
    expect(() => approveWizardLearnedExtractor({ ...htmlTableProposal, pattern: "html-table:header-column:table[data-anything]:Catalog%20Number" }, manufacturer, { upsertLearnedExtractor: () => undefined }, validation)).toThrow(/replayable/i);
    expect(() => approveWizardLearnedExtractor({ ...proposal, sourceUrl: "https://other.test/product" }, manufacturer, { upsertLearnedExtractor: () => undefined }, validation)).toThrow(/official/i);
  });

  it("downloads an enrichable wizard datasheet instead of marking it skipped", async () => {
    const downloaded = await downloadWizardDocument(
      {
        type: "datasheet",
        label: "Technical data",
        url: "https://example.test/docs/ABC-123.pdf"
      },
      "ABC-123",
      "C:/wizard-output/documents",
      {
        downloadFile: async (url, targetDir, suggestedName) => {
          expect(url).toBe("https://example.test/docs/ABC-123.pdf");
          expect(targetDir).toBe("C:/wizard-output/documents");
          expect(suggestedName).toMatch(/^ABC-123-datasheet-technical-data\.pdf$/);
          return "C:/wizard-output/documents/ABC-123-datasheet-technical-data.pdf";
        }
      }
    );

    expect(downloaded).toMatchObject({
      downloadStatus: "downloaded",
      localPath: "C:/wizard-output/documents/ABC-123-datasheet-technical-data.pdf"
    });
  });
});
