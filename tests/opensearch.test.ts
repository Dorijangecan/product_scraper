import { describe, expect, it } from "vitest";
import { fillOpenSearchTemplate, openSearchDescriptionUrls, openSearchTemplates } from "../src/server/scrapers/opensearch.js";

describe("openSearchDescriptionUrls", () => {
  it("finds the autodiscovery link and resolves it against the page", () => {
    const html = `<html><head>
      <link rel="search" type="application/opensearchdescription+xml" title="Vendor" href="/opensearch.xml">
    </head><body></body></html>`;
    expect(openSearchDescriptionUrls(html, "https://vendor.test/en/")).toEqual(["https://vendor.test/opensearch.xml"]);
  });

  // rel is a space-separated token list, not a single value.
  it("accepts a multi-token rel", () => {
    const html = `<link rel="alternate search" type="application/opensearchdescription+xml" href="https://vendor.test/os.xml">`;
    expect(openSearchDescriptionUrls(html, "https://vendor.test/")).toEqual(["https://vendor.test/os.xml"]);
  });

  it("ignores other rel=search links and malformed hrefs", () => {
    const html = `<head>
      <link rel="search" type="application/rss+xml" href="/feed.xml">
      <link rel="stylesheet" type="application/opensearchdescription+xml" href="/nope.xml">
      <link rel="search" type="application/opensearchdescription+xml" href="::::">
    </head>`;
    expect(openSearchDescriptionUrls(html, "https://vendor.test/")).toEqual([]);
  });
});

describe("openSearchTemplates", () => {
  const xml = `<?xml version="1.0"?>
    <OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
      <ShortName>Vendor</ShortName>
      <Url type="text/html" template="https://vendor.test/en/search?q={searchTerms}"/>
      <Url type="application/x-suggestions+json" template="/api/suggest?term={searchTerms}"/>
      <Url type="application/rss+xml" template="https://vendor.test/rss?q={searchTerms}"/>
    </OpenSearchDescription>`;

  it("separates the results page from the suggest endpoint and resolves relative templates", () => {
    const templates = openSearchTemplates(xml, "https://vendor.test/opensearch.xml");
    expect(templates.html).toEqual(["https://vendor.test/en/search?q={searchTerms}"]);
    expect(templates.suggestions).toEqual(["https://vendor.test/api/suggest?term={searchTerms}"]);
  });

  // `type` is required by the spec and routinely omitted in the wild; an untyped Url in a catalogue's
  // description is its search page.
  it("treats an untyped Url as the html results page", () => {
    const untyped = `<OpenSearchDescription><Url template="https://vendor.test/s?k={searchTerms}"/></OpenSearchDescription>`;
    expect(openSearchTemplates(untyped, "https://vendor.test/os.xml").html).toEqual(["https://vendor.test/s?k={searchTerms}"]);
  });

  it("returns nothing for a document that is not an OpenSearch description", () => {
    expect(openSearchTemplates("<html><body>not xml</body></html>", "https://vendor.test/x")).toEqual({ html: [], suggestions: [] });
  });
});

describe("fillOpenSearchTemplate", () => {
  it("substitutes the catalog number, url-encoded", () => {
    expect(fillOpenSearchTemplate("https://vendor.test/search?q={searchTerms}", "GN 3310-19-LK-K2")).toBe(
      "https://vendor.test/search?q=GN%203310-19-LK-K2"
    );
  });

  it("supplies values for the standard paging and encoding parameters", () => {
    const filled = fillOpenSearchTemplate("https://vendor.test/s?q={searchTerms}&n={count}&i={startIndex}&e={outputEncoding}", "ABC-1");
    expect(filled).toBe("https://vendor.test/s?q=ABC-1&n=10&i=1&e=UTF-8");
  });

  it("drops optional parameters instead of sending them empty", () => {
    expect(fillOpenSearchTemplate("https://vendor.test/s?q={searchTerms}&geo={geo:name?}", "ABC-1")).toBe("https://vendor.test/s?q=ABC-1");
  });

  // A template still carrying `{...}` is not a URL. Sending it spends a request to learn nothing,
  // which is the same reason discovery refuses to treat a guess as evidence.
  it("refuses a template whose required parameter we cannot honestly fill", () => {
    expect(fillOpenSearchTemplate("https://vendor.test/s?q={searchTerms}&cust={vendor:customerId}", "ABC-1")).toBeUndefined();
  });

  it("refuses a template that never asks for the search terms", () => {
    expect(fillOpenSearchTemplate("https://vendor.test/promo", "ABC-1")).toBeUndefined();
  });

  it("refuses a non-http template", () => {
    expect(fillOpenSearchTemplate("ftp://vendor.test/s?q={searchTerms}", "ABC-1")).toBeUndefined();
  });
});
