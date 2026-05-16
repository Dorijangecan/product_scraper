import { describe, expect, it } from "vitest";
import { listManufacturerConfigs } from "../src/server/config/manufacturers.js";

describe("manufacturer configuration", () => {
  it("includes the supported built-in manufacturers", () => {
    const manufacturers = listManufacturerConfigs();
    const byId = new Map(manufacturers.map((manufacturer) => [manufacturer.id, manufacturer]));

    expect([...byId.keys()]).toEqual(
      expect.arrayContaining(["abb", "balluff", "sce", "nvent", "rockwell", "eaton", "eta", "schneider", "siemens"])
    );
    expect(byId.get("balluff")?.shortName).toBe("BAL");
    expect(byId.get("sce")?.shortName).toBe("SCE");
    expect(byId.get("schneider")?.shortName).toBe("SE");
    expect(byId.get("siemens")?.shortName).toBe("SIE");
    expect(byId.get("eta")?.fallbackSources[0]?.directUrlTemplates.some((template) => template.includes("{partSnake}"))).toBe(true);
  });
});
