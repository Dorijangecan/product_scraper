import type { AttributeRecord, DocumentRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";
import { emptyResult, normalizeFields } from "./normalizer.js";
import { scrapeDiscoveredFallback, withDiscoveryFallbackDiagnostics } from "./discovery-fallback.js";

const ETA_PARSER_VERSION = "eta-v1";

interface EtaFamilyRule {
  name: string;
  pattern: RegExp;
  datasheetUrl: string;
}

const ETA_FAMILY_RULES: EtaFamilyRule[] = [
  {
    name: "eta-3120-f-datasheet",
    pattern: /^3120-F/i,
    datasheetUrl:
      "https://www.e-t-a.com/fileadmin/user_upload/Ordnerstruktur/pdf-Data/Products/Schutzschalter_Sicherungsautomaten/Thermisch/2_en/D_3120-F_en.pdf"
  }
];

export class ETAConnector implements ManufacturerConnector {
  readonly id = "eta";

  async scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
    const rule = ETA_FAMILY_RULES.find((candidate) => candidate.pattern.test(catalogNumber));
    if (!rule) {
      return scrapeEtaUnknownFamily(catalogNumber, context);
    }
    return buildEtaDatasheetResult(catalogNumber, rule);
  }
}

async function scrapeEtaUnknownFamily(catalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
  const { result, discovery } = await scrapeDiscoveredFallback(catalogNumber, context, { idPrefix: "eta" });
  return withDiscoveryFallbackDiagnostics(
    result ?? emptyResult("eta", catalogNumber, `No ETA family datasheet rule matched ${catalogNumber} and official discovery found no parseable product page.`),
    discovery
  );
}

function buildEtaDatasheetResult(catalogNumber: string, rule: EtaFamilyRule): ProductResult {
  const fetchedAt = new Date().toISOString();
  const attributes: AttributeRecord[] = [
    {
      group: "ETA datasheet identity",
      name: "Catalog Number",
      value: catalogNumber,
      sourceUrl: rule.datasheetUrl
    }
  ].map(stampAttribute);
  const documents: DocumentRecord[] = [
    stampDocument({
      type: "datasheet",
      label: "ETA family datasheet",
      url: rule.datasheetUrl,
      sourceUrl: rule.datasheetUrl
    })
  ];
  const sources: SourceRecord[] = [
    {
      url: rule.datasheetUrl,
      sourceType: "official-fallback",
      parser: rule.name,
      parserVersion: ETA_PARSER_VERSION,
      stage: "family-datasheet-rule",
      reason: "ETA publishes many orderable variants in family datasheets instead of exact product pages.",
      fetchedAt
    }
  ];

  return {
    manufacturerId: "eta",
    catalogNumber,
    status: "partial",
    confidence: 0.62,
    productUrl: rule.datasheetUrl,
    normalized: normalizeFields(attributes, documents),
    attributes,
    documents,
    sources
  };
}

function stampAttribute(attribute: AttributeRecord): AttributeRecord {
  return {
    sourceType: "official-fallback",
    parser: "eta-family-datasheet-rule",
    stage: "family-datasheet-rule",
    confidence: 0.78,
    ...attribute
  };
}

function stampDocument(document: DocumentRecord): DocumentRecord {
  return {
    sourceType: "official-fallback",
    parser: "eta-family-datasheet-rule",
    stage: "family-datasheet-rule",
    confidence: 0.78,
    ...document
  };
}
