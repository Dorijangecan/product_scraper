import { describe, expect, it } from "vitest";
import { filterNventProductImages, isExactNventProductPage, isNventBrowserFallbackError, isNventCloudflareResponse, nventProductUrl } from "../src/server/scrapers/nvent.js";

describe("nVent challenge detection", () => {
  it.each([
    [{ statusCode: 403, text: "Access denied" }, true],
    [{ statusCode: 200, text: "<title>Just a moment...</title>" }, true],
    [{ statusCode: 200, text: "Exact nVent product page" }, false]
  ])("recognizes retryable challenge responses", (response, expected) => {
    expect(isNventCloudflareResponse(response)).toBe(expected);
  });

  it("accepts a browser-rendered exact PDP with Cloudflare telemetry only when SKU and canonical path match", () => {
    const base = {
      requestedUrl: "https://www.nvent.com/en-us/erico/products/efs611380/",
      effectiveUrl: "https://www.nvent.com/en-us/erico/products/efs611380",
      statusCode: 200,
      contentType: "text/html",
      fetchedAt: "2026-10-19T00:00:00.000Z",
      fromCache: false
    };
    const exactHtml = `<html><head><link rel="canonical" href="${base.effectiveUrl}"><meta property="coveo:product_item_sku" content="EFS_611380"><title>611380</title></head><body>__CF$cvparams</body></html>`;
    const wrongPathHtml = exactHtml.replace("efs611380", "efs611381");
    const wrongSkuHtml = exactHtml.replace("EFS_611380", "EFS_611381");

    expect(isExactNventProductPage({ ...base, text: exactHtml }, "611380", base.requestedUrl)).toBe(true);
    expect(isExactNventProductPage({ ...base, text: wrongPathHtml }, "611380", base.requestedUrl)).toBe(false);
    expect(isExactNventProductPage({ ...base, text: wrongSkuHtml }, "611380", base.requestedUrl)).toBe(false);
  });

  it.each([
    [new Error("nVent Cloudflare challenge response"), true],
    [new Error("The request was aborted: The connection was closed unexpectedly."), true],
    [new Error("PowerShell fetch failed: invalid URL argument"), false]
  ])("selects browser retry for recoverable network failures", (error, expected) => {
    expect(isNventBrowserFallbackError(error)).toBe(expected);
  });
});

describe("nVent brand route resolution", () => {
  it.each([
    ["23022-010", "https://www.nvent.com/en-us/schroff/products/enc23022-010/"],
    ["14821-207", "https://www.nvent.com/en-us/schroff/products/enc14821-207/"],
    ["813480", "https://www.nvent.com/en-us/erico/products/efs813480/"],
    ["EGBA14418LL", "https://www.nvent.com/en-us/erico/products/efsegba14418ll/"],
    ["EDT230031R", "https://www.nvent.com/en-us/erico/products/efsedt230031r/"],
    ["B2700A2C1WH", "https://www.nvent.com/en-us/erico/products/efsb2700a2c1wh/"],
    ["GPECNED096", "https://www.nvent.com/en-us/erico/products/efsgpecned096/"],
    ["PCS2", "https://www.nvent.com/en-us/caddy/products/efspcs2/"],
    ["4100150EG", "https://www.nvent.com/en-us/caddy/products/efs4100150eg/"],
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

  it("rejects sibling SKU images when the model code is underscore-delimited", () => {
    const images = filterNventProductImages("NPATS11003", [{
      type: "image",
      label: "NPATS11002_RPAutoTrsfrSwitch_sq.tif",
      url: "https://www.nvent.com/sites/default/files/dam/npats11002_rpautotrsfrswitch_sq.png.webp",
      sourceUrl: "https://www.nvent.com/en-us/hoffman/products/encnpats11003",
      sourceType: "official"
    }]);

    expect(images).toEqual([]);
  });
});
