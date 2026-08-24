import { describe, expect, it } from "vitest";
import { decodeOrderingCodeLegend, orderingCodeLegendValue } from "../src/server/scrapers/ordering-code-legend.js";

describe("ordering-code legend reader", () => {
  // Hand-transcribed from the `Position n / code = published value` table shape
  // used in configurable-drive and enclosure datasheets.
  const legend = [
    "Ordering code",
    "Degree of protection (position 6)",
    "5 = IP65",
    "4 = IP54",
    "Connection type",
    "AB = M12 connector"
  ];

  it("decodes a position-bound legend entry instead of guessing from a sibling option", () => {
    expect(decodeOrderingCodeLegend(legend, "AB1235X")).toContainEqual({
      property: "Degree of protection",
      value: "IP65",
      code: "5",
      position: 6
    });
    expect(orderingCodeLegendValue(legend, "AB1235X", /protection/i)).toBe("IP65");
    expect(orderingCodeLegendValue(legend, "AB1234X", /protection/i)).toBe("IP54");
  });

  it("does not treat an unpositioned one-character option as evidence", () => {
    expect(decodeOrderingCodeLegend(["Degree of protection", "5 = IP65"], "AB1235X")).toEqual([]);
  });
});
