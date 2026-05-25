import { describe, expect, it } from "vitest";
import { ABBConnector, parseAbbProductPage } from "../src/server/scrapers/abb.js";
import { BalluffConnector, parseBalluffProductPage } from "../src/server/scrapers/balluff.js";
import {
  EatonConnector,
  buildEatonProductUrlCandidates,
  buildEatonSearchApiUrlCandidates,
  extractEatonSearchCandidates,
  parseEatonProductPage
} from "../src/server/scrapers/eaton.js";
import { parseGenericProductPage } from "../src/server/scrapers/generic.js";
import { parseSchneiderDatasheetReaderPage, parseSchneiderProductPage, parseTelemecaniqueProductPage } from "../src/server/scrapers/schneider.js";
import { parseSiemensProductApiResponse } from "../src/server/scrapers/siemens.js";
import { parseSceProductPage } from "../src/server/scrapers/sce.js";
import type { FetchedText } from "../src/server/scrapers/http-client.js";
import type { ScrapeContext } from "../src/server/scrapers/types.js";

describe("manufacturer parsers", () => {
  it("parses ABB JSON-LD product data", () => {
    const html = `
      <html><head>
        <title>ABB Product</title>
        <link rel="canonical" href="https://new.abb.com/products/1SDA126387R1/test" />
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"Product","sku":"1SDA126387R1","name":"ABB Padlock","description":"Padlock device","weight":"0.028 kg","url":"https://new.abb.com/products/1SDA126387R1/test"}
        </script>
      </head><body>1SDA126387R1</body></html>
    `;
    const result = parseAbbProductPage("1SDA126387R1", fetched(html, "https://new.abb.com/products/1SDA126387R1/test"));
    expect(result.status).toBe("found");
    expect(result.title).toBe("ABB Padlock");
    expect(result.normalized.weight).toBe("0.028 kg");
  });

  it("parses ABB embedded PIS attributes by stable attribute codes", () => {
    const html = `
      <html><head>
        <title>S201-C6 | ABB</title>
        <link rel="canonical" href="https://new.abb.com/products/pl/2CDS251001R0064/s201-c6" />
      </head><body>
        2CDS251001R0064
        <script>
          window.__ABB_PRODUCT__ = {"productId":"2CDS251001R0064","attributes":{
            "ExtendedProductType":{"type":"Text","attributeCode":"ExtendedProductType","attributeName":"Typ produktu","values":[{"text":"S201-C6"}],"isInternal":false},
            "ProductId":{"type":"Text","attributeCode":"ProductId","attributeName":"Kod zamowieniowy","values":[{"text":"2CDS251001R0064"}],"isInternal":false},
            "CatalogDescription":{"type":"Text","attributeCode":"CatalogDescription","attributeName":"Opis katalogowy","values":[{"text":"Miniature Circuit Breaker - S200 - 1P - 6 A - C - (AC) 6 kA"}],"isInternal":false},
            "OperationalVoltage":{"type":"Text","attributeCode":"OperationalVoltage","attributeName":"Napiecie znamionowe laczeniowe","values":[{"text":"Maximum (Incl. Tolerance) 253 V AC"},{"text":"Maximum (Incl. Tolerance) 72 V DC"},{"text":"Minimum 12 V AC"},{"text":"Minimum 12 V DC"}],"isInternal":false},
            "RatedCurrent":{"type":"Text","attributeCode":"RatedCurrent","attributeName":"Prad znamionowy (I<sub>n</sub>)","values":[{"text":"6 A"}],"isInternal":false},
            "DegreeOfProtection":{"type":"Text","attributeCode":"DegreeOfProtection","attributeName":"Stopien ochrony","values":[{"text":"IP20"},{"text":"IP40"}],"isInternal":false},
            "ProductNetWidth":{"type":"Text","attributeCode":"ProductNetWidth","attributeName":"Szerokosc netto","values":[{"text":"17.5 mm"}],"isInternal":false},
            "ProductNetHeight":{"type":"Text","attributeCode":"ProductNetHeight","attributeName":"Wysokosc netto","values":[{"text":"88 mm"}],"isInternal":false},
            "ProductNetDepth":{"type":"Text","attributeCode":"ProductNetDepth","attributeName":"Glebokosc / dlugosc netto","values":[{"text":"69 mm"}],"isInternal":false},
            "ProductNetWeight":{"type":"Text","attributeCode":"ProductNetWeight","attributeName":"Masa netto","values":[{"text":"0.112 kg"}],"isInternal":false},
            "DataSheetTechnicalInformation":{"type":"Text","attributeCode":"DataSheetTechnicalInformation","attributeName":"Data Sheet, Technical Information","values":[{"text":"2CDC400002D0201"}],"isInternal":false},
            "RoHSInformation":{"type":"Text","attributeCode":"RoHSInformation","attributeName":"RoHS Declaration","values":[{"text":"9AKK108472A0372"}],"isInternal":false},
            "DimensionDiagram":{"type":"Text","attributeCode":"DimensionDiagram","attributeName":"Dimension Diagram","values":[{"text":"2CDC022007F0010"}],"isInternal":false}
          },"images":[{"url":"https:\\/\\/cdn.productimages.abb.com\\/9PAA00000348460_400x400.png"},{"url":"https:\\/\\/cdn.productimages.abb.com\\/9PAA00000348460_100x100.png"}]};
        </script>
      </body></html>
    `;
    const result = parseAbbProductPage("2CDS251001R0064", fetched(html, "https://new.abb.com/products/pl/2CDS251001R0064/s201-c6"));

    expect(result.status).toBe("found");
    expect(result.attributes.some((attr) => attr.name === "Rated Current" && attr.value === "6 A")).toBe(true);
    expect(result.normalized.current).toBe("6 A");
    expect(result.normalized.voltage).toContain("253 V AC");
    expect(result.normalized.protection).toBe("IP20; IP40");
    expect(result.normalized.weight).toBe("0.112 kg");
    expect(result.normalized.dimensions).toBe("88 x 17.5 x 69 mm");
    expect(result.documents.some((doc) => doc.type === "datasheet" && doc.url.includes("DocumentID=2CDC400002D0201"))).toBe(true);
    expect(result.documents.some((doc) => doc.type === "certificate" && doc.url.includes("DocumentID=9AKK108472A0372"))).toBe(true);
    expect(result.documents.some((doc) => doc.type === "cad" && doc.url.includes("DocumentID=2CDC022007F0010"))).toBe(true);
    expect(result.documents.filter((doc) => doc.type === "image").map((doc) => doc.url)).toEqual([
      "https://cdn.productimages.abb.com/9PAA00000348460_400x400.png"
    ]);
  });

  it("parses ABB product model groups, downloads, classifications, and accessories", () => {
    const model = {
      ProductViewModel: {
        Product: {
          productDetails: {
            item: {
              images: [
                {
                  url: "https://cdn.productimages.abb.com/9PAA00000074124_400x400.png",
                  thumbnailUrl: "https://cdn.productimages.abb.com/9PAA00000074124_100x100.png",
                  masterUrl: "https://cdn.productimages.abb.com/9PAA00000074124_master.png"
                }
              ],
              productId: "1SLM004100A1100",
              attributes: {
                ExtendedProductType: abbAttribute("ExtendedProductType", "Extended Product Type", "41A04X11"),
                ProductId: abbAttribute("ProductId", "Product ID", "1SLM004100A1100"),
                "ABB.Type": abbAttribute("ABB.Type", "ABB Type Designation", "Mistral41F"),
                CatalogDescription: abbAttribute(
                  "CatalogDescription",
                  "Catalog Description",
                  "Consumer unit MISTRAL41F, Flush mounting, IP41"
                )
              }
            }
          },
          attributeGroups: {
            items: [
              {
                code: "PopularDownloads",
                description: "Popular Downloads",
                attributes: {
                  DatSheTecInf: abbAttribute("DatSheTecInf", "Data Sheet, Technical Information", "1SBC100214C0202"),
                  InsMan: abbAttribute("InsMan", "Instructions and Manuals", "9AKK107046A4893")
                }
              },
              {
                code: "Technical",
                description: "Technical",
                attributes: {
                  DooSurFin: abbAttribute("DooSurFin", "Door Surface Finishing", "Opaque"),
                  ImpResRat: abbAttribute("ImpResRat", "Impact Resistance Rating", "IK08")
                }
              },
              {
                code: "Design",
                description: "Design",
                attributes: {
                  RalNum: abbAttribute("RalNum", "RAL Number", "RAL 9016 - Traffic White"),
                  Color: abbAttribute("Color", "Color", "Traffic white")
                }
              }
            ]
          },
          productClassifications: {
            items: {
              Products: [
                [
                  { cid: "ROOT", name: "Products" },
                  { cid: "9AAC910006", name: "Low Voltage Products and Systems" },
                  { cid: "9AAC100241", name: "Consumer Units" }
                ]
              ]
            }
          },
          productRelationships: {
            items: [
              {
                code: "ACCESSORIES",
                description: "Accessories",
                type: "Accessories",
                table: {
                  rows: [
                    {
                      values: {
                        Identifier: [{ text: "1SBN010015R1001", link: { productId: "1SBN010015R1001", type: "Detail" } }],
                        Description: [{ text: "Auxiliary Contact Block" }],
                        Type: [{ text: "CE5-01D0.1" }],
                        Quantity: [{ text: "1" }],
                        UnitOfMeasure: [{ text: "piece" }]
                      }
                    }
                  ]
                }
              }
            ]
          }
        }
      }
    };
    const html = `
      <html><head>
        <title>41A04X11 | ABB</title>
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"Product","sku":"1SLM004100A1100","name":"41A04X11","description":"Consumer unit"}
        </script>
      </head><body>
        1SLM004100A1100
        <script>var model = ${JSON.stringify(model)};</script>
      </body></html>
    `;
    const result = parseAbbProductPage("1SLM004100A1100", fetched(html, "https://new.abb.com/products/1SLM004100A1100/41a04x11"));

    expect(result.status).toBe("found");
    expect(result.attributes.some((attr) => attr.group === "ABB Technical" && attr.name === "Door Surface Finishing" && attr.value === "Opaque")).toBe(true);
    expect(result.attributes.some((attr) => attr.group === "ABB Design" && attr.name === "RAL Number" && attr.value.includes("Traffic White"))).toBe(true);
    expect(result.attributes.some((attr) => attr.group === "ABB Product Classification" && attr.name === "Products Path")).toBe(true);
    expect(result.attributes.some((attr) => attr.group === "ABB Accessories" && attr.name === "Accessory" && attr.value.includes("1SBN010015R1001"))).toBe(true);
    expect(result.documents.some((doc) => doc.type === "datasheet" && doc.url.includes("DocumentID=1SBC100214C0202"))).toBe(true);
    expect(result.documents.some((doc) => doc.type === "manual" && doc.url.includes("DocumentID=9AKK107046A4893"))).toBe(true);
    expect(result.documents.find((doc) => doc.type === "image")?.candidateUrls?.some((url) => url.includes("_master"))).toBe(true);
  });

  it("canonicalizes ABB switch-disconnector PIS codes and summary ratings", () => {
    const html = `
      <html><head>
        <title>OT200US03 | ABB</title>
        <link rel="canonical" href="https://new.abb.com/products/1SCA022870R6290/ot200us03" />
      </head><body>
        1SCA022870R6290
        <script>
          window.__ABB_PRODUCT__ = {"productId":"1SCA022870R6290","attributes":{
            "ExtendedProductType":{"type":"Text","attributeCode":"ExtendedProductType","attributeName":"Extended Product Type","values":[{"text":"OT200US03"}],"isInternal":false},
            "ProductId":{"type":"Text","attributeCode":"ProductId","attributeName":"Product ID","values":[{"text":"1SCA022870R6290"}],"isInternal":false},
            "CatalogDescription":{"type":"Text","attributeCode":"CatalogDescription","attributeName":"Catalog Description","values":[{"text":"OT200US03 SWITCH-DISCONNECTOR"}],"isInternal":false},
            "RatOpeVol":{"type":"Text","attributeCode":"RatOpeVol","attributeName":"Rated Operational Voltage","values":[{"text":"Main Circuit 1000 V"}],"isInternal":false},
            "MaxOpeVolUlCsa":{"type":"Text","attributeCode":"MaxOpeVolUlCsa","attributeName":"Maximum Operating Voltage UL/CSA","values":[{"text":"600 V"}],"isInternal":false},
            "AmpereRating":{"type":"Text","attributeCode":"AmpereRating","attributeName":"Ampere Rating","values":[{"text":"200 A"}],"isInternal":false},
            "RatOpeCurAc23a":{"type":"Text","attributeCode":"RatOpeCurAc23a","attributeName":"Rated Operational Current AC-23A","values":[{"text":"(380 ... 415 V) 250 A"},{"text":"(690 V) 250 A"}],"isInternal":false},
            "NumberOfPoles":{"type":"Text","attributeCode":"NumberOfPoles","attributeName":"Number of Poles","values":[{"text":"3P"}],"isInternal":false},
            "ProductNetWidth":{"type":"Text","attributeCode":"ProductNetWidth","attributeName":"Product Net Width","values":[{"text":"205.5 mm"}],"isInternal":false},
            "ProductNetHeight":{"type":"Text","attributeCode":"ProductNetHeight","attributeName":"Product Net Height","values":[{"text":"150 mm"}],"isInternal":false},
            "ProductNetDepth":{"type":"Text","attributeCode":"ProductNetDepth","attributeName":"Product Net Depth / Length","values":[{"text":"101.5 mm"}],"isInternal":false},
            "ProductNetWeight":{"type":"Text","attributeCode":"ProductNetWeight","attributeName":"Product Net Weight","values":[{"text":"1.655 kg"}],"isInternal":false},
            "Standards":{"type":"Text","attributeCode":"Standards","attributeName":"Standards","values":[{"text":"IEC 60947-3 / UL 98 / CSA C22.2 NO.4"}],"isInternal":false}
          }};
        </script>
      </body></html>
    `;
    const result = parseAbbProductPage("1SCA022870R6290", fetched(html, "https://new.abb.com/products/1SCA022870R6290/ot200us03"));

    expect(result.status).toBe("found");
    expect(result.attributes.some((attr) => attr.name === "Rated Operational Current AC-23A" && attr.value.includes("250 A"))).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Maximum Operating Voltage UL/CSA" && attr.value === "600 V")).toBe(true);
    expect(result.normalized.voltage).toBe("Main Circuit 1000 V");
    expect(result.normalized.current).toBe("200 A");
    expect(result.normalized.weight).toBe("1.655 kg");
    expect(result.normalized.dimensions).toBe("150 x 205.5 x 101.5 mm");
  });

  it("discovers ABB product IDs from the official PIS search API for commercial aliases", async () => {
    const connector = new ABBConnector();
    const requestedUrls: string[] = [];
    const sparseHtml = `
      <html><head>
        <title>ACS580-01-039A-4 | ABB</title>
        <script type="application/ld+json">
          {"@context":"https://schema.org/","@type":"Product","sku":"3ABD50000038962","name":"LV AC drive (ACS580-01-039A-4)","description":"LV AC drive, 38 A (ACS580-01-039A-4)"}
        </script>
      </head><body>ACS580-01-039A-4 3ABD50000038962</body></html>
    `;
    const richHtml = `
      <html><head>
        <title>ACS580-01-039A-4 | ABB</title>
        <link rel="canonical" href="https://new.abb.com/products/pl/3AXD50000038962/acs580-01-039a-4" />
      </head><body>
        ACS580-01-039A-4
        <script>
          window.__ABB_PRODUCT__ = {"productId":"3AXD50000038962","attributes":{
            "GloComAli":{"type":"Text","attributeCode":"GloComAli","attributeName":"Global Commercial Alias","values":[{"text":"ACS580-01-039A-4"}],"isInternal":false},
            "ProductId":{"type":"Text","attributeCode":"ProductId","attributeName":"Product ID","values":[{"text":"3AXD50000038962"}],"isInternal":false},
            "ABB.Type":{"type":"Text","attributeCode":"ABB.Type","attributeName":"ABB Type","values":[{"text":"ACS580-01-039A-4"}],"isInternal":false},
            "CatalogDescription":{"type":"Text","attributeCode":"CatalogDescription","attributeName":"Catalog Description","values":[{"text":"LV AC general purpose wall-mounted drive, IEC: Pn 18.5 kW, 38 A, 400 V (ACS580-01-039A-4)"}],"isInternal":false},
            "InputVoltage":{"type":"Text","attributeCode":"InputVoltage","attributeName":"Input Voltage","values":[{"text":"380 ... 480 V"}],"isInternal":false},
            "OutputCurrent":{"type":"Text","attributeCode":"OutputCurrent","attributeName":"Output Current","values":[{"text":"38 A"}],"isInternal":false},
            "OutputPower":{"type":"Text","attributeCode":"OutputPower","attributeName":"Output Power","values":[{"text":"18.5 kW"}],"isInternal":false},
            "DegreeOfProtection":{"type":"Text","attributeCode":"DegreeOfProtection","attributeName":"Degree of Protection","values":[{"text":"IP21"}],"isInternal":false},
            "ProductNetWidth":{"type":"Text","attributeCode":"ProductNetWidth","attributeName":"Product Net Width","values":[{"text":"203 mm"}],"isInternal":false},
            "ProductNetHeight":{"type":"Text","attributeCode":"ProductNetHeight","attributeName":"Product Net Height","values":[{"text":"490 mm"}],"isInternal":false},
            "ProductNetDepth":{"type":"Text","attributeCode":"ProductNetDepth","attributeName":"Product Net Depth / Length","values":[{"text":"229 mm"}],"isInternal":false},
            "ProductNetWeight":{"type":"Text","attributeCode":"ProductNetWeight","attributeName":"Product Net Weight","values":[{"text":"11.8 kg"}],"isInternal":false},
            "DataSheetTechnicalInformation":{"type":"Text","attributeCode":"DataSheetTechnicalInformation","attributeName":"Data Sheet, Technical Information","values":[{"text":"3AXD10000497691"}],"isInternal":false}
          }};
        </script>
      </body></html>
    `;
    const searchJson = JSON.stringify({
      Items: [
        { ProductId: "3ABD50000038962", CatalogDescription: "LV AC general purpose wall-mounted drive, IEC: Pn 18.5 kW, 38 A (ACS580-01-039A-4)" },
        { ProductId: "3AXD50000038962", CatalogDescription: "LV AC general purpose wall-mounted drive, IEC: Pn 18.5 kW, 38 A, 400 V (ACS580-01-039A-4)" }
      ],
      TotalResultsCount: 2
    });
    const context = {
      manufacturer: {
        id: "abb",
        canonicalName: "ABB",
        shortName: "ABB",
        rateLimitMs: 0,
        officialBaseUrls: ["https://new.abb.com/products"],
        localizedUrlTemplates: [],
        fallbackSources: []
      },
      http: {
        fetchText: async (url: string) => {
          requestedUrls.push(url);
          if (url.includes("/api/PisSearchApi?")) return fetched(searchJson, url, "application/json");
          if (url.includes("/products/pl/3ABD50000038962/")) return fetched(sparseHtml, url);
          if (url.includes("/products/pl/3AXD50000038962/")) return fetched(richHtml, url);
          return fetched(`<html><body>not ${url}</body></html>`, url);
        },
        fetchTextViaPowerShell: async (url: string) => fetched(`<html><body>not ${url}</body></html>`, url)
      },
      runDir: "",
      documentsDir: "",
      downloadDocument: async (doc: Parameters<ScrapeContext["downloadDocument"]>[0]) => doc,
      fallback: {
        scrape: async () => undefined
      }
    } as unknown as ScrapeContext;

    const result = await connector.scrape("ACS580-01-039A-4", context);

    expect(result.status).toBe("found");
    expect(result.productUrl).toBe("https://new.abb.com/products/pl/3AXD50000038962/acs580-01-039a-4");
    expect(result.attributes.some((attr) => attr.name === "Product ID" && attr.value === "3AXD50000038962")).toBe(true);
    expect(result.normalized.voltage).toBe("380...480 V");
    expect(result.normalized.current).toBe("38 A");
    expect(result.normalized.dimensions).toBe("490 x 203 x 229 mm");
    expect(result.normalized.weight).toBe("11.8 kg");
    expect(result.normalized.protection).toBe("IP21");
    expect(result.documents.some((doc) => doc.type === "datasheet" && doc.url.includes("DocumentID=3AXD10000497691"))).toBe(true);
    expect(requestedUrls).toContain("https://new.abb.com/api/PisSearchApi?query=ACS580-01-039A-4&pageNumber=1&pageSize=8&lang=en");
  });

  it("parses SCE detail and CAD download links", () => {
    const detailHtml = `
      <html><head><title>SCE-20EL2010LP - Saginaw Control and Engineering</title></head>
      <body>
        <h1>SCE-20EL2010LP</h1>
        <img src="/images/sce-20el2010lp.png" alt="SCE-20EL2010LP" />
        <div class="prod-details-div">
          <p class="prod-info-header">Product Information</p>
          <p class="prod-info-body">Description: EL Enclosure</p>
          <p class="prod-info-body">Weight: 41 lb</p>
          <span class="product-dimension">20.00H</span><span class="product-dimension">20.00W</span><span class="product-dimension">10.00D</span>
          <a href="/instman/manual.pdf">Installation Manual</a>
          <a href="/download-doc/?Part=sce-20el2010lp">Download CAD Package</a>
        </div>
      </body></html>
    `;
    const cadHtml = `<html><head><meta http-equiv="Refresh" content="1;URL=https://www.saginawcontrol.com/download/sce-20el2010lp.zip"></head><body>SCE-20EL2010LP</body></html>`;
    const result = parseSceProductPage(
      "SCE-20EL2010LP",
      fetched(detailHtml, "https://www.saginawcontrol.com/partnumber_info?n=SCE-20EL2010LP"),
      undefined,
      fetched(cadHtml, "https://www.saginawcontrol.com/download-doc/?PartNumber=SCE-20EL2010LP")
    );
    expect(result.status).toBe("found");
    expect(result.normalized.weight).toBe("41 lb (18.60 kg)");
    expect(result.normalized.dimensions).toContain("20.00H");
    expect(result.localizedUrls?.en).toBe("https://www.saginawcontrol.com/partnumber_info?n=SCE-20EL2010LP");
    expect(result.localizedUrls?.de).toBeUndefined();
    expect(result.documents.some((doc) => doc.type === "cad" && doc.url.includes("download-doc"))).toBe(true);
    expect(result.documents.some((doc) => doc.type === "cad" && doc.url.includes("sce-20el2010lp.zip"))).toBe(true);
    expect(result.documents.some((doc) => doc.type === "image" && doc.url.includes("sce-20el2010lp.png"))).toBe(true);
  });

  it("parses SCE product specs, sections, accessories, and manuals", () => {
    const detailHtml = `
      <html><head><title>SCE-16H1206LP - Saginaw Control and Engineering</title></head>
      <body>
        <h1>SCE-16H1206LP</h1>
        <div class="bom-message"><p><a href="/partnumber_info?n=SCE-16EL1206LP">SCE-16EL1206LP</a> - Cost Effective Alternative.</p></div>
        <div class="prod-specs">
          <p class="prod-info-body"><strong>Part Number</strong>: <span>SCE-16H1206LP</span></p>
          <p class="prod-info-body"><strong>Description</strong>: <span>Nema 4 LP Enclosure</span></p>
          <p class="prod-info-body"><strong>Height</strong>: 16.00"</p>
          <p class="prod-info-body"><strong>Width</strong>: 12.00"</p>
          <p class="prod-info-body"><strong>Depth</strong>: 6.00"</p>
          <p class="prod-info-body"><strong>Price Code</strong>: A3</p>
          <p class="prod-info-body"><strong>List Price</strong>: $259.81</p>
          <p class="prod-info-body"><strong>Catalog Page</strong>: 98</p>
          <p class="prod-info-body"><strong>Est. Ship Weight</strong>: 21.00 lbs</p>
        </div>
        <div class="prod-details-div">
          <p class="prod-info-header">Construction</p>
          <ul class="prod-info-body-wrap">
            <li class="prod-info-body">0.075 In. carbon steel.</li>
            <li class="prod-info-body">Concealed hinge.</li>
          </ul>
        </div>
        <div class="prod-details-div">
          <p class="prod-info-header">Finish</p>
          <div class="prod-info-body-wrap"><p class="prod-info-body">ANSI-61 gray powder coating inside and out.</p></div>
        </div>
        <div class="prod-details-div">
          <p class="prod-info-header">Accessories Included</p>
          <div class="prod-info-body-wrap">
            <div class="part-acc"><a href="/partnumber_info?n=SCE-HLPMFK"><p class="prod-float-link">SCE-HLPMFK <br>Mounting Foot Kit for HLP and SA LPPL Enc.</p></a></div>
          </div>
        </div>
        <div class="prod-details-div">
          <p class="prod-info-header">Optional Accessories</p>
          <div class="prod-info-body-wrap">
            <div class="part-acc"><a href="/partnumber_info?n=SCE-16P12"><p class="prod-float-link">SCE-16P12 <br>Subpanel, Flat</p></a></div>
          </div>
        </div>
        <div class="prod-details-div">
          <p class="prod-info-header">Similar Part Numbers</p>
          <div class="prod-info-body-wrap">
            <div class="part-acc"><a href="/partnumber_info?n=SCE-16H1208LP"><p class="prod-float-link">SCE-16H1208LP<br>Nema 4 LP Enclosure</p></a></div>
          </div>
        </div>
        <div class="prod-details-div">
          <p class="prod-info-header">Installation Information</p>
          <ul class="prod-info-body-wrap">
            <li class="prod-info-body"><a href="/instman/deadfrontel-hlp.pdf">Dead Front Wall Mount Installation Instructions. H-LP REV. 2</a></li>
          </ul>
        </div>
      </body></html>
    `;
    const result = parseSceProductPage("SCE-16H1206LP", fetched(detailHtml, "https://www.saginawcontrol.com/partnumber_info/?n=SCE-16H1206LP"));

    expect(result.normalized.weight).toBe("21.00 lbs (9.53 kg)");
    expect(result.normalized.dimensions).toBe("16.00 x 12.00 x 6.00 in (406.4 x 304.8 x 152.4 mm)");
    expect(result.normalized.material).toBe("carbon steel");
    expect(result.normalized.wallThickness).toBe("0.075 in (1.91 mm)");
    expect(result.normalized.finish).toBe("ANSI-61 gray powder coating inside and out.");
    expect(result.normalized.color).toBe("ANSI-61 gray");
    expect(result.attributes.some((attr) => attr.group === "SCE Product Data" && attr.name === "Product Type" && attr.value === "Nema 4 LP Enclosure")).toBe(true);
    expect(result.attributes.some((attr) => attr.group === "Product Specifications" && attr.name === "List Price" && attr.value === "$259.81")).toBe(true);
    expect(result.attributes.some((attr) => attr.group === "Finish" && attr.name === "Finish" && attr.value.includes("ANSI-61"))).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Included Accessory" && attr.value.includes("SCE-HLPMFK - Mounting Foot Kit"))).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Optional Accessory" && attr.value.includes("SCE-16P12 - Subpanel"))).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Similar Part" && attr.value === "SCE-16H1208LP - Nema 4 LP Enclosure")).toBe(true);
    expect(result.attributes.some((attr) => attr.group === "Recommended Alternative" && attr.value.includes("SCE-16EL1206LP"))).toBe(true);
    expect(result.attributes.some((attr) => attr.group === "Construction" && attr.value === "Construction")).toBe(false);
    expect(result.documents.some((doc) => doc.type === "manual" && doc.url.includes("deadfrontel-hlp.pdf"))).toBe(true);
  });

  it("infers SCE material from sparse catalog descriptions and part codes", () => {
    const html = `
      <html><head><title>SCE-DS12SS6 - Saginaw Control and Engineering</title></head>
      <body>
        <h1>SCE-DS12SS6</h1>
        <div class="prod-specs">
          <p class="prod-info-body"><strong>Part Number</strong>: SCE-DS12SS6</p>
          <p class="prod-info-body"><strong>Description</strong>: Shield, S.S. Drip</p>
          <p class="prod-info-body"><strong>Height</strong>: 1.00"</p>
          <p class="prod-info-body"><strong>Width</strong>: 12.00"</p>
          <p class="prod-info-body"><strong>Depth</strong>: 3.00"</p>
          <p class="prod-info-body"><strong>Est. Ship Weight</strong>: 1.20 lbs</p>
        </div>
        <div class="prod-details-div">
          <p class="prod-info-header">Application</p>
          <p class="prod-info-body">Furnished with stainless steel screws and sealing washers.</p>
        </div>
      </body></html>
    `;
    const result = parseSceProductPage("SCE-DS12SS6", fetched(html, "https://www.saginawcontrol.com/partnumber_info/?n=SCE-DS12SS6"));

    expect(result.normalized.material).toBe("stainless steel Type 316/316L");
    expect(result.attributes.some((attr) => attr.group === "SCE Catalog Inference" && attr.name === "Material")).toBe(true);
  });

  it("parses Saginaw program port part numbers without the SCE prefix", () => {
    const html = `
      <html><head><title>P-P11R2-K3RF0-U450 - Saginaw Control and Engineering</title></head>
      <body>
        <h1>P-P11R2-K3RF0-U450</h1>
        <img src="/images/p-p11r2-k3rf0-u450.png" alt="P-P11R2-K3RF0-U450" />
        <div class="prod-specs">
          <p class="prod-info-body"><strong>Part Number</strong>: P-P11R2-K3RF0-U450</p>
          <p class="prod-info-body"><strong>Description</strong>: Port, Programming</p>
          <p class="prod-info-body"><strong>Height</strong>: 3.50"</p>
          <p class="prod-info-body"><strong>Width</strong>: 5.10"</p>
          <p class="prod-info-body"><strong>Depth</strong>: 1.65"</p>
          <p class="prod-info-body"><strong>Interface</strong>: Ethernet/USB</p>
          <p class="prod-info-body"><strong>Est. Ship Weight</strong>: 2.00 lbs</p>
        </div>
        <div class="prod-details-div">
          <p class="prod-info-header">Construction</p>
          <p class="prod-info-body">Body made of polycarbonate.</p>
        </div>
        <div class="prod-details-div">
          <p class="prod-info-header">Similar Part Numbers</p>
          <div class="prod-info-body-wrap">
            <div class="part-acc"><a href="/partnumber_info"><p class="prod-float-link">P-Q9-K3RF3-U450<br>Programming Port</p></a></div>
          </div>
        </div>
      </body></html>
    `;
    const result = parseSceProductPage("P-P11R2-K3RF0-U450", fetched(html, "https://www.saginawcontrol.com/partnumber_info?n=P-P11R2-K3RF0-U450"));

    expect(result.status).toBe("found");
    expect(result.description).toBe("Port, Programming");
    expect(result.normalized.material).toBe("polycarbonate");
    expect(result.normalized.weight).toBe("2.00 lbs (0.91 kg)");
    expect(result.attributes.some((attr) => attr.name === "Similar Part" && attr.value === "P-Q9-K3RF3-U450 - Programming Port")).toBe(true);
    expect(result.documents.some((doc) => doc.type === "image" && doc.url.includes("p-p11r2-k3rf0-u450.png"))).toBe(true);
  });

  it("keeps SCE official product images when the filename is a representative series image", () => {
    const html = `
      <html><head><title>SCE-10086PCW - Saginaw Control and Engineering</title></head>
      <body>
        <h1>SCE-10086PCW</h1>
        <img src="/wp-content/uploads/2017/05/SCE-1412PCW.png" alt="SCE-10086PCW" />
        <div class="prod-specs">
          <p class="prod-info-body"><strong>Part Number</strong>: SCE-10086PCW</p>
          <p class="prod-info-body"><strong>Description</strong>: Polycarbonate Window, Enclosure</p>
          <p class="prod-info-body"><strong>Height</strong>: 11.41"</p>
          <p class="prod-info-body"><strong>Width</strong>: 9.41"</p>
          <p class="prod-info-body"><strong>Depth</strong>: 7.39"</p>
          <p class="prod-info-body"><strong>Est. Ship Weight</strong>: 4.50 lbs</p>
        </div>
      </body></html>
    `;
    const result = parseSceProductPage("SCE-10086PCW", fetched(html, "https://www.saginawcontrol.com/partnumber_info/?n=SCE-10086PCW"));
    const image = result.documents.find((doc) => doc.type === "image");

    expect(image?.url).toContain("SCE-1412PCW.png");
    expect(image?.label).toContain("SCE-10086PCW");
  });

  it("derives SCE thermostat switch capacity and set point ratings from application text", () => {
    const html = `
      <html><head><title>SCE-TEMNC - Saginaw Control and Engineering</title></head>
      <body>
        <h1>SCE-TEMNC</h1>
        <img src="/images/sce-temnc.png" alt="SCE-TEMNC" />
        <div class="prod-specs">
          <p class="prod-info-body"><strong>Part Number</strong>: SCE-TEMNC</p>
          <p class="prod-info-body"><strong>Description</strong>: Thermostat (Normally Closed)</p>
          <p class="prod-info-body"><strong>Height</strong>: 2.40"</p>
          <p class="prod-info-body"><strong>Width</strong>: 1.26"</p>
          <p class="prod-info-body"><strong>Depth</strong>: 1.42"</p>
          <p class="prod-info-body"><strong>Est. Ship Weight</strong>: 1.00 lbs</p>
        </div>
        <div class="prod-details-div">
          <p class="prod-info-header">Application</p>
          <p class="prod-info-body">Designed to regulate air temperature. This mechanical bi-metallic thermostat has a set point range of 30° to 140° F and switch capacity 10 amp 120-250 VAC Resistive load and 1 amp 120-250VAC Inductive load, 1.25 amp 24VDC.</p>
        </div>
      </body></html>
    `;
    const result = parseSceProductPage("SCE-TEMNC", fetched(html, "https://www.saginawcontrol.com/partnumber_info/?n=SCE-TEMNC"));

    expect(result.normalized.voltage).toBe("120...250 V AC");
    expect(result.normalized.current).toBe("10 A");
    expect(result.attributes.some((attr) => attr.group === "SCE Electrical Ratings" && attr.name === "Switch Capacity")).toBe(true);
    expect(result.attributes.find((attr) => attr.group === "SCE Electrical Ratings" && attr.name === "Switch Capacity")?.value).toContain("1.25 amp 24VDC");
    expect(result.attributes.some((attr) => attr.group === "SCE Thermal Ratings" && attr.name === "Set Point Range" && attr.value === "30° to 140° F")).toBe(true);
  });

  it("infers SCE catalog voltage from heat exchanger part numbers when specs omit volts", () => {
    const html = `
      <html><head><title>SCE-HE04W120V - Saginaw Control and Engineering</title></head>
      <body>
        <h1>SCE-HE04W120V</h1>
        <img src="/images/sce-he04w120v.png" alt="SCE-HE04W120V" />
        <div class="prod-specs">
          <p class="prod-info-body"><strong>Part Number</strong>: SCE-HE04W120V</p>
          <p class="prod-info-body"><strong>Description</strong>: Exchanger, Heat</p>
          <p class="prod-info-body"><strong>Height</strong>: 20.00"</p>
          <p class="prod-info-body"><strong>Width</strong>: 7.50"</p>
          <p class="prod-info-body"><strong>Depth</strong>: 5.95"</p>
          <p class="prod-info-body"><strong>Est. Ship Weight</strong>: 14.08 lbs</p>
        </div>
      </body></html>
    `;
    const result = parseSceProductPage("SCE-HE04W120V", fetched(html, "https://www.saginawcontrol.com/partnumber_info/?n=SCE-HE04W120V"));

    expect(result.normalized.voltage).toBe("120 V");
    expect(result.attributes.some((attr) => attr.group === "SCE Catalog Inference" && attr.name === "Voltage" && attr.value === "120 V")).toBe(true);
  });

  it("does not infer material for SCE stainless steel cleaner consumables", () => {
    const html = `
      <html><head><title>SCE-SSCLEAN - Saginaw Control and Engineering</title></head>
      <body>
        <h1>SCE-SSCLEAN</h1>
        <img src="/images/sce-ssclean.png" alt="SCE-SSCLEAN" />
        <div class="prod-specs">
          <p class="prod-info-body"><strong>Part Number</strong>: SCE-SSCLEAN</p>
          <p class="prod-info-body"><strong>Description</strong>: Stainless Steel Cleaner</p>
          <p class="prod-info-body"><strong>Height</strong>: 1.00"</p>
          <p class="prod-info-body"><strong>Width</strong>: 1.00"</p>
          <p class="prod-info-body"><strong>Depth</strong>: 1.00"</p>
          <p class="prod-info-body"><strong>Est. Ship Weight</strong>: 1.00 lbs</p>
        </div>
      </body></html>
    `;
    const result = parseSceProductPage("SCE-SSCLEAN", fetched(html, "https://www.saginawcontrol.com/partnumber_info/?n=SCE-SSCLEAN"));

    expect(result.normalized.material).toBeUndefined();
    expect(result.attributes.some((attr) => attr.group === "SCE Catalog Inference" && attr.name === "Material")).toBe(false);
  });

  it("derives SCE thermal, mechanical, and certification details from buried page text", () => {
    const html = `
      <html><head><title>SCE-AC3400B120V - Saginaw Control and Engineering</title></head>
      <body>
        <h1>SCE-AC3400B120V</h1>
        <img src="/images/sce-ac3400b120v.png" alt="SCE-AC3400B120V" />
        <div class="prod-specs">
          <p class="prod-info-body"><strong>Part Number</strong>: SCE-AC3400B120V</p>
          <p class="prod-info-body"><strong>Description</strong>: Conditioner, Air - 3400 BTU/Hr. 120 Volt</p>
          <p class="prod-info-body"><strong>Height</strong>: 35.43"</p>
          <p class="prod-info-body"><strong>Width</strong>: 12.00"</p>
          <p class="prod-info-body"><strong>Depth</strong>: 10.63"</p>
          <p class="prod-info-body"><strong>Est. Ship Weight</strong>: 91.30 lbs</p>
          <p class="prod-info-body"><strong>Heating Capacity</strong>: 400 Watt</p>
        </div>
        <div class="prod-details-div">
          <p class="prod-info-header">Construction</p>
          <ul class="prod-info-body-wrap">
            <li class="prod-info-body">R513a Refrigerant - Chlorine-free and harmless to the environment</li>
            <li class="prod-info-body">Controller Preset 95°F to cool - adjustable 68°F to 122°F</li>
            <li class="prod-info-body">Preset at 41°F to heat - adjustable -4°F to 122°F</li>
            <li class="prod-info-body">Temperature differential hysteresis 5.4°F</li>
            <li class="prod-info-body">High temp alarm Preset 131°F</li>
          </ul>
        </div>
        <div class="prod-details-div">
          <p class="prod-info-header">Notes</p>
          <p class="prod-info-body">cULus File Component Recognized SA32278 cULus Listed E498756</p>
        </div>
      </body></html>
    `;
    const result = parseSceProductPage("SCE-AC3400B120V", fetched(html, "https://www.saginawcontrol.com/partnumber_info/?n=SCE-AC3400B120V"));

    expect(result.attributes.some((attr) => attr.group === "SCE Thermal Ratings" && attr.name === "Cooling Capacity" && attr.value === "3400 BTU/Hr")).toBe(true);
    expect(result.attributes.some((attr) => attr.group === "SCE Thermal Ratings" && attr.name === "Refrigerant" && attr.value === "R513a Refrigerant")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Controller Cooling Setpoint" && attr.value.includes("95°F"))).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Controller Heating Setpoint" && attr.value.includes("41°F"))).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Temperature Hysteresis" && attr.value === "5.4°F")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "High Temperature Alarm" && attr.value === "Preset 131°F")).toBe(true);
    expect(result.attributes.some((attr) => attr.group === "SCE Certification Details" && attr.value === "cULus File Component Recognized SA32278")).toBe(true);
    expect(result.attributes.some((attr) => attr.group === "SCE Certification Details" && attr.value === "cULus Listed E498756")).toBe(true);
    expect(result.normalized.certificates).toContain("cULus File Component Recognized SA32278");
    expect(result.normalized.certificates).toContain("cULus Listed E498756");
    expect(result.normalized.certificates?.split(";").map((item) => item.trim())).not.toContain("UL");
  });

  it("derives SCE pressure, filter, thread, airflow, and watt ratings from compact accessory fields", () => {
    const html = `
      <html><head><title>SCE-FRK24VDC - Saginaw Control and Engineering</title></head>
      <body>
        <h1>SCE-FRK24VDC</h1>
        <div class="prod-specs">
          <p class="prod-info-body"><strong>Part Number</strong>: SCE-FRK24VDC</p>
          <p class="prod-info-body"><strong>Description</strong>: Kit, Filter/regulator with 24VDC Shut off</p>
          <p class="prod-info-body"><strong>Volt</strong>: 24 VDC</p>
          <p class="prod-info-body"><strong>CFM</strong>: 140</p>
          <p class="prod-info-body"><strong>Watt</strong>: 125</p>
        </div>
        <div class="prod-details-div">
          <p class="prod-info-header">Construction</p>
          <ul class="prod-info-body-wrap">
            <li class="prod-info-body">Base material - Techpolymer</li>
            <li class="prod-info-body">0 to 180 PSI Gage</li>
            <li class="prod-info-body">5um filter</li>
            <li class="prod-info-body">1/4 inch NPT</li>
          </ul>
        </div>
      </body></html>
    `;
    const result = parseSceProductPage("SCE-FRK24VDC", fetched(html, "https://www.saginawcontrol.com/partnumber_info/?n=SCE-FRK24VDC"));

    expect(result.attributes.some((attr) => attr.group === "SCE Thermal Ratings" && attr.name === "Air Flow" && attr.value === "140 CFM")).toBe(true);
    expect(result.attributes.some((attr) => attr.group === "SCE Electrical Ratings" && attr.name === "Power" && attr.value === "125 W")).toBe(true);
    expect(result.attributes.some((attr) => attr.group === "SCE Mechanical Ratings" && attr.name === "Pressure Range" && attr.value === "0 to 180 PSI Gage")).toBe(true);
    expect(result.attributes.some((attr) => attr.group === "SCE Mechanical Ratings" && attr.name === "Filter Rating" && attr.value === "5um filter")).toBe(true);
    expect(result.attributes.some((attr) => attr.group === "SCE Mechanical Ratings" && attr.name === "Thread Size" && attr.value === "1/4 inch NPT")).toBe(true);
  });

  it("keeps SCE assembly component materials when no single main material is published", () => {
    const html = `
      <html><head><title>SCE-FA66 - Saginaw Control and Engineering</title></head>
      <body>
        <h1>SCE-FA66</h1>
        <div class="prod-specs">
          <p class="prod-info-body"><strong>Part Number</strong>: SCE-FA66</p>
          <p class="prod-info-body"><strong>Description</strong>: Assembly, Fan Housing (6in.)</p>
          <p class="prod-info-body"><strong>CFM</strong>: 140</p>
          <p class="prod-info-body"><strong>Volt</strong>: 115</p>
        </div>
        <div class="prod-details-div">
          <p class="prod-info-header">Application</p>
          <p class="prod-info-body">Consists of a washable aluminum filter, steel air plenum, removable stainless steel grille, single phase fan, and approximately 14 inch of lead wire. Air plenum is ANSI-61 gray urethane polyester powder coated.</p>
        </div>
      </body></html>
    `;
    const result = parseSceProductPage("SCE-FA66", fetched(html, "https://www.saginawcontrol.com/partnumber_info/?n=SCE-FA66"));

    expect(result.normalized.material).toContain("aluminum filter");
    expect(result.normalized.material).toContain("steel air plenum");
    expect(result.normalized.material).toContain("stainless steel grille");
    expect(result.normalized.wallThickness).toBeUndefined();
    expect(result.attributes.some((attr) => attr.group === "SCE Mechanical Ratings" && attr.name === "Material Components")).toBe(true);
  });

  it("parses Balluff product specs and downloads", () => {
    const html = `
      <html><head>
        <title>BCC039H (BCC M415-M414-3A-304-PX0434-003) Double-ended cordsets - BALLUFF USA</title>
        <link rel="canonical" href="https://www.balluff.com/en-us/products/BCC039H" />
        <meta name="description" content="BCC039H (BCC M415-M414-3A-304-PX0434-003) - Double-ended cordsets - List price USA: 25.39 USD - Connection 1: M12x1-Female, straight, 5-pin, A-coded, Cable: PUR black, 0.3 m, Drag chain compatible, Operating voltage Ub: 250 VDC / 250 VAC, Rated current (40 °C): 4.0 A, IP rating: IP67, IP68, IP69K, Approval/Conformity: CE, cULus, WEEE - BALLUFF USA" />
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"Product","name":"BCC039H","sku":"BCC039H","alternateName":"BCC M415-M414-3A-304-PX0434-003","mpn":"BCC039H","image":"https://assets.balluff.com/webp_1000x1000/50644_01_P_01_bk_bk_bk.webp"}
        </script>
      </head><body>
        <h1>BCC039H</h1>
        <h2>Sensor cables unshielded</h2>
        <table>
          <tr><th>Operating voltage Ub</th><td>250 VDC / 250 VAC</td></tr>
          <tr><th>Rated current (40 °C)</th><td>4.0 A</td></tr>
          <tr><th>IP rating</th><td>IP67, IP68, IP69K</td></tr>
        </table>
        <a href="https://publications.balluff.com/pdfengine/pdf?type=pdb&id=296250&con=en">Datasheet</a>
        <div wire:snapshot="{&quot;data&quot;:{&quot;cadLink&quot;:&quot;https:\/\/balluff-login-embedded.partcommunity.com\/?catalog=balluff&amp;part=BCC M415-M414-3A-304-PX0434-003&quot;}}"></div>
      </body></html>
    `;
    const result = parseBalluffProductPage("BCC039H", fetched(html, "https://www.balluff.com/en-us/products/BCC039H"));
    expect(result.status).toBe("found");
    expect(result.normalized.voltage).toBe("250 V DC / 250 V AC");
    expect(result.normalized.current).toBe("4.0 A");
    expect(result.normalized.protection).toBe("IP67, IP68, IP69K");
    expect(result.normalized.material).toBe("PUR black");
    expect(result.normalized.certificates).toContain("CE; cULus; WEEE");
    expect(result.localizedUrls?.en).toBe("https://www.balluff.com/en-us/products/BCC039H");
    expect(result.localizedUrls?.de).toBe("https://www.balluff.com/de-de/products/BCC039H");
    expect(result.documents.some((doc) => doc.type === "datasheet")).toBe(true);
    expect(result.documents.some((doc) => doc.type === "cad" && doc.url.includes("BCC%20M415"))).toBe(true);
    expect(result.documents.some((doc) => doc.type === "image" && doc.url.includes("assets.balluff.com"))).toBe(true);
  });

  it("canonicalizes ugly Balluff configurator URLs", () => {
    const html = `
      <html><head>
        <link rel="canonical" href="https://www.balluff.com/de-de/products/BCC039P?pm=S-BCC+DE+SCU&pf=G1103&attrs[cal_pm_connection_sel_1][0]=18421822" />
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"Product","name":"BCC039P","sku":"BCC039P","mpn":"BCC039P"}
        </script>
      </head><body>
        <h1>BCC039P</h1>
        <div>Hauptmerkmale</div>
        <div>Anschluss 1</div><div>M12x1-Buchse, gerade, 5-polig, A-codiert</div>
        <div>Anschluss 2</div><div>M12x1-Stecker, gerade, 4-polig, A-codiert</div>
        <div>Kabel</div><div>PUR schwarz, 5 m, schleppkettentauglich</div>
        <div>Betriebsspannung Ub</div><div>250 VDC / 250 VAC</div>
        <div>Nennstrom (40 °C)</div><div>4.0 A</div>
        <div>Schutzart</div><div>IP67, IP68, IP69K</div>
        <div>Zulassung/Konformität</div><div>CE</div><div>cULus</div><div>WEEE</div>
        <div>Klassifizierungen</div>
        <div>ECLASS 14.0</div><div>27-06-03-11</div>
        <div>ETIM 9.0</div><div>EC001855</div>
        <div>UNSPSC 11</div><div>26121604</div>
      </body></html>
    `;
    const result = parseBalluffProductPage(
      "BCC039P",
      fetched(
        html,
        "https://www.balluff.com/de-de/products/BCC039P?pm=S-BCC+DE+SCU&pf=G1103&attrs[cal_pm_connection_sel_1][0]=18421822"
      )
    );

    expect(result.productUrl).toBe("https://www.balluff.com/de-de/products/BCC039P");
    expect(result.normalized.voltage).toBe("250 V DC / 250 V AC");
    expect(result.attributes.some((attr) => attr.name === "ECLASS 14.0" && attr.value === "27-06-03-11")).toBe(true);
  });

  it("accepts Balluff long order codes while keeping localized links on the short product code", () => {
    const html = `
      <html><head>
        <link rel="canonical" href="https://www.balluff.com/en-us/products/BOD0014" />
        <meta name="description" content="BOD0014 (BOD 66M-LB04-S92-C) - Photoelectric distance sensors - Operating voltage Ub: 18...30 VDC, Interface: Analog, current 4...20 mA - BALLUFF USA" />
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"Product","name":"BOD0014","sku":"BOD0014","mpn":"BOD0014","alternateName":"BOD 66M-LB04-S92-C"}
        </script>
      </head><body>
        <h1>BOD0014</h1>
        <section>
          <h2>Key features</h2>
          <div>Interface</div><div>Analog, current 4...20 mA</div>
          <div>Operating voltage Ub</div><div>18...30 VDC</div>
          <div>Dimension</div><div>30 x 100.5 x 73.2 mm</div>
          <div>Approval/Conformity</div><div>CE</div><div>WEEE</div>
        </section>
        <section>
          <h2>Classifications</h2>
          <div>ECLASS 14.0</div><div>27-27-09-04</div>
          <div>ETIM 9.0</div><div>EC001825</div>
          <div>UNSPSC 11</div><div>39121528</div>
        </section>
      </body></html>
    `;
    const result = parseBalluffProductPage("BOD 66M-LB04-S92-C", fetched(html, "https://www.balluff.com/en-us/products/BOD0014"));

    expect(result.status).toBe("found");
    expect(result.productUrl).toBe("https://www.balluff.com/en-us/products/BOD0014");
    expect(result.localizedUrls?.en).toBe("https://www.balluff.com/en-us/products/BOD0014");
    expect(result.localizedUrls?.de).toBe("https://www.balluff.com/de-de/products/BOD0014");
    expect(result.normalized.voltage).toBe("18...30 V DC");
    expect(result.normalized.current).toBe("4...20 mA");
  });

  it("prefers expanded Balluff detail sections over alternative-product comparison rows", () => {
    const html = `
      <html><head>
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"Product","name":"BCC039P","sku":"BCC039P","mpn":"BCC039P"}
        </script>
      </head><body>
        <h1>BCC039P</h1>
        <div>Hauptmerkmale</div><div>Downloads</div><div>Klassifizierungen</div>
        <section>
          <h2>Alternative Produkte</h2>
          <div>BCC039P BCC03A7 BCC0AP7</div>
          <div>Betriebsspannung Ub 250 VDC / 250 VAC 30 VDC 250 VDC / 250 VAC</div>
          <div>Schutzart IP67 IP67 IP67</div>
        </section>
        <section>
          <h2>Hauptmerkmale</h2>
          <div>Anschluss 1</div><div>M12x1-Buchse, gerade, 5-polig, A-codiert</div>
          <div>Anschluss 2</div><div>M12x1-Stecker, gerade, 4-polig, A-codiert</div>
          <div>Kabel</div><div>PUR schwarz, 5 m, schleppkettentauglich</div>
          <div>Anzahl der Leiter</div><div>4</div>
          <div>Betriebsspannung Ub</div><div>250 VDC / 250 VAC</div>
          <div>Nennstrom (40 °C)</div><div>4.0 A</div>
          <div>Schutzart</div><div>IP67, IP68, IP69K/IP67, IP68, IP69K</div>
          <div>Zulassung/Konformität</div><div>CE</div><div>cULus</div><div>WEEE</div>
        </section>
        <section>
          <h2>Klassifizierungen</h2>
          <div>ECLASS 14.0</div><div>27-06-03-11</div>
          <div>ETIM 9.0</div><div>EC001855</div>
          <div>UNSPSC 11</div><div>26121604</div>
        </section>
      </body></html>
    `;
    const result = parseBalluffProductPage("BCC039P", fetched(html, "https://www.balluff.com/de-de/products/BCC039P"));

    expect(result.normalized.voltage).toBe("250 V DC / 250 V AC");
    expect(result.normalized.voltage).not.toContain("30 VDC");
    expect(result.normalized.protection).toBe("IP67, IP68, IP69K/IP67, IP68, IP69K");
  });

  it("extracts Balluff lifecycle status and recommended replacement without losing negative ranges", () => {
    const html = `
      <html><head>
        <meta name="description" content="BSI000E - Measuring principle: MEMS, Measuring range: -45...45°, Operating voltage Ub: 12...30 VDC - BALLUFF USA" />
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"Product","name":"BSI000E","sku":"BSI000E","mpn":"BSI000E","offers":{"availability":"https://schema.org/OutOfStock"}}
        </script>
      </head><body>
        <div>Canceled</div>
        <a href="#recommended-alternative">Recommended alternative</a>
        <h1>BSI000E</h1>
        <div>Show all main features</div>
        <section id="recommended-alternative">
          <h2>Recommended alternative</h2>
          <a href="/en-us/products/BSI0013">BSI0013</a>
          <div>Inclination sensors with two measuring axes</div>
          <div>BSI Q41K0-XA-MYS045-S92</div>
          <div>Availability</div>
          <button>Retrieve data</button>
        </section>
        <section>
          <h2>Alternative products</h2>
          <div>Discontinued</div>
          <div>Recommended alternative</div>
          <div>BSI000E</div><div>BSI0013</div>
          <div>Measuring range</div><div>-45...45°</div><div>-45...45°</div>
        </section>
        <section>
          <h2>Key features</h2>
          <div>Measuring principle</div><div>MEMS</div>
          <div>Measuring axes</div><div>2</div>
          <div>Measuring range</div><div>-45...45°</div>
          <div>Operating voltage Ub</div><div>12...30 VDC</div>
          <div>Interface</div><div>2x Analog, voltage 0…10 V</div>
          <div>IP rating</div><div>IP67</div>
          <div>Approval/Conformity</div><div>CE</div><div>UKCA</div><div>WEEE</div>
        </section>
        <section>
          <h2>Classifications</h2>
          <div>ECLASS 14.0</div><div>27-27-11-01</div>
          <div>ETIM 9.0</div><div>EC001852</div>
          <div>UNSPSC 11</div><div>41111938</div>
        </section>
      </body></html>
    `;
    const result = parseBalluffProductPage("BSI000E", fetched(html, "https://www.balluff.com/en-us/products/BSI000E"));

    expect(result.attributes.some((attr) => attr.name === "Product status" && attr.value === "Canceled")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Recommended alternative" && attr.value.includes("BSI0013"))).toBe(true);
    expect(result.attributes.find((attr) => attr.name === "Recommended alternative")?.value).not.toContain("BSI000E");
    expect(result.attributes.some((attr) => attr.name === "Measuring range" && attr.value === "-45...45°")).toBe(true);
    expect(result.normalized.voltage).toBe("12...30 V DC");
  });

  it("keeps Balluff inline summary labels from contaminating neighboring specifications", () => {
    const html = `
      <html><head>
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"Product","name":"BML0001","sku":"BML0001","mpn":"BML0001"}
        </script>
      </head><body>
        <h1>BML0001</h1>
        <div class="grid grid-cols-2 md:grid-cols-3">
          <div class="hyphens-auto">Analog output</div>
          <div class="font-medium">Analog, sin/cos 1 Vpp, Read distance: 0.01...0.35 mm, Reference signal: Individually or fixed-periodic</div>
          <div class="hyphens-auto">IP rating</div>
          <div class="font-medium">IP67, Procedure direction: transverse to tape</div>
          <div class="hyphens-auto">Dimension</div>
          <div class="font-medium">10 x 30 x 54 mm, Fork opening: 10 mm</div>
          <div class="hyphens-auto">Approval/Conformity</div>
          <div class="font-medium">CE, UKCA, cULus, WEEE, Trademark: Global</div>
        </div>
        <section>
          <h2>Key features</h2>
          <div>Analog output</div><div>Analog, sin/cos 1 Vpp</div>
          <div>Read distance</div><div>0.01...0.35 mm</div>
          <div>Reference signal</div><div>Individually or fixed-periodic</div>
          <div>Limit frequency –3 dB</div><div>200 Hz</div>
          <div>IP rating</div><div>IP67</div>
          <div>Procedure direction</div><div>transverse to tape</div>
          <div>Dimension</div><div>10 x 30 x 54 mm</div>
          <div>Fork opening</div><div>10 mm</div>
          <div>Approval/Conformity</div><div>CE</div><div>UKCA</div><div>WEEE</div>
          <div>Trademark</div><div>Global</div>
        </section>
        <section>
          <h2>Classifications</h2>
          <div class="flex"><div class="w-1/3">BML0001 ; BML-S1F2-A62Z-M310-90-KA05; Linear encoder</div><div class="w-2/3">// Update its position popperInstance.update();</div></div>
          <div>ECLASS 14.0</div><div>27-27-43-04</div>
          <div>ETIM 9.0</div><div>EC002544</div>
          <div>UNSPSC 11</div><div>41111945</div>
        </section>
      </body></html>
    `;
    const result = parseBalluffProductPage("BML0001", fetched(html, "https://www.balluff.com/en-us/products/BML0001"));

    expect(result.attributes.some((attr) => attr.name === "Analog output" && attr.value === "Analog, sin/cos 1 Vpp")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Read distance" && attr.value === "0.01...0.35 mm")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Reference signal" && attr.value === "Individually or fixed-periodic")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Limit frequency -3 dB" && attr.value === "200 Hz")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "IP rating" && attr.value === "IP67")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Procedure direction" && attr.value === "transverse to tape")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Dimension" && attr.value === "10 x 30 x 54 mm")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Fork opening" && attr.value === "10 mm")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Trademark" && attr.value === "Global")).toBe(true);
    expect(result.attributes.some((attr) => /popperInstance/.test(`${attr.name} ${attr.value}`))).toBe(false);
  });

  it("extracts Balluff safety and limit-switch labels as separate specifications", () => {
    const html = `
      <html><head>
        <meta name="description" content="BID0013 - Performance Level: e (for locking function), Safety category (EN ISO 13849-1): 4, SIL (IEC 61508): 3, SIL CL (EN 62061): 3, Coding level (EN ISO 14119): high, Operating principle: non-contact (RFID), Utilization category: DC-12: 24 V/0.25 A, No of contacts: 2x positive opening - BALLUFF USA" />
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"Product","name":"BID0013","sku":"BID0013","mpn":"BID0013"}
        </script>
      </head><body>
        <h1>BID0013</h1>
        <section>
          <h2>Key features</h2>
          <div>Performance Level</div><div>e (for locking function); d (for retention function)</div>
          <div>Safety category (EN ISO 13849-1)</div><div>4 (for locking function); 2 (for retention function)</div>
          <div>SIL (IEC 61508)</div><div>3 (for locking function); 2 (for retention function)</div>
          <div>SIL CL (EN 62061)</div><div>3 (for locking function); 2 (for retention function)</div>
          <div>Coding level (EN ISO 14119)</div><div>high</div>
          <div>B10d (EN ISO 13849-1)</div><div>5 mil. switching operations</div>
          <div>Operating principle</div><div>non-contact (RFID)</div>
          <div>Utilization category</div><div>DC-12: 24 V/0.25 A; DC-13: 24 V/0.25 A</div>
          <div>No of contacts</div><div>2x positive opening</div>
          <div>Guard locking, principle</div><div>Quiescent current</div>
          <div>Holding force FZH</div><div>1000 N</div>
          <div>Axillary release</div><div>Triangular Key</div>
          <div>Escape release</div><div>yes</div>
          <div>Switch position spacing</div><div>12 mm</div>
          <div>Connection</div><div>Connector, M12x1, 8-pin</div>
          <div>IP rating</div><div>IP69, IP67, IP66</div>
          <div>Approval/Conformity</div><div>CE</div><div>cULus</div><div>TÜV</div><div>WEEE</div>
        </section>
        <section>
          <h2>Classifications</h2>
          <div>ECLASS 14.0</div><div>27-27-26-03</div>
          <div>ETIM 9.0</div><div>EC002593</div>
          <div>UNSPSC 11</div><div>39122205</div>
        </section>
      </body></html>
    `;
    const result = parseBalluffProductPage("BID0013", fetched(html, "https://www.balluff.com/en-us/products/BID0013"));

    expect(result.attributes.some((attr) => attr.name === "SIL CL (EN 62061)" && attr.value.includes("3"))).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Coding level (EN ISO 14119)" && attr.value === "high")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "B10d (EN ISO 13849-1)" && attr.value === "5 mil. switching operations")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "No of contacts" && attr.value === "2x positive opening")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Utilization category" && attr.value.includes("DC-12"))).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Guard locking, principle" && attr.value === "Quiescent current")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Holding force FZH" && attr.value === "1000 N")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Axillary release" && attr.value === "Triangular Key")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Escape release" && attr.value === "Yes")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Switch position spacing" && attr.value === "12 mm")).toBe(true);
    expect(result.attributes.find((attr) => attr.name === "Operating principle")?.value).not.toContain("No of contacts");
  });

  it("extracts Balluff SmartLight and machine-light labels plus EPREL documents", () => {
    const html = `
      <html><head>
        <meta name="description" content="BNI008A - SmartLight - Interface: IO-Link 1.1, Operating voltage Ub: 18...30.2 VDC, Segments, number max.: 3, Function indicator: Chaser, Level indicator, Stack light, Flexi-Mode, Volume max.: 95 dB, Setting: Function indicator, Volume, Additional function: Expanded process data, Light intensity: 746 lm, Color temperature: 4000 K, Illumination area: 332 x 14 mm - BALLUFF USA" />
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"Product","name":"BNI008A","sku":"BNI008A","mpn":"BNI008A"}
        </script>
      </head><body>
        <h1>BNI008A</h1>
        <section>
          <h2>Key features</h2>
          <div>Principle of operation</div><div>Indicator light with sound module</div>
          <div>Interface</div><div>IO-Link 1.1</div>
          <div>Operating voltage Ub</div><div>18...30.2 VDC</div>
          <div>Segments, number max.</div><div>3</div>
          <div>Predefined colors</div><div>Yellow</div><div>White</div><div>Green</div><div>Blue</div><div>Red</div><div>Orange</div><div>Configurable</div>
          <div>Function indicator</div><div>Chaser</div><div>Level indicator</div><div>Stack light</div><div>Flexi-Mode</div>
          <div>Volume max.</div><div>95 dB</div>
          <div>Setting</div><div>Function indicator</div><div>Volume</div>
          <div>Additional function</div><div>Expanded process data</div>
          <div>Light intensity</div><div>746 lm</div>
          <div>Color temperature</div><div>4000 K</div>
          <div>Illumination area</div><div>332 x 14 mm</div>
          <div>Beam angle</div><div>120 °</div>
          <div>IP rating</div><div>IP30</div>
          <div>Approval/Conformity</div><div>CE</div><div>WEEE</div>
        </section>
        <section>
          <h2>Classifications</h2>
          <div>ECLASS 14.0</div><div>27-11-03-50</div>
          <div>ETIM 9.0</div><div>EC000232</div>
          <div>UNSPSC 11</div><div>39100000</div>
        </section>
        <img src="https://eprel.ec.europa.eu/assets/images/label/thumbnails/F-Right-DarkOrange-WithAGScale.svg" alt="Efficiency class F" />
        <p href="https://eprel.ec.europa.eu/screen/product/lightsources/2018608"
          x-on:click="$dispatch('new-energy-label', {&quot;class&quot;:&quot;F&quot;,&quot;url&quot;:&quot;https:\/\/eprel.ec.europa.eu\/screen\/product\/lightsources\/2018608&quot;,&quot;icon_url&quot;:&quot;https:\/\/eprel.ec.europa.eu\/assets\/images\/label\/thumbnails\/F-Right-DarkOrange-WithAGScale.svg&quot;,&quot;image_url&quot;:&quot;https:\/\/eprel.ec.europa.eu\/labels\/lightsources\/Label_2018608_big_color.svg&quot;})">EPREL product data sheet</p>
      </body></html>
    `;
    const result = parseBalluffProductPage("BNI008A", fetched(html, "https://www.balluff.com/en-us/products/BNI008A"));

    expect(result.attributes.some((attr) => attr.name === "Segments, number max." && attr.value === "3")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Predefined colors" && attr.value.includes("Yellow"))).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Volume max." && attr.value === "95 dB")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Additional function" && attr.value === "Expanded process data")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Light intensity" && attr.value === "746 lm")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Color temperature" && attr.value === "4000 K")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Illumination area" && attr.value === "332 x 14 mm")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Beam angle" && attr.value === "120 °")).toBe(true);
    expect(result.attributes.find((attr) => attr.name === "Function indicator")?.value).not.toContain("Volume max.");
    expect(result.documents.some((doc) => doc.type === "other" && doc.label === "EPREL product data sheet" && doc.url.includes("2018608"))).toBe(true);
    expect(result.documents.some((doc) => doc.type === "image" && doc.label === "EPREL energy label" && doc.url.includes("Label_2018608"))).toBe(true);
    expect(result.documents.some((doc) => doc.type === "image" && doc.label === "EPREL efficiency label")).toBe(true);
  });

  it("extracts Balluff Livewire download snapshots", () => {
    const snapshot = JSON.stringify({
      data: {
        productVariant: "BCC039P",
        productLabel: "BCC M415-M414-3A-304-PX0434-050",
        datasheet: "https://publications.balluff.com/pdfengine/pdf?type=pdb&id=289976&con=de",
        weeePdfUrl: "https://publications.balluff.com/pdfengine/pdf?id=PV156662&type=weee&language=de",
        cadLink: "https://balluff-embedded.partcommunity.com/?catalog=balluff&part=BCC M415-M414-3A-304-PX0434-050"
      },
      memo: { name: "product::downloads" }
    }).replaceAll('"', "&quot;");
    const html = `
      <html><head>
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"Product","name":"BCC039P","sku":"BCC039P","mpn":"BCC039P"}
        </script>
      </head><body>
        <h1>BCC039P</h1>
        <div wire:snapshot="${snapshot}"></div>
      </body></html>
    `;
    const result = parseBalluffProductPage("BCC039P", fetched(html, "https://www.balluff.com/de-de/products/BCC039P"));

    expect(result.documents.some((doc) => doc.type === "datasheet" && doc.url.includes("type=pdb"))).toBe(true);
    expect(result.documents.some((doc) => doc.type === "certificate" && doc.url.includes("type=weee"))).toBe(true);
    expect(result.documents.some((doc) => doc.type === "cad" && doc.url.includes("part=BCC%20M415"))).toBe(true);
  });

  it("parses Balluff DOM feature grids with device-specific labels", () => {
    const html = `
      <html><head>
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"Product","name":"BOS025P","sku":"BOS025P","mpn":"BOS025P"}
        </script>
      </head><body>
        <h1>BOS025P</h1>
        <div class="grid grid-cols-2 md:grid-cols-3 gap-y-2 gap-x-1 text-14px leading-tightest">
          <div class="hyphens-auto">Series</div><div class="md:col-span-2 font-medium">18M</div>
          <div class="hyphens-auto">Dimension</div><div class="md:col-span-2 font-medium">Ø 18 x 75 mm</div>
          <div class="hyphens-auto">Interface</div><div class="md:col-span-2 font-medium">PNP normally open (NO)<br>PNP normally closed (NC)</div>
          <div class="hyphens-auto">Principle of operation</div><div class="md:col-span-2 font-medium">Photoelectric sensor</div>
        </div>
        <section>
          <h2>Key features</h2>
          <div class="grid grid-cols-1 sm:grid-cols-5 space-y-1 sm:space-y-0 py-3">
            <div class="col-span-2 pr-6.5 hyphens-auto">Principle of optical operation</div>
            <div class="col-span-3">Through-beam sensor (receiver)</div>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-5 space-y-1 sm:space-y-0 py-3">
            <div class="col-span-2 pr-6.5 hyphens-auto">Light type</div>
            <div class="col-span-3">Infrared</div>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-5 space-y-1 sm:space-y-0 py-3">
            <div class="col-span-2 pr-6.5 hyphens-auto">Scope of delivery</div>
            <div class="col-span-3">2x nut M18x1<br>User manual</div>
          </div>
        </section>
        <section>
          <h2>Classifications</h2>
          <div class="flex py-3"><div class="w-1/3">ECLASS 14.0</div><div class="w-2/3">27-27-09-01</div></div>
        </section>
      </body></html>
    `;
    const result = parseBalluffProductPage("BOS025P", fetched(html, "https://www.balluff.com/en-gb/products/BOS025P"));

    expect(result.attributes.some((attr) => attr.name === "Series" && attr.value === "18M")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Principle of operation" && attr.value === "Photoelectric sensor")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Principle of optical operation" && attr.value === "Through-beam sensor (receiver)")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Scope of delivery" && attr.value === "2x nut M18x1; User manual")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "ECLASS 14.0" && attr.value === "27-27-09-01")).toBe(true);
    expect(result.normalized.dimensions).toBe("Ø 18 x 75 mm");
  });

  it("parses Balluff generic meta specs without swallowing adjacent labels", () => {
    const html = `
      <html><head>
        <meta name="description" content="BNI0098 (BNI IOF-329-P02-Z038) - Profisafe over IO-Link - List price United Kingdom: 743.99 GBP - Performance Level: e, Safety category (EN ISO 13849-1): 4, SIL (IEC 61508): 3, Response time max.: 20 ms, Approval/Conformity: CE, UKCA, Safety, cULus, WEEE, Number of safe inputs: 12, Number of safe outputs: 2, Current sum US, sensor: 4.8 A, Dimension: 68 x 32.4 x 181.5 mm, IP rating: IP67 - BALLUFF United Kingdom" />
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"Product","name":"BNI0098","sku":"BNI0098","mpn":"BNI0098"}
        </script>
      </head><body><h1>BNI0098</h1></body></html>
    `;
    const result = parseBalluffProductPage("BNI0098", fetched(html, "https://www.balluff.com/en-gb/products/BNI0098"));

    expect(result.attributes.some((attr) => attr.name === "Performance Level" && attr.value === "e")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Safety category (EN ISO 13849-1)" && attr.value === "4")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "SIL (IEC 61508)" && attr.value === "3")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Response time max." && attr.value === "20 ms")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Approval/Conformity" && attr.value === "CE, UKCA, Safety, cULus, WEEE")).toBe(true);
    expect(result.attributes.find((attr) => attr.name === "Approval/Conformity")?.value).not.toContain("Number of safe inputs");
    expect(result.normalized.dimensions).toBe("68 x 32.4 x 181.5 mm");
    expect(result.normalized.current).toBe("4.8 A");
    expect(result.normalized.protection).toBe("IP67");
  });

  it("parses Balluff lens meta specs without treating focal length as product length", () => {
    const html = `
      <html><head>
        <meta name="description" content="FHW0069 (LM8HC-VIS-SW) - C-mount lenses - Ambient temperature: -10...50 °C, Focal length: 8 mm, Aperture: 1.8, Minimum object distance (MOD): 200 mm, Angle of view, horizontal: 81.3 °, Angle of view, vertical: 63.5 °, Max. Sensor size: 1&quot;, Image resolution: 12 MP, Mounting part: Threads, Lens mount: C-Mount, Dimension: Ø 58 x 79.5 mm, Material: Aluminum, black anodized, Weight: 235 g, Manufacturer: KOWA - BALLUFF United Kingdom" />
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"Product","name":"FHW0069","sku":"FHW0069","mpn":"FHW0069"}
        </script>
      </head><body><h1>FHW0069</h1></body></html>
    `;
    const result = parseBalluffProductPage("FHW0069", fetched(html, "https://www.balluff.com/en-gb/products/FHW0069"));

    expect(result.attributes.some((attr) => attr.name === "Focal length" && attr.value === "8 mm")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Aperture" && attr.value === "1.8")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Lens mount" && attr.value === "C-Mount")).toBe(true);
    expect(result.attributes.find((attr) => attr.name === "Ambient temperature")?.value).toBe("-10...50 °C");
    expect(result.normalized.dimensions).toBe("Ø 58 x 79.5 mm");
    expect(result.normalized.weight).toBe("235 g (0.24 kg)");
    expect(result.normalized.finish).toBe("black anodized");
    expect(result.normalized.color).toBe("black");
  });

  it("parses Balluff capacitive and vision labels without folding them into previous values", () => {
    const html = `
      <html><head>
        <meta name="description" content="BCS01CY (BCS R08RRE-PICFHC-BP00,3-GS04) - Capacitive level sensors - Sensitivity: teachable depending on media, Function: Smart Level 50, Additional features: Electrically conductive media, Foam and residue compensation, Image resolution: 1280 x 1024 pixels, Sensor type Vision: CMOS 1/1.8 color global shutter, Total current max.: 8 A, Connection type: Screw terminal - BALLUFF United Kingdom" />
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"Product","name":"BCS01CY","sku":"BCS01CY","mpn":"BCS01CY"}
        </script>
      </head><body>
        <h1>BCS01CY</h1>
        <section>
          <h2>Key features</h2>
          <div>Sensitivity</div><div>teachable depending on media</div>
          <div>Function</div><div>Smart Level 50</div>
          <div>Additional features</div><div>Electrically conductive media<br>Foam and residue compensation</div>
          <div>Image resolution</div><div>1280 x 1024 pixels</div>
          <div>Sensor type Vision</div><div>CMOS 1/1.8 color global shutter</div>
          <div>Total current max.</div><div>8 A</div>
          <div>Connection type</div><div>Screw terminal</div>
        </section>
      </body></html>
    `;
    const result = parseBalluffProductPage("BCS01CY", fetched(html, "https://www.balluff.com/en-gb/products/BCS01CY"));

    expect(result.attributes.some((attr) => attr.name === "Sensitivity" && attr.value === "teachable depending on media")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Function" && attr.value === "Smart Level 50")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Additional features" && attr.value === "Electrically conductive media, Foam and residue compensation")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Image resolution" && attr.value === "1280 x 1024 pixels")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Sensor type Vision" && attr.value === "CMOS 1/1.8 color global shutter")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Total current max." && attr.value === "8 A")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Connection type" && attr.value === "Screw terminal")).toBe(true);
    expect(result.attributes.find((attr) => attr.name === "Sensitivity")?.value).not.toContain("Function");
  });

  it("parses Balluff condition monitoring labels and video links", () => {
    const html = `
      <html><head>
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"Product","name":"BCM0002","sku":"BCM0002","mpn":"BCM0002"}
        </script>
      </head><body>
        <h1>BCM0002</h1>
        <section>
          <h2>Key features</h2>
          <div>Function</div><div>Vibration analysis in time domain<br>Contact temperature monitoring</div>
          <div>Vibration, frequency range</div><div>2...1800 Hz<br>2...2500 Hz</div>
          <div>Vibration, number of measuring axes</div><div>3</div>
          <div>Vibration, measuring range</div><div>-16...16 g</div>
          <div>Contact temperature, measuring range</div><div>-25...+70 °C</div>
          <div>Relative humidity, measuring range</div><div>5...95 %RH</div>
          <div>Ambient pressure, measuring range</div><div>300...1100 hPa</div>
          <div>Rated operating voltage Ue DC</div><div>24 V</div>
        </section>
        <div>
          <img src="https://img.youtube.com/vi_webp/NdntbY6WxJU/sddefault.webp" alt="Condition Monitoring im Fokus - Montage" />
          <button x-on:click.prevent="$dispatch('open-video-preview', {'src': 'https://www.youtube.com/embed/NdntbY6WxJU'})">Play</button>
        </div>
      </body></html>
    `;
    const result = parseBalluffProductPage("BCM0002", fetched(html, "https://www.balluff.com/en-gb/products/BCM0002"));

    expect(result.attributes.some((attr) => attr.name === "Vibration, frequency range" && attr.value === "2...1800 Hz; 2...2500 Hz")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Relative humidity, measuring range" && attr.value === "5...95 %RH")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Ambient pressure, measuring range" && attr.value === "300...1100 hPa")).toBe(true);
    expect(result.normalized.voltage).toBe("24 V");
    expect(result.documents.some((doc) => doc.type === "other" && doc.label.includes("Condition Monitoring") && doc.url.includes("youtube.com/embed/NdntbY6WxJU"))).toBe(true);
  });

  it("renders Balluff accordion sections and merges lazy-loaded passport and knowledge data", async () => {
    const staticHtml = `
      <html><head>
        <link rel="canonical" href="https://www.balluff.com/en-gb/products/BCC039H" />
        <meta name="description" content="BCC039H - Double-ended cordsets - Cable: PUR black, 0.3 m, Operating voltage Ub: 250 VDC / 250 VAC, Rated current (40 °C): 4.0 A, IP rating: IP67, Approval/Conformity: CE, cULus, WEEE" />
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"Product","name":"BCC039H","sku":"BCC039H","mpn":"BCC039H"}
        </script>
      </head><body>
        <h1>BCC039H</h1>
        <h2>Key features</h2>
        <div>Connection 1</div><div>M12x1-Female, straight, 5-pin, A-coded</div>
        <div>Cable</div><div>PUR black, 0.3 m</div>
        <h2>Downloads</h2>
        <a href="https://publications.balluff.com/pdfengine/pdf?type=pdb&id=289970&con=en">Datasheet</a>
        <h2>Classifications</h2>
        <div>ECLASS 14.0</div><div>27-44-01-02</div>
        <div>ETIM 9.0</div><div>EC001855</div>
        <div>UNSPSC 11</div><div>39121413</div>
        <h2>Digital Product Passport</h2>
        <h2>Knowledge Base articles</h2>
      </body></html>
    `;
    const expandedHtml = `
      <html><head>
        <link rel="canonical" href="https://www.balluff.com/en-gb/products/BCC039H" />
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"Product","name":"BCC039H","sku":"BCC039H","mpn":"BCC039H"}
        </script>
      </head><body>
        <h1>BCC039H</h1>
        <section><h2>Digital Product Passport</h2>
          <div class="grid"><div class="col-span-2">Battery regulation</div><div class="col-span-3">Not applicable</div></div>
        </section>
        <section><h2>Knowledge Base articles</h2>
          <a href="/en-gb/knowledge-base/articles/how-to-connect-BCC039H">How to connect BCC039H</a>
        </section>
      </body></html>
    `;
    const livewireSnapshot = {
      memo: { name: "product::digital-product-pass" },
      data: {
        productVariant: "BCC039H",
        data: {
          manufacturer: "Balluff",
          countryOfOrigin: "Hungary",
          productCarbonFootprint: "1.2 kg CO2e"
        }
      }
    };
    const networkText = JSON.stringify({
      components: [
        {
          snapshot: JSON.stringify(livewireSnapshot),
          effects: {
            html: `<div>Digital Product Passport</div><dl><dt>Battery regulation</dt><dd>Not applicable</dd></dl>`
          }
        }
      ]
    });
    let renderCalls = 0;
    const connector = new BalluffConnector();
    const context = {
      manufacturer: {
        id: "balluff",
        canonicalName: "Balluff",
        shortName: "BAL",
        rateLimitMs: 0,
        officialBaseUrls: ["https://www.balluff.com/en-gb/products"],
        fallbackSources: [],
        fetchPolicy: { minContentLength: 0 },
        localizedUrlTemplates: [
          { locale: "en", urlTemplate: "https://www.balluff.com/en-gb/products/{part}" },
          { locale: "de", urlTemplate: "https://www.balluff.com/de-de/products/{part}" }
        ]
      },
      http: {
        fetchText: async (url: string) => fetched(staticHtml, url),
        fetchTextViaPowerShell: async (url: string) => fetched(staticHtml, url)
      },
      runDir: "",
      documentsDir: "",
      browserRenderer: {
        renderProductPage: async (url: string) => {
          renderCalls += 1;
          return {
            fetched: fetched(expandedHtml, url),
            networkTexts: [fetched(networkText, "https://www.balluff.com/livewire/message/product::digital-product-pass", "application/json")],
            networkDiagnostics: [
              {
                url: "https://www.balluff.com/livewire/message/product::digital-product-pass",
                statusCode: 200,
                contentType: "application/json",
                category: "product-api"
              }
            ]
          };
        }
      },
      learnedEndpoints: { list: () => [], upsert: () => undefined },
      downloadDocument: async (doc: unknown) => doc,
      fallback: { scrape: async () => undefined }
    } as unknown as ScrapeContext;

    const result = await connector.scrape("BCC039H", context);

    expect(renderCalls).toBe(1);
    expect(result.attributes.some((attr) => attr.group === "Digital Product Passport" && attr.name === "Manufacturer" && attr.value === "Balluff")).toBe(true);
    expect(result.attributes.some((attr) => attr.group === "Digital Product Passport" && attr.name === "Country Of Origin" && attr.value === "Hungary")).toBe(true);
    expect(result.attributes.some((attr) => attr.group === "Digital Product Passport" && attr.name === "Battery regulation" && attr.value === "Not applicable")).toBe(true);
    expect(result.documents.some((doc) => doc.type === "other" && doc.label === "How to connect BCC039H")).toBe(true);
    expect(result.documents.some((doc) => doc.type === "datasheet")).toBe(true);
    expect(result.normalized.certificates).toContain("CE");
  });

  it("rejects Balluff HTTP error pages even when the URL contains the catalog number", () => {
    const html = `
      <html><head><title>BCS00A0 Balluff</title></head><body>
        <h1>We could not find BCS00A0</h1>
        <div>Key features</div><div>Downloads</div><div>Classifications</div>
      </body></html>
    `;
    const result = parseBalluffProductPage("BCS00A0", { ...fetched(html, "https://www.balluff.com/en-gb/products/BCS00A0"), statusCode: 404 });

    expect(result.status).toBe("failed");
    expect(result.attributes).toHaveLength(0);
    expect(result.error).toContain("HTTP 404");
  });

  it("parses generic embedded product data and skips unrelated policy PDFs", () => {
    const html = `
      <html><head>
        <title>1SDA126387R1 - Distributor</title>
        <meta name="description" content="ABB padlock accessory" />
        <script type="application/ld+json">
          {"@context":"http://schema.org/","@type":"Product","name":"ACB ACCS PADLOCK DEVICE IN OPEN POSITION LEFT 4MMD FOR E2.3,E4.3,E6.3 ABB"}
        </script>
        <script>
          window.products = [{"Description":"ACB ACCS PADLOCK DEVICE","ProductCode":"1SDA126387R1"}];
        </script>
      </head><body>
        <h1>ACB ACCS PADLOCK DEVICE</h1>
        <a href="/Documents/Pdf/TermsConditions.pdf">Trading Terms & Conditions</a>
      </body></html>
    `;
    const result = parseGenericProductPage(
      "abb",
      "1SDA126387R1",
      fetched(html, "https://www.ipd.com.au/ProductDisplay.aspx?Product=1SDA126387R1"),
      "distributor",
      "IPD distributor product page"
    );
    expect(result.status).toBe("partial");
    expect(result.documents).toHaveLength(0);
    expect(result.attributes.some((attr) => attr.name === "ProductCode" && attr.value === "1SDA126387R1")).toBe(true);
  });

  it("parses generic product images from structured data, meta tags, and product image elements", () => {
    const html = `
      <html><head>
        <title>ABC-123 - Eaton</title>
        <meta property="og:image" content="/assets/ABC-123-og.webp" />
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"Product","sku":"ABC-123","name":"ABC-123 breaker","image":["https://assets.example.com/ABC-123-main.jpg"]}
        </script>
      </head><body>
        <h1>ABC-123 breaker</h1>
        <img class="product-gallery-image" src="/media/ABC-123-side.png" alt="ABC-123 side view" />
        <table>
          <tr><th>Material</th><td>Steel</td></tr>
          <tr><th>Weight</th><td>1.2 kg</td></tr>
        </table>
      </body></html>
    `;
    const result = parseGenericProductPage(
      "eaton",
      "ABC-123",
      fetched(html, "https://www.eaton.com/us/en-us/skuPage.ABC-123.html"),
      "official-fallback",
      "Eaton SKU page"
    );

    expect(result.status).toBe("partial");
    expect(result.normalized.weight).toBe("1.2 kg");
    expect(result.normalized.material).toBe("Steel");
    expect(result.localizedUrls?.de).toBe("https://www.eaton.com/de/de-de/skuPage.ABC-123.html");
    expect(result.documents.filter((doc) => doc.type === "image").map((doc) => doc.url)).toEqual([
      "https://assets.example.com/ABC-123-main.jpg",
      "https://www.eaton.com/assets/ABC-123-og.webp",
      "https://www.eaton.com/media/ABC-123-side.png"
    ]);
  });

  it("parses generic Next-style embedded state and document URLs", () => {
    const html = `
      <html><head>
        <script id="__NEXT_DATA__" type="application/json">
          {
            "props": {
              "pageProps": {
                "product": {
                  "sku": "ABC-123",
                  "name": "ABC-123 enclosure",
                  "attributes": [
                    {"label": "Material", "value": "Steel"},
                    {"label": "Product Weight", "value": "1.2 kg"}
                  ],
                  "downloads": [
                    {"title": "ABC-123 datasheet", "url": "/downloads/ABC-123-datasheet.pdf"}
                  ]
                }
              }
            }
          }
        </script>
      </head><body><h1>ABC-123</h1></body></html>
    `;
    const result = parseGenericProductPage(
      "eaton",
      "ABC-123",
      fetched(html, "https://example.test/products/ABC-123"),
      "official-fallback",
      "fixture"
    );

    expect(result.attributes.some((attr) => attr.group === "Next Data" && attr.name === "Material" && attr.value === "Steel")).toBe(true);
    expect(result.normalized.weight).toBe("1.2 kg");
    expect(result.documents.some((doc) => doc.type === "datasheet" && doc.url === "https://example.test/downloads/ABC-123-datasheet.pdf")).toBe(true);
  });

  it("parses generic escaped Next flight product properties and extensionless product images", () => {
    const html = `
      <html><head>
        <meta property="og:image" content="https://products.schmersal.com/api/og?type=product&slug=abc&locale=en-US" />
        <script>
          self.__next_f.push([1,"{\\"translatedName\\":\\"Electrical data\\",\\"properties\\":[{\\"groupName\\":\\"Rated operating voltage\\",\\"values\\":[\\"24\\"],\\"unit\\":\\"VDC\\"},{\\"groupName\\":\\"Operating current\\",\\"values\\":[\\"800\\"],\\"unit\\":\\"mA\\"},{\\"groupName\\":\\"Certificates\\",\\"values\\":[\\"UKCA\\",\\"cULus\\"],\\"unit\\":null}]}"]);
        </script>
      </head><body><h1>AZM300B-ST-1P2P-A</h1></body></html>
    `;
    const result = parseGenericProductPage(
      "schmersal",
      "AZM300B-ST-1P2P-A",
      fetched(html, "https://products.schmersal.com/en_US/azm300b-st-1p2p-a-103001423"),
      "official-fallback",
      "fixture"
    );

    expect(result.normalized.voltage).toBe("24 V DC");
    expect(result.normalized.current).toBe("800 mA");
    expect(result.normalized.certificates).toContain("UKCA");
    expect(result.normalized.certificates).toContain("cULus");
    expect(result.documents.some((doc) => doc.type === "image" && doc.url.includes("/api/og?type=product"))).toBe(true);
  });

  it("classifies product download links with generic PDF file parameters as datasheets", () => {
    const html = `
      <html><body>
        <h1>TK PS 2518-11-m</h1>
        <a title="Download PDF" href="/industrial-housing/with-/-without-metric-knock-outs.download?file=10590801.pdf&uri=%2Fp%2F10590801.pdf">PDF</a>
      </body></html>
    `;
    const result = parseGenericProductPage(
      "spelsberg",
      "TK PS 2518-11-m",
      fetched(html, "https://www.spelsberg.com/industrial-housing/with-/-without-metric-knock-outs/10590801/"),
      "official-fallback",
      "fixture"
    );

    expect(result.documents.some((doc) => doc.type === "datasheet" && doc.url.includes("10590801.pdf"))).toBe(true);
  });

  it("does not treat image dimensions metadata as product dimensions or images", () => {
    const html = `
      <html><head>
        <title>BPZ:VSG519K15-5</title>
        <meta property="og:image" content="/products/BPZ-VSG519K15-5.webp" />
        <meta property="og:image:width" content="300" />
        <meta property="og:image:height" content="300" />
      </head><body>
        <h1>BPZ:VSG519K15-5</h1>
        <p>SKU: BPZ:VSG519K15-5</p>
      </body></html>
    `;
    const result = parseGenericProductPage(
      "siemens",
      "BPZ:VSG519K15-5",
      fetched(html, "https://example.test/product"),
      "distributor",
      "test"
    );

    expect(result.documents.filter((doc) => doc.type === "image").map((doc) => doc.url)).toEqual([
      "https://example.test/products/BPZ-VSG519K15-5.webp"
    ]);
    expect(result.normalized.dimensions).toBeUndefined();
  });

  it("skips generic favicon, menu, and footer illustration images", () => {
    const html = `
      <html><head>
        <title>1SDA126387R1 - Product</title>
        <meta property="og:image" content="/cropped-ABB-favicon-270x270.png" />
      </head><body>
        <h1>1SDA126387R1</h1>
        <img src="/mobile_menu.svg" alt="menu" />
        <img src="/assets/illustration-footer.svg" alt="footer" />
        <img class="product-gallery-image" src="/images/1SDA126387R1-product.png" alt="1SDA126387R1" />
      </body></html>
    `;
    const result = parseGenericProductPage("abb", "1SDA126387R1", fetched(html, "https://example.test/product"), "distributor", "test");

    expect(result.documents.filter((doc) => doc.type === "image").map((doc) => doc.url)).toEqual([
      "https://example.test/images/1SDA126387R1-product.png"
    ]);
  });

  it("parses nVent data-row-data specs without Drupal settings noise or related accessory images", () => {
    const rowData = JSON.stringify([
      { value: "16084", label: "Article Number" },
      { value: "12in", label: "Height", measuresys: "imperial", attributeId: "height_imperial" },
      { value: "12in", label: "Width", measuresys: "imperial", attributeId: "width_imperial" },
      { value: "6in", label: "Depth", measuresys: "imperial", attributeId: "depth_imperial" },
      { value: "Mild Steel", label: "Material", attributeId: "material" },
      { value: "12lb", label: "Weight", measuresys: "imperial", attributeId: "weight_imperial" }
    ]).replaceAll('"', "&quot;");
    const html = `
      <html><head>
        <meta property="og:image" content="/share/A12126T1PP.webp" />
        <script type="application/json" data-drupal-selector="drupal-settings-json">
          {"dataLayer":{"languages":{"neutral":{"weight":-10},"en":{"weight":-9}}}}
        </script>
      </head><body>
        <h1>Hinged-Cover with Perforated Panel Type 1, 12.00x12.00x6.00, Gray, Steel</h1>
        <div>Catalog#: A12126T1PP</div>
        <h2>Industry Standards</h2>
        <div>UL 50, 50E Listed; Type 1; File No. E27567</div>
        <div>NEMA/EEMAC Type 1 IEC 60529, IP30</div>
        <img src="/images/main-product.png" alt="T1LockPerfPanelEnclPair Product Photo" />
        <section>
          <h3>Features</h3>
          <div><ul>
            <li>Door has key lock quarter-turn latch; two keys included</li>
            <li>Includes removable, 16-gauge, ANSI 61 gray, perforated panel</li>
          </ul></div>
        </section>
        <section><h3>Bulletin Number</h3><div>A1PP</div></section>
        <div data-row-data="${rowData}"></div>
        <section>
          <h2>Related Accessories</h2>
          <img src="/images/accessory.png" alt="Hol-Sealers Non-Metallic Hole Seals; Photo Render; ASPB05075NM" />
        </section>
      </body></html>
    `;
    const result = parseGenericProductPage(
      "nvent",
      "A12126T1PP",
      fetched(html, "https://www.nvent.com/en-us/hoffman/products/enca12126t1pp"),
      "official-fallback",
      "nVent fixture"
    );

    expect(result.normalized.weight).toBe("12lb (5.44 kg)");
    expect(result.normalized.dimensions).toBe("12 x 12 x 6 in (304.8 x 304.8 x 152.4 mm)");
    expect(result.normalized.material).toBe("Mild Steel");
    expect(result.normalized.protection).toContain("IP30");
    expect(result.attributes.some((attr) => attr.group === "Identity" && attr.name === "Catalog Number" && attr.value === "A12126T1PP")).toBe(true);
    expect(result.attributes.some((attr) => attr.group === "Features" && attr.name === "Feature" && attr.value.includes("quarter-turn latch"))).toBe(true);
    expect(result.attributes.some((attr) => attr.group === "Industry Standards" && attr.value.includes("UL 50"))).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Bulletin Number" && attr.value === "A1PP")).toBe(true);
    expect(result.attributes.some((attr) => attr.value === "-10")).toBe(false);
    expect(result.attributes.some((attr) => /^<noscript|^<title/i.test(attr.name))).toBe(false);
    expect(result.attributes.some((attr) => /^"description"$/i.test(attr.name))).toBe(false);
    expect(result.documents.filter((doc) => doc.type === "image").map((doc) => doc.url)).toEqual([
      "https://www.nvent.com/share/A12126T1PP.webp",
      "https://www.nvent.com/images/main-product.png"
    ]);
  });

  it("keeps nVent hero images when the same URL appears in meta and DOM", () => {
    const html = `
      <html><head>
        <meta property="og:image" content="/sites/default/files/styles/product_and_sku_image_582x334_no_crop/public/dam/u3esjx4y5p/dah4002b_electricheater_m_sq.png.webp?itok=VHT_YPJ6" />
      </head><body>
        <h1>Electric Heater, 115VAC 400W, 7.50x4.25x4.38 inch, Brushed, Aluminum</h1>
        <div>Catalog#: DAH4001B</div>
        <div class="product-hero__main-box">
          <div class="product-hero__image product-hero__zoom">
            <img class="img" src="/sites/default/files/styles/product_and_sku_image_582x334_no_crop/public/dam/u3esjx4y5p/dah4002b_electricheater_m_sq.png.webp?itok=VHT_YPJ6" alt="Dah4002B Electric Heaters D85 26074" />
          </div>
        </div>
      </body></html>
    `;
    const result = parseGenericProductPage(
      "nvent",
      "DAH4001B",
      fetched(html, "https://www.nvent.com/en-us/hoffman/products/encdah4001b"),
      "official-fallback",
      "nVent hero image fixture"
    );

    expect(result.documents.filter((doc) => doc.type === "image").map((doc) => doc.url)).toEqual([
      "https://www.nvent.com/sites/default/files/styles/product_and_sku_image_582x334_no_crop/public/dam/u3esjx4y5p/dah4002b_electricheater_m_sq.png.webp?itok=VHT_YPJ6"
    ]);
  });

  it("keeps nVent product gallery images with generic alt text", () => {
    const html = `
      <html><body>
        <h1>Busbar With FASTON Connections</h1>
        <div>Catalog#: 69001-073</div>
        <div class="product-gallery__main">
          <div class="carousel__main-wrapper">
            <img class="img" src="/sites/default/files/styles/product_and_sku_image_582x334_no_crop/public/dam/gyl30p4k6n/00097008_0.png.webp?itok=mFJL_vtY" alt="busbar" title="busbar" />
          </div>
        </div>
      </body></html>
    `;
    const result = parseGenericProductPage(
      "nvent",
      "69001-073",
      fetched(html, "https://www.nvent.com/en-us/schroff/products/enc69001-073"),
      "official-fallback",
      "nVent gallery image fixture"
    );

    expect(result.documents.some((doc) => doc.type === "image" && doc.url.includes("00097008_0.png.webp"))).toBe(true);
  });

  it("derives nVent fallback specs from title and description when structured rows are absent", () => {
    const html = `
      <html><head>
        <meta name="description" content="Electric enclosure heater with aluminum housing and brushed finish." />
      </head><body>
        <h1>Electric Heater, 115VAC 400W, 7.50x4.25x4.38 inch, Brushed, Aluminum</h1>
        <div>Catalog#: DAH4001B</div>
      </body></html>
    `;
    const result = parseGenericProductPage(
      "nvent",
      "DAH4001B",
      fetched(html, "https://www.nvent.com/en-us/hoffman/products/encdah4001b"),
      "official-fallback",
      "nVent title fallback fixture"
    );

    expect(result.normalized.voltage).toBe("115 V AC");
    expect(result.normalized.dimensions).toBe("7.50 x 4.25 x 4.38 inch (190.5 x 107.95 x 111.25 mm)");
    expect(result.normalized.material).toBe("Aluminum");
    expect(result.normalized.finish).toBe("Brushed");
    expect(result.attributes.some((attr) => attr.group === "Title/Description Inference" && attr.name === "Power" && attr.value === "400W")).toBe(true);
  });

  it("captures nVent certification, declaration, and compliance sections as product attributes", () => {
    const html = `
      <html><body>
        <h1>Self-Regulating Heating Cable</h1>
        <div>Catalog#: 10BTV1-CR</div>
        <h2>Certifications</h2>
        <div>UL 2269</div>
        <div>CSA C22.2 No. 18.2</div>
        <h2>Declarations</h2>
        <div>nVent RoHS Declaration</div>
        <h2>Compliance</h2>
        <div>REACH; WEEE</div>
      </body></html>
    `;
    const result = parseGenericProductPage(
      "nvent",
      "10BTV1-CR",
      fetched(html, "https://www.chemelex.com/en-us/raychem/products/btv-self-regulating-heating-cable"),
      "official-fallback",
      "nVent compliance fixture"
    );

    expect(result.attributes.some((attr) => attr.group === "Certifications" && attr.name === "Certification" && attr.value === "UL 2269")).toBe(true);
    expect(result.attributes.some((attr) => attr.group === "Declarations" && attr.name === "Declaration" && attr.value === "nVent RoHS Declaration")).toBe(true);
    expect(result.attributes.some((attr) => attr.group === "Compliance" && attr.name === "Compliance" && attr.value === "REACH; WEEE")).toBe(true);
    expect(result.normalized.certificates).toContain("UL");
    expect(result.normalized.certificates).toContain("CSA");
    expect(result.normalized.certificates).toContain("RoHS");
    expect(result.normalized.certificates).toContain("REACH");
    expect(result.normalized.certificates).toContain("WEEE");
  });

  it("parses the matching row from nVent product family data-row-data tables", () => {
    const rowData = JSON.stringify([
      {
        sku: "<a href='/en-us/hoffman/products/encdah4001b'>DAH4001B</a>",
        height_imperial: "7.5in",
        width_imperial: "4.25in",
        depth_imperial: "4.38in",
        nominal_voltage: "115V",
        max_current: "3.72A",
        material: "Aluminum",
        finish: "Brushed",
        weight_imperial: "2.5lb"
      },
      {
        sku: "<a href='/en-us/hoffman/products/encdah8001b'>DAH8001B</a>",
        nominal_voltage: "230V",
        max_current: "9.9A",
        weight_imperial: "9.9lb"
      }
    ]).replaceAll('"', "&quot;");
    const html = `
      <html><body>
        <h1>Electric Heaters, DAH</h1>
        <div data-row-data="${rowData}"></div>
      </body></html>
    `;
    const result = parseGenericProductPage(
      "nvent",
      "DAH4001B",
      fetched(html, "https://www.nvent.com/en-us/hoffman/products/electric-heaters-dah-0"),
      "official-fallback",
      "nVent family fixture"
    );

    expect(result.normalized.dimensions).toBe("7.5 x 4.25 x 4.38 in (190.5 x 107.95 x 111.25 mm)");
    expect(result.normalized.voltage).toBe("115 V");
    expect(result.normalized.current).toBe("3.72 A");
    expect(result.normalized.weight).toBe("2.5lb (1.13 kg)");
    expect(result.attributes.some((attr) => attr.value === "230V")).toBe(false);
  });

  it("parses nVent CADDY data-row measurements with measure-system units", () => {
    const rowData = JSON.stringify([
      { value: "Steel", label: "Material", measuresys: null, attributeId: "material" },
      { value: "Pregalvanized;Powder Coated", label: "Finish", measuresys: null, attributeId: "finish" },
      { value: "Black", label: "Color", measuresys: null, attributeId: "color" },
      { value: "2", label: "Height (H)", measuresys: "imperial", attributeId: "height_imperial_range" },
      { value: "50", label: "Height (H)", measuresys: "metric", attributeId: "height_metric_range" },
      { value: "12", label: "Width (W)", measuresys: "imperial", attributeId: "width_imperial_range" },
      { value: "300", label: "Width (W)", measuresys: "metric", attributeId: "width_metric_range" },
      { value: "118", label: "Length (L)", measuresys: "imperial", attributeId: "length_imperial" },
      { value: "3", label: "Length (L)", measuresys: "metric", attributeId: "length_metric" },
      { value: "14 lb", label: "Unit Weight", measuresys: "imperial", attributeId: "unit_weight_imperial" },
      { label: "EAN", value: "0784805130765" }
    ]).replaceAll('"', "&quot;");
    const html = `
      <html><body>
        <h1>Wire Basket Tray Shaped Wire 2"X12"X118", Black, Pregalvanized</h1>
        <div>Catalog#: WBT2X12SBA</div>
        <div data-row-data="${rowData}"></div>
        <p>nVent CADDY Adjustable Depth Multi-Gang Masonry Open Back Box</p>
      </body></html>
    `;
    const result = parseGenericProductPage(
      "nvent",
      "WBT2X12SBA",
      fetched(html, "https://www.nvent.com/en-us/caddy/products/efswbt2x12sba"),
      "official-fallback",
      "nVent CADDY fixture"
    );

    expect(result.normalized.dimensions).toBe("2 x 12 x 118 in (50.8 x 304.8 x 2997.2 mm)");
    expect(result.normalized.weight).toBe("14 lb (6.35 kg)");
    expect(result.normalized.material).toBe("Steel");
    expect(result.normalized.finish).toBe("Pregalvanized;Powder Coated");
    expect(result.normalized.color).toBe("Black");
    expect(result.attributes.some((attr) => attr.name === "Length (L)" && attr.value === "118in")).toBe(true);
  });

  it("uses nVent resource row context to keep catalog and declaration documents", () => {
    const html = `
      <html><body>
        <h1>Busbar With FASTON Connections</h1>
        <div>Catalog#: 69001-073</div>
        <div data-row-data="${JSON.stringify([{ value: "Busbar", label: "Product Type" }]).replaceAll('"', "&quot;")}"></div>
        <section class="resources">
          <div class="resource"><h3>Catalog</h3><span>Connector 2.91 MB English</span><a href="/sites/default/files/dam/zitr7zavwy/zitr7zavwy.pdf"><svg></svg></a></div>
          <div class="resource"><h3>Declarations</h3><span>nVent RoHS SCHROFF 125.04 KB English</span><a href="/sites/default/files/dam/yuk9ejwiwl/nvent-rohs-declaration-_schroff.pdf"><svg></svg></a></div>
        </section>
      </body></html>
    `;
    const result = parseGenericProductPage(
      "nvent",
      "69001-073",
      fetched(html, "https://www.nvent.com/en-us/schroff/products/enc69001-073"),
      "official-fallback",
      "nVent SCHROFF fixture"
    );

    expect(result.documents.some((doc) => doc.type === "datasheet" && doc.label.includes("Connector 2.91 MB English"))).toBe(true);
    expect(result.documents.some((doc) => doc.type === "certificate" && doc.label.includes("nVent RoHS SCHROFF"))).toBe(true);
  });

  it("parses nVent RAYCHEM/Chemelex embedded variant and resource tables", () => {
    const html = `
      <html><body>
        <h1>BTV Self-Regulating Heating Cable</h1>
        <div id="cxproductstyle_specifications_section">
          <h3 class="cxproductstyle-section-header">Specifications</h3>
          <div class="cxproductstyle-specs-container">
            <div class="cxproductstyle-spec-item"><span class="cxproductstyle-spec-label">Area Classification:</span> Non-Hazardous; Hazardous</div>
            <div class="cxproductstyle-spec-item"><span class="cxproductstyle-spec-label">Ground Path Type:</span> Braid</div>
            <div class="cxproductstyle-spec-item"><span class="cxproductstyle-spec-label">Max Intermittent Exposure Temperature, Power On/Off:</span> 185 F</div>
          </div>
        </div>
        <table><tr><th>Header 1</th><th>Header 2</th><th>Header 3</th></tr></table>
        <script>
          window.__CHEMELEX_PRODUCT__ = {
            "productItemsTableDataMetric": [
              ["Catalog Number","Item Name","Nominal Power Output @ 10°C, 120V","Supply Voltage","Outer Jacket Material"],
              ["002349-000","10BTV1-CR","33 W/m","100 - 130 V","Modified Polyolefin"],
              ["498639-000","10BTV2-CR","33 W/m","200 - 277 V","Modified Polyolefin"]
            ],
            "productItemsTableDataImperial": [
              ["Catalog Number","Item Name","Nominal Power Output @ 50°F, 120V","Supply Voltage","Outer Jacket Material"],
              ["002349-000","10BTV1-CR","10 W/ft","100 - 130 V","Modified Polyolefin"]
            ],
            "resourcesTableData": [
              [{"columnName":"Document Category"},{"columnName":"Document Type"},{"columnName":"Document Name"},{"columnName":"Document Size"},{"columnName":"Document Language"},{"columnName":"Document URL"}],
              ["Data Sheet","PDF","English (Americas) Datasheet BTV","705.37 KB","English","https://cdn.chemelex.com/Product%20Documents/Data%20Sheets/RAYCHEM-DS-BTV-EN.pdf"],
              ["Certification","PDF","CSA 1233495 BTV","172.16 KB","English","https://cdn.chemelex.com/Product%20Documents/Certifications/CSA-1233495-BTV.pdf"],
              ["Installation Instructions","PDF","Industrial Heat-Tracing Installation and Maintenance Manual","1.3 MB","English","https://cdn.chemelex.com/Product%20Documents/Installation%20Manuals/RAYCHEM-IM-H57374-EN.pdf"]
            ]
          };
        </script>
      </body></html>
    `;
    const result = parseGenericProductPage(
      "nvent",
      "10BTV1-CR",
      fetched(html, "https://www.chemelex.com/en-us/raychem/products/btv-self-regulating-heating-cable-0"),
      "official-fallback",
      "nVent RAYCHEM fixture"
    );

    expect(result.normalized.voltage).toBe("100...130 V");
    expect(result.normalized.material).toBe("Modified Polyolefin");
    expect(result.attributes.some((attr) => attr.name === "Catalog Number" && attr.value === "002349-000")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Item Name" && attr.value === "10BTV1-CR")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Nominal Power Output @ 10°C, 120V" && attr.value === "33 W/m")).toBe(true);
    expect(result.attributes.some((attr) => attr.value === "200 - 277 V")).toBe(false);
    expect(result.attributes.some((attr) => attr.name === "Area Classification" && attr.value === "Non-Hazardous; Hazardous")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Ground Path Type" && attr.value === "Braid")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Header 1")).toBe(false);
    expect(result.documents.some((doc) => doc.type === "datasheet" && doc.label.includes("Datasheet BTV"))).toBe(true);
    expect(result.documents.some((doc) => doc.type === "certificate" && doc.label.includes("CSA 1233495"))).toBe(true);
    expect(result.documents.some((doc) => doc.type === "manual" && doc.label.includes("Installation and Maintenance Manual"))).toBe(true);
  });

  it("rejects blocked official pages before marker extraction can produce false specs", () => {
    const html = `<html><head><title>Just a moment...</title></head><body><style>body{height:100vh;width:100%;color:#313131}</style></body></html>`;
    const result = parseGenericProductPage(
      "nvent",
      "DAHHL4001A",
      { ...fetched(html, "https://www.nvent.com/en-us/hoffman/products/encdahhl4001a"), statusCode: 403 },
      "official-fallback",
      "nVent blocked fixture"
    );

    expect(result.status).toBe("failed");
    expect(result.attributes).toHaveLength(0);
    expect(result.normalized.weight).toBeUndefined();
  });

  it("parses Eaton markdown product pages from the public reader fallback", () => {
    const markdown = `
Title: 5250C81G17 | Eaton motor control contact kit | Eaton
URL Source: http://www.eaton.com/us/en-us/skuPage.5250C81G17.html
![Image 11: 5250C81G17 - sku page](https://www.eaton.com/mdmfiles/PDM39110324/ES-ICD-MC-RENEWAL_FM/500x500_72dpi)
# 5250C81G17
Motor Control Renewal Parts- Contact Kit, A201, Model K, Three-pole
**Product Name**Eaton motor control contact kit
**Catalog Number**5250C81G17
**Product Length/Depth**2.6 in
**Product Height**2.5 in
**Product Width**2.6 in
**Product Weight**0.25 lb
**Certifications**Not Applicable
**Type**Renewal Parts/Accessories
* [Eaton Specification Sheet - 5250C81G17](https://www.eaton.com/us/en-us/skuPage.5250C81G17.pdf)
    `;
    const result = parseEatonProductPage(
      "5250C81G17",
      fetched(markdown, "https://r.jina.ai/http://www.eaton.com/us/en-us/skuPage.5250C81G17.html"),
      "https://www.eaton.com/us/en-us/skuPage.5250C81G17.html"
    );

    expect(result.status).toBe("found");
    expect(result.productUrl).toBe("https://www.eaton.com/us/en-us/skuPage.5250C81G17.html");
    expect(result.normalized.weight).toBe("0.25 lb (0.11 kg)");
    expect(result.normalized.dimensions).toBe("2.5 x 2.6 x 2.6 in (63.5 x 66.04 x 66.04 mm)");
    expect(result.documents.find((doc) => doc.type === "image")?.url).toBe(
      "https://dynamicmedia.eaton.com/is/image/eaton/ES-ICD-MC-RENEWAL_FM?wid=500&hei=500"
    );
    expect(result.documents.some((doc) => doc.type === "image")).toBe(true);
    expect(result.documents.some((doc) => doc.type === "datasheet")).toBe(true);
  });

  it("rejects Eaton soft-404 SKU pages so discovery can continue", () => {
    const html = `
      <html>
        <head>
          <title>404 | Eaton</title>
          <meta name="description" content="The page you requested could not be found." />
        </head>
        <body>
          <h1>404 error</h1>
          <p>The page you requested could not be found. DILM9-10</p>
        </body>
      </html>
    `;
    const result = parseEatonProductPage(
      "DILM9-10",
      fetched(html, "https://www.eaton.com/us/en-us/skuPage.DILM9-10.html"),
      "https://www.eaton.com/us/en-us/skuPage.DILM9-10.html"
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("not-found");

    const readerResult = parseEatonProductPage(
      "DILM9-10",
      fetched("Title: Errore 404\nURL Source: https://www.eaton.com/it/it-it/skuPage.DILM9-10.html\n\n# Errore 404\nDILM9-10", "https://r.jina.ai/http://https://www.eaton.com/it/it-it/skuPage.DILM9-10.html"),
      "https://www.eaton.com/de/de-de/skuPage.DILM9-10.html"
    );

    expect(readerResult.status).toBe("failed");
    expect(readerResult.error).toContain("not-found");
  });

  it("parses Eaton reader label-value lines without merging adjacent fields", () => {
    const markdown = `
Title: 5S1500G | Eaton 5S UPS | Eaton
# 5S1500G
Eaton 5S UPS, 1500 VA, 900 W, C14 input, Outputs: (8) C13
## General specifications
Product Name
Eaton 5S UPS
Catalog Number
5S1500G
Product Length/Depth
15 in
Product Height
9.8 in
Product Width
3.4 in
Product Weight
24.6 lb
Certifications
UL 497A
NOM-019-SCFI
UL 1778
Product Type
UPS
## Electrical output
Battery type
Sealed, lead-acid
Receptacle
(8) C13
VA rating
1500 VA
Wattage
900 W
Output nominal voltage
230V
## Electrical input
Input connection
C14
Input nominal voltage
230V
Nominal frequency
50/60 Hz
* [Eaton Specification Sheet - 5S1500G](https://www.eaton.com/us/en-us/skuPage.5S1500G.pdf)
* [Eaton extended warranty certificate](https://www.eaton.com/content/dam/eaton/support/warranty/eaton-extended-warranty-certificate.pdf)
    `;
    const result = parseEatonProductPage(
      "5S1500G",
      fetched(markdown, "https://r.jina.ai/http://www.eaton.com/us/en-us/skuPage.5S1500G.html"),
      "https://www.eaton.com/us/en-us/skuPage.5S1500G.html"
    );

    expect(result.status).toBe("found");
    expect(result.normalized.weight).toBe("24.6 lb (11.16 kg)");
    expect(result.normalized.dimensions).toBe("9.8 x 3.4 x 15 in (248.92 x 86.36 x 381 mm)");
    expect(result.normalized.voltage).toBe("230 V");
    expect(result.attributes.find((attr) => attr.name === "Product Name")?.value).toBe("Eaton 5S UPS");
    expect(result.attributes.find((attr) => attr.name === "Catalog Number")?.value).toBe("5S1500G");
    expect(result.attributes.some((attr) => attr.name === "VA rating" && attr.value === "1500 VA")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Input connection" && attr.value === "C14")).toBe(true);
    expect(result.documents.some((doc) => doc.type === "datasheet")).toBe(true);
    expect(result.documents.some((doc) => doc.type === "other" && /warranty/i.test(doc.label))).toBe(true);
  });

  it("parses Eaton reader fields for contactors and residential breakers", () => {
    const markdown = `
Title: 276705 | Eaton Moeller series DILM contactor | Eaton
# 276705
Model code: DILM9-10(24VDC)
Eaton Moeller series DILM Contactor, 3 pole, 380 V 400 V 4 kW, 1 N/O, 24 V DC, DC operation, Screw terminals DILM9-10(24VDC)
## General specifications
Product Name
Eaton Moeller series DILM contactor
Catalog Number
276705
Model Code
DILM9-10(24VDC)
Product Length/Depth
75 mm
Product Height
68 mm
Product Width
45 mm
Product Weight
0.24 kg
Product Type
Contactor
## Product specifications
Amperage Rating
9A
HP rating - max
0.5, 1.5/ 3, 3, 5, 7.5 (1/3PH @120,240/208,240,480,575 V)
Frame size
45 mm
Coil
24 V DC
Coil voltage
24 V DC
Contact configuration
1 NO
Continuous ampere rating
9 A
Operation
Non-reversing
## Installation
Terminals
Screw terminals
* [Eaton Specification Sheet - 276705](https://www.eaton.com/us/en-us/skuPage.276705.pdf)
    `;
    const result = parseEatonProductPage(
      "DILM9-10",
      fetched(markdown, "https://r.jina.ai/http://www.eaton.com/us/en-us/skuPage.276705.html"),
      "https://www.eaton.com/us/en-us/skuPage.276705.html"
    );

    expect(result.status).toBe("found");
    expect(result.attributes.some((attr) => attr.name === "Coil" && attr.value === "24 V DC")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "HP rating - max" && attr.value.includes("1/3PH"))).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Contact configuration" && attr.value === "1 NO")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Operation" && attr.value === "Non-reversing")).toBe(true);
    expect(result.normalized.dimensions).toBe("68 x 45 x 75 mm");
    expect(result.normalized.current).toBe("9 A");
    expect(result.documents.some((doc) => doc.type === "datasheet")).toBe(true);
  });

  it("parses Eaton breaker and safety switch distribution fields", () => {
    const markdown = `
Title: DG221URB | Eaton general duty non-fusible safety switch | Eaton
# DG221URB
Eaton General duty non-fusible safety switch, single-throw, 30 A, 240 V, NEMA 3R, Rainproof, Painted galvanized steel, Two-pole, Two-wire
## General specifications
Product Name
Eaton general duty non-fusible safety switch
Catalog Number
DG221URB
Product Length/Depth
6.88 in
Product Height
10.81 in
Product Width
6.38 in
Product Weight
6 lb
Product Type
Non-fusible safety switch
## Physical Attributes
Enclosure
NEMA 3R
Enclosure material
Painted galvanized steel
Fuse configuration
Non-fusible
Number of poles
Two-pole
Number of wires
2
Type
Non-fusible, single-throw
## Performance Ratings
Amperage Rating
30A
Voltage rating
240V
## Miscellaneous
Product Category
General duty safety switch
* [Eaton Specification Sheet - DG221URB](https://www.eaton.com/us/en-us/skuPage.DG221URB.pdf)
    `;
    const result = parseEatonProductPage(
      "DG221URB",
      fetched(markdown, "https://r.jina.ai/http://www.eaton.com/us/en-us/skuPage.DG221URB.html"),
      "https://www.eaton.com/us/en-us/skuPage.DG221URB.html"
    );

    expect(result.status).toBe("found");
    expect(result.normalized.current).toBe("30 A");
    expect(result.normalized.voltage).toBe("240 V");
    expect(result.normalized.protection).toBe("NEMA 3R");
    expect(result.normalized.material).toBe("Painted galvanized steel");
    expect(result.attributes.some((attr) => attr.name === "Fuse configuration" && attr.value === "Non-fusible")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Number of wires" && attr.value === "2")).toBe(true);
  });

  it("parses Eaton M22 operator fields and environmental ratings", () => {
    const markdown = `
Title: M22-PV-K12 | Eaton M22 modular pushbutton | Eaton
# M22-PV-K12
Eaton M22 modular pushbutton, M22 Push-Pull Emergency stop, Complete Device, 22.5 mm, Knob, Maintained, Non-illuminated, Bezel: Silver, Button: Red, 1NO-2NC, IP67, IP69K, NEMA 4X, 13
## General specifications
Product Name
Eaton M22 modular pushbutton
Catalog Number
M22-PV-K12
UPC
786685271767
Product Length/Depth
1.5 in
Product Height
2.5 in
Product Width
6 in
Product Weight
0.15 lb
Product Type
Modular pushbutton
## Product specifications
Type
Emergency Stop
Bezel
Silver
Actuator function
Maintained
Button color
Red
Actuator
Knob, push-pull
Contact configuration
1 NO-2 NC
Illumination
Non-illuminated
Series
M22
Environmental rating
IP67, IP69K, NEMA 4X, NEMA 13
Size
22.5 mm
* [Eaton Specification Sheet - M22-PV-K12](https://www.eaton.com/us/en-us/skuPage.M22-PV-K12.pdf)
    `;
    const result = parseEatonProductPage(
      "M22-PV-K12",
      fetched(markdown, "https://r.jina.ai/http://www.eaton.com/us/en-us/skuPage.M22-PV-K12.html"),
      "https://www.eaton.com/us/en-us/skuPage.M22-PV-K12.html"
    );

    expect(result.status).toBe("found");
    expect(result.normalized.protection).toBe("IP67, IP69K, NEMA 4X, NEMA 13");
    expect(result.attributes.some((attr) => attr.name === "Button color" && attr.value === "Red")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Contact configuration" && attr.value === "1 NO-2 NC")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Actuator function" && attr.value === "Maintained")).toBe(true);
  });

  it("builds Eaton SKU candidates across common Eaton locales", () => {
    const urls = buildEatonProductUrlCandidates("P1-25/I2/SVB", [
      { locale: "en", urlTemplate: "https://www.eaton.com/us/en-us/skuPage.{partSlashBraces}.html" },
      { locale: "de", urlTemplate: "https://www.eaton.com/de/de-de/skuPage.{partSlashBraces}.html" }
    ]);

    expect(urls[0]).toBe("https://www.eaton.com/us/en-us/skuPage.P1-25%7B%7DI2%7B%7DSVB.html");
    expect(urls).toContain("https://www.eaton.com/de/de-de/skuPage.P1-25%7B%7DI2%7B%7DSVB.html");
    expect(urls).toContain("https://www.eaton.com/gb/en-gb/skuPage.P1-25%7B%7DI2%7B%7DSVB.html");
    expect(urls).toContain("https://www.eaton.com/no/no-no/skuPage.P1-25%7B%7DI2%7B%7DSVB.html");
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("builds Eaton official site-search API candidates with encoded catalog input", () => {
    const urls = buildEatonSearchApiUrlCandidates("P1-25/I2/SVB", [
      "https://www.eaton.com/content/eaton/us/en-us/site-search/jcr:content/root/responsivegrid/search_results.searchTerm${part}.SortBy$relevance.Facets$.startDate$.endDate$.loadMore$.json"
    ]);

    expect(urls[0]).toContain("search_results.searchTerm$P1-25%2FI2%2FSVB.SortBy$relevance");
    expect(urls).toContain(
      "https://www.eaton.com/content/eaton/no/no-no/site-search/jcr:content/root/responsivegrid/search_results.searchTerm$P1-25%2FI2%2FSVB.SortBy$relevance.Facets$.startDate$.endDate$.loadMore$.json"
    );
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("extracts SKU pages from Eaton site-search JSON", () => {
    const searchJson = JSON.stringify({
      siteSearchResults: [
        {
          title: "M22-PV-K12",
          description: "Eaton M22 modular pushbutton, emergency stop, 1NO-2NC",
          contentType: "sku",
          completeUrl: "https://www.eaton.com/us/en-us/skuPage.M22-PV-K12.specifications.html",
          secondaryLinkList: [
            { text: "Specifications", url: "https://www.eaton.com/us/en-us/skuPage.M22-PV-K12.html#tab-1" }
          ]
        },
        {
          title: "Catalog PDF",
          contentType: "resource",
          completeUrl: "https://www.eaton.com/content/dam/eaton/catalog.pdf"
        }
      ]
    });

    const candidates = extractEatonSearchCandidates(
      searchJson,
      "https://www.eaton.com/content/eaton/us/en-us/site-search/jcr:content/root/responsivegrid/search_results.json",
      "M22-PV-K12"
    );

    expect(candidates[0]?.url).toBe("https://www.eaton.com/us/en-us/skuPage.M22-PV-K12.html");
    expect(candidates[0]?.score).toBeGreaterThanOrEqual(90);
    expect(candidates.some((candidate) => candidate.url.endsWith(".pdf"))).toBe(false);
  });

  it("prefers exact Eaton model-code variants from site-search JSON", () => {
    const searchJson = JSON.stringify({
      siteSearchResults: [
        {
          title: "276704",
          description: "Eaton Moeller series DILM Contactor, Model code: DILM9-10(12VDC)",
          contentType: "sku",
          completeUrl: "https://www.eaton.com/us/en-us/skuPage.276704.html"
        },
        {
          title: "276705",
          description: "Eaton Moeller series DILM Contactor, Model code: DILM9-10(24VDC)",
          contentType: "sku",
          completeUrl: "https://www.eaton.com/us/en-us/skuPage.276705.html"
        }
      ]
    });

    const candidates = extractEatonSearchCandidates(
      searchJson,
      "https://www.eaton.com/content/eaton/us/en-us/site-search/jcr:content/root/responsivegrid/search_results.json",
      "DILM9-10(24VDC)"
    );

    expect(candidates[0]?.url).toBe("https://www.eaton.com/us/en-us/skuPage.276705.html");
    expect(candidates[0]?.score).toBeGreaterThan(candidates[1]?.score ?? 0);
  });

  it("uses Eaton site-search discovery when the input is a model code instead of the SKU page number", async () => {
    const searchUrl = buildEatonSearchApiUrlCandidates("DILM9-10")[0];
    const requestedUrls: string[] = [];
    const connector = new EatonConnector();
    const searchJson = JSON.stringify({
      siteSearchResults: [
        {
          title: "276704",
          description: "Eaton Moeller series DILM Contactor, 3 pole, 380 V 400 V 4 kW, 1 N/O, 12 V DC, DC operation, Screw terminals",
          contentType: "sku",
          url: "/content/eaton/us/en-us/skuPage.276704",
          completeUrl: "https://www.eaton.com/us/en-us/skuPage.276704.html",
          secondaryLinkList: [
            { text: "Specifications", url: "https://www.eaton.com/us/en-us/skuPage.276704.html#tab-1" }
          ]
        }
      ]
    });
    const html = `
      <html><head>
        <title>276704 | Eaton Moeller series DILM contactor | Eaton</title>
        <meta name="description" content="Eaton Moeller series DILM contactor DILM9-10(12VDC)" />
      </head><body>
        <h1>276704</h1>
        <p>Model code: DILM9-10(12VDC)</p>
        <div class="product-specification-item">
          <h2 class="product-specification-item__title">General specifications</h2>
          <table>
            <tr class="specification-row"><td class="specification-title"><strong>Product Name</strong></td><td class="specification-value">Eaton Moeller series DILM contactor</td></tr>
            <tr class="specification-row"><td class="specification-title"><strong>Catalog Number</strong></td><td class="specification-value">276704</td></tr>
            <tr class="specification-row"><td class="specification-title"><strong>Model Code</strong></td><td class="specification-value">DILM9-10(12VDC)</td></tr>
            <tr class="specification-row"><td class="specification-title"><strong>Product Length/Depth</strong></td><td class="specification-value">75 mm</td></tr>
            <tr class="specification-row"><td class="specification-title"><strong>Product Height</strong></td><td class="specification-value">68 mm</td></tr>
            <tr class="specification-row"><td class="specification-title"><strong>Product Width</strong></td><td class="specification-value">45 mm</td></tr>
            <tr class="specification-row"><td class="specification-title"><strong>Product Weight</strong></td><td class="specification-value">0.24 kg</td></tr>
            <tr class="specification-row"><td class="specification-title"><strong>Product Type</strong></td><td class="specification-value">Contactor</td></tr>
          </table>
        </div>
        <div class="product-specification-item">
          <h2 class="product-specification-item__title">Product specifications</h2>
          <table>
            <tr class="specification-row"><td class="specification-title"><strong>Amperage Rating</strong></td><td class="specification-value">9 A</td></tr>
            <tr class="specification-row"><td class="specification-title"><strong>Coil voltage</strong></td><td class="specification-value">12 V DC</td></tr>
            <tr class="specification-row"><td class="specification-title"><strong>Terminals</strong></td><td class="specification-value">Screw terminals</td></tr>
          </table>
        </div>
        <a href="https://www.eaton.com/us/en-us/skuPage.276704.pdf">Eaton Specification Sheet - 276704</a>
      </body></html>
    `;
    const soft404Html = `
      <html><head><title>404 error | Eaton</title></head>
      <body><h1>404 error</h1><p>The page you requested could not be found. DILM9-10</p></body></html>
    `;
    const context = {
      manufacturer: {
        id: "eaton",
        canonicalName: "Eaton",
        shortName: "EAT",
        rateLimitMs: 0,
        officialBaseUrls: ["https://www.eaton.com"],
        localizedUrlTemplates: [],
        fallbackSources: [],
        scrapeRecipe: { searchUrlTemplates: [searchUrl] }
      },
      http: {
        fetchText: async (url: string) => {
          requestedUrls.push(url);
          if (url === searchUrl) return fetched(searchJson, url);
          if (url === "https://www.eaton.com/us/en-us/skuPage.276704.html") return fetched(html, url);
          if (/skuPage\.DILM9-10\.html/i.test(url)) return fetched(soft404Html, url);
          throw new Error(`Unexpected URL ${url}`);
        }
      },
      runDir: "",
      documentsDir: "",
      downloadDocument: async (doc: Parameters<ScrapeContext["downloadDocument"]>[0]) => doc,
      fallback: {
        scrape: async () => undefined
      }
    } as unknown as ScrapeContext;

    const result = await connector.scrape("DILM9-10", context);

    expect(result.status).toBe("found");
    expect(result.productUrl).toBe("https://www.eaton.com/us/en-us/skuPage.276704.html");
    expect(result.attributes.some((attr) => attr.name === "Model Code" && attr.value === "DILM9-10(12VDC)")).toBe(true);
    expect(result.normalized.dimensions).toBe("68 x 45 x 75 mm");
    expect(result.documents.some((doc) => doc.type === "datasheet")).toBe(true);
    expect(result.diagnostics?.attemptedUrls).toContain(searchUrl);
    expect(result.diagnostics?.discoveredCandidates?.some((candidate) => candidate.url === "https://www.eaton.com/us/en-us/skuPage.276704.html")).toBe(true);
    expect(result.localizedUrls?.en).toBe("https://www.eaton.com/us/en-us/skuPage.276704.html");
    expect(result.localizedUrls?.de).toBe("https://www.eaton.com/de/de-de/skuPage.276704.html");
    expect(requestedUrls).toContain("https://www.eaton.com/us/en-us/skuPage.276704.html");
  });

  it("parses localized Eaton reader fields that are not in the fixed label list", () => {
    const markdown = `
Title: 197517 | Eaton Moeller® series EASY I/O expansion | Eaton
# 197517
Modellkode: EASY-E4-DC-4PE1P
Eaton Moeller® series EASY I/O expansion for easyE4 with temperature detection Pt100, Pt1000 or Ni1000, 24 VDC, analog inputs: 4, push-in
## General specifications
Product Name
Eaton Moeller® series EASY I/O expansion
Catalog Number
197517
EAN
4015081940950
Product Length/Depth
58 mm
Product Height
90 mm
Product Width
36 mm
Product Weight
0.1 kg
Certifications
UL Listed
CE
Model Code
EASY-E4-DC-4PE1P
## Miljøforhold
Ambient operating temperature - max
55 °C
Relative humidity
5 - 95 % (IEC 60068-2-30, IEC 60068-2-78)
## Kommunikasjon
Connection type
Push in terminals
## Elektrisk klassifisering
Power consumption
1 W
Rated operational voltage
20.4 - 28.8 V DC
24 V DC (-15 %/+ 20 % - power supply)
Supply voltage at DC - max
28.8 VDC
Supply voltage at DC - min
20.4 VDC
## Generell informasjon
Degree of protection
IP20
Protocol
MODBUS
Software
EASYSOFT-SWLIC/easySoft
Used with
easyE4
## Inn-/utgang
Input
Input type resistance sensor: Platinum sensor Pt100
Input current
40 mA
Number of inputs (analog)
4
Number of outputs (digital)
0
## Terminalkapasitet
Terminal capacity
0.2 - 2.5 mm² (22 - 12 AWG), flexible with ferrule
## Declarations of conformity
* [eaton-i-o-expansion-declaration-of-conformity-eu251486en.pdf](https://www.eaton.com/content/dam/eaton/products/industrialcontrols-drives-automation-sensors/easy-relays/eaton-i-o-expansion-declaration-of-conformity-eu251486en.pdf)
## eCAD model
* [DA-CE-ETN.EASY-E4-DC-4PE1P](https://www.eaton.com/content/dam/eaton/products/industrialcontrols-drives-automation-sensors/easy-relays/DA-CE-ETN.EASY-E4-DC-4PE1P)
    `;
    const result = parseEatonProductPage(
      "197517",
      fetched(markdown, "https://r.jina.ai/http://www.eaton.com/no/no-no/skuPage.197517.html"),
      "https://www.eaton.com/no/no-no/skuPage.197517.html"
    );

    expect(result.status).toBe("found");
    expect(result.normalized.dimensions).toBe("90 x 36 x 58 mm");
    expect(result.normalized.weight).toBe("0.1 kg");
    expect(result.normalized.voltage).toContain("20.4...28.8 V DC");
    expect(result.normalized.current).toBe("40 mA");
    expect(result.normalized.protection).toBe("IP20");
    expect(result.attributes.some((attr) => attr.name === "Supply voltage at DC - max" && attr.value === "28.8 VDC")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Number of inputs (analog)" && attr.value === "4")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Terminal capacity" && attr.value.includes("0.2 - 2.5 mm²"))).toBe(true);
    expect(result.documents.some((doc) => doc.type === "certificate" && doc.label.includes("declaration-of-conformity"))).toBe(true);
    expect(result.documents.some((doc) => doc.type === "cad" && doc.label.includes("DA-CE-ETN"))).toBe(true);
  });

  it("parses Eaton direct HTML specification sections and resources", () => {
    const html = `
      <html><head>
        <title>PDG23M0060TFFJ | Eaton Power Defense molded case circuit breaker | Eaton</title>
        <meta name="description" content="PDG23M0060TFFJ - Eaton Power Defense molded case circuit breaker, Frame 2, Three Pole, 60A, 65kA/480V" />
        <meta property="og:title" content="PDG23M0060TFFJ | Eaton Power Defense molded case circuit breaker | Eaton" />
      </head><body>
        <h1 class="module-product-detail-card-v2__title">PDG23M0060TFFJ</h1>
        <img src="https://www.eaton.com/mdmfiles/PDM60890391/PDG23P0225TFFN_BK/90x90_96dpi" alt="PDG23M0060TFFJ - Power Defense molded case circuit breaker" />
        <div class="product-specification-item">
          <h2 class="product-specification-item__title">General specifications</h2>
          <table>
            <tr class="specification-row"><td class="specification-title"><strong>Product Name</strong></td><td class="specification-value">Eaton Power Defense molded case circuit breaker</td></tr>
            <tr class="specification-row"><td class="specification-title"><strong>Catalog Number</strong></td><td class="specification-value">PDG23M0060TFFJ</td></tr>
            <tr class="specification-row"><td class="specification-title"><strong>Product Length/Depth</strong></td><td class="specification-value">88.9 mm</td></tr>
            <tr class="specification-row"><td class="specification-title"><strong>Product Height</strong></td><td class="specification-value">152.4 mm</td></tr>
            <tr class="specification-row"><td class="specification-title"><strong>Product Width</strong></td><td class="specification-value">104.6 mm</td></tr>
            <tr class="specification-row"><td class="specification-title"><strong>Product Weight</strong></td><td class="specification-value">1.82 kg</td></tr>
            <tr class="specification-row"><td class="specification-title"><strong>Certifications</strong></td><td class="specification-value">CCC Marked<br>IEC 60947-2<br>UL 489<br>CSA</td></tr>
            <tr class="specification-row"><td class="specification-title"><strong>Product Type</strong></td><td class="specification-value">Molded case circuit breaker</td></tr>
          </table>
        </div>
        <div class="product-specification-item">
          <h2 class="product-specification-item__title">Delivery program</h2>
          <table>
            <tr class="specification-row"><td class="specification-title"><strong>Amperage Rating</strong></td><td class="specification-value">60 A</td></tr>
            <tr class="specification-row"><td class="specification-title"><strong>Number of poles</strong></td><td class="specification-value">Three-pole</td></tr>
          </table>
        </div>
        <div class="product-specification-item">
          <h2 class="product-specification-item__title">Technical data - Electrical</h2>
          <table>
            <tr class="specification-row"><td class="specification-title"><strong>Voltage rating</strong></td><td class="specification-value">600 Vac</td></tr>
          </table>
        </div>
        <a href="https://www.eaton.com/us/en-us/skuPage.PDG23M0060TFFJ.pdf">Eaton Specification Sheet - PDG23M0060TFFJ</a>
        <a href="https://www.eaton.com/content/dam/eaton/products/electrical-circuit-protection/molded-case-circuit-breakers/pdg23m0060tffj-3d.stp">3D drawing</a>
      </body></html>
    `;
    const result = parseEatonProductPage(
      "PDG23M0060TFFJ",
      fetched(html, "https://www.eaton.com/us/en-us/skuPage.PDG23M0060TFFJ.html"),
      "https://www.eaton.com/us/en-us/skuPage.PDG23M0060TFFJ.html"
    );

    expect(result.status).toBe("found");
    expect(result.normalized.weight).toBe("1.82 kg");
    expect(result.normalized.dimensions).toBe("152.4 x 104.6 x 88.9 mm");
    expect(result.normalized.voltage).toBe("600 V AC");
    expect(result.normalized.current).toBe("60 A");
    expect(result.attributes.some((attr) => attr.group === "Delivery program" && attr.name === "Amperage Rating")).toBe(true);
    expect(result.attributes.find((attr) => attr.name === "Certifications")?.value).toContain("UL 489");
    expect(result.documents.some((doc) => doc.type === "image" && doc.url.includes("dynamicmedia.eaton.com/is/image/eaton/PDG23P0225TFFN_BK"))).toBe(true);
    expect(result.documents.some((doc) => doc.type === "datasheet")).toBe(true);
    expect(result.documents.some((doc) => doc.type === "cad")).toBe(true);
  });

  it("keeps Eaton related-product images separate while exporting related products", () => {
    const html = `
      <html><head>
        <title>002242 | Eaton xEffect Ci Enclosures Switch- & Controlgear Enclosure | Eaton</title>
      </head><body>
        <h1>002242</h1>
        <img class="hide gallery-item-img" src="https://www.eaton.com/mdmfiles/PDM89946573/VT50213_L/500x500_72dpi" alt="002242 - sku page" />
        <div class="product-specification-item">
          <h2 class="product-specification-item__title">General specifications</h2>
          <table>
            <tr class="specification-row"><td class="specification-title"><strong>Product Name</strong></td><td class="specification-value">Eaton xEffect Ci Enclosures Switch- & Controlgear Enclosure</td></tr>
            <tr class="specification-row"><td class="specification-title"><strong>Catalog Number</strong></td><td class="specification-value">002242</td></tr>
            <tr class="specification-row"><td class="specification-title"><strong>Product Length/Depth</strong></td><td class="specification-value">225 mm</td></tr>
            <tr class="specification-row"><td class="specification-title"><strong>Product Height</strong></td><td class="specification-value">296 mm</td></tr>
            <tr class="specification-row"><td class="specification-title"><strong>Product Width</strong></td><td class="specification-value">421 mm</td></tr>
            <tr class="specification-row"><td class="specification-title"><strong>Product Weight</strong></td><td class="specification-value">3.099 kg</td></tr>
          </table>
        </div>
        <img src="/content/dam/eaton/resources/siteconfig/360.png" alt="360 product view" />
        <div class="resource-list-item">
          <h2 class="resource-list-item__title">Characteristic curve</h2>
          <a href="https://www.eaton.com/content/dam/eaton/products/control-drives-automation-sensors/eaton-electrical-timers-easy-control-relays-characteristic-curve-002.eps.thumb.580.580.png">timer characteristic curve</a>
          <img src="https://www.eaton.com/content/dam/eaton/products/control-drives-automation-sensors/eaton-electrical-timers-easy-control-relays-characteristic-curve-002.eps.thumb.580.580.png" alt="timer characteristic curve" />
        </div>
        <div class="module-related-products upsell-products">
          <div class="related-products-component__card">
            <a href="/us/en-us/skuPage.057621.html">057621</a>
            <img class="rendition__image img-responsive" src="https://www.eaton.com/mdmfiles/PDM89946002/3200PIC-261_C/220x220_96dpi" alt="" />
            <p>057621 Eaton xEnergy Safety Ci LV systems LV switchgear. Cable clamp, for 2 cables D=14-54mm</p>
          </div>
        </div>
      </body></html>
    `;
    const result = parseEatonProductPage(
      "002242",
      fetched(html, "https://www.eaton.com/us/en-us/skuPage.002242.html"),
      "https://www.eaton.com/us/en-us/skuPage.002242.html"
    );

    const images = result.documents.filter((doc) => doc.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0]?.url).toContain("VT50213_L");
    expect(result.documents.some((doc) => doc.type === "other" && doc.label.includes("characteristic curve"))).toBe(true);
    expect(result.attributes.some((attr) => attr.group === "Designed to work together" && attr.name === "Related Product" && attr.value.includes("057621"))).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Related Product" && attr.value.includes("Cable clamp"))).toBe(true);
  });

  it("parses Eaton structured product metadata, breadcrumbs, and fallback images", () => {
    const html = `
      <html><head>
        <title>ABC-LD | Eaton structured product | Eaton</title>
        <link rel="canonical" href="https://www.eaton.com/us/en-us/skuPage.ABC-LD.html" />
        <meta property="og:title" content="ABC-LD | Eaton structured product | Eaton" />
        <meta property="og:description" content="Structured product for controls" />
        <meta name="coveo:product_brand" content="Eaton" />
        <meta name="coveo:product_core_group" content="Industrial controls" />
        <meta property="og:image" content="https://www.eaton.com/mdmfiles/PDM123456/ABC-LD_MAIN/500x500_72dpi" />
        <script type="text/javascript">
          let dataLayerJson = {
            "country": "us",
            "language": "en-us",
            "pageType": "product sku",
            "productFamily": "sku page",
            "productSku": "ABC-LD",
            "productName": "000000||Control relays",
            "domain": "www.eaton.com"
          };
        </script>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "schema:Product",
            "sku": "ABC-LD",
            "name": "Eaton structured product",
            "brand": {"@type": "Brand", "name": "Eaton"},
            "category": "Control relays",
            "image": "https://www.eaton.com/mdmfiles/PDM123456/ABC-LD_MAIN/500x500_72dpi"
          }
        </script>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            "itemListElement": [
              {"@type": "ListItem", "position": 1, "name": "Products"},
              {"@type": "ListItem", "position": 2, "name": "Industrial controls"},
              {"@type": "ListItem", "position": 3, "name": "Control relays"}
            ]
          }
        </script>
      </head><body>
        <nav class="breadcrumb"><a>Products</a><a>Industrial controls</a><a>Control relays</a></nav>
        <h1>ABC-LD</h1>
      </body></html>
    `;
    const result = parseEatonProductPage(
      "ABC-LD",
      fetched(html, "https://www.eaton.com/us/en-us/skuPage.ABC-LD.html"),
      "https://www.eaton.com/us/en-us/skuPage.ABC-LD.html"
    );

    expect(result.status).toBe("found");
    expect(result.attributes.some((attr) => attr.group === "Structured Product Data" && attr.name === "SKU" && attr.value === "ABC-LD")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Product Core Group" && attr.value === "Industrial controls")).toBe(true);
    expect(result.attributes.some((attr) => attr.group === "Eaton data layer" && attr.name === "Product SKU" && attr.value === "ABC-LD")).toBe(true);
    expect(result.attributes.some((attr) => attr.group === "Eaton data layer" && attr.name === "Product Name" && attr.value === "Control relays")).toBe(true);
    expect(result.attributes.some((attr) => attr.group === "Page metadata" && attr.name === "Open Graph Description" && attr.value === "Structured product for controls")).toBe(true);
    expect(result.attributes.some((attr) => attr.group === "Page metadata" && attr.name === "Canonical URL" && attr.value.endsWith("/skuPage.ABC-LD.html"))).toBe(true);
    expect(result.attributes.some((attr) => attr.group === "Product hierarchy" && attr.name === "Breadcrumb" && attr.value.includes("Control relays"))).toBe(true);
    expect(result.documents.some((doc) => doc.type === "image" && doc.url.includes("ABC-LD_MAIN"))).toBe(true);
  });

  it("normalizes Eaton generated spec sheet labels and keeps resource categories", () => {
    const html = `
      <html><head><title>ABC-LD | Eaton test product | Eaton</title></head><body>
        <h1>ABC-LD</h1>
        <div class="product-specification-item">
          <h2 class="product-specification-item__title">General specifications</h2>
          <table>
            <tr class="specification-row"><td class="specification-title"><strong>Product Name</strong></td><td class="specification-value">Eaton test product</td></tr>
            <tr class="specification-row"><td class="specification-title"><strong>Catalog Number</strong></td><td class="specification-value">ABC-LD</td></tr>
            <tr class="specification-row"><td class="specification-title"><strong>Product Weight</strong></td><td class="specification-value">1 kg</td></tr>
          </table>
        </div>
        <a id="linktopdf" href="https://www.eaton.com/us/en-us/skuPage.ABC-LD.pdf">Product specifications</a>
        <div class="resource-list-item">
          <h2 class="resource-list-item__title">mCAD model</h2>
          <a class="resource-list__title-link" href="https://www.eaton.com/content/dam/eaton/cad/mcad/step/abc_ld.stp">abc_ld.stp</a>
        </div>
        <div class="resource-list-item">
          <h2 class="resource-list-item__title">Declarations of conformity</h2>
          <a class="resource-list__title-link" href="https://www.eaton.com/content/dam/eaton/products/controls/abc-declaration-of-conformity.pdf">abc-declaration-of-conformity.pdf</a>
        </div>
      </body></html>
    `;
    const result = parseEatonProductPage(
      "ABC-LD",
      fetched(html, "https://www.eaton.com/us/en-us/skuPage.ABC-LD.html"),
      "https://www.eaton.com/us/en-us/skuPage.ABC-LD.html"
    );

    expect(result.status).toBe("found");
    expect(result.documents.some((doc) => doc.type === "datasheet" && doc.label === "Eaton Specification Sheet - ABC-LD")).toBe(true);
    expect(result.documents.some((doc) => doc.type === "cad" && doc.label === "abc_ld.stp (mCAD model)")).toBe(true);
    expect(result.documents.some((doc) => doc.type === "certificate" && doc.label === "abc-declaration-of-conformity.pdf (Declarations of conformity)")).toBe(true);
  });

  it("does not parse Eaton static HTML meta tags as markdown attributes", () => {
    const html = `
      <html><head>
        <meta property="og:title" content="220PC01A | Eaton pushbutton cap | Eaton" />
        <meta property="twitter:title" content="220PC01A | Eaton pushbutton cap | Eaton" />
      </head><body>
        <h1>220PC01A</h1>
        <div class="product-specification-item">
          <h2 class="product-specification-item__title">General specifications</h2>
          <table>
            <tr class="specification-row"><td class="specification-title"><strong>Product Name</strong></td><td class="specification-value">Eaton pushbutton cap</td></tr>
            <tr class="specification-row"><td class="specification-title"><strong>Catalog Number</strong></td><td class="specification-value">220PC01A</td></tr>
            <tr class="specification-row"><td class="specification-title"><strong>Type</strong></td><td class="specification-value">Clear cap</td></tr>
            <tr class="specification-row"><td class="specification-title"><strong>Illumination</strong></td><td class="specification-value">Illuminated</td></tr>
          </table>
        </div>
      </body></html>
    `;
    const result = parseEatonProductPage(
      "220PC01A",
      fetched(html, "https://www.eaton.com/us/en-us/skuPage.220PC01A.html"),
      "https://www.eaton.com/us/en-us/skuPage.220PC01A.html"
    );

    expect(result.status).toBe("found");
    expect(result.attributes.some((attr) => attr.name === "Type" && attr.value === "Clear cap")).toBe(true);
    expect(result.attributes.some((attr) => attr.name.includes("<meta") || attr.name === "220PC01A")).toBe(false);
  });

  it("parses Schneider embedded product characteristics, documents, and images", () => {
    const html = `
      <html><head>
        <link rel="canonical" href="https://www.se.com/us/en/product/NSYS3D3215/wall-mounted-steel-enclosure/" />
      </head><body>
        &quot;productId&quot;:&quot;NSYS3D3215&quot;,&quot;productInfo&quot;:{&quot;brand&quot;:&quot;Schneider Electric&quot;,&quot;description&quot;:&quot;Wall mounted steel enclosure, PanelSeT S3D, plain door, without mounting plate, 300x200x150mm, IP66, IK10&quot;}
        &quot;characteristicName&quot;:&quot;Enclosure nominal height&quot;,&quot;characteristicValues&quot;:[{&quot;needUpperCase&quot;:true,&quot;labelText&quot;:&quot;11.8 in (300 mm)&quot;}]
        &quot;characteristicName&quot;:&quot;Enclosure nominal width&quot;,&quot;characteristicValues&quot;:[{&quot;needUpperCase&quot;:true,&quot;labelText&quot;:&quot;7.9 in (200 mm)&quot;}]
        &quot;characteristicName&quot;:&quot;Enclosure nominal depth&quot;,&quot;characteristicValues&quot;:[{&quot;needUpperCase&quot;:true,&quot;labelText&quot;:&quot;5.9 in (150 mm)&quot;}]
        &quot;characteristicName&quot;:&quot;Material&quot;,&quot;characteristicValues&quot;:[{&quot;needUpperCase&quot;:true,&quot;labelText&quot;:&quot;steel&quot;}]
        &quot;characteristicName&quot;:&quot;Product Certifications&quot;,&quot;characteristicValues&quot;:[{&quot;needUpperCase&quot;:true,&quot;labelText&quot;:&quot;BV&quot;},{&quot;needUpperCase&quot;:true,&quot;labelText&quot;:&quot;UL&quot;},{&quot;needUpperCase&quot;:true,&quot;labelText&quot;:&quot;cUL&quot;}]
        &quot;characteristicName&quot;:&quot;Product Weight&quot;,&quot;characteristicValues&quot;:[{&quot;needUpperCase&quot;:true,&quot;labelText&quot;:&quot;6.66 lb(US) (3.02 kg)&quot;}]
        &quot;characteristicName&quot;:&quot;IP degree of protection&quot;,&quot;characteristicValues&quot;:[{&quot;needUpperCase&quot;:true,&quot;labelText&quot;:&quot;IP66 IEC 60529&quot;}]
        &quot;url&quot;:&quot;https://download.schneider-electric.com/files?p_Doc_Ref=NSYS3D3215_IoPmain-ODA20&amp;p_File_Type=rendition_1500_jpg&quot;
        &quot;url&quot;:&quot;/us/en/product/download-pdf/NSYS3D3215?filename=NSYS3D3215.pdf&quot;
        &quot;url&quot;:&quot;https://download.schneider-electric.com/files?p_enDocType=CAD&amp;p_File_Name=NSYS3D3215_3D-Simplified.stp&amp;p_Doc_Ref=NSYS3D3215_3D-CAD&quot;
      </body></html>
    `;
    const result = parseSchneiderProductPage("NSYS3D3215", fetched(html, "https://www.se.com/us/en/product/NSYS3D3215/"));

    expect(result.status).toBe("found");
    expect(result.normalized.weight).toBe("6.66 lb(US) (3.02 kg)");
    expect(result.normalized.dimensions).toBe("H 11.8 in (300 mm) x W 7.9 in (200 mm) x D 5.9 in (150 mm)");
    expect(result.normalized.material).toBe("steel");
    expect(result.normalized.protection).toContain("IP66 IEC 60529");
    expect(result.normalized.certificates).toContain("UL");
    expect(result.normalized.certificates).toContain("cUL");
    expect(result.documents.some((doc) => doc.type === "image")).toBe(true);
    expect(result.documents.some((doc) => doc.type === "datasheet" && doc.url.includes("/download-pdf/NSYS3D3215"))).toBe(true);
    expect(result.documents.some((doc) => doc.type === "cad")).toBe(true);
  });

  it("rejects blocked Schneider pages before catalog-only extraction", () => {
    const html = `<html><head><title>Access Denied</title></head><body>Access Denied for /us/en/product/NSYS3D3215/</body></html>`;
    const result = parseSchneiderProductPage(
      "NSYS3D3215",
      { ...fetched(html, "https://www.se.com/us/en/product/NSYS3D3215/"), statusCode: 403 }
    );

    expect(result.status).toBe("failed");
    expect(result.attributes).toHaveLength(0);
    expect(result.error).toContain("blocked");
  });

  it("rejects Schneider country-selector pages as product matches", () => {
    const html = `
      <html>
        <head><title>Country Selector</title></head>
        <body>Choose your country for sourceId=XS618B1PAL2</body>
      </html>
    `;
    const result = parseSchneiderProductPage(
      "XS618B1PAL2",
      fetched(html, "https://www.se.com/ww/en/product-country-selector/?pageType=product&sourceId=XS618B1PAL2")
    );

    expect(result.status).toBe("failed");
    expect(result.attributes).toHaveLength(0);
    expect(result.error).toContain("selector");
  });

  it("parses Schneider readable datasheet markdown into key specifications", () => {
    const text = `
Title: GV2ME08.pdf

URL Source: https://www.se.com/us/en/product/download-pdf/GV2ME08

Markdown Content:
# TeSys Deca Manual Starter and Protector, thermal magnetic circuit protector, push buttons, 2.5 to 4 A, screw clamp GV2ME08

Product availability: Stock - Normally stocked in distribution facility Main Range TeSys Deca

Product name TeSys GV2

Product or Component Type Motor circuit breaker

Device short name GV2ME

## Complementary Poles description 3P

Motor power kW 1.1 kW 400/415 V AC 50/60 Hz 1.5 kW 500 V AC 50/60 Hz

Line Rated Current 4 A

Thermal protection adjustment range

2.5...4 A IEC 60947-2

Magnetic tripping current 74 A

[Ue] rated operational voltage 690 V AC 50/60 Hz IEC 60947-2

Width 1.8 in (45 mm)

Height 3.5 in (89 mm)

Depth 3.09 in (78.5 mm)

Product Weight 0.57 lb(US) (0.26 kg)

## Environment Standards EN/IEC 60947-2 EN/IEC 60947-4-1 UL 60947-4-1

Product Certi fi cations CCC UL CSA EAC ATEX BV UKCA

IP degree of protection IP20 IEC 60529

## Ordering and shipping details Category US10I1122367

GTIN 3389110343090
    `;
    const result = parseSchneiderDatasheetReaderPage(
      "GV2ME08",
      fetched(text, "https://r.jina.ai/http://https://www.se.com/us/en/product/download-pdf/GV2ME08")
    );

    expect(result.status).toBe("found");
    expect(result.title).toContain("TeSys Deca Manual Starter");
    expect(result.normalized.voltage).toBe("690 V AC 50/60 Hz IEC 60947-2");
    expect(result.normalized.current).toBe("2.5...4 A IEC 60947-2");
    expect(result.normalized.weight).toBe("0.57 lb(US) (0.26 kg)");
    expect(result.normalized.dimensions).toBe("H 3.5 in (89 mm) x W 1.8 in (45 mm) x D 3.09 in (78.5 mm)");
    expect(result.normalized.protection).toContain("IP20");
    expect(result.normalized.certificates).toContain("UL");
    expect(result.attributes.some((attr) => attr.name === "Product or Component Type" && attr.value === "Motor circuit breaker")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Main Range" && attr.value === "TeSys Deca")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "GTIN" && attr.value === "3389110343090")).toBe(true);
    expect(result.documents.some((doc) => doc.type === "datasheet" && doc.url.includes("/download-pdf/GV2ME08"))).toBe(true);
  });

  it("parses Schneider readable datasheet markdown for discontinued power supplies", () => {
    const text = `
Title: ABL8REM24030.pdf

URL Source: https://www.se.com/us/en/product/download-pdf/ABL8REM24030

Markdown Content:
\uF322 Discontinued regulated power supply, Phaseo, 100 to 240 V, 24 V, 3 A ABL8REM24030

# \uF322 Discontinued on: Dec 1, 2020

Product availability: Non-Stock - Not normally stocked in distribution facility Main Range of Product Modicon Power Supply

Product or Component Type Power supply

Power supply type Regulated switch mode

Nominal input voltage 100...240 V AC phase to phase L1-L2 100...240 V AC single phase N-L1 110...220 V DC

Rated power in W 72 W

Output voltage 24 V DC

Power supply output current 3 A

## Complementary Input protection type Integrated fuse (not interchangeable)

Efficiency 84 %

Depth 4.7 in (120 mm)

Height 4.7 in (120 mm)

Width 1.06 in (27 mm)

Product Weight 1.15 lb(US) (0.52 kg)

## Product data sheet Marking CE

## Environment Standards UL 508 CSA C22.2 No 60950-1 EN/IEC 62368-1

Product Certi fi cations CSA 22-2 No 950 EAC RCM KC UL

IP degree of protection IP20 conforming to IEC 60529
    `;
    const result = parseSchneiderDatasheetReaderPage(
      "ABL8REM24030",
      fetched(text, "https://r.jina.ai/http://https://www.se.com/us/en/product/download-pdf/ABL8REM24030")
    );

    expect(result.status).toBe("found");
    expect(result.title).toContain("regulated power supply");
    expect(result.title).not.toContain("Discontinued on");
    expect(result.normalized.voltage).toBe("24 V DC");
    expect(result.normalized.current).toBe("3 A");
    expect(result.normalized.weight).toBe("1.15 lb(US) (0.52 kg)");
    expect(result.normalized.dimensions).toBe("H 4.7 in (120 mm) x W 1.06 in (27 mm) x D 4.7 in (120 mm)");
    expect(result.normalized.protection).toContain("IP20");
    expect(result.normalized.certificates).toContain("UL");
    expect(result.attributes.some((attr) => attr.group === "Schneider Lifecycle" && attr.name === "Discontinued on" && attr.value === "Dec 1, 2020")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Main Range of Product" && attr.value === "Modicon Power Supply")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Product or Component Type" && attr.value === "Power supply")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Rated power in W" && attr.value === "72 W")).toBe(true);
  });

  it("parses Schneider readable datasheets from non-US locales and split chained commercial labels", () => {
    const text = `
Title: LV429630.pdf

URL Source: https://www.se.com/uk/en/product/download-pdf/LV429630

Markdown Content:
# Discontinued Circuit breaker, ComPact NSX100F, 36kA/415VAC, TMD trip unit 100A, 3 poles 3d LV429630

Discontinued on: Jun 15, 2023

Product availability: Non-Stock - Not normally stocked in distribution facility Important message: This product has been switched to new ComPacT range and is no longer commercialized. Main Range ComPact

Product name ComPact NSX

Product or Component Type Circuit breaker

Line Rated Current 100 A 104 °F (40 °C)

[Ue] rated operational voltage 690 V AC 50/60 Hz

Height 161 mm

Width 105 mm

Depth 86 mm

Product Weight 2.05 kg
    `;
    const result = parseSchneiderDatasheetReaderPage(
      "LV429630",
      fetched(text, "https://r.jina.ai/http://https://www.se.com/uk/en/product/download-pdf/LV429630")
    );

    expect(result.status).toBe("found");
    expect(result.productUrl).toBe("https://www.se.com/uk/en/product/LV429630/");
    expect(result.normalized.voltage).toBe("690 V AC 50/60 Hz");
    expect(result.normalized.current).toBe("100 A 104 °F (40 °C)");
    expect(result.attributes.some((attr) => attr.group === "Schneider Lifecycle" && attr.name === "Discontinued on" && attr.value === "Jun 15, 2023")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Product availability" && attr.value === "Non-Stock - Not normally stocked in distribution facility")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Important message" && attr.value.includes("new ComPacT range"))).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Main Range" && attr.value === "ComPact")).toBe(true);
    expect(result.documents.some((doc) => doc.type === "datasheet" && doc.url.includes("/uk/en/product/download-pdf/LV429630"))).toBe(true);
  });

  it("parses Schneider sensor datasheet labels from global readable markdown", () => {
    const text = `
Title: XS618B1PAL2.pdf

URL Source: https://www.se.com/ww/en/product/download-pdf/XS618B1PAL2

Markdown Content:
# Discontinued Inductive proximity sensors XS, inductive sensor XS6 M18, L62mm, brass, Sn8mm, 12...48 VDC, cable 2 m XS618B1PAL2

Range of product Telemecanique Inductive proximity sensors XS

Sensor type Inductive proximity sensor

Sensor design Cylindrical M18

[Sn] nominal sensing distance 8 mm

Discrete output type PNP

[Us] rated supply voltage 12...48 V DC with reverse polarity protection

Switching capacity in mA <= 200 mA DC with overload and short-circuit protection

Cable length 2 m

Enclosure material Nickel plated brass

IP degree of protection IP68 conforming to IEC 60529 IP69K conforming to DIN 40050
    `;
    const result = parseSchneiderDatasheetReaderPage(
      "XS618B1PAL2",
      fetched(text, "https://r.jina.ai/http://https://www.se.com/ww/en/product/download-pdf/XS618B1PAL2")
    );

    expect(result.status).toBe("found");
    expect(result.productUrl).toBe("https://www.se.com/ww/en/product/XS618B1PAL2/");
    expect(result.normalized.voltage).toBe("12...48 V DC with reverse polarity protection");
    expect(result.normalized.current).toBe("<= 200 mA DC with overload and short-circuit protection");
    expect(result.normalized.material).toBe("Nickel plated brass");
    expect(result.attributes.some((attr) => attr.name === "Range of Product" && attr.value === "Telemecanique Inductive proximity sensors XS")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "[Sn] nominal sensing distance" && attr.value === "8 mm")).toBe(true);
  });

  it("parses Telemecanique sensor pages as Schneider official product data", () => {
    const html = `
      <html>
        <head><title>XS618B1PAL2 - Inductive proximity sensors XS, inductive sensor XS6 M18, L62mm, brass, Sn8mm, 12...48 VDC, cable 2 m | Telemecanique Sensors</title></head>
        <body>
          <h1>XS618B1PAL2</h1>
          <img src="https://download.schneider-electric.com/files?p_Doc_Ref=103187&p_File_Type=rendition_4000_png" alt="XS618B1PAL2 product image" />
          <a href="https://downloads.telemecaniquesensors.com/dam/datasheets/en/XS618B1PAL2_EN.pdf">Download pdf datasheet</a>
          <a href="/global/en/download/dam/MCADID0004033_3D-CAD_9">Inductive sensor XS6 M18 - L62mm brass Sn8mm cable - 3D CAD (dxf)</a>
          Datasheet
          Main
          Range of product
          Telemecanique Inductive proximity sensors XS
          Sensor type
          Inductive proximity sensor
          Material
          Metal
          [Us] rated supply voltage
          12...48 V DC with reverse polarity protection
          Switching capacity in mA
          <= 200 mA DC with overload and short-circuit protection
          IP degree of protection
          IP68 double insulation conforming to IEC 60529, IP69K conforming to DIN 40050
          Complementary
          Enclosure material
          Nickel plated brass
          Cable composition
          3 x 0.34 mm²
          Environment
          Product certifications
          CSAE2UL
          Documents & Downloads
        </body>
      </html>
    `;
    const result = parseTelemecaniqueProductPage(
      "XS618B1PAL2",
      fetched(html, "https://telemecaniquesensors.com/us/en/product/reference/XS618B1PAL2")
    );

    expect(result.status).toBe("found");
    expect(result.title).toContain("Inductive proximity sensors XS");
    expect(result.normalized.voltage).toBe("12...48 V DC with reverse polarity protection");
    expect(result.normalized.current).toBe("<= 200 mA DC with overload and short-circuit protection");
    expect(result.normalized.protection).toContain("IP68");
    expect(result.normalized.material).toBe("Nickel plated brass");
    expect(result.documents.some((doc) => doc.type === "datasheet" && doc.url.includes("XS618B1PAL2_EN.pdf"))).toBe(true);
    expect(result.documents.some((doc) => doc.type === "cad" && doc.url.includes("MCADID0004033"))).toBe(true);
    expect(result.documents.some((doc) => doc.type === "image" && doc.url.includes("p_Doc_Ref=103187"))).toBe(true);
    expect(result.attributes.find((attr) => attr.name === "Sensor type")?.parser).toBe("schneider-telemecanique-product-page");
  });

  it("parses Schneider PES structured data payloads", () => {
    const allData = {
      metaTags: {
        title: "GV2ME08 - TeSys Deca Manual Starter and Protector | Schneider Electric USA",
        description:
          "Schneider Electric USA. GV2ME08 - TeSys Deca Manual Starter and Protector, thermal magnetic circuit protector, push buttons, 2.5 to 4 A, screw clamp.",
        productId: "GV2ME08",
        canonicalUrl: "/us/en/product/GV2ME08/tesys-deca-manual-starter-and-protector/"
      },
      breadcrumbs: [
        { itemType: "BUSINESS", name: "Industrial Automation and Control" },
        { itemType: "CATEGORY", name: "Contactors and Protection Relays" },
        { itemType: "RANGE", nameForChat: "TeSys Deca Manual Starters and Protectors GV2" }
      ],
      base: {
        productInfo: {
          brand: "Schneider Electric",
          description: "TeSys Deca Manual Starter and Protector, thermal magnetic circuit protector"
        },
        productId: "GV2ME08",
        productCR: "GV2ME08",
        highlightedCharacteristics: { all: [{ label: "Product availability", values: ["Stock"] }] },
        ctaArea: { price: "179.93", currency: "USD" },
        productMedia: {
          zoomPictureDesktop: {
            title: "GV2ME08 product image",
            url: "https://download.schneider-electric.com/files?p_Doc_Ref=GV2ME08_Image&p_File_Type=rendition_1500_jpg"
          }
        },
        variants: {
          chars: [
            {
              title: "Thermal protection adjustment range",
              variants: [{ value: "2.5...4 A", productId: "GV2ME08", type: "selected" }]
            }
          ]
        }
      },
      specifications: {
        longDescSentences: ["Manual starter and protector for motor applications."],
        characteristicTables: [
          {
            tableName: "Main",
            rows: [
              { characteristicName: "Product or Component Type", characteristicValues: [{ labelText: "Motor circuit breaker" }] },
              { characteristicName: "Range", characteristicValues: [{ labelText: "TeSys Deca" }] }
            ]
          },
          {
            tableName: "Complementary",
            rows: [
              { characteristicName: "[Ue] rated operational voltage", characteristicValues: [{ labelText: "690 V AC 50/60 Hz" }] },
              { characteristicName: "Rated Current", characteristicValues: [{ labelText: "2.5...4 A" }] },
              { characteristicName: "Product Weight", characteristicValues: [{ labelText: "0.57 lb(US) (0.26 kg)" }] }
            ]
          }
        ]
      },
      environmentalData: {
        data: {
          groups: [
            {
              subGroups: [
                {
                  characteristicRecords: [
                    { charName: { labelText: "Total lifecycle Carbon footprint" }, charValue: { labelText: "11 kg CO2 eq." } }
                  ]
                }
              ]
            }
          ]
        }
      },
      assetBarRelatedProducts: {
        assetBar: {
          documents: [
            {
              url: "/us/en/product/download-pdf/GV2ME08?filename=GV2ME08.pdf",
              title: "Product Datasheet",
              documentType: "Product Data Sheet"
            },
            {
              url: "https://download.schneider-electric.com/files?p_enDocType=User+guide&p_File_Name=1672546-08.pdf&p_Doc_Ref=1672546",
              title: "User guide",
              documentType: "User guide"
            }
          ],
          secondaryDocuments: []
        }
      }
    };
    const html = `<html><body><pes-app-spryker-pdp plain-all-data='${htmlAttributeJson(allData)}'></pes-app-spryker-pdp></body></html>`;
    const result = parseSchneiderProductPage("GV2ME08", fetched(html, "https://www.se.com/us/en/product/GV2ME08/"));

    expect(result.status).toBe("found");
    expect(result.title).toBe("TeSys Deca Manual Starter and Protector, thermal magnetic circuit protector");
    expect(result.productUrl).toBe("https://www.se.com/us/en/product/GV2ME08/tesys-deca-manual-starter-and-protector/");
    expect(result.normalized.current).toBe("2.5...4 A");
    expect(result.normalized.voltage).toBe("690 V AC 50/60 Hz");
    expect(result.normalized.weight).toBe("0.57 lb(US) (0.26 kg)");
    expect(result.attributes.some((attr) => attr.group === "Schneider Main" && attr.name === "Product or Component Type")).toBe(true);
    expect(result.attributes.find((attr) => attr.name === "Product or Component Type")?.sourceType).toBe("official");
    expect(result.attributes.find((attr) => attr.name === "Product or Component Type")?.parser).toBe("schneider-product-page");
    expect(result.attributes.some((attr) => attr.group === "Schneider Product Hierarchy" && attr.name === "Category")).toBe(true);
    expect(result.attributes.some((attr) => attr.name === "Total lifecycle Carbon footprint" && attr.value === "11 kg CO2 eq.")).toBe(true);
    expect(result.documents.some((doc) => doc.type === "datasheet" && doc.url.includes("/download-pdf/GV2ME08"))).toBe(true);
    expect(result.documents.find((doc) => doc.type === "datasheet")?.sourceType).toBe("official");
    expect(result.documents.some((doc) => doc.type === "manual" && doc.url.includes("1672546-08.pdf"))).toBe(true);
    expect(result.documents.some((doc) => doc.type === "image" && doc.url.includes("GV2ME08_Image"))).toBe(true);
  });

  it("parses Schneider marketplace Astro props payloads", () => {
    const props = {
      sku: [0, "XB4BA21"],
      brand: [0, "Schneider Electric"],
      productName: [0, "Harmony 22mm push button, black flush, spring return"],
      productSpecs: [
        1,
        [
          [
            0,
            {
              tableName: [0, "Main"],
              rows: [
                1,
                [
                  [0, { characteristicName: [0, "Product or Component Type"], characteristicValues: [1, [[0, { labelText: [0, "Push-button"] }]]] }],
                  [0, { characteristicName: [0, "[Ue] rated operational voltage"], characteristicValues: [1, [[0, { labelText: [0, "600 V"] }]]] }],
                  [0, { characteristicName: [0, "Contacts type and composition"], characteristicValues: [1, [[0, { labelText: [0, "1 NO"] }]]] }]
                ]
              ]
            }
          ]
        ]
      ],
      productDocs: [
        1,
        [
          [
            0,
            {
              url: [0, "https://download.schneider-electric.com/files?p_enDocType=Instruction+sheet&p_File_Name=BRU46063_00.pdf&p_Doc_Ref=BRU46063"],
              title: [0, "Instruction sheet"],
              documentType: [0, "Instruction sheet"]
            }
          ]
        ]
      ],
      productMedia: [
        0,
        {
          zoomPictureDesktop: [
            0,
            {
              title: [0, "XB4BA21 product image"],
              url: [0, "https://download.schneider-electric.com/files?p_Doc_Ref=XB4BA21_DA19&p_File_Type=rendition_1500_jpg"]
            }
          ]
        }
      ]
    };
    const html = `<html><body><astro-island props='${htmlAttributeJson(props)}'></astro-island></body></html>`;
    const result = parseSchneiderProductPage("XB4BA21", fetched(html, "https://shop.se.com/pro/us/en/product/harmony-22mm-push-button/"));

    expect(result.status).toBe("found");
    expect(result.title).toBe("Harmony 22mm push button, black flush, spring return");
    expect(result.normalized.voltage).toBe("600 V");
    expect(result.attributes.some((attr) => attr.group === "Schneider Main" && attr.value === "Push-button")).toBe(true);
    expect(result.documents.some((doc) => doc.type === "manual" && doc.url.includes("BRU46063_00.pdf"))).toBe(true);
    expect(result.documents.some((doc) => doc.type === "image" && doc.url.includes("XB4BA21_DA19"))).toBe(true);
  });

  it("parses Siemens public API product details", () => {
    const result = parseSiemensProductApiResponse(
      "6AG4141-5BB04-0FA0",
      fetched(
        JSON.stringify({
          products: [
            {
              itemId: "1",
              articleNumber: "6AG4141-5BB04-0FA0",
              uiNetWeightValue: "3,00 Kg",
              uiPackagingDimension: "Not available",
              thumbnailUrl: "https://mall.industry.siemens.com/thumb.jpg",
              imageUrl: "https://mall.industry.siemens.com/image.jpg",
              description: "SIMATIC IPC427E, 24 V DC industrial power supply",
              materialShortText: "SIMATIC IPC427E",
              countryOfOrigin: "DE",
              upc: "195125000292"
            }
          ]
        }),
        "https://sieportal.siemens.com/api/mall/SearchApi/GetProductsDetails"
      )
    );

    expect(result.status).toBe("found");
    expect(result.normalized.weight).toBe("3,00 Kg");
    expect(result.normalized.voltage).toBeUndefined();
    expect(result.description).toContain("24 V DC");
    expect(result.localizedUrls?.de).toContain("mall/de/WW/Catalog/Product");
    expect(result.documents.filter((doc) => doc.type === "image")).toHaveLength(2);
    expect(result.attributes.some((attr) => attr.name === "Country Of Origin" && attr.value === "DE")).toBe(true);
  });
});

function fetched(text: string, effectiveUrl: string, contentType = "text/html"): FetchedText {
  return {
    requestedUrl: effectiveUrl,
    effectiveUrl,
    statusCode: 200,
    contentType,
    text,
    fetchedAt: "2026-05-13T00:00:00.000Z",
    fromCache: false
  };
}

function abbAttribute(attributeCode: string, attributeName: string, text: string) {
  return {
    type: "Text",
    attributeCode,
    attributeName,
    values: [{ text }],
    isInternal: false,
    internal: false,
    highlight: false
  };
}

function htmlAttributeJson(value: unknown): string {
  return JSON.stringify(value).replace(/&/g, "&amp;").replace(/'/g, "&#39;");
}
