import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { queryFixtureCandidates, type FixtureExtractOptions } from "../scripts/extract-page-fixtures.js";

function options(overrides: Partial<FixtureExtractOptions> = {}): FixtureExtractOptions {
  return { help: false, list: false, includeNonFound: false, limit: 3, ...overrides };
}

describe("page-fixture candidate selection", () => {
  it("narrows vendor and catalog in SQL before the cache-file existence pass", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE runs (id TEXT PRIMARY KEY, manufacturer_id TEXT NOT NULL);
        CREATE TABLE run_items (run_id TEXT NOT NULL, catalog_number TEXT NOT NULL, product_url TEXT, status TEXT NOT NULL);
        CREATE TABLE page_cache (url TEXT NOT NULL, effective_url TEXT, path TEXT NOT NULL, content_type TEXT, status_code INTEGER);
      `);
      db.exec(`
        INSERT INTO runs VALUES ('alpha-run', 'alpha'), ('beta-run', 'beta');
        INSERT INTO run_items VALUES
          ('alpha-run', 'A-100', 'https://alpha.test/products/A-100', 'found'),
          ('alpha-run', 'A-200', 'https://alpha.test/products/A-200', 'found'),
          ('beta-run', 'B-100', 'https://beta.test/products/B-100', 'found');
        INSERT INTO page_cache VALUES
          ('https://alpha.test/products/A-100', NULL, 'cache/a-100.html', 'text/html', 200),
          ('https://alpha.test/products/A-200', NULL, 'cache/a-200.html', 'text/html', 200),
          ('https://beta.test/products/B-100', NULL, 'cache/b-100.html', 'text/html', 200);
      `);

      expect(queryFixtureCandidates(db, options({ vendor: "alpha", catalog: "A-100" }))).toEqual([
        expect.objectContaining({ manufacturerId: "alpha", catalogNumber: "A-100", cachePath: "cache/a-100.html" })
      ]);
      expect(queryFixtureCandidates(db, options({ vendor: "beta" }))).toEqual([
        expect.objectContaining({ manufacturerId: "beta", catalogNumber: "B-100" })
      ]);
    } finally {
      db.close();
    }
  });
});
