import { describe, expect, it } from "vitest";
import { filterNventProductImages, nventProductUrl } from "../src/server/scrapers/nvent.js";

describe("nVent brand route resolution", () => {
  it.each([
    ["23022-010", "https://www.nvent.com/en-us/schroff/products/enc23022-010/"],
    ["14821-207", "https://www.nvent.com/en-us/schroff/products/enc14821-207/"],
    ["813480", "https://www.nvent.com/en-us/erico/products/efs813480/"],
    ["EGBA14418LL", "https://www.nvent.com/en-us/erico/products/efsegba14418ll/"],
    ["GPECNED096", "https://www.nvent.com/en-us/erico/products/efsgpecned096/"],
    ["PCS2", "https://www.nvent.com/en-us/caddy/products/efspcs2/"],
    ["DAH4001B", "https://www.nvent.com/en-us/hoffman/products/encdah4001b/"]
  ])("maps %s to its expected official brand path", (catalogNumber, expectedUrl) => {
    expect(nventProductUrl(catalogNumber)).toBe(expectedUrl);
  });
});

describe("nVent product image identity", () => {
  it("does not mistake nVent PH asset IDs for sibling product SKUs", () => {
    const images = filterNventProductImages("PCS2", [{
      type: "image",
      label: "image",
      url: "https://www.nvent.com/sites/default/files/dam/abc123/PH6006.jpg",
      sourceUrl: "https://www.nvent.com/en-us/caddy/products/efspcs2"
    }]);
    expect(images).toHaveLength(1);
  });

  it("accepts an official wildcard family photo on the exact SKU PDP", () => {
    const images = filterNventProductImages("HF0516514", [{
      type: "image",
      label: "HF05XX414 HF Side Mount Filter Fans",
      url: "https://www.nvent.com/sites/default/files/dam/asset123/hf05xx414_filterfan_left_m_sq.png.webp",
      sourceUrl: "https://www.nvent.com/en-us/hoffman/products/enchf0516514"
    }]);
    expect(images).toHaveLength(1);
  });

  it("still rejects a clearly labeled sibling SKU image", () => {
    const images = filterNventProductImages("DAH4001B", [{
      type: "image",
      label: "dah4002b electric heater",
      url: "https://www.nvent.com/dah4002b_electricheater_m_sq.png.webp",
      sourceUrl: "https://www.nvent.com/en-us/hoffman/products/encdah4001b"
    }]);
    expect(images).toHaveLength(0);
  });
});
