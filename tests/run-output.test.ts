import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ManufacturerConfig, RunRecord } from "../src/shared/types.js";
import { buildRunOutputLayout, findRunLogPath, getAllowedRunOutputRoots, isPathInsideAny } from "../src/server/run-output.js";

const manufacturer: ManufacturerConfig = {
  id: "balluff",
  canonicalName: "Balluff",
  shortName: "BAL",
  rateLimitMs: 100,
  officialBaseUrls: [],
  fallbackSources: []
};

describe("run output layout", () => {
  it("keeps run files grouped by manufacturer and file type", () => {
    const layout = buildRunOutputLayout(path.join("tmp", "outputs"), manufacturer, "run-1");

    expect(layout.runDir).toBe(path.join("tmp", "outputs", "BAL", "run-1"));
    expect(layout.excelDir).toBe(path.join("tmp", "outputs", "BAL", "run-1", "excel"));
    expect(layout.imagesDir).toBe(path.join("tmp", "outputs", "BAL", "run-1", "images"));
    expect(layout.documentsDir).toBe(path.join("tmp", "outputs", "BAL", "run-1", "documents"));
    expect(layout.logPath).toBe(path.join("tmp", "outputs", "BAL", "run-1", "logs", "run-log.txt"));
  });

  it("allows new and legacy run folders but rejects paths outside outputs", () => {
    const outputRoot = path.resolve("tmp", "outputs");
    const roots = getAllowedRunOutputRoots(outputRoot, manufacturer, "run-1");

    expect(isPathInsideAny(path.join(outputRoot, "BAL", "run-1", "images", "BAL.BCC039H.png"), roots)).toBe(true);
    expect(isPathInsideAny(path.join(outputRoot, "run-1", "documents", "old.pdf"), roots)).toBe(true);
    expect(isPathInsideAny(path.resolve("tmp", "outside", "file.pdf"), roots)).toBe(false);
  });

  it("finds the clean run log path", () => {
    const outputRoot = path.resolve("tmp", "outputs");
    const run: RunRecord = {
      id: "run-1",
      manufacturerId: "balluff",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "completed",
      total: 1,
      processed: 1,
      found: 1,
      partial: 0,
      failed: 0
    };

    expect(findRunLogPath(outputRoot, manufacturer, run)).toBe(path.join(outputRoot, "BAL", "run-1", "logs", "run-log.txt"));
  });
});
