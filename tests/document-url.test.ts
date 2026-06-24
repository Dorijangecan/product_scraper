import { describe, expect, it } from "vitest";
import { documentUrlLooksDownloadable, documentUrlLooksRelevant } from "../src/server/scrapers/document-url.js";

describe("document URL classification", () => {
  it("recognizes PDF-like query endpoints without .pdf suffixes", () => {
    expect(documentUrlLooksDownloadable("https://example.test/files?p_Doc_Ref=ABC123&p_enDocType=Data+Sheet")).toBe(true);
    expect(documentUrlLooksDownloadable("https://example.test/download?documentId=ABC123&format=pdf")).toBe(true);
  });

  it("recognizes encoded PDF filenames and MIME hints in query parameters", () => {
    expect(documentUrlLooksDownloadable("https://example.test/download?filename=ABC-123_datasheet.pdf&token=abc")).toBe(true);
    expect(documentUrlLooksDownloadable("https://example.test/asset?file=%2Fdocs%2FABC-123_manual.pdf")).toBe(true);
    expect(documentUrlLooksDownloadable("https://example.test/resource?id=ABC-123&mime=application%2Fpdf")).toBe(true);
    expect(documentUrlLooksDownloadable("https://example.test/resource?id=ABC-123&extension=pdf")).toBe(true);
  });

  it("recognizes additional CAD document extensions through the shared helper", () => {
    expect(documentUrlLooksDownloadable("https://assets.example.test/cad/ABC-123.igs")).toBe(true);
    expect(documentUrlLooksDownloadable("https://assets.example.test/cad/ABC-123.iges?download=1")).toBe(true);
    expect(documentUrlLooksDownloadable("https://assets.example.test/download?file=%2Fcad%2FABC-123.step")).toBe(true);
  });

  it("uses label and path context for non-extension document links", () => {
    expect(documentUrlLooksRelevant("https://example.test/resources/ABC123", "ABC123 technical datasheet PDF", "datasheet")).toBe(true);
    expect(documentUrlLooksRelevant("https://example.test/about", "About us", "other")).toBe(false);
  });
});
