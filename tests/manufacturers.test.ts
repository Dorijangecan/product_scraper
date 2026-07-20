import { describe, expect, it, vi } from "vitest";
import { listManufacturerConfigs } from "../src/server/config/manufacturers.js";
import { ABBConnector } from "../src/server/scrapers/abb.js";
import { BalluffConnector } from "../src/server/scrapers/balluff.js";
import { EatonConnector } from "../src/server/scrapers/eaton.js";
import { ETAConnector } from "../src/server/scrapers/eta.js";
import { RockwellConnector } from "../src/server/scrapers/rockwell.js";
import { SCEConnector } from "../src/server/scrapers/sce.js";
import { ScameConnector } from "../src/server/scrapers/scame.js";
import { SchmersalConnector } from "../src/server/scrapers/schmersal.js";
import { SchneiderConnector } from "../src/server/scrapers/schneider.js";
import { SiemensConnector } from "../src/server/scrapers/siemens.js";
import { SpelsbergConnector } from "../src/server/scrapers/spelsberg.js";
import type { ScrapeContext } from "../src/server/scrapers/types.js";

describe("manufacturer configuration", () => {
  it("includes the supported built-in manufacturers", () => {
    const manufacturers = listManufacturerConfigs();
    const byId = new Map(manufacturers.map((manufacturer) => [manufacturer.id, manufacturer]));

    expect([...byId.keys()]).toEqual(
      expect.arrayContaining(["abb", "balluff", "sce", "nvent", "rockwell", "eaton", "eta", "phoenix", "schmersal", "schneider", "siemens", "spelsberg", "scame"])
    );
    expect(byId.get("balluff")?.shortName).toBe("BAL");
    expect(byId.get("balluff")?.concurrency).toBe(2);
    expect(byId.get("balluff")?.scrapeRecipe?.fallbackPolicy?.documentDownloadProfile).toBe("quality");
    expect(byId.get("balluff")?.scrapeRecipe?.fallbackPolicy?.rationales?.documentDownloadProfile).toMatch(/official.*source PDF/i);
    expect(byId.get("abb")?.scrapeRecipe?.qualityPolicy?.preferredFinalFields).toEqual(["material"]);
    expect(byId.get("abb")?.scrapeRecipe?.qualityPolicy?.rationales?.preferredFinalFields).toMatch(/official.*manual PDT/i);
    expect(byId.get("sce")?.shortName).toBe("SCE");
    expect(byId.get("sce")?.scrapeRecipe?.qualityPolicy?.requiredFinalFields).toEqual(["weight", "dimensions", "material"]);
    expect(byId.get("sce")?.scrapeRecipe?.qualityPolicy?.rationales?.requiredFinalFields).toMatch(/manual PDT.*source-backed/i);
    expect(byId.get("schneider")?.shortName).toBe("SE");
    expect(byId.get("rockwell")?.scrapeRecipe?.qualityPolicy?.typeCodeFallback).toBe("catalogNumber");
    expect(byId.get("rockwell")?.scrapeRecipe?.qualityPolicy?.rationales?.typeCodeFallback).toMatch(/official.*manual PDT/i);
    expect(byId.get("rockwell")?.scrapeRecipe?.fallbackPolicy?.documentDownloadProfile).toBe("quality");
    expect(byId.get("rockwell")?.scrapeRecipe?.fallbackPolicy?.rationales?.documentDownloadProfile).toMatch(/official.*source PDFs/i);
    expect(byId.get("rockwell")?.scrapeRecipe?.fallbackPolicy?.skipPreferredFinalCompletenessRetry).toBe(true);
    expect(byId.get("rockwell")?.scrapeRecipe?.fallbackPolicy?.rationales?.skipPreferredFinalCompletenessRetry).toMatch(/official.*manual PDT/i);
    expect(byId.get("siemens")?.shortName).toBe("SIE");
    expect(byId.get("phoenix")?.shortName).toBe("PHX");
    expect(byId.get("scame")?.shortName).toBe("SCA");
    expect(byId.get("scame")?.scrapeRecipe?.fallbackPolicy?.distributorFallback).toBe(false);
    expect(byId.get("scame")?.scrapeRecipe?.fallbackPolicy?.documentDownloadProfile).toBe("quality");
    expect(byId.get("eta")?.fallbackSources[0]?.directUrlTemplates.some((template) => template.includes("{partSnake}"))).toBe(true);
  });

  it("configures nVent discovery beyond HOFFMAN-only product URLs", () => {
    const nvent = listManufacturerConfigs().find((manufacturer) => manufacturer.id === "nvent");
    const templates = nvent?.fallbackSources.flatMap((source) => source.directUrlTemplates) ?? [];

    expect(nvent?.canonicalName).toBe("nVent");
    expect(nvent?.officialBaseUrls).toContain("https://www.chemelex.com");
    expect(templates).toEqual(expect.arrayContaining([
      "https://www.nvent.com/en-us/hoffman/products/enc{partLower}",
      "https://www.nvent.com/en-us/caddy/products/{partLower}",
      "https://www.nvent.com/en-us/erico/products/{partLower}",
      "https://www.nvent.com/en-us/eriflex/products/{partLower}",
      "https://www.nvent.com/en-us/schroff/products/{partLower}"
    ]));
    expect(nvent?.scrapeRecipe?.discoveryPolicy?.allowedOfficialDomains).toContain("chemelex.com");
    // Sitemap discovery is disabled for nVent — the direct brand templates + search URL resolve
    // products without per-part fetches of the large per-host sitemaps.
    expect(nvent?.scrapeRecipe?.discoveryPolicy?.sitemapUrls).toEqual([]);
    expect(nvent?.scrapeRecipe?.discoveryPolicy?.enableRobotsSitemaps).toBe(false);
  });

  it("configures Eaton official site-search API discovery", () => {
    const eaton = listManufacturerConfigs().find((manufacturer) => manufacturer.id === "eaton");
    const searchTemplates = eaton?.scrapeRecipe?.searchUrlTemplates ?? [];

    expect(eaton?.officialBaseUrls).toContain("https://www.eaton.com.cn");
    expect(eaton?.homepageUrl).toBe("https://www.eaton.com/gb/en-gb.html");
    expect(eaton?.localizedUrlTemplates?.find((template) => template.locale === "en")?.urlTemplate).toBe(
      "https://www.eaton.com/gb/en-gb/skuPage.{partSlashBraces}.html"
    );
    expect(eaton?.localizedUrlTemplates?.find((template) => template.locale === "de")?.urlTemplate).toBe(
      "https://www.eaton.com/de/de-de/skuPage.{partSlashBraces}.html"
    );
    expect(searchTemplates.some((template) => template.includes("/site-search/jcr:content/root/responsivegrid/search_results.searchTerm${part}"))).toBe(true);
    expect(searchTemplates.some((template) => template.includes("/skuPage.{partSlashBraces}.html"))).toBe(true);
  });

  it("routes ETA 3120-F variants through the declared official family datasheet rule", async () => {
    const manufacturer = listManufacturerConfigs().find((item) => item.id === "eta")!;
    const connector = new ETAConnector();
    const result = await connector.scrape("3120-F521-P7T1-W01D-16A", {
      manufacturer,
      runDir: "",
      documentsDir: "",
      http: {} as ScrapeContext["http"],
      downloadDocument: async (doc) => doc,
      fallback: {
        scrape: async () => undefined
      }
    });

    expect(result.status).toBe("partial");
    expect(result.productUrl).toContain("D_3120-F_en.pdf");
    expect(result.documents[0]).toMatchObject({ type: "datasheet", sourceType: "official-fallback" });
    expect(result.attributes.find((attr) => attr.name === "Catalog Number")?.value).toBe("3120-F521-P7T1-W01D-16A");
    expect(result.attributes.some((attr) => /product family|description/i.test(attr.name))).toBe(false);
    expect(result.title).toBeUndefined();
    expect(result.description).toBeUndefined();
    expect(result.normalized.current).toBeUndefined();
  });

  it("uses generic official discovery for ETA catalog numbers outside known family datasheet rules", async () => {
    const manufacturer = listManufacturerConfigs().find((item) => item.id === "eta")!;
    const connector = new ETAConnector();
    const fetchedUrls: string[] = [];
    const fallbackSourcesSeen: string[] = [];
    const result = await connector.scrape("ESX10-TB-101-DC24V-10A", {
      manufacturer: {
        ...manufacturer,
        scrapeRecipe: {
          ...manufacturer.scrapeRecipe,
          searchUrlTemplates: ["https://www.e-t-a.com/search?q={part}"],
          discoveryPolicy: {
            ...(manufacturer.scrapeRecipe?.discoveryPolicy ?? {}),
            allowedOfficialDomains: ["e-t-a.com"],
            maxCandidates: 6
          }
        }
      },
      runDir: "",
      documentsDir: "",
      http: {
        fetchText: async (url: string) => {
          fetchedUrls.push(url);
          if (url === "https://www.e-t-a.com/search?q=ESX10-TB-101-DC24V-10A") {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<main>
                <a href="/products/nonstandard/esx10/detail?id=44">ESX10-TB-101-DC24V-10A electronic circuit protector</a>
              </main>`
            };
          }
          throw new Error(`unexpected URL ${url}`);
        }
      } as unknown as ScrapeContext["http"],
      downloadDocument: async (doc) => doc,
      fallback: {
        scrape: async (_catalogNumber, sources) => {
          fallbackSourcesSeen.push(...sources.flatMap((source) => source.directUrlTemplates));
          return {
            manufacturerId: "eta",
            catalogNumber: "ESX10-TB-101-DC24V-10A",
            status: "partial",
            confidence: 0.72,
            productUrl: "https://www.e-t-a.com/products/nonstandard/esx10/detail?id=44",
            normalized: { voltage: "24 V DC", current: "10 A" },
            attributes: [
              { group: "Generic ETA page", name: "Catalog Number", value: "ESX10-TB-101-DC24V-10A" },
              { group: "Generic ETA page", name: "Rated voltage", value: "24 V DC" },
              { group: "Generic ETA page", name: "Rated current", value: "10 A" }
            ],
            documents: [{ type: "datasheet", label: "ESX10 datasheet", url: "https://www.e-t-a.com/esx10.pdf" }],
            sources: []
          };
        }
      }
    });

    expect(fetchedUrls).toContain("https://www.e-t-a.com/search?q=ESX10-TB-101-DC24V-10A");
    expect(fallbackSourcesSeen).toContain("https://www.e-t-a.com/products/nonstandard/esx10/detail?id=44");
    expect(result.productUrl).toBe("https://www.e-t-a.com/products/nonstandard/esx10/detail?id=44");
    expect(result.normalized.voltage).toBe("24 V DC");
    expect(result.diagnostics?.attemptedUrls).toContain("https://www.e-t-a.com/search?q=ESX10-TB-101-DC24V-10A");
    expect(result.diagnostics?.discoveredCandidates?.some((candidate) => candidate.url === "https://www.e-t-a.com/products/nonstandard/esx10/detail?id=44")).toBe(true);
  });

  it("uses generic official discovery for ABB when PIS search and direct product URLs miss", async () => {
    const manufacturer = listManufacturerConfigs().find((item) => item.id === "abb")!;
    const connector = new ABBConnector();
    const fetchedUrls: string[] = [];
    const fallbackSourcesSeen: string[] = [];
    const catalogNumber = "ABB-NEW-24";
    const searchUrl = "https://new.abb.com/search?query=ABB-NEW-24";
    const discoveredUrl = "https://new.abb.com/products/nonstandard/abb-new-24?catalog=ABB-NEW-24";

    const result = await connector.scrape(catalogNumber, {
      manufacturer: {
        ...manufacturer,
        rateLimitMs: 0,
        officialBaseUrls: ["https://new.abb.com"],
        fallbackSources: [],
        scrapeRecipe: {
          ...manufacturer.scrapeRecipe,
          searchUrlTemplates: ["https://products.schmersal.com/en_US/catalogsearch/result?q={part}"],
          discoveryPolicy: {
            ...(manufacturer.scrapeRecipe?.discoveryPolicy ?? {}),
            allowedOfficialDomains: ["new.abb.com", "abb.com"],
            maxCandidates: 6
          }
        }
      },
      runDir: "",
      documentsDir: "",
      http: {
        fetchText: async (url: string) => {
          fetchedUrls.push(url);
          if (url.includes("/api/PisSearchApi")) {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "application/json",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: JSON.stringify({ Items: [], TotalResultsCount: 1 })
            };
          }
          if (url === searchUrl) {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<main>
                <a href="/products/nonstandard/abb-new-24?catalog=ABB-NEW-24">ABB-NEW-24 miniature contactor</a>
              </main>`
            };
          }
          throw new Error(`unexpected URL ${url}`);
        },
        fetchTextViaPowerShell: async (url: string) => {
          throw new Error(`unexpected PowerShell URL ${url}`);
        }
      } as unknown as ScrapeContext["http"],
      downloadDocument: async (doc) => doc,
      fallback: {
        scrape: async (_catalogNumber, sources) => {
          fallbackSourcesSeen.push(...sources.flatMap((source) => source.directUrlTemplates));
          return sources.some((source) => source.directUrlTemplates.includes(discoveredUrl))
            ? {
                manufacturerId: "abb",
                catalogNumber,
                status: "partial",
                confidence: 0.74,
                productUrl: discoveredUrl,
                localizedDescriptions: { de: { title: "ABB-NEW-24", description: "ABB-NEW-24" } },
                normalized: { voltage: "24 V DC", current: "9 A" },
                attributes: [
                  { group: "ABB Product Data", name: "Catalog Number", value: catalogNumber },
                  { group: "ABB Product Data", name: "Rated control supply voltage", value: "24 V DC" },
                  { group: "ABB Product Data", name: "Rated operational current", value: "9 A" }
                ],
                documents: [{ type: "datasheet", label: "ABB product datasheet", url: `${discoveredUrl}&download=pdf` }],
                sources: []
              }
            : undefined;
        }
      }
    });

    expect(fetchedUrls).toContain(searchUrl);
    expect(fallbackSourcesSeen).toContain(discoveredUrl);
    expect(result.productUrl).toBe(discoveredUrl);
    expect(result.normalized.voltage).toBe("24 V DC");
    expect(result.diagnostics?.attemptedUrls).toContain(searchUrl);
    expect(result.diagnostics?.discoveredCandidates?.some((candidate) => candidate.url === discoveredUrl)).toBe(true);
  });

  it("uses generic official discovery for Eaton when site search returns a non-sku product link", async () => {
    const manufacturer = listManufacturerConfigs().find((item) => item.id === "eaton")!;
    const connector = new EatonConnector();
    const fetchedUrls: string[] = [];
    const fallbackSourcesSeen: string[] = [];
    const catalogNumber = "ETN-NEW-24";
    const searchUrl = "https://www.eaton.com/search?query=ETN-NEW-24";
    const discoveredUrl = "https://www.eaton.com/us/en-us/catalog/nonstandard/etn-new-24.html?catalog=ETN-NEW-24";

    const result = await connector.scrape(catalogNumber, {
      manufacturer: {
        ...manufacturer,
        officialBaseUrls: ["https://www.eaton.com"],
        fallbackSources: [],
        scrapeRecipe: {
          ...manufacturer.scrapeRecipe,
          searchUrlTemplates: ["https://products.schmersal.com/en_US/catalogsearch/result?q={part}"],
          discoveryPolicy: {
            ...(manufacturer.scrapeRecipe?.discoveryPolicy ?? {}),
            searchUrlTemplates: [searchUrl],
            allowedOfficialDomains: ["eaton.com", "www.eaton.com"],
            maxCandidates: 6
          }
        }
      },
      runDir: "",
      documentsDir: "",
      http: {
        fetchText: async (url: string) => {
          fetchedUrls.push(url);
          if (url === searchUrl) {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<main>
                <a href="/us/en-us/catalog/nonstandard/etn-new-24.html?catalog=ETN-NEW-24">ETN-NEW-24 illuminated selector</a>
              </main>`
            };
          }
          throw new Error(`unexpected URL ${url}`);
        }
      } as unknown as ScrapeContext["http"],
      downloadDocument: async (doc) => doc,
      fallback: {
        scrape: async (_catalogNumber, sources) => {
          fallbackSourcesSeen.push(...sources.flatMap((source) => source.directUrlTemplates));
          return sources.some((source) => source.directUrlTemplates.includes(discoveredUrl))
            ? {
                manufacturerId: "eaton",
                catalogNumber,
                status: "partial",
                confidence: 0.73,
                productUrl: discoveredUrl,
                normalized: { voltage: "24 V AC/DC", current: "2 A" },
                attributes: [
                  { group: "Eaton Product Data", name: "Catalog Number", value: catalogNumber },
                  { group: "Eaton Product Data", name: "Voltage rating", value: "24 V AC/DC" },
                  { group: "Eaton Product Data", name: "Amperage Rating", value: "2 A" }
                ],
                documents: [{ type: "datasheet", label: "Eaton product datasheet", url: `${discoveredUrl}&download=pdf` }],
                sources: []
              }
            : undefined;
        }
      }
    });

    expect(fetchedUrls).toContain(searchUrl);
    expect(fallbackSourcesSeen).toContain(discoveredUrl);
    expect(result.productUrl).toBe(discoveredUrl);
    expect(result.normalized.voltage).toBe("24 V AC/DC");
    expect(result.diagnostics?.attemptedUrls).toContain(searchUrl);
    expect(result.diagnostics?.discoveredCandidates?.some((candidate) => candidate.url === discoveredUrl)).toBe(true);
  });

  it("uses generic official discovery for Balluff when direct pages and built-in search do not parse", async () => {
    const manufacturer = listManufacturerConfigs().find((item) => item.id === "balluff")!;
    const connector = new BalluffConnector();
    const fetchedUrls: string[] = [];
    const fallbackSourcesSeen: string[] = [];
    const catalogNumber = "BAL-NEW-24";
    const searchUrl = "https://www.balluff.com/en-gb/search?query=BAL-NEW-24";
    const discoveredUrl = "https://www.balluff.com/en-gb/products/nonstandard/bal-new-24?sku=BAL-NEW-24";
    const filler = " Balluff official search result ".repeat(60);

    const result = await connector.scrape(catalogNumber, {
      manufacturer: {
        ...manufacturer,
        rateLimitMs: 0,
        officialBaseUrls: ["https://www.balluff.com/en-gb"],
        fallbackSources: [],
        scrapeRecipe: {
          ...manufacturer.scrapeRecipe,
          searchUrlTemplates: [searchUrl],
          discoveryPolicy: {
            ...(manufacturer.scrapeRecipe?.discoveryPolicy ?? {}),
            allowedOfficialDomains: ["balluff.com", "www.balluff.com"],
            maxCandidates: 6
          }
        }
      },
      runDir: "",
      documentsDir: "",
      http: {
        fetchText: async (url: string) => {
          fetchedUrls.push(url);
          if (url === searchUrl) {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<main>
                <a href="/en-gb/products/nonstandard/bal-new-24?sku=BAL-NEW-24">BAL-NEW-24 inductive sensor</a>
                <p>${filler}</p>
              </main>`
            };
          }
          throw new Error(`unexpected URL ${url}`);
        },
        fetchTextViaPowerShell: async (url: string) => {
          throw new Error(`unexpected PowerShell URL ${url}`);
        }
      } as unknown as ScrapeContext["http"],
      downloadDocument: async (doc) => doc,
      fallback: {
        scrape: async (_catalogNumber, sources) => {
          fallbackSourcesSeen.push(...sources.flatMap((source) => source.directUrlTemplates));
          return sources.some((source) => source.directUrlTemplates.includes(discoveredUrl))
            ? {
                manufacturerId: "balluff",
                catalogNumber,
                status: "partial",
                confidence: 0.74,
                productUrl: discoveredUrl,
                normalized: { voltage: "24 V DC", protection: "IP67" },
                attributes: [
                  { group: "Balluff Product Data", name: "Order code", value: catalogNumber },
                  { group: "Balluff Product Data", name: "Operating voltage", value: "24 V DC" },
                  { group: "Balluff Product Data", name: "IP rating", value: "IP67" }
                ],
                documents: [{ type: "datasheet", label: "Balluff product datasheet", url: `${discoveredUrl}&download=pdf` }],
                sources: []
              }
            : undefined;
        }
      }
    });

    expect(fetchedUrls).toContain(searchUrl);
    expect(fallbackSourcesSeen).toContain(discoveredUrl);
    expect(result.productUrl).toBe(discoveredUrl);
    expect(result.normalized.protection).toBe("IP67");
    expect(result.diagnostics?.attemptedUrls).toContain(searchUrl);
    expect(result.diagnostics?.discoveredCandidates?.some((candidate) => candidate.url === discoveredUrl)).toBe(true);
  });

  it("uses the official Siemens product-data table before broad discovery when the API rejects an MLFB", async () => {
    const manufacturer = listManufacturerConfigs().find((item) => item.id === "siemens")!;
    const connector = new SiemensConnector();
    const catalogNumber = "6ES7193-6BP00-0DA0";
    const productDataUrl = "https://mall.industry.siemens.com/goos/catalog/Pages/mmpdata.ashx?MLFB1=6ES7193-6BP00-0DA0&lang=en";

    const result = await connector.scrape(catalogNumber, {
      manufacturer,
      runDir: "",
      documentsDir: "",
      http: {
        fetchText: async () => {
          throw new Error("SiePortal rejected the server-side API request.");
        }
      } as unknown as ScrapeContext["http"],
      downloadDocument: async (doc) => doc,
      fallback: {
        scrape: async (_catalogNumber, sources) =>
          sources.some((source) => source.directUrlTemplates.includes("https://mall.industry.siemens.com/goos/catalog/Pages/mmpdata.ashx?MLFB1={part}&lang=en"))
            ? {
                manufacturerId: "siemens",
                catalogNumber,
                status: "found",
                confidence: 0.82,
                productUrl: productDataUrl,
                normalized: { weight: "0.02 kg" },
                attributes: [{ group: "Siemens product data", name: "Article number", value: catalogNumber }],
                documents: [],
                sources: []
              }
            : undefined
      }
    });

    expect(result.productUrl).toBe(productDataUrl);
    expect(result.normalized.weight).toBe("0.02 kg");
  });

  it("uses generic official discovery when the Siemens API path cannot resolve a new product", async () => {
    const manufacturer = listManufacturerConfigs().find((item) => item.id === "siemens")!;
    const connector = new SiemensConnector();
    const fetchedUrls: string[] = [];
    const fallbackSourcesSeen: string[] = [];
    const catalogNumber = "6ES7-NEW-24V";
    const discoveredUrl = "https://sieportal.siemens.com/en-ww/products-services/detail/6ES7-NEW-24V";
    const searchUrl = "https://sieportal.siemens.com/search?query=6ES7-NEW-24V";

    const result = await connector.scrape(catalogNumber, {
      manufacturer: {
        ...manufacturer,
        officialBaseUrls: ["https://sieportal.siemens.com"],
        fallbackSources: [],
        scrapeRecipe: {
          ...manufacturer.scrapeRecipe,
          searchUrlTemplates: [searchUrl],
          discoveryPolicy: {
            ...(manufacturer.scrapeRecipe?.discoveryPolicy ?? {}),
            allowedOfficialDomains: ["sieportal.siemens.com"],
            maxCandidates: 6
          }
        }
      },
      runDir: "",
      documentsDir: "",
      http: {
        fetchText: async (url: string) => {
          fetchedUrls.push(url);
          if (url === searchUrl) {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<section>
                <a href="/en-ww/products-services/detail/6ES7-NEW-24V">6ES7-NEW-24V compact automation module</a>
              </section>`
            };
          }
          throw new Error(`unexpected URL ${url}`);
        }
      } as unknown as ScrapeContext["http"],
      downloadDocument: async (doc) => doc,
      fallback: {
        scrape: async (_catalogNumber, sources) => {
          fallbackSourcesSeen.push(...sources.flatMap((source) => source.directUrlTemplates));
          return sources.some((source) => source.directUrlTemplates.includes(discoveredUrl))
            ? {
                manufacturerId: "siemens",
                catalogNumber,
                status: "partial",
                confidence: 0.74,
                productUrl: discoveredUrl,
                normalized: { voltage: "24 V DC" },
                attributes: [
                  { group: "Generic Siemens page", name: "Article Number", value: catalogNumber },
                  { group: "Generic Siemens page", name: "Rated voltage", value: "24 V DC" }
                ],
                documents: [{ type: "datasheet", label: "Siemens datasheet", url: `${discoveredUrl}/datasheet.pdf` }],
                sources: []
              }
            : undefined;
        }
      }
    });

    expect(fetchedUrls).toContain(searchUrl);
    expect(fallbackSourcesSeen).toContain(discoveredUrl);
    expect(result.productUrl).toBe(discoveredUrl);
    expect(result.normalized.voltage).toBe("24 V DC");
    expect(result.diagnostics?.attemptedUrls).toContain(searchUrl);
    expect(result.diagnostics?.discoveredCandidates?.some((candidate) => candidate.url === discoveredUrl)).toBe(true);
  });

  it("uses generic official discovery for Rockwell when standard product URLs miss a nonstandard page", async () => {
    const manufacturer = listManufacturerConfigs().find((item) => item.id === "rockwell")!;
    const connector = new RockwellConnector();
    const fetchedUrls: string[] = [];
    const fallbackSourcesSeen: string[] = [];
    const catalogNumber = "1756-L902TSXT";
    const discoveredUrl = "https://www.rockwellautomation.com/en-us/products/details.controlLogix-5590-xt.1756-L902TSXT.html";
    const searchUrl = "https://www.rockwellautomation.com/site-search?keyword=1756-L902TSXT";

    const result = await connector.scrape(catalogNumber, {
      manufacturer: {
        ...manufacturer,
        officialBaseUrls: ["https://www.rockwellautomation.com"],
        fallbackSources: [],
        scrapeRecipe: {
          ...manufacturer.scrapeRecipe,
          searchUrlTemplates: ["https://www.rockwellautomation.com/site-search?keyword={part}"],
          discoveryPolicy: {
            ...(manufacturer.scrapeRecipe?.discoveryPolicy ?? {}),
            allowedOfficialDomains: ["rockwellautomation.com"],
            maxCandidates: 6
          }
        }
      },
      runDir: "",
      documentsDir: "",
      http: {
        fetchText: async (url: string) => {
          fetchedUrls.push(url);
          if (url === searchUrl) {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<main>
                <a href="/en-us/products/details.controlLogix-5590-xt.1756-L902TSXT.html">1756-L902TSXT ControlLogix 5590 XT controller</a>
              </main>`
            };
          }
          throw new Error(`unexpected URL ${url}`);
        }
      } as ScrapeContext["http"],
      downloadDocument: async (doc) => doc,
      fallback: {
        scrape: async (_catalogNumber, sources) => {
          fallbackSourcesSeen.push(...sources.flatMap((source) => source.directUrlTemplates));
          return sources.some((source) => source.directUrlTemplates.includes(discoveredUrl))
            ? {
                manufacturerId: "rockwell",
                catalogNumber,
                status: "partial",
                confidence: 0.76,
                productUrl: discoveredUrl,
                normalized: { voltage: "24 V DC" },
                attributes: [
                  { group: "Rockwell Product Page", name: "Catalog Number", value: catalogNumber },
                  { group: "Technical Data", name: "Supply voltage", value: "24 V DC" },
                  { group: "Technical Data", name: "Product Net Width", value: "68.9 mm" },
                  { group: "Technical Data", name: "Product Net Height", value: "91.7 mm" }
                ],
                documents: [{ type: "datasheet", label: "Rockwell technical data", url: "https://literature.rockwellautomation.com/idc/groups/literature/documents/td/1756-td001_-en-p.pdf" }],
                sources: []
              }
            : undefined;
        }
      }
    });

    expect(fetchedUrls).toContain(searchUrl);
    expect(fallbackSourcesSeen).toContain(discoveredUrl);
    expect(result.productUrl).toBe(discoveredUrl);
    expect(result.normalized.voltage).toBe("24 V DC");
    expect(result.diagnostics?.attemptedUrls).toEqual(expect.arrayContaining([
      "https://www.rockwellautomation.com/en-us/products/details.1756-L902TSXT.html",
      searchUrl
    ]));
    expect(result.diagnostics?.discoveredCandidates?.some((candidate) => candidate.url === discoveredUrl)).toBe(true);
  });

  it("takes the English title/description from Rockwell's own pagePersonalizationSummary, and the German one from the de-de page", async () => {
    // Real layout confirmed live on rockwellautomation.com: window.pagePersonalizationSummary
    // carries a clean short title + long description in the page's OWN locale on every
    // details.*.html page - the schema.org JSON-LD title/description stays English even when
    // fetched from the German URL, so the German page's own personalization summary is the only
    // reliable source for a German description.
    const manufacturer = listManufacturerConfigs().find((item) => item.id === "rockwell")!;
    const connector = new RockwellConnector();
    const catalogNumber = "1606-XLB90EQ";
    const enUrl = "https://www.rockwellautomation.com/en-us/products/details.1606-XLB90EQ.html";
    const deUrl = "https://www.rockwellautomation.com/de-de/products/details.1606-XLB90EQ.html";

    const enHtml = `<html><body>
      1606-XLB90EQ
      <script>
        window.pagePersonalizationSummary = {
          "title": "XLB Power Supply 90W 24VDC 3.8A",
          "description": "1606-XLB90EQ:Basic Power Supply, 24-28V DC, 90 W, 100-240V AC Input Voltage",
          "isAiTranslated": false
        }
      </script>
    </body></html>`;
    const deHtml = `<html><body>
      1606-XLB90EQ
      <script>
        window.pagePersonalizationSummary = {
          "title": "XLB-Netzteil 90 W 24 V DC 3.8 A",
          "description": "1606-XLB90EQ:Basisnetzteil, 24-28 V DC, 90 W, 100-240 V AC Eingangsspannung",
          "isAiTranslated": true
        }
      </script>
    </body></html>`;

    const result = await connector.scrape(catalogNumber, {
      manufacturer,
      runDir: "",
      documentsDir: "",
      http: {
        fetchText: async (url: string) => {
          const html = url === enUrl || url.toLowerCase() === enUrl.toLowerCase() ? enHtml : url === deUrl ? deHtml : undefined;
          if (!html) {
            const err: any = new Error("not found");
            err.statusCode = 404;
            throw err;
          }
          return {
            requestedUrl: url,
            effectiveUrl: url,
            statusCode: 200,
            contentType: "text/html",
            fetchedAt: "2026-01-01T00:00:00.000Z",
            fromCache: false,
            text: html
          };
        }
      } as ScrapeContext["http"],
      downloadDocument: async (doc) => doc,
      fallback: { scrape: async () => undefined }
    });

    expect(result.title).toBe("XLB Power Supply 90W 24VDC 3.8A");
    expect(result.description).toBe("1606-XLB90EQ:Basic Power Supply, 24-28V DC, 90 W, 100-240V AC Input Voltage");
    expect(result.localizedDescriptions?.de?.title).toBe("XLB-Netzteil 90 W 24 V DC 3.8 A");
    expect(result.localizedDescriptions?.de?.description).toBe("1606-XLB90EQ:Basisnetzteil, 24-28 V DC, 90 W, 100-240 V AC Eingangsspannung");
  });

  it("uses generic official discovery for SCE when advanced search and direct URLs miss", async () => {
    const manufacturer = listManufacturerConfigs().find((item) => item.id === "sce")!;
    const connector = new SCEConnector();
    const fetchedUrls: string[] = [];
    const fallbackSourcesSeen: string[] = [];
    const catalogNumber = "SCE-NEW-24X20";
    const searchUrl = "https://www.saginawcontrol.com/search?keyword=SCE-NEW-24X20";
    const discoveredUrl = "https://www.saginawcontrol.com/partnumber_info/?n=SCE-NEW-24X20&variant=painted";

    const result = await connector.scrape(catalogNumber, {
      manufacturer: {
        ...manufacturer,
        officialBaseUrls: ["https://www.saginawcontrol.com"],
        fallbackSources: [],
        scrapeRecipe: {
          ...manufacturer.scrapeRecipe,
          searchUrlTemplates: ["https://www.saginawcontrol.com/search?keyword={part}"],
          discoveryPolicy: {
            ...(manufacturer.scrapeRecipe?.discoveryPolicy ?? {}),
            allowedOfficialDomains: ["saginawcontrol.com"],
            maxCandidates: 6
          }
        }
      },
      runDir: "",
      documentsDir: "",
      http: {
        fetchText: async (url: string) => {
          fetchedUrls.push(url);
          if (url === searchUrl) {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<article>
                <a href="/partnumber_info/?n=SCE-NEW-24X20&variant=painted">SCE-NEW-24X20 steel enclosure</a>
              </article>`
            };
          }
          throw new Error(`unexpected URL ${url}`);
        },
        fetchTextViaPowerShell: async (url: string) => {
          throw new Error(`unexpected PowerShell URL ${url}`);
        }
      } as unknown as ScrapeContext["http"],
      downloadDocument: async (doc) => doc,
      fallback: {
        scrape: async (_catalogNumber, sources) => {
          fallbackSourcesSeen.push(...sources.flatMap((source) => source.directUrlTemplates));
          return sources.some((source) => source.directUrlTemplates.includes(discoveredUrl))
            ? {
                manufacturerId: "sce",
                catalogNumber,
                status: "partial",
                confidence: 0.73,
                productUrl: discoveredUrl,
                normalized: { material: "Carbon steel", dimensions: "24 x 20 x 8 in" },
                attributes: [
                  { group: "SCE Product Data", name: "Catalog Number", value: catalogNumber },
                  { group: "SCE Product Data", name: "Material", value: "Carbon steel" },
                  { group: "SCE Product Data", name: "Dimensions", value: "24 x 20 x 8 in" }
                ],
                documents: [{ type: "datasheet", label: "SCE technical data", url: `${discoveredUrl}&pdf=1` }],
                sources: []
              }
            : undefined;
        }
      }
    });

    expect(fetchedUrls).toContain(searchUrl);
    expect(fallbackSourcesSeen).toContain(discoveredUrl);
    expect(result.productUrl).toBe(discoveredUrl);
    expect(result.normalized.material).toBe("Carbon steel");
    expect(result.diagnostics?.attemptedUrls).toContain(searchUrl);
    expect(result.diagnostics?.discoveredCandidates?.some((candidate) => candidate.url === discoveredUrl)).toBe(true);
  });

  it("uses generic official discovery for Schneider when locale product URLs miss", async () => {
    const manufacturer = listManufacturerConfigs().find((item) => item.id === "schneider")!;
    const connector = new SchneiderConnector();
    const fetchedUrls: string[] = [];
    const fallbackSourcesSeen: string[] = [];
    const catalogNumber = "XB4NEW42";
    const searchUrl = "https://www.se.com/ww/en/search/XB4NEW42";
    const discoveredUrl = "https://www.se.com/ww/en/product/XB4NEW42/?source=site-search";

    const result = await connector.scrape(catalogNumber, {
      manufacturer: {
        ...manufacturer,
        officialBaseUrls: ["https://www.se.com"],
        fallbackSources: [],
        scrapeRecipe: {
          ...manufacturer.scrapeRecipe,
          searchUrlTemplates: ["https://www.se.com/ww/en/search/{part}"],
          discoveryPolicy: {
            ...(manufacturer.scrapeRecipe?.discoveryPolicy ?? {}),
            allowedOfficialDomains: ["se.com", "www.se.com"],
            maxCandidates: 6
          }
        }
      },
      runDir: "",
      documentsDir: "",
      http: {
        fetchText: async (url: string) => {
          fetchedUrls.push(url);
          if (url === searchUrl) {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<main>
                <a href="/ww/en/product/XB4NEW42/?source=site-search">XB4NEW42 illuminated push button</a>
              </main>`
            };
          }
          throw new Error(`unexpected URL ${url}`);
        },
        fetchTextViaPowerShell: async (url: string) => {
          throw new Error(`unexpected PowerShell URL ${url}`);
        }
      } as unknown as ScrapeContext["http"],
      downloadDocument: async (doc) => doc,
      fallback: {
        scrape: async (_catalogNumber, sources) => {
          fallbackSourcesSeen.push(...sources.flatMap((source) => source.directUrlTemplates));
          return sources.some((source) => source.directUrlTemplates.includes(discoveredUrl))
            ? {
                manufacturerId: "schneider",
                catalogNumber,
                status: "partial",
                confidence: 0.75,
                productUrl: discoveredUrl,
                normalized: { voltage: "24 V AC/DC", protection: "IP66" },
                attributes: [
                  { group: "Schneider Main", name: "Product or Component Type", value: "Illuminated push-button" },
                  { group: "Schneider Complementary", name: "Rated supply voltage", value: "24 V AC/DC" },
                  { group: "Schneider Environment", name: "IP degree of protection", value: "IP66" }
                ],
                documents: [{ type: "datasheet", label: "Schneider product datasheet", url: "https://www.se.com/ww/en/product/download-pdf/XB4NEW42" }],
                sources: []
              }
            : undefined;
        }
      }
    });

    expect(fetchedUrls).toContain(searchUrl);
    expect(fallbackSourcesSeen).toContain(discoveredUrl);
    expect(result.productUrl).toBe(discoveredUrl);
    expect(result.normalized.protection).toBe("IP66");
    expect(result.diagnostics?.attemptedUrls).toContain(searchUrl);
    expect(result.diagnostics?.discoveredCandidates?.some((candidate) => candidate.url === discoveredUrl)).toBe(true);
  });

  it("uses generic official discovery for Spelsberg when product finder has no exact hit", async () => {
    const manufacturer = listManufacturerConfigs().find((item) => item.id === "spelsberg")!;
    const connector = new SpelsbergConnector();
    const fetchedUrls: string[] = [];
    const fallbackSourcesSeen: string[] = [];
    const catalogNumber = "TK-NEW-1818";
    const searchUrl = "https://www.spelsberg.com/product-finder/?query=TK-NEW-1818";
    const discoveredUrl = "https://www.spelsberg.com/product-finder/tk-new-1818?sku=TK-NEW-1818";

    const result = await connector.scrape(catalogNumber, {
      manufacturer: {
        ...manufacturer,
        officialBaseUrls: ["https://www.spelsberg.com"],
        fallbackSources: [],
        scrapeRecipe: {
          ...manufacturer.scrapeRecipe,
          searchUrlTemplates: [searchUrl],
          discoveryPolicy: {
            ...(manufacturer.scrapeRecipe?.discoveryPolicy ?? {}),
            allowedOfficialDomains: ["spelsberg.com", "www.spelsberg.com"],
            maxCandidates: 6
          }
        }
      },
      runDir: "",
      documentsDir: "",
      http: {
        fetchText: async (url: string) => {
          fetchedUrls.push(url);
          if (url === searchUrl) {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<main>
                <a href="/product-finder/tk-new-1818?sku=TK-NEW-1818">TK-NEW-1818 empty enclosure</a>
              </main>`
            };
          }
          if (url.includes("algolia.net")) {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "application/json",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: JSON.stringify({ hits: [] })
            };
          }
          throw new Error(`unexpected URL ${url}`);
        }
      } as unknown as ScrapeContext["http"],
      downloadDocument: async (doc) => doc,
      fallback: {
        scrape: async (_catalogNumber, sources) => {
          fallbackSourcesSeen.push(...sources.flatMap((source) => source.directUrlTemplates));
          return sources.some((source) => source.directUrlTemplates.includes(discoveredUrl))
            ? {
                manufacturerId: "spelsberg",
                catalogNumber,
                status: "partial",
                confidence: 0.73,
                productUrl: discoveredUrl,
                normalized: { material: "Polystyrene", protection: "IP65" },
                attributes: [
                  { group: "Spelsberg Product Data", name: "Catalog Number", value: catalogNumber },
                  { group: "Spelsberg Product Data", name: "Material", value: "Polystyrene" },
                  { group: "Spelsberg Product Data", name: "Protection class", value: "IP65" }
                ],
                documents: [{ type: "datasheet", label: "Spelsberg product datasheet", url: `${discoveredUrl}&download=pdf` }],
                sources: []
              }
            : undefined;
        }
      }
    });

    expect(fetchedUrls).toContain(searchUrl);
    expect(fallbackSourcesSeen).toContain(discoveredUrl);
    expect(result.productUrl).toBe(discoveredUrl);
    expect(result.normalized.material).toBe("Polystyrene");
    expect(result.diagnostics?.attemptedUrls).toContain(searchUrl);
    expect(result.diagnostics?.discoveredCandidates?.some((candidate) => candidate.url === discoveredUrl)).toBe(true);
  });

  it("uses generic official discovery for SCAME when techsheet PDF endpoints are not published", async () => {
    const manufacturer = listManufacturerConfigs().find((item) => item.id === "scame")!;
    const connector = new ScameConnector();
    const fetchedUrls: string[] = [];
    const fallbackSourcesSeen: string[] = [];
    const catalogNumber = "NEW.1698/S";
    const searchUrl = "https://www.scame.com/search?keyword=NEW.1698%2FS";
    const discoveredUrl = "https://www.scame.com/web/scame-uk/product/new-1698-s?code=NEW.1698%2FS";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not found", { status: 404, headers: { "content-type": "text/html" } })
    );

    try {
      const result = await connector.scrape(catalogNumber, {
        manufacturer: {
          ...manufacturer,
          officialBaseUrls: ["https://www.scame.com"],
          fallbackSources: [],
          scrapeRecipe: {
            ...manufacturer.scrapeRecipe,
            searchUrlTemplates: ["https://www.scame.com/search?keyword={part}"],
            discoveryPolicy: {
              ...(manufacturer.scrapeRecipe?.discoveryPolicy ?? {}),
              allowedOfficialDomains: ["scame.com", "www.scame.com"],
              maxCandidates: 6
            }
          }
        },
        runDir: "",
        documentsDir: "",
        http: {
          fetchText: async (url: string) => {
            fetchedUrls.push(url);
            if (url === searchUrl) {
              return {
                requestedUrl: url,
                effectiveUrl: url,
                statusCode: 200,
                contentType: "text/html",
                fetchedAt: "2026-01-01T00:00:00.000Z",
                fromCache: false,
                text: `<main>
                  <a href="/web/scame-uk/product/new-1698-s?code=NEW.1698%2FS">NEW.1698/S industrial plug</a>
                </main>`
              };
            }
            throw new Error(`unexpected URL ${url}`);
          }
        } as unknown as ScrapeContext["http"],
        downloadDocument: async (doc) => doc,
        fallback: {
          scrape: async (_catalogNumber, sources) => {
            fallbackSourcesSeen.push(...sources.flatMap((source) => source.directUrlTemplates));
            return sources.some((source) => source.directUrlTemplates.includes(discoveredUrl))
              ? {
                  manufacturerId: "scame",
                  catalogNumber,
                  status: "partial",
                  confidence: 0.72,
                  productUrl: discoveredUrl,
                  normalized: { voltage: "400 V", current: "16 A", protection: "IP67" },
                  attributes: [
                    { group: "SCAME Product Data", name: "Catalog Number", value: catalogNumber },
                    { group: "SCAME Product Data", name: "Rated voltage", value: "400 V" },
                    { group: "SCAME Product Data", name: "Rated current", value: "16 A" },
                    { group: "SCAME Product Data", name: "IP rating", value: "IP67" }
                  ],
                  documents: [{ type: "datasheet", label: "SCAME product information sheet", url: `${discoveredUrl}&download=pdf` }],
                  sources: []
                }
              : undefined;
          }
        }
      });

      expect(fetchSpy).toHaveBeenCalled();
      expect(fetchedUrls).toContain(searchUrl);
      expect(fallbackSourcesSeen).toContain(discoveredUrl);
      expect(result.productUrl).toBe(discoveredUrl);
      expect(result.normalized.current).toBe("16 A");
      expect(result.diagnostics?.attemptedUrls).toEqual(expect.arrayContaining([
        "https://techsheet.scame.com/infodata/en/new.1698_s.pdf",
        searchUrl
      ]));
      expect(result.diagnostics?.discoveredCandidates?.some((candidate) => candidate.url === discoveredUrl)).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("uses generic official discovery for Schmersal when its standard search rescue misses", async () => {
    const manufacturer = listManufacturerConfigs().find((item) => item.id === "schmersal")!;
    const connector = new SchmersalConnector();
    const fetchedUrls: string[] = [];
    const fallbackSourcesSeen: string[] = [];
    const catalogNumber = "AZM-NEW-24";
    const searchUrl = "https://products.schmersal.com/en_US/catalogsearch/result?q=AZM-NEW-24";
    const discoveredUrl = "https://products.schmersal.com/en_US/product/azm-new-24?item=AZM-NEW-24";

    const result = await connector.scrape(catalogNumber, {
      manufacturer: {
        ...manufacturer,
        officialBaseUrls: ["https://products.schmersal.com"],
        fallbackSources: [],
        scrapeRecipe: {
          ...manufacturer.scrapeRecipe,
          searchUrlTemplates: ["https://products.schmersal.com/en_US/catalogsearch/result?q={part}"],
          discoveryPolicy: {
            ...(manufacturer.scrapeRecipe?.discoveryPolicy ?? {}),
            allowedOfficialDomains: ["products.schmersal.com"],
            maxCandidates: 6
          }
        }
      },
      runDir: "",
      documentsDir: "",
      http: {
        fetchText: async (url: string) => {
          fetchedUrls.push(url);
          if (url === searchUrl) {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<main>
                <a href="/en_US/product/azm-new-24?item=AZM-NEW-24">AZM-NEW-24 solenoid interlock</a>
              </main>`
            };
          }
          throw new Error(`unexpected URL ${url}`);
        }
      } as unknown as ScrapeContext["http"],
      downloadDocument: async (doc) => doc,
      fallback: {
        scrape: async (_catalogNumber, sources) => {
          fallbackSourcesSeen.push(...sources.flatMap((source) => source.directUrlTemplates));
          return sources.some((source) => source.directUrlTemplates.includes(discoveredUrl))
            ? {
                manufacturerId: "schmersal",
                catalogNumber,
                status: "partial",
                confidence: 0.74,
                productUrl: discoveredUrl,
                normalized: { voltage: "24 V DC", protection: "IP67" },
                attributes: [
                  { group: "Schmersal Product Data", name: "Catalog Number", value: catalogNumber },
                  { group: "Schmersal Product Data", name: "Rated control voltage", value: "24 V DC" },
                  { group: "Schmersal Product Data", name: "Degree of protection", value: "IP67" }
                ],
                documents: [{ type: "datasheet", label: "Schmersal product datasheet", url: `${discoveredUrl}&download=pdf` }],
                sources: []
              }
            : undefined;
        }
      }
    });

    expect(fetchedUrls).toContain(searchUrl);
    expect(fallbackSourcesSeen).toContain(discoveredUrl);
    expect(result.productUrl).toBe(discoveredUrl);
    expect(result.normalized.protection).toBe("IP67");
    expect(result.diagnostics?.attemptedUrls).toContain(searchUrl);
    expect(result.diagnostics?.discoveredCandidates?.some((candidate) => candidate.url === discoveredUrl)).toBe(true);
  });

  it("configures Schmersal and Spelsberg discovery through current official search pages", () => {
    const manufacturers = listManufacturerConfigs();
    const schmersal = manufacturers.find((manufacturer) => manufacturer.id === "schmersal");
    const spelsberg = manufacturers.find((manufacturer) => manufacturer.id === "spelsberg");

    expect(schmersal?.officialBaseUrls).toContain("https://products.schmersal.com");
    expect(schmersal?.scrapeRecipe?.searchUrlTemplates).toContain("https://products.schmersal.com/en_US/search?query={part}");
    expect(schmersal?.scrapeRecipe?.discoveryPolicy?.allowedOfficialDomains).toContain("products.schmersal.com");

    expect(spelsberg?.officialBaseUrls).toContain("https://www.spelsberg.com");
    expect(spelsberg?.scrapeRecipe?.searchUrlTemplates).toContain("https://www.spelsberg.com/product-finder/?query={part}");
    expect(spelsberg?.scrapeRecipe?.extractionPolicy?.documentUrlPatterns).toContain("\\.download\\?file=.+\\.pdf");
  });

  it("configures SCAME through official techsheet PDFs", () => {
    const scame = listManufacturerConfigs().find((manufacturer) => manufacturer.id === "scame");

    expect(scame?.officialBaseUrls).toEqual(expect.arrayContaining(["https://www.scame.com", "https://techsheet.scame.com"]));
    expect(scame?.homepageUrl).toBe("https://www.scame.com/web/scame-uk/home");
    expect(scame?.scrapeRecipe?.requiredDocuments).toEqual(["datasheet"]);
    expect(scame?.scrapeRecipe?.extractionPolicy?.documentUrlPatterns).toEqual(expect.arrayContaining([
      "techsheet\\.scame\\.com/infodata/.+\\.pdf",
      "techsheet\\.scame\\.com/Download/dms/cad/pdf/.+\\.pdf"
    ]));
  });

  it("configures Turck through official shop search and product pages", () => {
    const turck = listManufacturerConfigs().find((manufacturer) => manufacturer.id === "turck");

    expect(turck?.shortName).toBe("TUR");
    expect(turck?.officialBaseUrls).toEqual(expect.arrayContaining(["https://www.turck.com/de/en/shop"]));
    expect(turck?.scrapeRecipe?.searchUrlTemplates).toContain("https://www.turck.com/de/en/shop/search?q={part}");
    expect(turck?.scrapeRecipe?.discoveryPolicy?.allowedOfficialDomains).toEqual(expect.arrayContaining([
      "turck.com",
      "hansturck.azureedge.net"
    ]));
    expect(turck?.fallbackSources.some((source) =>
      source.id === "turck-shop-product" &&
      source.directUrlTemplates.includes("https://www.turck.com/de/en/shop/p/{part}")
    )).toBe(true);
    expect(turck?.fallbackSources.flatMap((source) => source.directUrlTemplates).some((template) =>
      template.includes("/sensors/inductive-sensors/")
    )).toBe(false);
    // Type Code column is populated from the catalog number (the shop "Type" row equals it).
    expect(turck?.scrapeRecipe?.qualityPolicy?.typeCodeFallback).toBe("catalogNumber");
    // Datasheet + Approvals certificate PDFs sit behind JS tabs, so one browser render is allowed
    // on quality failure to surface them for voltage/current/power/certificate enrichment.
    expect(turck?.scrapeRecipe?.fallbackPolicy?.browserOnQualityFailure).toBe(true);
    expect(turck?.scrapeRecipe?.fallbackPolicy?.maxBrowserAttempts).toBe(1);
  });
});
