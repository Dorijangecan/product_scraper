import type { AttributeRecord, DocumentRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";
import { emptyResult, normalizeFields } from "./normalizer.js";
import { scrapeDiscoveredFallback, withDiscoveryFallbackDiagnostics } from "./discovery-fallback.js";

const ETA_PARSER_VERSION = "eta-v1";

interface EtaFamilyRule {
  name: string;
  pattern: RegExp;
  productUrl: string;
  datasheetUrl: string;
  type: string;
  voltage?: string;
  current?: string;
  description: string;
}

const ETA_FAMILY_RULES: EtaFamilyRule[] = [
  {
    name: "eta-3120-f-datasheet",
    pattern: /^3120-F/i,
    productUrl: "https://global.e-t-a.com/products/circuit_protection_devices/thermal_overcurrent_circuit_breakers/p/3120_f/",
    datasheetUrl:
      "https://www.e-t-a.com/fileadmin/user_upload/Ordnerstruktur/pdf-Data/Products/Schutzschalter_Sicherungsautomaten/Thermisch/2_en/D_3120-F_en.pdf",
    type: "Circuit Breaker",
    voltage: "AC 240 V / DC 50 V",
    current: "0.1...20 A",
    description: "Thermal circuit breaker"
  },
  { name: "eta-3120-n", pattern: /^3120-N/i, productUrl: "https://global.e-t-a.com/products/circuit_protection_devices/thermal_overcurrent_circuit_breakers/p/3120_n/", datasheetUrl: "https://www.e-t-a.com/fileadmin/user_upload/Ordnerstruktur/pdf-Data/Products/Schutzschalter_Sicherungsautomaten/Thermisch/2_en/D_3120-N_en.pdf", type: "Circuit Breaker", voltage: "AC 240 V / DC 50 V", current: "0.1...20 A", description: "Thermal circuit breaker/switch combination" },
  { name: "eta-esx10-tb", pattern: /^ESX10-TB/i, productUrl: "https://global.e-t-a.com/products/electronic_overcurrent_protection/electronic_overcurrent_protection_dc/", datasheetUrl: "https://www.e-t-a.com/fileadmin/user_upload/Ordnerstruktur/pdf-Data/Products/Elek_Ueberstromschutz/DC/2_en/D_ESX10_en.pdf", type: "Circuit Breaker", voltage: "DC 24 V", current: "16 A", description: "Electronic circuit protector" },
  { name: "eta-esx10-tc", pattern: /^ESX10-TC/i, productUrl: "https://global.e-t-a.com/products/electronic_overcurrent_protection/electronic_overcurrent_protection_dc/p/esx10_tc_dc_48_v/", datasheetUrl: "https://global.e-t-a.com/products/electronic_overcurrent_protection/electronic_overcurrent_protection_dc/p/esx10_tc_dc_48_v/", type: "Circuit Breaker", voltage: "DC 48 V", current: "1...16 A", description: "Electronic circuit protector" },
  { name: "eta-esx60d", pattern: /^ESX60D/i, productUrl: "https://global.e-t-a.com/products/electronic_overcurrent_protection/electronic_overcurrent_protection_dc/p/esx60d/", datasheetUrl: "https://global.e-t-a.com/fileadmin/user_upload/Ordnerstruktur/pdf-Data/Products/Elek_Ueberstromschutz/DC/2_en/D_ESX60D_en.pdf", type: "Circuit Breaker", voltage: "DC 24 V", current: "1...10 A", description: "Smart electronic circuit protector" },
  { name: "eta-esx300-s-plus", pattern: /^ESX300-S\s+plus/i, productUrl: "https://global.e-t-a.com/products/electronic_overcurrent_protection/electronic_overcurrent_protection_dc/p/esx300_s_plus/", datasheetUrl: "https://global.e-t-a.com/products/electronic_overcurrent_protection/electronic_overcurrent_protection_dc/p/esx300_s_plus/", type: "Circuit Breaker", voltage: "DC 24 V / DC 48 V / DC 60 V", current: "2...24 A", description: "Electronic circuit protector" },
  { name: "eta-rex12-t", pattern: /^REX12-T/i, productUrl: "https://global.e-t-a.com/products/electronic_overcurrent_protection/electronic_overcurrent_protection_dc/p/rex12_t/", datasheetUrl: "https://www.e-t-a.com/fileadmin/user_upload/Ordnerstruktur/pdf-Data/Products/Elek_Ueberstromschutz/DC/2_en/D_REX12-T_en.pdf", type: "Circuit Breaker", voltage: "DC 24 V", current: "1...10 A", description: "Electronic circuit protector" },
  { name: "eta-rex22d-t", pattern: /^REX22D-T/i, productUrl: "https://www.e-t-a.com/products/circuit_protection_devices/electronic_overcurrent_protection/p/rex22d_t/", datasheetUrl: "https://global.e-t-a.com/fileadmin/user_upload/Ordnerstruktur/pdf-Data/Products/int_Stromverteilung/ControlPlex_DINrail/2_en/D_REX22D-T_en.pdf", type: "Circuit Breaker", voltage: "DC 24 V", current: "1...20 A", description: "Intelligent electronic circuit protector" },
  { name: "eta-em12d-tio", pattern: /^EM12D-TIO/i, productUrl: "https://global.e-t-a.com/products/power_distribution_systems/intelligent_power_distribution_systems/controlplex_overview/controlplex_dinrail/power_supply_modules/", datasheetUrl: "https://global.e-t-a.com/products/power_distribution_systems/intelligent_power_distribution_systems/controlplex_overview/controlplex_dinrail/power_supply_modules/", type: "Power Supply", voltage: "DC 24 V", description: "IO-Link-capable ControlPlex power supply module" },
  { name: "eta-smps-t-20a", pattern: /^SMPS-T\s*20A/i, productUrl: "https://global.e-t-a.com/products/switch_mode_power_supply_units/1_phase_switch_mode_power_supplies/p/smps_t_20a/", datasheetUrl: "https://global.e-t-a.com/products/switch_mode_power_supply_units/1_phase_switch_mode_power_supplies/p/smps_t_20a/", type: "Power Supply", voltage: "AC 120...240 V input / DC 24 V output", current: "20 A", description: "1-phase switch mode power supply" },
  { name: "eta-pfa10-t-20a-24v", pattern: /^PFA10-T\s*20\s*A,?\s*DC\s*24\s*V/i, productUrl: "https://global.e-t-a.com/products/switch_mode_power_supply_units/3_phase_switch_mode_power_supplies/p/pfa10_t_20_a_dc_24_v/", datasheetUrl: "https://global.e-t-a.com/products/switch_mode_power_supply_units/3_phase_switch_mode_power_supplies/p/pfa10_t_20_a_dc_24_v/", type: "Power Supply", voltage: "AC 400...480 V input / DC 24 V output", current: "20 A", description: "3-phase switch mode power supply" }
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
      sourceUrl: rule.productUrl
    },
    {
      group: "ETA Product Data",
      name: "Product Type",
      value: rule.type,
      sourceUrl: rule.productUrl
    },
    {
      group: "ETA Product Data",
      name: "Description",
      value: rule.description,
      sourceUrl: rule.productUrl
    }
  ].map(stampAttribute);
  if (rule.voltage) attributes.push(stampAttribute({ group: "ETA Technical Data", name: "Rated Voltage", value: rule.voltage, sourceUrl: rule.productUrl }));
  if (rule.current) attributes.push(stampAttribute({ group: "ETA Technical Data", name: "Rated Current", value: rule.current, sourceUrl: rule.productUrl }));
  const documents: DocumentRecord[] = [
    stampDocument({
      type: "datasheet",
      label: "ETA family datasheet",
      url: rule.datasheetUrl,
      sourceUrl: rule.productUrl
    })
  ];
  const sources: SourceRecord[] = [
    {
      url: rule.productUrl,
      sourceType: "official-fallback",
      parser: rule.name,
      parserVersion: ETA_PARSER_VERSION,
      stage: "family-datasheet-rule",
      reason: "ETA official product family page and datasheet identify the orderable family and published ratings.",
      fetchedAt
    }
  ];

  return {
    manufacturerId: "eta",
    catalogNumber,
    status: "partial",
    confidence: 0.62,
    productUrl: rule.productUrl,
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
