import type { AttributeRecord, DocumentRecord, FallbackSourceConfig, ProductResult, SourceRecord } from "../../shared/types.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";
import { emptyResult, normalizeFields } from "./normalizer.js";
import { scrapeDiscoveredFallback, withDiscoveryFallbackDiagnostics } from "./discovery-fallback.js";

const ETA_PARSER_VERSION = "eta-v1";

interface EtaDirectProductRoute {
  id: string;
  pattern: RegExp;
  url: (catalogNumber: string) => string;
}

// Official product-page routes learned from isolated ETA cold batches. The generic parser still
// has to find the exact requested catalog number in the page before it returns a result.
const ETA_DIRECT_PRODUCT_ROUTES: EtaDirectProductRoute[] = [
  {
    id: "eta-product-mru10-monitoring-reporting-unit",
    pattern: /^MRU10$/i,
    url: () => "https://www.e-t-a.com/products/power_management_systems/rack_mount_power_management_systems/p/monitoring_reporting_unit_mru10/"
  },
  {
    id: "eta-product-1610-92-automotive-circuit-protector",
    pattern: /^1610-92$/i,
    url: () => "https://www.e-t-a.com/products/circuit_protection_devices/thermal_overcurrent_circuit_breakers/p/1610_92/"
  },
  {
    id: "eta-product-e-1048-8i-smart-power-relay",
    pattern: /^E-1048-8I$/i,
    url: () => "https://global.e-t-a.com/products/relays_ssrpcs/solid_state_remote_power_controllers/p/e_1048_8i/"
  },
  {
    id: "eta-product-x3120-power-entry-module",
    pattern: /^X3120$/i,
    url: () => "https://www.e-t-a.com/products/circuit_protection_devices/power_entry_modules/p/x3120/"
  },
  {
    id: "eta-product-mm500-power-distribution-module",
    pattern: /^MM500$/i,
    // The English overview route is indexed but returns 404. The German exact-product page is live
    // and publishes the SKU, ratings, image and datasheet.
    url: () => "https://www.e-t-a.de/produkte/stromverteilungssysteme/intelligente_stromverteilung/powerplex/produktuebersicht/p/powerplex_mini_modul_mm500/"
  },
  {
    id: "eta-product-2210-s2-breaker",
    pattern: /^2210-S2(?:[A-Z0-9-]+)?$/i,
    url: () => "https://www.e-t-a.com/products/circuit_protection_devices/thermal_magnetic_overcurrent_circuit_breakers/p/2210_s2/"
  },
  {
    id: "eta-product-cpc20-bus-controller",
    pattern: /^CPC20(?:[- ]?(?:EN|PN))?(?:[- ][A-Z0-9-]+)?$/i,
    url: () => "https://www.e-t-a.com/products/power_distribution_systems/intelligent_power_distribution_systems/controlplex_overview/controlplex_dinrail/bus_controllers/p/cpc20/"
  },
  {
    id: "eta-product-module-18plus-power-distribution",
    pattern: /^Module\s*18plus$/i,
    url: () => "https://www.e-t-a.com/solutions/automation_process_control/car_production/p/modul_18plus/"
  },
  {
    id: "eta-product-mpr20-power-relay",
    pattern: /^MPR20$/i,
    url: () => "https://www.e-t-a.com/products/relays_solid_state_remote_power_controllers/power_relays/p/mpr20/"
  },
  {
    id: "eta-product-pfa10-t-40a-24v",
    pattern: /^PFA10-T\s*40\s*A,?\s*DC\s*24\s*V$/i,
    url: () => "https://www.e-t-a.com/products/power_supplies/3_phase_switch_mode_power_supply_units/p/pfa10_t_40_a_dc_24_v/"
  },
  {
    id: "eta-direct-thermal-overcurrent-breaker",
    pattern: /^2-\d{4}$/i,
    url: (catalogNumber) => `https://global.e-t-a.com/products/circuit_protection_devices/thermal_overcurrent_circuit_breakers/p/${etaSlug(catalogNumber)}/`
  },
  {
    id: "eta-direct-solid-state-power-controller",
    pattern: /^E-1072-\d+$/i,
    url: (catalogNumber) => `https://global.e-t-a.com/products/relays_ssrpcs/solid_state_remote_power_controllers/p/${etaSlug(catalogNumber)}/`
  },
  {
    id: "eta-direct-controlplex-bus-controller",
    pattern: /^CPC12(?:EC|EN|MB|PN)?$/i,
    url: () => "https://global.e-t-a.com/products/power_distribution_systems/intelligent_power_distribution_systems/controlplex_overview/controlplex_dinrail/bus_controllers/p/cpc12/"
  },
  {
    id: "eta-direct-scsr-control-system",
    pattern: /^SCS1000-\d+HS$/i,
    url: () => "https://global.e-t-a.com/products/power_distribution_systems/intelligent_power_distribution_systems/scsr_smart_control_systems/scsr_smart_control_systems_products/p/scs1000/"
  },
  {
    id: "eta-direct-power-entry-module",
    pattern: /^X31\d{2}$/i,
    url: (catalogNumber) => `https://global.e-t-a.com/products/circuit_protection_devices_thermal_thermal_magnetic_magnetic_high_performance_electronic/power_entry_modules/p/${etaSlug(catalogNumber)}/`
  },
  {
    id: "eta-direct-smps-t-10a",
    pattern: /^SMPS-T\s*10A$/i,
    url: () => "https://www.e-t-a.com/products/power_supplies/1_phase_switch_mode_power_supplies/p/smps_t_10a/"
  },
  {
    id: "eta-direct-battery-isolation-switch",
    pattern: /^E-1073-\d+$/i,
    url: (catalogNumber) => `https://global.e-t-a.com/products/circuit_protection_devices_thermal_thermal_magnetic_magnetic_high_performance_electronic/battery_isolation_switches/p/${etaSlug(catalogNumber)}/`
  },
  {
    id: "eta-direct-eai300-interface",
    pattern: /^EAI300$/i,
    url: () => "https://www.e-t-a.com/products/circuit_protection_devices/electronic_overcurrent_protection/p/eai300/"
  },
  {
    id: "eta-direct-hvr10-high-voltage-relay",
    pattern: /^HVR10$/i,
    url: () => "https://www.e-t-a.com/products/relays_ssrpcs/high_voltage_relay/p/hvr10/"
  }
];

