import { describe, expect, it } from "vitest";
import { driftFromTargetHealth } from "../src/server/scrapers/mission-control.js";

describe("target-health drift bootstrap", () => {
  it("escalates three catastrophic early official-source outcomes instead of waiting for eight", () => {
    expect(driftFromTargetHealth({
      manufacturerId: "test" as never,
      host: "example.test",
      stage: "official-source",
      sampleCount: 3,
      successRate: 0,
      avgQualityScore: 0
    })).toMatchObject({ suspected: true, reason: expect.stringMatching(/bootstrap/i) });
  });

  it("does not turn a small or merely mixed sample into a drift verdict", () => {
    expect(driftFromTargetHealth({
      manufacturerId: "test" as never,
      host: "example.test",
      stage: "official-source",
      sampleCount: 2,
      successRate: 0,
      avgQualityScore: 0
    }).suspected).toBe(false);
    expect(driftFromTargetHealth({
      manufacturerId: "test" as never,
      host: "example.test",
      stage: "official-source",
      sampleCount: 3,
      successRate: 0.34,
      avgQualityScore: 44
    }).suspected).toBe(false);
  });
});
