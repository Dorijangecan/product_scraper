import { describe, expect, it } from "vitest";
import { searchResultVerdict } from "../src/server/scrapers/search-results.js";

const page = (body: string, head = ""): string => `<html><head>${head}</head><body>${body}</body></html>`;

describe("searchResultVerdict", () => {
  it("reads the site's own zero-result sentence", () => {
    const verdict = searchResultVerdict({ html: page("<main><p>No results found for 1SVR405611R1000.</p></main>") });
    expect(verdict.kind).toBe("zero");
    expect(verdict.evidence).toContain("no results found");
  });

  it("reads zero-result sentences in the other corpus languages", () => {
    for (const sentence of ["Keine Ergebnisse gefunden.", "Aucun résultat trouvé.", "Nessun risultato.", "Sin resultados."]) {
      expect(searchResultVerdict({ html: page(`<p>${sentence}</p>`) }).kind, sentence).toBe("zero");
    }
  });

  it("treats a printed total as hits, and keeps the number", () => {
    const verdict = searchResultVerdict({ html: page("<div class='toolbar'>137 results</div>") });
    expect(verdict.kind).toBe("hits");
    expect(verdict.count).toBe(137);
  });

  it("reads a paging range and takes the total, not the page size", () => {
    const verdict = searchResultVerdict({ html: page("<span>1 – 20 of 1.234 Ergebnisse</span>") });
    expect(verdict.kind).toBe("hits");
    expect(verdict.count).toBe(1234);
  });

  it("prefers the list total over a smaller facet counter", () => {
    const verdict = searchResultVerdict({
      html: page("<aside><span>3 products</span></aside><div class='toolbar'>48 results</div>")
    });
    expect(verdict.count).toBe(48);
  });

  // The edge this rule exists for: an empty 'recently viewed' or unmatched facet next to a perfectly
  // good result list must not be able to declare the whole page empty.
  it("refuses the zero verdict while the page still yielded product links", () => {
    const verdict = searchResultVerdict({
      html: page("<aside>No results found</aside><ul><li><a href='/p/1'>CT-MFD.21</a></li></ul>"),
      candidateCount: 1
    });
    expect(verdict.kind).toBe("hits");
    expect(verdict.evidence).toContain("product link");
  });

  it("calls bot mitigation blocked, never a missing product", () => {
    expect(searchResultVerdict({ html: page("<h1>Just a moment...</h1>") }).kind).toBe("blocked");
    expect(searchResultVerdict({ html: page("<p>ok</p>"), statusCode: 403 }).kind).toBe("blocked");
    expect(searchResultVerdict({ html: page("<p>ok</p>"), statusCode: 429 }).evidence).toBe("HTTP 429");
  });

  it("recognises an empty client-rendered result container", () => {
    const verdict = searchResultVerdict({
      html: page(
        "<div class='search-results'></div>",
        "<script id='__NEXT_DATA__' type='application/json'>{}</script>"
      )
    });
    expect(verdict.kind).toBe("js-only");
  });

  // A framework fingerprint alone describes most of the modern web. Without this rule every
  // unexplained failure would be filed as js-only, which is the answer this module exists to stop.
  it("does not call a filled result list js-only just because the site ships a framework", () => {
    const verdict = searchResultVerdict({
      html: page(
        "<div class='search-results'><a href='/p/1'>CT-MFD.21 monitoring relay</a></div>",
        "<script id='__NEXT_DATA__'>{}</script>"
      ),
      candidateCount: 1
    });
    expect(verdict.kind).toBe("hits");
  });

  it("says unknown rather than guessing", () => {
    expect(searchResultVerdict({ html: page("<p>Welcome to our catalogue.</p>") }).kind).toBe("unknown");
    expect(searchResultVerdict({ html: "" }).kind).toBe("unknown");
  });

  // A phrase inside a script tag is code, not the page's verdict.
  it("ignores zero-result phrases that only appear in scripts", () => {
    const verdict = searchResultVerdict({
      html: page("<div class='list'><a href='/p/1'>CT-MFD.21</a></div><script>var msg = 'no results found';</script>"),
      candidateCount: 1
    });
    expect(verdict.kind).toBe("hits");
  });
});
