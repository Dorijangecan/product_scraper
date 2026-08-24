import { describe, expect, it } from "vitest";
import { proposeUnmappedLabelMappings } from "../src/server/scrapers/llm-label-proposals.js";

const entries = [
  {
    label: "Bemessungsstoßspannung",
    occurrences: 3,
    valueKinds: ["quantity" as const],
    exampleValues: ["6 kV"],
    exampleCatalogNumbers: ["ABC-1"]
  },
  {
    label: "Mystery field",
    occurrences: 1,
    valueKinds: ["text" as const],
    exampleValues: ["42"],
    exampleCatalogNumbers: ["ABC-2"]
  }
];

describe("local LLM unmapped-label proposals", () => {
  it("is disabled by default and never calls a local model", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const result = await proposeUnmappedLabelMappings(entries);
      expect(result.status).toBe("disabled");
      expect(result.proposals).toEqual([]);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps only exact input labels and existing canonical keys as review-only proposals", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("http://ollama.test/api/generate");
      return new Response(
        JSON.stringify({
          response: JSON.stringify({
            proposals: [
              { label: "Bemessungsstoßspannung", canonicalKey: "impulseVoltage", rationale: "German impulse rating." },
              { label: "MYSTERY FIELD", canonicalKey: "not-a-property" },
              { label: "not in the teach list", canonicalKey: "ratedVoltage" },
              { label: "Bemessungsstoßspannung", canonicalKey: "ratedVoltage" }
            ]
          })
        }),
        { status: 200 }
      );
    }) as typeof fetch;
    try {
      const result = await proposeUnmappedLabelMappings(entries, { enabled: true, host: "http://ollama.test" });
      expect(result.status).toBe("reviewed");
      expect(result.proposals).toEqual([
        {
          label: "Bemessungsstoßspannung",
          canonicalKey: "impulseVoltage",
          rationale: "German impulse rating."
        }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