interface EtaFamilyRule {
  name: string;
  pattern: RegExp;
  productUrl: string;
  datasheetUrl: string;
  identitySourceUrl?: string;
  technicalSourceUrl?: string;
  imageUrl?: string;
  datasheetLabel?: string;
  type: string;
  voltage?: string;
  current?: string;
  description: string;
  attributes?: Array<{ name: string; value: string }>;
}

const ETA_FAMILY_RULES: EtaFamilyRule[] = [
  {
    name: "eta-4230-t110-k0ce-10a-ordering-example",
    pattern: /^4230-T110-K0CE-10A$/i,
    productUrl: "https://global.e-t-a.com/products/circuit_protection_devices/thermal_magnetic_overcurrent_circuit_breakers/p/4230_t_ul_1077_en_60947_2/",
    datasheetUrl: "https://www.e-t-a.com/fileadmin/user_upload/Ordnerstruktur/pdf-Data/Products/Schutzschalter_Sicherungsautomaten/Therm_magn/2_en/D_4230-T_en.pdf",
    identitySourceUrl: "https://www.e-t-a.com/fileadmin/user_upload/Ordnerstruktur/pdf-Data/Products/Schutzschalter_Sicherungsautomaten/Therm_magn/2_en/D_4230-T_en.pdf",
    technicalSourceUrl: "https://www.e-t-a.com/fileadmin/user_upload/Ordnerstruktur/pdf-Data/Products/Schutzschalter_Sicherungsautomaten/Therm_magn/2_en/D_4230-T_en.pdf",
    imageUrl: "https://global.e-t-a.com/fileadmin/_processed_/c/b/csm_4230-T_UL_1077_EN_60947-2_0868170b2c.png",
    type: "Miniature Circuit Breaker",
    voltage: "AC 240 V / DC 80 V",
    current: "10 A",
    description: "Single-pole 4230-T thermal-magnetic miniature circuit breaker, C characteristic, IEC/EN 60947-2 and UL 1077",
    attributes: [
      { name: "Ordering code", value: "4230-T110-K0CE-10A" },
      { name: "Number of poles", value: "1 pole" },
      { name: "Trip characteristic", value: "C" },
      { name: "Mounting method", value: "DIN rail" },
      { name: "Rated current", value: "10 A" }
    ]
  },
  {
    name: "eta-scs1000-16hs-exact-datasheet",
    pattern: /^SCS1000-16HS$/i,
    productUrl: "https://global.e-t-a.com/products/power_distribution_systems/intelligent_power_distribution_systems/scsr_smart_control_systems/scsr_smart_control_systems_products/p/scs1000/",
    datasheetUrl: "https://www.e-t-a.com/fileadmin/user_upload/Ordnerstruktur/pdf-Data/Products/int_Stromverteilung/Smart_Control_System_SCS/2_en/D_SCS1000_en.pdf",
    identitySourceUrl: "https://www.e-t-a.com/fileadmin/user_upload/Ordnerstruktur/pdf-Data/Products/int_Stromverteilung/Smart_Control_System_SCS/2_en/D_SCS1000_en.pdf",
    technicalSourceUrl: "https://www.e-t-a.com/fileadmin/user_upload/Ordnerstruktur/pdf-Data/Products/int_Stromverteilung/Smart_Control_System_SCS/2_en/D_SCS1000_en.pdf",
    imageUrl: "https://global.e-t-a.com/fileadmin/_processed_/4/1/csm_SCS1000_cab4a314dd.png",
    datasheetLabel: "ETA SCS1000-16HS datasheet",
    type: "Power Distribution Unit",
    voltage: "DC 12 V / 24 V",
    current: "160 A",
    description: "SCS1000 smart control system with 16 load outputs",
    attributes: [
      { name: "Number of load outputs", value: "16" },
      { name: "High-side outputs", value: "4 x 32.5 A" },
      { name: "Additional outputs", value: "12 x 15 A" },
      { name: "Input voltage range", value: "DC 9 V ... 32 V" },
      { name: "Degree of protection", value: "IP67" },
      { name: "Ambient temperature", value: "-40 ... +85 °C" },
      { name: "Mass", value: "580 g" },
      { name: "Dimensions", value: "174 mm x 116 mm x 51.7 mm" },
      { name: "Housing", value: "Aluminium die-cast" }
    ]
  },
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
  const directRoute = ETA_DIRECT_PRODUCT_ROUTES.find((candidate) => candidate.pattern.test(catalogNumber));
  if (directRoute) {
    const direct = await scrapeEtaDirectProductPage(catalogNumber, context, directRoute);
    if (direct) return direct;
    const failed = emptyResult(
      "eta",
      catalogNumber,
      `The learned ETA product page for ${catalogNumber} did not return an exact-catalog result; broad discovery was skipped.`
    );
    failed.diagnostics = {
      terminal: { reason: "learned-eta-product-route-unavailable-or-identity-unconfirmed", skipNetworkFallback: true }
    };
    return failed;
  }

  const { result, discovery } = await scrapeDiscoveredFallback(catalogNumber, context, { idPrefix: "eta" });
  return withDiscoveryFallbackDiagnostics(
    result ?? emptyResult("eta", catalogNumber, `No ETA family datasheet rule matched ${catalogNumber} and official discovery found no parseable product page.`),
    discovery
  );
}

