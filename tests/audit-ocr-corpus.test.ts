import { describe, expect, it } from "vitest";
import { parseOcrCorpusOptions } from "../scripts/audit-ocr-corpus.js";

describe("OCR corpus audit options", () => {
  it("recognizes help before any potentially expensive corpus scan", () => {
    expect(parseOcrCorpusOptions(["--help"])).toMatchObject({ help: true });
    expect(parseOcrCorpusOptions(["-h"])).toMatchObject({ help: true });
  });
});
