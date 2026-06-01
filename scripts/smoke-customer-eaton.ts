import path from "node:path";
import { fileURLToPath } from "node:url";
import { CustomerDocumentParseCache, extractCustomerDocumentAttributes, applyCustomerDocumentOverride } from "../src/server/scrapers/customer-documents.js";
import type { CustomerDocumentRecord, ProductResult } from "../src/shared/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const pdfPath = path.join(rootDir, "PDFs and DOCs form customer", "eaton-e6-catalogue-en-cn.pdf");

const customerDoc: CustomerDocumentRecord = {
  id: "smoke-eaton",
  originalName: "eaton-e6-catalogue-en-cn.pdf",
  storedPath: pdfPath,
  mimeType: "application/pdf",
  uploadedAt: new Date().toISOString()
};

const catalogNumbers = ["CBE04417", "CBE04418", "CBE04419", "CBE04420", "CBE04425", "CBE04430", "CBE04436"];

const baseline: ProductResult = {
  manufacturerId: "eaton",
  catalogNumber: "",
  status: "failed",
  confidence: 0,
  normalized: {},
  attributes: [],
  documents: [],
  sources: [],
  error: "Not found on website"
};

const cache = new CustomerDocumentParseCache();

const startAll = performance.now();
for (const catalogNumber of catalogNumbers) {
  const startOne = performance.now();
  const extraction = await extractCustomerDocumentAttributes(catalogNumber, [customerDoc], {
    cache,
    onProgress: (event) => {
      if (event.kind === "scan-pdf-page") {
        process.stdout.write(`    [${catalogNumber}] page ${event.pageNumber}/${event.totalPages ?? "?"}, ${event.matchesSoFar} match(es)\n`);
      }
    }
  });
  const result = applyCustomerDocumentOverride({ ...baseline, catalogNumber }, extraction);
  const elapsed = (performance.now() - startOne).toFixed(0);
  console.log(`${catalogNumber}: status=${result.status}, attrs=${result.attributes.length}, docs=${result.documents.length}, elapsed=${elapsed}ms`);
}
const total = (performance.now() - startAll).toFixed(0);
console.log(`\nTotal for ${catalogNumbers.length} catalogs: ${total}ms`);
