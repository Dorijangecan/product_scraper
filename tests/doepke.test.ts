import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import {
  doepkeDatasheetLink,
  doepkeDownloadDocuments,
  doepkeFeatureAttributes,
  doepkePageMatches,
  doepkeProductImage,
  doepkeShortDescription,
  doepkeTitle
} from "../src/server/scrapers/doepke.js";

// Trimmed but structurally faithful excerpt of the real `prodext.php?ARTNR=09144919&lang=en`
// legacy template (mismatched-case tags and reused ids included, since the real page has both).
const DOEPKE_PRODEXT_FIXTURE = `
<html><body>
<DIV ID="ART_Links">
<DIV ID="ART_LKopf">ArtNr 09144919</DIV>
<DIV ID="ART_Bild"><A href="javascript:opendetail('/produktbilder/600px_png/doepke_09144919_600px_ml.png')"><img src="/produktbilder/600px_png/doepke_09144919_600px_ml.png" border="0"></A></DIV>
<DIV ID="ART_Link_ges"><DIV ID="ART_Link_mark">&raquo;</DIV><DIV ID="ART_Link"><A target="_new" href="/uploads/tx_doepkeproducts/datenblatt/doepke_09144919_dbl_en.pdf" type="application/pdf" title="Data sheet DFS4 063-4/0,03-A KV R [893 KB]" class="vtip">Data sheet DFS4 063-4/0,03-A KV R</A></DIV></DIV>
<DIV ID="ART_Link_ges"><DIV ID="ART_Link_mark">&raquo;</DIV><DIV ID="ART_Link"><A target="_new" href="/uploads/tx_doepkeproducts/bedienungsanleitung/web/doepke_3930298_dfs2dfs4_bed_web_ml.pdf" type="application/pdf" title="Operating instructions [201 KB]" class="vtip">Operating instructions</A></DIV></DIV>
<DIV ID="ART_Link_ges"><DIV ID="ART_Link_mark">&raquo;</DIV><DIV ID="ART_Link"><A target="_new" href="/uploads/tx_doepkeproducts/software/Doepke_Etiketten_Setup.exe" title="Labelling software DFS / DLS [1727 KB]" class="vtip">Labelling software DFS / DLS</A></DIV></DIV>
<DIV ID="ART_Link_ges"><DIV ID="ART_Link_mark">&raquo;</DIV><DIV ID="ART_Link"><A target="_new" href="/uploads/tx_doepkeproducts/anschlussschema/jpg/doepke_09112911_ans_ml.jpg" title="Wiring diagram [119 KB]" class="vtip">Wiring diagram</A></DIV></DIV>
<DIV ID="ART_Link_ges"><DIV ID="ART_Link_mark">&raquo;</DIV><DIV ID="ART_Link"><A href="prodext.php?ARTNR=9200011&lang=en" title="9200011 " class="vtip"></A></DIV></DIV>
<DIV ID="ART_EG">
<DIV ID="ART_EG1">&nbsp;<b>Features:</b></DIV>
<DIV ID="ART_EGn">&nbsp;&nbsp;Number of poles<br>&nbsp;&nbsp;<b>4</b></DIV>
<DIV ID="ART_EGn">&nbsp;&nbsp;Residual current type<br>&nbsp;&nbsp;<b>A</b></DIV>
<DIV ID="ART_EGn">&nbsp;&nbsp;Rated current (AC)<br>&nbsp;&nbsp;<b>63 A</b></DIV>
</DIV>
</DIV>
<DIV ID="ART_Rechts">
<DIV ID="ART_RKopf">residual current circuit-breaker DFS 4 063-4/0,03-A KV R<DIV ID="TLINK">&raquo;&nbsp;&nbsp;<A href="/uploads/tx_doepkeproducts/datenblatt/doepke_09144919_dbl_en.pdf" title="Data sheet DFS4 063-4/0,03-A KV R PDF - [893 KB)]" class="vtip">articles properties</A>&nbsp;&nbsp;</DIV></DIV>
<DIV ID="ART_Text">Residual current circuit-breakers, four-pole, 63 A, 0,03 A, Type A, short-time delayed, N right<br><br><div id="ART_TXT_Z1">Function:</DIV>Type A residual current circuit-breakers detect pulsating direct current and alternating current.</DIV>
</DIV>
</body></html>
`;

const DOEPKE_NOT_FOUND_FIXTURE = `
<html><body>Unfortunately, we are not aware of any product with item no 00000000.</body></html>
`;