async function scrapeEtaDirectProductPage(
  catalogNumber: string,
  context: ScrapeContext,
  route: EtaDirectProductRoute
): Promise<ProductResult | undefined> {
  const source: FallbackSourceConfig = {
    id: route.id,
    label: `ETA ${route.id.replace(/^eta-direct-/, "").replace(/-/g, " ")} product page`,
    enabled: true,
    sourceType: "official-fallback",
    directUrlTemplates: [route.url(catalogNumber)],
    match: { compact: true, ignoreCase: true, requireCatalogNumber: true },
    fetchPolicy: { timeoutMs: 5000, maxAttempts: 1, minContentLength: 1000 },
    ...( /^E-1073-\d+$/i.test(catalogNumber) ? {
      markerRules: [
        {
          name: "Current ratings",
          start: "Current ratings </th> <td> from ",
          end: ` ${catalogNumber}`,
          group: "Technical Data",
          normalizeWhitespace: true,
          // The table row itself contains the requested E-1073 type code, so its range belongs
          // to this exact configured model even though the page also lists other pole options.
          scope: "variant"
        },
        {
          name: "Battery protection option",
          start: "Available with ",
          end: " option",
          group: "Features",
          scope: "family"
        }
      ]
    } : {}),
    confidence: 0.88
  };

  try {
    const result = await context.fallback.scrape(catalogNumber, [source]);
    if (process.env.DEBUG_ETA_TIMINGS === "1") console.info(`[eta:timing] ${route.id} connector returned status=${result?.status ?? "undefined"} attrs=${result?.attributes.length ?? 0} docs=${result?.documents.length ?? 0}`);
    // GenericFallbackScraper can return a useful partial before the run-level quality gate is
    // applied. Its required catalog match already proved exact identity for this single source.
    if (!result || result.status === "failed" || !result.productUrl) return undefined;
    return { ...result, documents: etaRelevantDirectDocuments(catalogNumber, etaVariantDocuments(catalogNumber, result.documents)) };
  } catch {
    // The caller turns route errors or identity misses into a terminal fail-closed result.
    return undefined;
  }
}

