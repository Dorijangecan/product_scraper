import { describe, expect, it } from "vitest";
import { parseAbbProductPage } from "../src/server/scrapers/abb.js";
import { parseBalluffProductPage } from "../src/server/scrapers/balluff.js";
import { parseEatonProductPage } from "../src/server/scrapers/eaton.js";
import { parseGenericProductPage } from "../src/server/scrapers/generic.js";
import { parseSchneiderProductPage } from "../src/server/scrapers/schneider.js";
import { parseSiemensProductApiResponse } from "../src/server/scrapers/siemens.js";
import { parseSceProductPage } from "../src/server/scrapers/sce.js";
import type { FetchedText } from "../src/server/scrapers/http-client.js";

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
    expect(result.normalized.weight).toBe("41 lb");
    expect(result.normalized.dimensions).toContain("20.00H");
    expect(result.documents.some((doc) => doc.type === "cad")).toBe(true);
    expect(result.documents.some((doc) => doc.type === "image" && doc.url.includes("sce-20el2010lp.png"))).toBe(true);
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
    expect(result.normalized.voltage).toBe("250 VDC / 250 VAC");
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
    expect(result.normalized.weight).toBe("0.25 lb");
    expect(result.normalized.dimensions).toBe("H 2.5 in x W 2.6 in x D 2.6 in");
    expect(result.documents.find((doc) => doc.type === "image")?.url).toBe(
      "https://dynamicmedia.eaton.com/is/image/eaton/ES-ICD-MC-RENEWAL_FM?wid=500&hei=500"
    );
    expect(result.documents.some((doc) => doc.type === "image")).toBe(true);
    expect(result.documents.some((doc) => doc.type === "datasheet")).toBe(true);
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
        &quot;characteristicName&quot;:&quot;Product Certifications&quot;,&quot;characteristicValues&quot;:[{&quot;needUpperCase&quot;:true,&quot;labelText&quot;:&quot;BV&lt;br /&gt;UL&lt;br /&gt;cUL&quot;}]
        &quot;characteristicName&quot;:&quot;Product Weight&quot;,&quot;characteristicValues&quot;:[{&quot;needUpperCase&quot;:true,&quot;labelText&quot;:&quot;6.66 lb(US) (3.02 kg)&quot;}]
        &quot;characteristicName&quot;:&quot;IP degree of protection&quot;,&quot;characteristicValues&quot;:[{&quot;needUpperCase&quot;:true,&quot;labelText&quot;:&quot;IP66 IEC 60529&quot;}]
        &quot;url&quot;:&quot;https://download.schneider-electric.com/files?p_Doc_Ref=NSYS3D3215_IoPmain-ODA20&amp;p_File_Type=rendition_1500_jpg&quot;
        &quot;url&quot;:&quot;https://download.schneider-electric.com/files?p_enDocType=CAD&amp;p_File_Name=NSYS3D3215_3D-Simplified.stp&amp;p_Doc_Ref=NSYS3D3215_3D-CAD&quot;
      </body></html>
    `;
    const result = parseSchneiderProductPage("NSYS3D3215", fetched(html, "https://www.se.com/us/en/product/NSYS3D3215/"));

    expect(result.status).toBe("found");
    expect(result.normalized.weight).toBe("6.66 lb(US) (3.02 kg)");
    expect(result.normalized.dimensions).toBe("H 11.8 in (300 mm) x W 7.9 in (200 mm) x D 5.9 in (150 mm)");
    expect(result.normalized.material).toBe("steel");
    expect(result.normalized.protection).toContain("IP66 IEC 60529");
    expect(result.documents.some((doc) => doc.type === "image")).toBe(true);
    expect(result.documents.some((doc) => doc.type === "cad")).toBe(true);
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

function fetched(text: string, effectiveUrl: string): FetchedText {
  return {
    requestedUrl: effectiveUrl,
    effectiveUrl,
    statusCode: 200,
    contentType: "text/html",
    text,
    fetchedAt: "2026-05-13T00:00:00.000Z",
    fromCache: false
  };
}