// The real German not-found page (e.g. prodext.php?ARTNR=09112633&lang=de) echoes the searched
// article number back into its own "not found" sentence — a naive catalog-number-presence check
// would treat this as a match. This wording ("ist uns leider nicht bekannt") differs from the
// guessed "kein produkt mit der artikelnummer" phrasing that shipped originally.
const DOEPKE_NOT_FOUND_DE_FIXTURE = `
<html><body><h3>Ein Produkt mit der Artikelnummer 09112633 ist uns leider nicht bekannt.<br>Moeglicherweise ist die Artikelnummer fehlerhaft, oder das Produkt ist nicht mehr verfuegbar.</h3></body></html>
`;

describe("Doepke scraper helpers", () => {
  it("matches a resolved prodext.php article page and rejects the not-found page (EN and DE)", () => {
    expect(doepkePageMatches(DOEPKE_PRODEXT_FIXTURE, "09144919")).toBe(true);
    expect(doepkePageMatches(DOEPKE_NOT_FOUND_FIXTURE, "00000000")).toBe(false);
    expect(doepkePageMatches(DOEPKE_NOT_FOUND_DE_FIXTURE, "09112633")).toBe(false);
  });

  it("extracts a clean title without the trailing nested datasheet-link div", () => {
    const $ = cheerio.load(DOEPKE_PRODEXT_FIXTURE);
    expect(doepkeTitle($)).toBe("residual current circuit-breaker DFS 4 063-4/0,03-A KV R");
  });

  it("extracts the short language-independent description up to the first heading div", () => {
    const $ = cheerio.load(DOEPKE_PRODEXT_FIXTURE);
    expect(doepkeShortDescription($)).toBe("Residual current circuit-breakers, four-pole, 63 A, 0,03 A, Type A, short-time delayed, N right");
  });

  it("reads the Features mini spec table into attributes", () => {
    const $ = cheerio.load(DOEPKE_PRODEXT_FIXTURE);
    const attributes = doepkeFeatureAttributes($, "https://www.doepke.de/source/prodext.php?ARTNR=09144919&lang=en");
    expect(attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Number of poles", value: "4" }),
      expect.objectContaining({ name: "Residual current type", value: "A" }),
      expect.objectContaining({ name: "Rated current (AC)", value: "63 A" })
    ]));
  });

  it("resolves the datasheet PDF URL and derives the type code from its link text", () => {
    const $ = cheerio.load(DOEPKE_PRODEXT_FIXTURE);
    const datasheet = doepkeDatasheetLink($, "https://www.doepke.de/source/prodext.php?ARTNR=09144919&lang=en");
    expect(datasheet?.document.url).toBe("https://www.doepke.de/uploads/tx_doepkeproducts/datenblatt/doepke_09144919_dbl_en.pdf");
    expect(datasheet?.document.type).toBe("datasheet");
    expect(datasheet?.typeCode).toBe("DFS4 063-4/0,03-A KV R");
  });

  it("resolves the product image to an absolute URL", () => {
    const $ = cheerio.load(DOEPKE_PRODEXT_FIXTURE);
    const image = doepkeProductImage($, "https://www.doepke.de/source/prodext.php?ARTNR=09144919&lang=en");
    expect(image?.url).toBe("https://www.doepke.de/produktbilder/600px_png/doepke_09144919_600px_ml.png");
    expect(image?.type).toBe("image");
  });

  it("collects real /uploads/ downloads while excluding the datasheet, .exe installer and accessory cross-links", () => {
    const $ = cheerio.load(DOEPKE_PRODEXT_FIXTURE);
    const documents = doepkeDownloadDocuments($, "https://www.doepke.de/source/prodext.php?ARTNR=09144919&lang=en", "09144919");
    const urls = documents.map((doc) => doc.url);
    expect(urls).toContain("https://www.doepke.de/uploads/tx_doepkeproducts/bedienungsanleitung/web/doepke_3930298_dfs2dfs4_bed_web_ml.pdf");
    expect(urls.some((url) => url.endsWith(".exe"))).toBe(false);
    expect(urls.some((url) => url.includes("_dbl_en.pdf"))).toBe(false);
    expect(urls.some((url) => url.includes("ARTNR=9200011"))).toBe(false);
  });

  it("classifies the wiring diagram as a technical drawing, not a product photo", () => {
    const $ = cheerio.load(DOEPKE_PRODEXT_FIXTURE);
    const documents = doepkeDownloadDocuments($, "https://www.doepke.de/source/prodext.php?ARTNR=09144919&lang=en", "09144919");
    const wiringDiagram = documents.find((doc) => doc.url.includes("anschlussschema"));
    expect(wiringDiagram?.type).toBe("cad");
  });
});