function etaRelevantDirectDocuments(catalogNumber: string, documents: DocumentRecord[]): DocumentRecord[] {
  const e1073 = catalogNumber.match(/^E-1073-\d+$/i)?.[0].toUpperCase();
  return documents.flatMap((document) => {
    if (document.type === "image") {
      if (!e1073) return [document];
      const codes = [...`${document.label} ${document.url}`.matchAll(/E-1073-\d+/gi)].map(([code]) => code.toUpperCase());
      // E-T-A sometimes puts an image for a related E-1073 variant on the requested model's
      // exact PDP. Keep it out unless both its label and asset identify only this exact model.
      return codes.length > 0 && codes.every((code) => code === e1073) ? [document] : [];
    }

    let pathname = "";
    try {
      pathname = new URL(document.url).pathname;
    } catch {
      return [];
    }
    if (!/\.pdf$/i.test(pathname)) return [];
    const compactSku = catalogNumber.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const compactEvidence = `${document.label} ${document.url}`.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const exactProductLibraryPdf =
      /\/fileadmin\/user_upload\/Ordnerstruktur\/pdf-Data\/Products\//i.test(pathname) && compactEvidence.includes(compactSku);
    if (exactProductLibraryPdf && (document.type === "other" || document.type === "certificate")) {
      // ETA's German PDP labels the exact product-library PDF "Datenblatt", but the generic
      // classifier leaves that German label as "other". Exact SKU + product-data path is enough
      // to recognize this linked technical datasheet without promoting general certificates.
      return [{ ...document, type: "datasheet" }];
    }
    if (document.type === "datasheet" || document.type === "manual") {
      // Only download actual product-library PDFs. Generic support links, JS download buttons,
      // navigation pages, and unrelated company-wide certificates were being parsed as docs.
      return /\/fileadmin\/user_upload\/Ordnerstruktur\/pdf-Data\/Products\//i.test(pathname) || compactEvidence.includes(compactSku)
        ? [document]
        : [];
    }
    if (document.type === "certificate") {
      return compactEvidence.includes(compactSku) ? [document] : [];
    }
    return [];
  });
}

function etaVariantDocuments(catalogNumber: string, documents: DocumentRecord[]): DocumentRecord[] {
  const match = catalogNumber.match(/^CPC12(EC|EN|MB|PN)$/i);
  if (!match) return documents;
  const requestedVariant = match[1].toUpperCase();
  return documents.filter((document) => {
    const variants = [...`${document.label} ${document.url}`.matchAll(/CPC12(EC|EN|MB|PN)/gi)]
      .map((variant) => variant[1].toUpperCase());
    return variants.every((variant) => variant === requestedVariant);
  });
}

function etaSlug(catalogNumber: string): string {
  return catalogNumber.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function buildEtaDatasheetResult(catalogNumber: string, rule: EtaFamilyRule): ProductResult {
  const fetchedAt = new Date().toISOString();
  const attributes: AttributeRecord[] = [
    {
      group: "ETA datasheet identity",
      name: "Catalog Number",
      value: catalogNumber,
      sourceUrl: rule.identitySourceUrl ?? rule.productUrl
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
  if (rule.voltage) attributes.push(stampAttribute({ group: "ETA Technical Data", name: "Rated Voltage", value: rule.voltage, sourceUrl: rule.technicalSourceUrl ?? rule.productUrl }));
  if (rule.current) attributes.push(stampAttribute({ group: "ETA Technical Data", name: "Rated Current", value: rule.current, sourceUrl: rule.technicalSourceUrl ?? rule.productUrl }));
  for (const attribute of rule.attributes ?? []) {
    attributes.push(stampAttribute({ group: "ETA Technical Data", ...attribute, sourceUrl: rule.technicalSourceUrl ?? rule.productUrl }));
  }
  const documents: DocumentRecord[] = [
    stampDocument({
      type: "datasheet",
      label: rule.datasheetLabel ?? "ETA family datasheet",
      url: rule.datasheetUrl,
      sourceUrl: rule.productUrl
    })
  ];
  if (rule.imageUrl) {
    documents.push(stampDocument({
      type: "image",
      label: `E-T-A ${catalogNumber} product image`,
      url: rule.imageUrl,
      sourceUrl: rule.productUrl
    }));
  }
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
  if (rule.identitySourceUrl || rule.technicalSourceUrl) {
    sources.push({
      url: rule.technicalSourceUrl ?? rule.identitySourceUrl ?? rule.datasheetUrl,
      sourceType: "official-fallback",
      parser: rule.name,
      parserVersion: ETA_PARSER_VERSION,
      stage: "exact-model-datasheet",
      reason: "The official ETA datasheet supports the exact requested model and the published technical ratings.",
      fetchedAt
    });
  }

  const normalized = normalizeFields(attributes, documents);
  if (rule.technicalSourceUrl) {
    if (rule.voltage) normalized.voltage = rule.voltage;
    if (rule.current) normalized.current = rule.current;
  }

  return {
    manufacturerId: "eta",
    catalogNumber,
    status: "partial",
    confidence: 0.62,
    productUrl: rule.productUrl,
    normalized,
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
