import type { AttributeRecord, DocumentRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";
import { emptyResult, normalizeFields } from "./normalizer.js";

const ETA_PARSER_VERSION = "eta-v1";

interface EtaFamilyRule {
  name: string;
  pattern: RegExp;
  family: string;
  title: string;
  datasheetUrl: string;
}

const ETA_FAMILY_RULES: EtaFamilyRule[] = [
  {
    name: "eta-3120-f-datasheet",
    pattern: /^3120-F/i,
    family: "3120-F",
    title: "Thermal Circuit Breaker 3120-F",
    datasheetUrl:
      "https://www.e-t-a.com/fileadmin/user_upload/Ordnerstruktur/pdf-Data/Products/Schutzschalter_Sicherungsautomaten/Thermisch/2_en/D_3120-F_en.pdf"
  }
];

export class ETAConnector implements ManufacturerConnector {
  readonly id = "eta";

  async scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
    const rule = ETA_FAMILY_RULES.find((candidate) => candidate.pattern.test(catalogNumber));
    if (!rule) {
      const fallback = await context.fallback.scrape(catalogNumber, context.manufacturer.fallbackSources);
      return fallback ?? emptyResult("eta", catalogNumber, `No ETA family datasheet rule matched ${catalogNumber}.`);
    }
    return buildEtaDatasheetResult(catalogNumber, rule);
  }
}

function buildEtaDatasheetResult(catalogNumber: string, rule: EtaFamilyRule): ProductResult {
  const fetchedAt = new Date().toISOString();
  const attributes: AttributeRecord[] = [
    {
      group: "ETA datasheet identity",
      name: "Catalog Number",
      value: catalogNumber,
      sourceUrl: rule.datasheetUrl
    },
    {
      group: "ETA datasheet identity",
      name: "Product Family",
      value: rule.family,
      sourceUrl: rule.datasheetUrl
    },
    {
      group: "ETA datasheet identity",
      name: "Description",
      value: rule.title,
      sourceUrl: rule.datasheetUrl
    }
  ].map(stampAttribute);
  const documents: DocumentRecord[] = [
    stampDocument({
      type: "datasheet",
      label: rule.title,
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
    confidence: 0.72,
    productUrl: rule.datasheetUrl,
    title: rule.title,
    description: `${rule.title}; orderable variant ${catalogNumber}`,
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
