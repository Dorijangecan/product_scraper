import fs from "node:fs";
import path from "node:path";
import type {
  CustomCoverageField,
  FallbackSourceConfig,
  FetchPolicyConfig,
  LocalizedUrlTemplate,
  ManufacturerConfig,
  ManufacturerId,
  MarkerExtractionRule,
  MatchPolicyConfig,
  ScrapeRecipeConfig
} from "../../shared/types.js";
import { templateContainsCatalogPlaceholder } from "../scrapers/catalog-number.js";

type DiscoveryUrlVariant = NonNullable<NonNullable<ScrapeRecipeConfig["discoveryPolicy"]>["urlVariants"]>[number];
type RequiredNormalizedField = NonNullable<NonNullable<ScrapeRecipeConfig["qualityPolicy"]>["requiredNormalizedFields"]>[number];
type RequiredDocumentType = NonNullable<NonNullable<ScrapeRecipeConfig["qualityPolicy"]>["requiredDocumentTypes"]>[number];

const builtInManufacturerConfigs: Record<string, ManufacturerConfig> = {
  abb: {
    id: "abb",
    canonicalName: "ABB",
    shortName: "ABB",
    rateLimitMs: 1500,
    concurrency: 4,
    officialBaseUrls: [
      "https://new.abb.com/products",
      "https://new.abb.com/smartlinks",
      "https://abb-control-products.partcommunity.com/3d-cad-models/?part={part}"
    ],
    homepageUrl: "https://global.abb/group/en",
    localizedUrlTemplates: [
      { locale: "en", urlTemplate: "https://new.abb.com/smartlinks/en?ProductId={part}&Language=en&PrintPreview=False&pid={part}" },
      { locale: "de", urlTemplate: "https://new.abb.com/smartlinks/de?ProductId={part}&Language=de&PrintPreview=False&pid={part}" }
    ],
    customCoverageFields: [
      {
        id: "abb-rated-control-voltage",
        label: "Rated/control voltage",
        pattern: "rated control circuit voltage|rated voltage|voltage rating|derived voltage range"
      },
      {
        id: "abb-rated-current",
        label: "Rated current",
        pattern: "rated operational current|rated current|conventional thermal current|current rating"
      },
      {
        id: "abb-power-loss-per-pole",
        label: "Power loss / pole",
        pattern: "power loss|power dissipation|power consumption"
      },
      {
        id: "abb-voltage-type",
        label: "Voltage type",
        pattern: "current type|voltage type|rated control circuit voltage|derived voltage type"
      }
    ],
    fallbackSources: [
      {
        id: "abb-empower",
        label: "ABB eCatalog / empower",
        enabled: false,
        sourceType: "official-fallback",
        directUrlTemplates: ["https://empower.abb.com/ecatalog/ec/EN_NA/p/{part}"]
      },
      {
        id: "abblvp-search",
        label: "ABBlvp product search",
        enabled: true,
        sourceType: "official-fallback",
        directUrlTemplates: ["https://abblvp.no/?s={part}"]
      },
      {
        id: "ipd-abb",
        label: "IPD distributor product page",
        enabled: true,
        sourceType: "distributor",
        directUrlTemplates: ["https://www.ipd.com.au/ProductDisplay.aspx?Product={part}"]
      }
    ],
    markerRules: [
      { group: "ABB Legacy Markers", name: "Extended Product Type", start: 'Extended Product Type","values":[{"text":"', end: '"}],"isInternal' },
      { group: "ABB Legacy Markers", name: "Product ID", start: 'Product ID","values":[{"text":"', end: '"}],"isInternal' },
      { group: "ABB Legacy Markers", name: "EAN", start: 'EAN","values":[{"text":"', end: '"}],"isInternal' },
      { group: "ABB Legacy Markers", name: "Catalog Description", start: 'Catalog Description","values":[{"text":"', end: '"}],"isInternal' },
      { group: "ABB Legacy Markers", name: "Long Description", start: 'Long Description","values":[{"text":"', end: '"}],"isInternal' },
      { group: "ABB Legacy Markers", name: "Product Net Width", start: 'Product Net Width","values":[{"text":"', end: '"}],"isInternal' },
      { group: "ABB Legacy Markers", name: "Product Net Height", start: 'Product Net Height","values":[{"text":"', end: '"}],"isInternal' },
      { group: "ABB Legacy Markers", name: "Product Net Depth / Length", start: 'Product Net Depth / Length","values":[{"text":"', end: '"}],"isInternal' },
      { group: "ABB Legacy Markers", name: "Product Net Weight", start: 'Product Net Weight","values":[{"text":"', end: '"}],"isInternal' },
      { group: "ABB Legacy Markers", name: "Rated Current", start: 'Rated Current","values":[{"text":"', end: '"}],"isInternal' },
      { group: "ABB Legacy Markers", name: "Rated Voltage", start: 'Rated Voltage","values":[{"text":"', end: '"}],"isInternal' },
      { group: "ABB Legacy Markers", name: "Product image", start: 'images":[{"url":"', end: '","thumbnailUrl', documentType: "image" }
    ]
  },
  sce: {
    id: "sce",
    canonicalName: "Saginaw Control and Engineering",
    shortName: "SCE",
    rateLimitMs: 1500,
    officialBaseUrls: ["https://www.saginawcontrol.com"],
    // Matches the manual SCE PDT MANUFACTURER_URL column (homepage with trailing slash).
    homepageUrl: "https://www.saginawcontrol.com/",
    localizedUrlTemplates: [
      { locale: "en", urlTemplate: "https://www.saginawcontrol.com/partnumber_info?n={part}" }
    ],
    fallbackSources: [
      {
        id: "kele-sce",
        label: "Kele distributor SKU page",
        enabled: true,
        sourceType: "distributor",
        directUrlTemplates: ["https://www.kele.com/product/sku?kid={partCompact}"]
      }
    ],
    markerRules: [
      { group: "SCE Legacy Markers", name: "Part Number", start: "PartNumber=", end: "' >" },
      { group: "SCE Legacy Markers", name: "Description", start: 'description">', end: "</span" },
      { group: "SCE Legacy Markers", name: "Height", start: "Height</strong>:", end: "</p" },
      { group: "SCE Legacy Markers", name: "Width", start: "Width</strong>:", end: "</p" },
      { group: "SCE Legacy Markers", name: "Depth", start: "Depth</strong>:", end: "</p" },
      { group: "SCE Legacy Markers", name: "Price Code", start: "Price Code</strong>:", end: "</p" },
      { group: "SCE Legacy Markers", name: "List Price", start: "List Price</strong>:", end: "</p" },
      { group: "SCE Legacy Markers", name: "Catalog Page", start: "Catalog Page</strong>:", end: "</p" },
      { group: "SCE Legacy Markers", name: "Est. Ship Weight", start: "Est. Ship Weight</strong>:", end: "</p" },
      { name: "Product image", start: "/images/", end: ".png", documentType: "image", urlPrefix: "https://www.saginawcontrol.com/images/", urlSuffix: ".png" }
    ]
  },
  balluff: {
    id: "balluff",
    canonicalName: "Balluff",
    shortName: "BAL",
    rateLimitMs: 1200,
    // Balluff uses heavy Playwright/Livewire drawers; two workers is a practical throughput/responsiveness balance.
    concurrency: 2,
    officialBaseUrls: ["https://www.balluff.com/en-gb/products"],
    homepageUrl: "https://www.balluff.com/en-gb",
    localizedUrlTemplates: [
      { locale: "en", urlTemplate: "https://www.balluff.com/en-gb/products/{part}" },
      { locale: "de", urlTemplate: "https://www.balluff.com/de-de/products/{part}" }
    ],
    fetchPolicy: {
      timeoutMs: 20000,
      acceptLanguage: "en-GB,en;q=0.9,en-US;q=0.8,de;q=0.6",
      referer: "https://www.balluff.com/en-gb/products",
      fallbackUserAgents: [
        "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
      ],
      minContentLength: 1000
    },
    fallbackSources: []
  },
  nvent: {
    id: "nvent",
    canonicalName: "nVent",
    shortName: "NVE",
    rateLimitMs: 1500,
    officialBaseUrls: ["https://www.nvent.com", "https://www.chemelex.com"],
    homepageUrl: "https://www.nvent.com/en-us",
    fetchPolicy: {
      timeoutMs: 30000,
      acceptLanguage: "en-US,en;q=0.9",
      referer: "https://www.nvent.com/",
      minContentLength: 50000,
      fallbackUserAgents: [
        "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
      ]
    },
    fallbackSources: [
      {
        id: "nvent-products",
        label: "nVent product page",
        enabled: true,
        sourceType: "official-fallback",
        directUrlTemplates: [
          "https://hoffman.nvent.com/en-us/products/enc{partLower}",
          "https://www.nvent.com/en-us/hoffman/products/enc{partLower}",
          "https://www.nvent.com/en-us/hoffman/products/enc{partLower}/pdf",
          "https://www.nvent.com/en-us/hoffman/products/{partLower}",
          "https://www.nvent.com/en-us/hoffman/products/{partLower}/pdf",
          "https://www.nvent.com/en-us/caddy/products/efs{partLower}",
          "https://www.nvent.com/en-us/caddy/products/{partLower}",
          "https://www.nvent.com/en-us/erico/products/efs{partLower}",
          "https://www.nvent.com/erico/products/efs{partLower}",
          "https://www.nvent.com/en-us/erico/products/{partLower}",
          "https://www.nvent.com/en-us/eriflex/products/efs{partLower}",
          "https://www.nvent.com/en-us/eriflex/products/{partLower}",
          "https://www.nvent.com/en-us/schroff/products/enc{partLower}",
          "https://www.nvent.com/en-us/schroff/products/{partLower}",
          "https://www.nvent.com/raychem/products/{partLower}",
          "https://www.nvent.com/en-us/raychem/products/{partLower}"
        ]
      }
    ]
  },
  schmersal: {
    id: "schmersal",
    canonicalName: "Schmersal",
    shortName: "SCH",
    rateLimitMs: 1500,
    officialBaseUrls: ["https://products.schmersal.com"],
    homepageUrl: "https://www.schmersal.com/en/",
    localizedUrlTemplates: [
      { locale: "en", urlTemplate: "https://products.schmersal.com/en_US/search?query={part}" },
      { locale: "de", urlTemplate: "https://products.schmersal.com/de_DE/search?query={part}" }
    ],
    markerRules: [
      { group: "Schmersal Legacy Markers", name: "Product type description", start: 'Product type description"">', end: "</p" },
      { group: "Schmersal Legacy Markers", name: "Article number (order number)", start: 'Article number (order number)"">', end: "</p" },
      { group: "Schmersal Legacy Markers", name: "EAN (European Article Number)", start: 'EAN (European Article Number)"">', end: "</p" },
      { group: "Schmersal Legacy Markers", name: "eCl@ss number, version 12.0", start: 'eCl@ss number, version 12.0"">', end: "</p" },
      { name: "Product image", start: 'img-responsive center rounded" src="', end: ".png", documentType: "image", urlSuffix: ".png" }
    ],
    fallbackSources: [
      {
        id: "schmersal-product-search",
        label: "Schmersal product search",
        enabled: true,
        sourceType: "official-fallback",
        directUrlTemplates: [
          "https://products.schmersal.com/en_US/search?query={part}",
          "https://products.schmersal.com/en_GB/search?query={part}",
          "https://products.schmersal.com/de_DE/search?query={part}"
        ],
        confidence: 0.72,
        fetchPolicy: { timeoutMs: 30000, minContentLength: 1000 }
      }
    ]
  },
  spelsberg: {
    id: "spelsberg",
    canonicalName: "Spelsberg",
    shortName: "SPE",
    rateLimitMs: 1500,
    officialBaseUrls: ["https://www.spelsberg.com", "https://www.spelsberg.de"],
    homepageUrl: "https://www.spelsberg.com/en/",
    localizedUrlTemplates: [
      { locale: "en", urlTemplate: "https://www.spelsberg.com/product-finder/?query={part}" },
      { locale: "de", urlTemplate: "https://www.spelsberg.de/produktfinder/?query={part}" }
    ],
    fallbackSources: [
      {
        id: "spelsberg-product-finder",
        label: "Spelsberg product finder",
        enabled: true,
        sourceType: "official-fallback",
        directUrlTemplates: [
          "https://www.spelsberg.com/product-finder/?query={part}",
          "https://www.spelsberg.com/search?query={part}"
        ],
        confidence: 0.72,
        fetchPolicy: { timeoutMs: 30000, minContentLength: 1000 }
      }
    ]
  },
  rockwell: {
    id: "rockwell",
    canonicalName: "Rockwell Automation",
    shortName: "RA",
    rateLimitMs: 1800,
    officialBaseUrls: ["https://www.rockwellautomation.com/en-us/products"],
    // Matches MANUFACTURER_URL in the manual Rockwell PDTs.
    homepageUrl: "https://www.rockwellautomation.com/en-us.html",
    localizedUrlTemplates: [
      { locale: "en", urlTemplate: "https://www.rockwellautomation.com/en-us/products/details.{part}.html" },
      { locale: "de", urlTemplate: "https://www.rockwellautomation.com/de-de/products/details.{part}.html" }
    ],
    fallbackSources: [
      {
        id: "rockwell-product-details",
        label: "Rockwell Automation product details",
        enabled: true,
        sourceType: "official-fallback",
        directUrlTemplates: ["https://www.rockwellautomation.com/en-us/products/details.{part}.html"]
      }
    ]
  },
  fath: {
    id: "fath",
    canonicalName: "FATH GmbH",
    shortName: "FATH",
    rateLimitMs: 1500,
    officialBaseUrls: ["https://www.fath24.com"],
    homepageUrl: "https://www.fath.com/en/",
    localizedUrlTemplates: [
      { locale: "en", urlTemplate: "https://www.fath24.com/en/search?search={part}" },
      { locale: "de", urlTemplate: "https://www.fath24.com/de/search?search={part}" }
    ],
    fallbackSources: [
      {
        id: "fath-search",
        label: "FATH24 shop search",
        enabled: true,
        sourceType: "official-fallback",
        directUrlTemplates: ["https://www.fath24.com/en/search?search={part}"],
        confidence: 0.72,
        fetchPolicy: { timeoutMs: 25000, minContentLength: 500 }
      }
    ]
  },
  eaton: {
    id: "eaton",
    canonicalName: "Eaton",
    shortName: "EAT",
    rateLimitMs: 1500,
    officialBaseUrls: ["https://www.eaton.com"],
    // Matches MANUFACTURER_URL in the manual Eaton PDTs (CAD + manual variants).
    homepageUrl: "https://www.eaton.com/us/en-us.html",
    localizedUrlTemplates: [
      { locale: "en", urlTemplate: "https://www.eaton.com/us/en-us/skuPage.{partSlashBraces}.html" },
      { locale: "de", urlTemplate: "https://www.eaton.com/de/de-de/skuPage.{partSlashBraces}.html" }
    ],
    fallbackSources: [
      {
        id: "eaton-sku-page",
        label: "Eaton SKU page",
        enabled: true,
        sourceType: "official-fallback",
        directUrlTemplates: [
          "https://www.eaton.com/us/en-us/skuPage.{partSlashBraces}.html",
          "https://images.eaton.com/us/en-us/skuPage.{partSlashBraces}.html"
        ]
      }
    ]
  },
  eta: {
    id: "eta",
    canonicalName: "E-T-A",
    shortName: "ETA",
    rateLimitMs: 1500,
    officialBaseUrls: ["https://www.e-t-a.com/products"],
    homepageUrl: "https://www.e-t-a.com/",
    fallbackSources: [
      {
        id: "eta-product-pages",
        label: "E-T-A product pages",
        enabled: true,
        sourceType: "official-fallback",
        directUrlTemplates: [
          "https://www.e-t-a.com/products/circuit_protection_devices/thermal_magnetic_overcurrent_circuit_breakers/p/{partSnake}/",
          "https://www.e-t-a.com/products/circuit_protection_devices/thermal_overcurrent_circuit_breakers/p/{partSnake}/",
          "https://www.e-t-a.com/products/circuit_protection_devices/electronic_overcurrent_protection/p/{partSnake}/",
          "https://www.e-t-a.com/products/circuit_protection_devices/high_performance_circuit_breakers/p/{partSnake}/"
        ]
      }
    ]
  },
  phoenix: {
    id: "phoenix",
    canonicalName: "Phoenix Contact",
    shortName: "PHX",
    rateLimitMs: 1500,
    officialBaseUrls: ["https://www.phoenixcontact.com"],
    homepageUrl: "https://www.phoenixcontact.com/",
    localizedUrlTemplates: [
      { locale: "en", urlTemplate: "https://www.phoenixcontact.com/product/{part}" }
    ],
    fallbackSources: [
      {
        id: "phoenix-product-number",
        label: "Phoenix Contact product page",
        enabled: true,
        sourceType: "official-fallback",
        directUrlTemplates: [
          "https://r.jina.ai/http://www.phoenixcontact.com/product/{part}",
          "https://r.jina.ai/http://www.phoenixcontact.com/us/products/{part}",
          "https://www.phoenixcontact.com/product/{part}",
          "https://www.phoenixcontact.com/us/products/{part}",
          "https://www.phoenixcontact.com/en-us/products/{part}"
        ],
        confidence: 0.72,
        fetchPolicy: { timeoutMs: 30000, minContentLength: 1000 }
      }
    ]
  },
  schneider: {
    id: "schneider",
    canonicalName: "Schneider Electric",
    shortName: "SE",
    rateLimitMs: 1800,
    officialBaseUrls: ["https://www.se.com"],
    homepageUrl: "https://www.se.com/ww/en/",
    localizedUrlTemplates: [
      { locale: "en", urlTemplate: "https://www.se.com/ww/en/product/{part}/" },
      { locale: "de", urlTemplate: "https://www.se.com/de/de/product/{part}/" }
    ],
    fallbackSources: [
      {
        id: "schneider-product-pages",
        label: "Schneider Electric product page",
        enabled: true,
        sourceType: "official-fallback",
        directUrlTemplates: [
          "https://www.se.com/us/en/product/{part}/",
          "https://www.se.com/ww/en/product/{part}/",
          "https://www.se.com/ww/products/US/en/products/{part}"
        ]
      },
      {
        id: "schneider-reader-product-pages",
        label: "Schneider Electric readable product page",
        enabled: true,
        sourceType: "official-fallback",
        directUrlTemplates: [
          "https://r.jina.ai/http://www.se.com/us/en/product/{part}/",
          "https://r.jina.ai/http://www.se.com/ww/en/product/{part}/",
          "https://r.jina.ai/http://www.se.com/ww/products/US/en/products/{part}"
        ]
      }
    ]
  },
  siemens: {
    id: "siemens",
    canonicalName: "Siemens",
    shortName: "SIE",
    rateLimitMs: 1800,
    officialBaseUrls: ["https://mall.industry.siemens.com"],
    homepageUrl: "https://www.siemens.com/global/en/",
    localizedUrlTemplates: [
      { locale: "en", urlTemplate: "https://mall.industry.siemens.com/mall/en/WW/Catalog/Product?mlfb={part}" },
      { locale: "de", urlTemplate: "https://mall.industry.siemens.com/mall/de/WW/Catalog/Product?mlfb={part}" }
    ],
    fallbackSources: [
      {
        id: "siemens-industry-mall",
        label: "Siemens Industry Mall product page",
        enabled: true,
        sourceType: "official-fallback",
        directUrlTemplates: [
          "https://mall.industry.siemens.com/mall/en/us/Catalog/Product?SiepCountryCode=US&mlfb={part}",
          "https://mall.industry.siemens.com/mall/en/WW/Catalog/Product?mlfb={part}",
          "https://mall.industry.siemens.com/mall/en/us/Catalog/Product?SiepCountryCode=US&mlfb={partCompact}",
          "https://mall.industry.siemens.com/mall/en/WW/Catalog/Product?mlfb={partCompact}",
          "https://mall.industry.siemens.com/mall/en/us/Catalog/Product/{part}"
        ]
      },
      {
        id: "siemens-industry-mall-reader",
        label: "Siemens Industry Mall readable product page",
        enabled: true,
        sourceType: "official-fallback",
        directUrlTemplates: [
          "https://r.jina.ai/http://mall.industry.siemens.com/mall/en/WW/Catalog/Product?mlfb={part}",
          "https://r.jina.ai/http://mall.industry.siemens.com/mall/en/b1/Catalog/Product/{partCompact}"
        ]
      },
      {
        id: "kontrolyum-siemens",
        label: "Kontrolyum Siemens distributor page",
        enabled: true,
        sourceType: "distributor",
        directUrlTemplates: [
          "https://www.kontrolyum.com/{partAfterColonLower}-siemens-field-control-equipment",
          "https://www.kontrolyum.com/{partAfterColonLower}-bpz-{partAfterColonLower}-siemens-fark-basinc-vanasi"
        ]
      }
    ]
  }
};

attachBuiltInScrapeRecipes();

function attachBuiltInScrapeRecipes() {
  const accordionSelectors = [
    "button[aria-expanded='false']",
    "[role='button'][aria-expanded='false']",
    "summary",
    ".accordion button",
    ".accordion__trigger",
    "[data-accordion] button",
    "[data-testid*='accordion'] button",
    "[data-testid*='tab']",
    "[role='tab']",
    "button.show-more",
    "button[class*='show']"
  ];

  builtInManufacturerConfigs.balluff.scrapeRecipe = {
    searchUrlTemplates: [
      "https://www.balluff.com/en-gb/search?query={part}",
      "https://www.balluff.com/de-de/search?query={part}"
    ],
    canonicalParamDenylist: ["pm", "pf", "attrs"],
    requiredSections: [
      "summary features|key features|hauptmerkmale|component data|meta specs",
      "classifications|klassifizierungen|approval|conformity|zulassung|konformitat|protection class"
    ],
    requiredAttributes: [
      "sku|mpn|product id|product label|product variant|alternateName|artikelnummer",
      "product group|product family|series|style|principle|function|interface|dimension|measuring range|measuring length|range|connection|operating voltage|material",
      "eclass|etim|unspsc|approval|conformity|zulassung|konformitat|konformit"
    ],
    requiredDocuments: ["datasheet"],
    minAttributes: 8,
    minDocuments: 1,
    expandSelectors: accordionSelectors,
    dynamicFramework: ["livewire", "json-ld", "embedded-json"],
    fallbackPolicy: {
      officialFirst: true,
      readerOnQualityFailure: true,
      browserOnQualityFailure: true,
      distributorFallback: false,
      maxReaderAttempts: 1,
      maxBrowserAttempts: 1
    },
    confidenceRules: { foundMinScore: 85, partialMaxConfidence: 0.78 }
  };

  builtInManufacturerConfigs.schneider.scrapeRecipe = {
    searchUrlTemplates: [
      "https://www.se.com/ww/en/search/{part}",
      "https://www.se.com/ww/en/search/?q={part}",
      "https://www.se.com/us/en/search/{part}"
    ],
    canonicalParamDenylist: ["selected-node-id", "range"],
    requiredAttributes: [
      "product id|catalog number|range",
      "material|product weight|ip degree|enclosure nominal|voltage|current"
    ],
    requiredDocuments: ["datasheet|image"],
    minAttributes: 4,
    expandSelectors: accordionSelectors,
    dynamicFramework: ["embedded-json", "json-ld"],
    fallbackPolicy: {
      officialFirst: true,
      readerOnQualityFailure: true,
      browserOnQualityFailure: true,
      distributorFallback: true,
      distributorConfidenceCap: 0.45
    },
    confidenceRules: { foundMinScore: 78, partialMaxConfidence: 0.74, distributorMaxConfidence: 0.45 }
  };

  builtInManufacturerConfigs.siemens.scrapeRecipe = {
    searchUrlTemplates: [
      "https://mall.industry.siemens.com/mall/en/WW/Catalog/Search?searchTerm={part}",
      "https://mall.industry.siemens.com/mall/en/WW/Catalog/Product?mlfb={part}"
    ],
    canonicalParamDenylist: ["SiepCountryCode"],
    requiredAttributes: ["article number|mlfb|product short text|description"],
    minAttributes: 3,
    minDocuments: 1,
    expandSelectors: accordionSelectors,
    dynamicFramework: ["api", "embedded-json"],
    fallbackPolicy: {
      officialFirst: true,
      readerOnQualityFailure: true,
      browserOnQualityFailure: true,
      distributorFallback: true,
      distributorConfidenceCap: 0.42
    },
    confidenceRules: { foundMinScore: 76, partialMaxConfidence: 0.72, distributorMaxConfidence: 0.42 }
  };

  builtInManufacturerConfigs.abb.scrapeRecipe = {
    searchUrlTemplates: [
      "https://new.abb.com/search/results#query={part}",
      "https://new.abb.com/products/{part}"
    ],
    requiredAttributes: ["product id|extended product type|catalog description|long description"],
    requiredDocuments: ["image"],
    minAttributes: 3,
    expandSelectors: accordionSelectors,
    dynamicFramework: ["json-ld", "embedded-json"],
    fallbackPolicy: {
      officialFirst: true,
      readerOnQualityFailure: true,
      browserOnQualityFailure: true,
      distributorFallback: true,
      distributorConfidenceCap: 0.45
    },
    confidenceRules: { foundMinScore: 76, partialMaxConfidence: 0.74, distributorMaxConfidence: 0.45 }
  };

  builtInManufacturerConfigs.sce.scrapeRecipe = {
    searchUrlTemplates: ["https://www.saginawcontrol.com/partnumber_info?n={part}"],
    requiredAttributes: ["part number|description|height|width|depth|weight"],
    requiredDocuments: ["image"],
    minAttributes: 4,
    fallbackPolicy: {
      officialFirst: true,
      readerOnQualityFailure: true,
      browserOnQualityFailure: false,
      distributorFallback: true,
      distributorConfidenceCap: 0.45
    },
    confidenceRules: { foundMinScore: 78, partialMaxConfidence: 0.72, distributorMaxConfidence: 0.45 }
  };

  builtInManufacturerConfigs.eaton.scrapeRecipe = {
    searchUrlTemplates: [
      "https://www.eaton.com/content/eaton/us/en-us/site-search/jcr:content/root/responsivegrid/search_results.searchTerm${part}.SortBy$relevance.Facets$.startDate$.endDate$.loadMore$.json",
      "https://www.eaton.com/content/eaton/gb/en-gb/site-search/jcr:content/root/responsivegrid/search_results.searchTerm${part}.SortBy$relevance.Facets$.startDate$.endDate$.loadMore$.json",
      "https://www.eaton.com/content/eaton/de/de-de/site-search/jcr:content/root/responsivegrid/search_results.searchTerm${part}.SortBy$relevance.Facets$.startDate$.endDate$.loadMore$.json",
      "https://www.eaton.com/content/eaton/no/no-no/site-search/jcr:content/root/responsivegrid/search_results.searchTerm${part}.SortBy$relevance.Facets$.startDate$.endDate$.loadMore$.json",
      "https://www.eaton.com/us/en-us/skuPage.{partSlashBraces}.html"
    ],
    requiredAttributes: ["catalog number|product name|product weight|dimensions|certifications|type"],
    requiredDocuments: ["datasheet|technical data sheet|specification sheet|skuPage"],
    minAttributes: 4,
    expandSelectors: accordionSelectors,
    dynamicFramework: ["json-ld", "embedded-json"],
    fallbackPolicy: {
      officialFirst: true,
      readerOnQualityFailure: true,
      browserOnQualityFailure: true,
      distributorFallback: true,
      distributorConfidenceCap: 0.45
    },
    confidenceRules: { foundMinScore: 76, partialMaxConfidence: 0.72, distributorMaxConfidence: 0.45 }
  };

  for (const id of ["nvent", "rockwell", "schmersal", "spelsberg", "eta", "phoenix"] as const) {
    builtInManufacturerConfigs[id].scrapeRecipe = {
      searchUrlTemplates: [`${builtInManufacturerConfigs[id].officialBaseUrls[0]}`].filter(templateContainsCatalogPlaceholder),
      requiredAttributes: ["catalog|article|part|product|description|material|dimensions|weight|certification|approval"],
      minAttributes: 3,
      minDocuments: 1,
      expandSelectors: accordionSelectors,
      dynamicFramework: ["json-ld", "embedded-json"],
      fallbackPolicy: {
        officialFirst: true,
        readerOnQualityFailure: true,
        browserOnQualityFailure: true,
        distributorFallback: true,
        distributorConfidenceCap: 0.45
      },
      confidenceRules: { foundMinScore: 74, partialMaxConfidence: 0.72, distributorMaxConfidence: 0.45 }
    };
  }

  builtInManufacturerConfigs.schmersal.scrapeRecipe = {
    searchUrlTemplates: [
      "https://products.schmersal.com/en_US/search?query={part}",
      "https://products.schmersal.com/en_GB/search?query={part}",
      "https://products.schmersal.com/de_DE/search?query={part}"
    ],
    requiredAttributes: ["article|order number|product type|description", "certificate|approval|standard|classification|ecl@ss"],
    requiredDocuments: ["image"],
    minAttributes: 3,
    minDocuments: 1,
    expandSelectors: accordionSelectors,
    dynamicFramework: ["next", "embedded-json", "json-ld"],
    discoveryPolicy: {
      searchUrlTemplates: [
        "https://products.schmersal.com/en_US/search?query={part}",
        "https://products.schmersal.com/en_GB/search?query={part}",
        "https://products.schmersal.com/de_DE/search?query={part}"
      ],
      allowedOfficialDomains: ["products.schmersal.com"],
      urlVariants: ["partLower", "part", "partUpper"],
      maxCandidates: 10
    },
    extractionPolicy: {
      ignoredImageUrlPatterns: ["logo|favicon|sprite|placeholder|icon"]
    },
    fallbackPolicy: {
      officialFirst: true,
      readerOnQualityFailure: true,
      browserOnQualityFailure: true,
      distributorFallback: true,
      distributorConfidenceCap: 0.45,
      maxReaderAttempts: 1,
      maxBrowserAttempts: 1
    },
    confidenceRules: { foundMinScore: 74, partialMaxConfidence: 0.72, distributorMaxConfidence: 0.45 }
  };

  builtInManufacturerConfigs.spelsberg.scrapeRecipe = {
    searchUrlTemplates: [
      "https://www.spelsberg.com/product-finder/?query={part}",
      "https://www.spelsberg.com/search?query={part}",
      "https://www.spelsberg.de/produktfinder/?query={part}"
    ],
    requiredAttributes: ["product|article|part|description", "material|dimensions|weight|protection|certification|approval"],
    requiredDocuments: ["datasheet"],
    minAttributes: 4,
    minDocuments: 1,
    expandSelectors: accordionSelectors,
    dynamicFramework: ["embedded-json", "json-ld"],
    discoveryPolicy: {
      searchUrlTemplates: [
        "https://www.spelsberg.com/product-finder/?query={part}",
        "https://www.spelsberg.com/search?query={part}",
        "https://www.spelsberg.de/produktfinder/?query={part}"
      ],
      allowedOfficialDomains: ["spelsberg.com", "spelsberg.de"],
      urlVariants: ["partLower", "partDash", "part", "partUpper"],
      maxCandidates: 10
    },
    extractionPolicy: {
      documentUrlPatterns: [
        "\\.download\\?file=.+\\.pdf",
        "/p/\\d+\\.pdf",
        "\\b(data.?sheet|technical.?data|download)\\b"
      ],
      ignoredImageUrlPatterns: ["logo|favicon|sprite|placeholder|icon"]
    },
    fallbackPolicy: {
      officialFirst: true,
      readerOnQualityFailure: true,
      browserOnQualityFailure: true,
      distributorFallback: true,
      distributorConfidenceCap: 0.45,
      maxReaderAttempts: 1,
      maxBrowserAttempts: 1
    },
    confidenceRules: { foundMinScore: 74, partialMaxConfidence: 0.72, distributorMaxConfidence: 0.45 }
  };

  builtInManufacturerConfigs.nvent.scrapeRecipe = {
    requiredAttributes: ["catalog|article|part|product|description|material|dimensions|weight|certification|approval"],
    requiredDocuments: ["image"],
    minAttributes: 6,
    minDocuments: 1,
    expandSelectors: accordionSelectors,
    dynamicFramework: ["embedded-json", "json-ld"],
    discoveryPolicy: {
      searchUrlTemplates: [
        "https://www.nvent.com/en-us/search?text={part}",
        "https://www.chemelex.com/en-us/raychem/search?keyword={part}"
      ],
      allowedOfficialDomains: ["nvent.com", "hoffman.nvent.com", "chemelex.com"],
      sitemapUrls: ["https://www.nvent.com/sitemap.xml", "https://www.chemelex.com/sitemap.xml"],
      urlVariants: ["partLower", "part", "partUpper"],
      maxCandidates: 18
    },
    extractionPolicy: {
      documentUrlPatterns: [
        "/sites/default/files/.+\\.(pdf|zip)$",
        "/products/.+/pdf(?:\\?|$)",
        "\\b(spec|data.?sheet|certificate|declaration|manual|instruction|catalog|brochure|flyer|handbook|guide|test.?report|engineering.?specification|cad|dxf|step)\\b"
      ],
      ignoredImageUrlPatterns: [
        "logo|favicon|sprite|placeholder|footer|mobile[_-]?menu"
      ]
    },
    fallbackPolicy: {
      officialFirst: true,
      readerOnQualityFailure: true,
      browserOnQualityFailure: true,
      distributorFallback: true,
      distributorConfidenceCap: 0.45,
      maxReaderAttempts: 1,
      maxBrowserAttempts: 1
    },
    confidenceRules: { foundMinScore: 76, partialMaxConfidence: 0.72, distributorMaxConfidence: 0.45 }
  };
}

const legacyManufacturerAliases: Record<string, string> = {
  newabb: "abb",
  saginawcontrol: "sce",
  schneiderelectric: "schneider",
  nventhoffman: "nvent",
  eldon: "nvent"
};

let customManufacturerConfigs: Record<string, ManufacturerConfig> = {};
let customConfigPath: string | undefined;

export function initializeManufacturerConfig(dataDir: string) {
  customConfigPath = path.join(dataDir, "manufacturers.json");
  fs.mkdirSync(path.dirname(customConfigPath), { recursive: true });
  if (!fs.existsSync(customConfigPath)) {
    customManufacturerConfigs = {};
    return;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(customConfigPath, "utf8")) as unknown;
    const entries = Array.isArray(parsed) ? parsed : Object.values(parsed as Record<string, unknown>);
    customManufacturerConfigs = Object.fromEntries(
      entries
        .map((entry) => sanitizeManufacturerConfig(entry))
        .filter((entry): entry is ManufacturerConfig => Boolean(entry))
        .map((entry) => [entry.id, entry])
    );
  } catch {
    customManufacturerConfigs = {};
  }
}

export function listManufacturerConfigs(): ManufacturerConfig[] {
  const ids = new Set([...Object.keys(builtInManufacturerConfigs), ...Object.keys(customManufacturerConfigs)]);
  return [...ids]
    .flatMap((id) => {
      const config = getManufacturerConfig(id);
      return config ? [withManufacturerOrigin(config)] : [];
    })
    .sort((left, right) => left.shortName.localeCompare(right.shortName, undefined, { sensitivity: "base" }));
}

export function getManufacturerConfig(id: string): ManufacturerConfig | undefined {
  const normalizedId = normalizeManufacturerId(id);
  return customManufacturerConfigs[id] ?? customManufacturerConfigs[normalizedId] ?? builtInManufacturerConfigs[normalizedId];
}

export async function saveManufacturerConfig(input: unknown): Promise<ManufacturerConfig> {
  if (!customConfigPath) throw new Error("Manufacturer config store was not initialized.");
  const config = parseManufacturerConfig(input);
  customManufacturerConfigs = {
    ...customManufacturerConfigs,
    [config.id]: config
  };
  await fs.promises.writeFile(customConfigPath, JSON.stringify(Object.values(customManufacturerConfigs), null, 2), "utf8");
  return withManufacturerOrigin(config);
}

export function parseManufacturerConfig(input: unknown): ManufacturerConfig {
  const config = sanitizeManufacturerConfig(input);
  if (!config) throw new Error("Manufacturer config is invalid.");
  return config;
}

export async function resetManufacturerOverride(id: ManufacturerId): Promise<ManufacturerConfig> {
  if (!customConfigPath) throw new Error("Manufacturer config store was not initialized.");
  const normalizedId = normalizeManufacturerId(id);
  if (!builtInManufacturerConfigs[normalizedId]) throw new Error("Only built-in manufacturers can be reset.");
  if (customManufacturerConfigs[normalizedId]) {
    const { [normalizedId]: _removed, ...remaining } = customManufacturerConfigs;
    customManufacturerConfigs = remaining;
    await fs.promises.writeFile(customConfigPath, JSON.stringify(Object.values(customManufacturerConfigs), null, 2), "utf8");
  }
  return withManufacturerOrigin(builtInManufacturerConfigs[normalizedId]);
}

export function isBuiltInManufacturer(id: ManufacturerId): boolean {
  return Boolean(builtInManufacturerConfigs[normalizeManufacturerId(id)]);
}

function withManufacturerOrigin(config: ManufacturerConfig): ManufacturerConfig {
  const id = normalizeManufacturerId(config.id);
  const builtIn = Boolean(builtInManufacturerConfigs[id]);
  const hasOverride = Boolean(customManufacturerConfigs[id]);
  return {
    ...config,
    origin: builtIn ? hasOverride ? "override" : "built-in" : "custom",
    isBuiltIn: builtIn,
    hasOverride
  };
}

function normalizeManufacturerId(id: string): string {
  const normalized = id.toLowerCase().trim();
  return legacyManufacturerAliases[normalized] ?? normalized;
}

function sanitizeManufacturerConfig(input: unknown): ManufacturerConfig | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Partial<ManufacturerConfig>;
  const id = slugify(String(record.id ?? ""));
  const canonicalName = clean(String(record.canonicalName ?? ""));
  const shortName = clean(String(record.shortName ?? "")).toUpperCase();
  const rateLimitMs = clampInteger(Number(record.rateLimitMs ?? 1500), 250, 10000);
  const concurrency = record.concurrency !== undefined ? clampInteger(Number(record.concurrency), 1, 8) : undefined;
  const officialBaseUrls = sanitizeStringList(record.officialBaseUrls);
  const localizedUrlTemplates = sanitizeLocalizedUrlTemplates(record.localizedUrlTemplates);
  const fallbackSources = sanitizeFallbackSources(record.fallbackSources, id);
  const match = sanitizeMatchPolicy(record.match);
  const fetchPolicy = sanitizeFetchPolicy(record.fetchPolicy);
  const markerRules = sanitizeMarkerRules(record.markerRules);
  const scrapeRecipe = sanitizeScrapeRecipe(record.scrapeRecipe);
  const customCoverageFields = sanitizeCustomCoverageFields(record.customCoverageFields);

  if (!id || !canonicalName || !shortName) return undefined;
  return {
    id,
    canonicalName,
    shortName,
    rateLimitMs,
    ...(concurrency !== undefined ? { concurrency } : {}),
    officialBaseUrls,
    fallbackSources,
    ...(localizedUrlTemplates.length ? { localizedUrlTemplates } : {}),
    ...(match ? { match } : {}),
    ...(fetchPolicy ? { fetchPolicy } : {}),
    ...(markerRules.length ? { markerRules } : {}),
    ...(scrapeRecipe ? { scrapeRecipe } : {}),
    ...(customCoverageFields.length ? { customCoverageFields } : {})
  };
}

function sanitizeCustomCoverageFields(input: unknown): CustomCoverageField[] {
  if (!Array.isArray(input)) return [];
  const seenIds = new Set<string>();
  const cleaned: CustomCoverageField[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as { id?: unknown; label?: unknown; pattern?: unknown };
    const label = clean(String(raw.label ?? ""));
    const pattern = clean(String(raw.pattern ?? ""));
    const id = slugify(String(raw.id ?? label));
    if (!id || !label || !pattern) continue;
    if (seenIds.has(id)) continue;
    // Reject patterns the regex engine cannot compile — we surface the failure here
    // rather than letting it become a silent "always missing" tile at run-time.
    try {
      new RegExp(pattern, "i");
    } catch {
      continue;
    }
    seenIds.add(id);
    cleaned.push({ id, label, pattern });
    if (cleaned.length >= 32) break;
  }
  return cleaned;
}

function sanitizeFallbackSources(input: unknown, manufacturerId: string): FallbackSourceConfig[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((source, index) => {
      if (!source || typeof source !== "object") return undefined;
      const record = source as Partial<FallbackSourceConfig>;
      const label = clean(String(record.label ?? `Source ${index + 1}`));
      const id = slugify(String(record.id ?? (label || `${manufacturerId}-source-${index + 1}`)));
      const sourceType = record.sourceType === "distributor" ? "distributor" : "official-fallback";
      const directUrlTemplates = sanitizeStringList(record.directUrlTemplates).filter(templateContainsCatalogPlaceholder);
      const match = sanitizeMatchPolicy(record.match);
      const fetchPolicy = sanitizeFetchPolicy(record.fetchPolicy);
      const confidence = clampOptionalNumber(record.confidence, 0.05, 0.95);
      const markerRules = sanitizeMarkerRules(record.markerRules);
      if (!id || !label || directUrlTemplates.length === 0) return undefined;
      return {
        id,
        label,
        enabled: record.enabled !== false,
        sourceType,
        directUrlTemplates,
        ...(match ? { match } : {}),
        ...(fetchPolicy ? { fetchPolicy } : {}),
        ...(confidence !== undefined ? { confidence } : {}),
        ...(markerRules.length ? { markerRules } : {})
      } satisfies FallbackSourceConfig;
    })
    .filter((source): source is FallbackSourceConfig => Boolean(source));
}

function sanitizeLocalizedUrlTemplates(input: unknown): LocalizedUrlTemplate[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      if (!item || typeof item !== "object") return undefined;
      const record = item as Partial<LocalizedUrlTemplate>;
      const locale = record.locale === "de" ? "de" : record.locale === "en" ? "en" : undefined;
      const urlTemplate = clean(String(record.urlTemplate ?? ""));
      if (!locale || !templateContainsCatalogPlaceholder(urlTemplate)) return undefined;
      return { locale, urlTemplate } satisfies LocalizedUrlTemplate;
    })
    .filter((item): item is LocalizedUrlTemplate => Boolean(item));
}

function sanitizeMatchPolicy(input: unknown): MatchPolicyConfig | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Partial<MatchPolicyConfig>;
  const aliases = sanitizeStringList(record.aliases);
  const policy: MatchPolicyConfig = {
    ...(aliases.length ? { aliases } : {}),
    ...(typeof record.ignoreCase === "boolean" ? { ignoreCase: record.ignoreCase } : {}),
    ...(typeof record.compact === "boolean" ? { compact: record.compact } : {}),
    ...(typeof record.afterColon === "boolean" ? { afterColon: record.afterColon } : {}),
    ...(typeof record.requireCatalogNumber === "boolean" ? { requireCatalogNumber: record.requireCatalogNumber } : {})
  };
  return Object.keys(policy).length ? policy : undefined;
}

function sanitizeFetchPolicy(input: unknown): FetchPolicyConfig | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Partial<FetchPolicyConfig>;
  const fallbackUserAgents = sanitizeStringList(record.fallbackUserAgents).slice(0, 5);
  const policy: FetchPolicyConfig = {
    ...(record.timeoutMs !== undefined ? { timeoutMs: clampInteger(Number(record.timeoutMs), 1000, 180000) } : {}),
    ...(record.cacheTtlMs !== undefined ? { cacheTtlMs: clampInteger(Number(record.cacheTtlMs), 0, 30 * 24 * 60 * 60 * 1000) } : {}),
    ...(record.maxAttempts !== undefined ? { maxAttempts: clampInteger(Number(record.maxAttempts), 1, 5) } : {}),
    ...(record.retryBackoffMs !== undefined ? { retryBackoffMs: clampInteger(Number(record.retryBackoffMs), 100, 10000) } : {}),
    ...(record.userAgent ? { userAgent: clean(String(record.userAgent)).slice(0, 500) } : {}),
    ...(record.acceptLanguage ? { acceptLanguage: clean(String(record.acceptLanguage)).slice(0, 200) } : {}),
    ...(record.referer ? { referer: clean(String(record.referer)).slice(0, 500) } : {}),
    ...(fallbackUserAgents.length ? { fallbackUserAgents } : {}),
    ...(record.minContentLength !== undefined ? { minContentLength: clampInteger(Number(record.minContentLength), 0, 250000) } : {})
  };
  return Object.keys(policy).length ? policy : undefined;
}

function sanitizeMarkerRules(input: unknown): MarkerExtractionRule[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      if (!item || typeof item !== "object") return undefined;
      const record = item as Partial<MarkerExtractionRule>;
      const name = clean(String(record.name ?? ""));
      const start = String(record.start ?? "");
      const end = record.end === undefined ? undefined : String(record.end);
      const group = record.group ? clean(String(record.group)) : undefined;
      const documentType = record.documentType;
      const urlPrefix = record.urlPrefix ? clean(String(record.urlPrefix)) : undefined;
      const urlSuffix = record.urlSuffix ? clean(String(record.urlSuffix)) : undefined;
      const caseSensitive = typeof record.caseSensitive === "boolean" ? record.caseSensitive : undefined;
      if (!name || !start) return undefined;
      if (documentType && !["datasheet", "certificate", "manual", "cad", "image", "other"].includes(documentType)) return undefined;
      return {
        name,
        start,
        ...(end !== undefined ? { end } : {}),
        ...(group ? { group } : {}),
        ...(documentType ? { documentType } : {}),
        ...(urlPrefix ? { urlPrefix } : {}),
        ...(urlSuffix ? { urlSuffix } : {}),
        ...(caseSensitive !== undefined ? { caseSensitive } : {})
      } satisfies MarkerExtractionRule;
    })
    .filter((item): item is MarkerExtractionRule => Boolean(item));
}

function sanitizeScrapeRecipe(input: unknown): ScrapeRecipeConfig | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Partial<ScrapeRecipeConfig>;
  const searchUrlTemplates = sanitizeStringList(record.searchUrlTemplates).filter(templateContainsCatalogPlaceholder);
  const canonicalParamDenylist = sanitizeStringList(record.canonicalParamDenylist).slice(0, 50);
  const requiredSections = sanitizeStringList(record.requiredSections).slice(0, 50);
  const requiredAttributes = sanitizeStringList(record.requiredAttributes).slice(0, 100);
  const requiredDocuments = sanitizeStringList(record.requiredDocuments).slice(0, 50);
  const expandSelectors = sanitizeStringList(record.expandSelectors).slice(0, 50);
  const dynamicFramework = sanitizeDynamicFramework(record.dynamicFramework);
  const discoveryPolicy = sanitizeDiscoveryPolicy(record.discoveryPolicy);
  const interactionPolicy = sanitizeInteractionPolicy(record.interactionPolicy);
  const extractionPolicy = sanitizeExtractionPolicy(record.extractionPolicy);
  const qualityPolicy = sanitizeQualityPolicy(record.qualityPolicy);
  const fallbackPolicy = sanitizeFallbackPolicy(record.fallbackPolicy);
  const confidenceRules = sanitizeConfidenceRules(record.confidenceRules);
  const recipe: ScrapeRecipeConfig = {
    ...(searchUrlTemplates.length ? { searchUrlTemplates } : {}),
    ...(canonicalParamDenylist.length ? { canonicalParamDenylist } : {}),
    ...(requiredSections.length ? { requiredSections } : {}),
    ...(requiredAttributes.length ? { requiredAttributes } : {}),
    ...(requiredDocuments.length ? { requiredDocuments } : {}),
    ...(record.minAttributes !== undefined ? { minAttributes: clampInteger(Number(record.minAttributes), 0, 1000) } : {}),
    ...(record.minDocuments !== undefined ? { minDocuments: clampInteger(Number(record.minDocuments), 0, 100) } : {}),
    ...(expandSelectors.length ? { expandSelectors } : {}),
    ...(dynamicFramework ? { dynamicFramework } : {}),
    ...(discoveryPolicy ? { discoveryPolicy } : {}),
    ...(interactionPolicy ? { interactionPolicy } : {}),
    ...(extractionPolicy ? { extractionPolicy } : {}),
    ...(qualityPolicy ? { qualityPolicy } : {}),
    ...(fallbackPolicy ? { fallbackPolicy } : {}),
    ...(confidenceRules ? { confidenceRules } : {})
  };
  return Object.keys(recipe).length ? recipe : undefined;
}

function sanitizeDiscoveryPolicy(input: unknown): ScrapeRecipeConfig["discoveryPolicy"] | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as NonNullable<ScrapeRecipeConfig["discoveryPolicy"]>;
  const searchUrlTemplates = sanitizeStringList(record.searchUrlTemplates).filter(templateContainsCatalogPlaceholder).slice(0, 40);
  const sitemapUrls = sanitizeStringList(record.sitemapUrls).filter(isHttpUrl).slice(0, 20);
  const allowedOfficialDomains = sanitizeStringList(record.allowedOfficialDomains).slice(0, 30);
  const allowedVariants = new Set(["part", "partUpper", "partLower", "partCompact", "partSnake", "partDash", "partAfterColon", "partAfterColonCompact"]);
  const urlVariants = Array.isArray(record.urlVariants)
    ? record.urlVariants.filter((item): item is DiscoveryUrlVariant => typeof item === "string" && allowedVariants.has(item))
    : [];
  const policy: NonNullable<ScrapeRecipeConfig["discoveryPolicy"]> = {
    ...(searchUrlTemplates.length ? { searchUrlTemplates } : {}),
    ...(sitemapUrls.length ? { sitemapUrls } : {}),
    ...(typeof record.enableRobotsSitemaps === "boolean" ? { enableRobotsSitemaps: record.enableRobotsSitemaps } : {}),
    ...(urlVariants.length ? { urlVariants: [...new Set(urlVariants)] } : {}),
    ...(allowedOfficialDomains.length ? { allowedOfficialDomains } : {}),
    ...(record.maxCandidates !== undefined ? { maxCandidates: clampInteger(Number(record.maxCandidates), 1, 50) } : {})
  };
  return Object.keys(policy).length ? policy : undefined;
}

function sanitizeInteractionPolicy(input: unknown): ScrapeRecipeConfig["interactionPolicy"] | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as NonNullable<ScrapeRecipeConfig["interactionPolicy"]>;
  const policy: NonNullable<ScrapeRecipeConfig["interactionPolicy"]> = {
    ...nonEmptyList("closeOverlaySelectors", sanitizeStringList(record.closeOverlaySelectors).slice(0, 50)),
    ...nonEmptyList("expandSelectors", sanitizeStringList(record.expandSelectors).slice(0, 80)),
    ...nonEmptyList("localeSelectors", sanitizeStringList(record.localeSelectors).slice(0, 30)),
    ...nonEmptyList("tabSelectors", sanitizeStringList(record.tabSelectors).slice(0, 50)),
    ...nonEmptyList("paginationSelectors", sanitizeStringList(record.paginationSelectors).slice(0, 50)),
    ...nonEmptyList("downloadSectionSelectors", sanitizeStringList(record.downloadSectionSelectors).slice(0, 50)),
    ...nonEmptyList("waitForSelectors", sanitizeStringList(record.waitForSelectors).slice(0, 50)),
    ...(record.maxClicks !== undefined ? { maxClicks: clampInteger(Number(record.maxClicks), 1, 200) } : {}),
    ...(record.scrollPasses !== undefined ? { scrollPasses: clampInteger(Number(record.scrollPasses), 1, 6) } : {}),
    ...(record.networkIdleTimeoutMs !== undefined ? { networkIdleTimeoutMs: clampInteger(Number(record.networkIdleTimeoutMs), 1000, 60000) } : {})
  };
  return Object.keys(policy).length ? policy : undefined;
}

function sanitizeExtractionPolicy(input: unknown): ScrapeRecipeConfig["extractionPolicy"] | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as NonNullable<ScrapeRecipeConfig["extractionPolicy"]>;
  const labelAliases = sanitizeStringRecord(record.labelAliases);
  const policy: NonNullable<ScrapeRecipeConfig["extractionPolicy"]> = {
    ...(Object.keys(labelAliases).length ? { labelAliases } : {}),
    ...nonEmptyList("requiredSections", sanitizeStringList(record.requiredSections).slice(0, 80)),
    ...nonEmptyList("documentUrlPatterns", sanitizeStringList(record.documentUrlPatterns).slice(0, 80)),
    ...nonEmptyList("ignoredDocumentUrlPatterns", sanitizeStringList(record.ignoredDocumentUrlPatterns).slice(0, 80)),
    ...nonEmptyList("ignoredImageUrlPatterns", sanitizeStringList(record.ignoredImageUrlPatterns).slice(0, 80)),
    ...(record.maxRawAttributes !== undefined ? { maxRawAttributes: clampInteger(Number(record.maxRawAttributes), 1, 2000) } : {}),
    ...(record.maxDocuments !== undefined ? { maxDocuments: clampInteger(Number(record.maxDocuments), 1, 300) } : {})
  };
  return Object.keys(policy).length ? policy : undefined;
}

function sanitizeQualityPolicy(input: unknown): ScrapeRecipeConfig["qualityPolicy"] | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as NonNullable<ScrapeRecipeConfig["qualityPolicy"]>;
  const normalizedFields = new Set(["weight", "dimensions", "material", "voltage", "current", "protection", "certificates"]);
  const documentTypes = new Set(["datasheet", "certificate", "manual", "cad", "image", "other"]);
  const requiredNormalizedFields = Array.isArray(record.requiredNormalizedFields)
    ? record.requiredNormalizedFields.filter((item): item is RequiredNormalizedField => typeof item === "string" && normalizedFields.has(item))
    : [];
  const requiredDocumentTypes = Array.isArray(record.requiredDocumentTypes)
    ? record.requiredDocumentTypes.filter((item): item is RequiredDocumentType => typeof item === "string" && documentTypes.has(item))
    : [];
  const policy: NonNullable<ScrapeRecipeConfig["qualityPolicy"]> = {
    ...(requiredNormalizedFields.length ? { requiredNormalizedFields: [...new Set(requiredNormalizedFields)] } : {}),
    ...(record.minRawAttributes !== undefined ? { minRawAttributes: clampInteger(Number(record.minRawAttributes), 0, 2000) } : {}),
    ...(requiredDocumentTypes.length ? { requiredDocumentTypes: [...new Set(requiredDocumentTypes)] } : {}),
    ...(record.officialSourceConfidenceFloor !== undefined ? { officialSourceConfidenceFloor: clampOptionalNumber(record.officialSourceConfidenceFloor, 0.05, 0.99) } : {}),
    ...(record.partialConfidenceCap !== undefined ? { partialConfidenceCap: clampOptionalNumber(record.partialConfidenceCap, 0.05, 0.99) } : {}),
    ...(record.distributorConfidenceCap !== undefined ? { distributorConfidenceCap: clampOptionalNumber(record.distributorConfidenceCap, 0.05, 0.95) } : {})
  };
  return Object.keys(policy).length ? policy : undefined;
}

function sanitizeDynamicFramework(input: ScrapeRecipeConfig["dynamicFramework"]): ScrapeRecipeConfig["dynamicFramework"] | undefined {
  const allowed = new Set(["generic", "json-ld", "embedded-json", "next", "nuxt", "astro", "livewire", "api"]);
  if (Array.isArray(input)) {
    const values = input.filter((item) => typeof item === "string" && allowed.has(item));
    return values.length ? [...new Set(values)] as ScrapeRecipeConfig["dynamicFramework"] : undefined;
  }
  return typeof input === "string" && allowed.has(input) ? input : undefined;
}

function sanitizeFallbackPolicy(input: unknown): ScrapeRecipeConfig["fallbackPolicy"] | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as NonNullable<ScrapeRecipeConfig["fallbackPolicy"]>;
  const policy: NonNullable<ScrapeRecipeConfig["fallbackPolicy"]> = {
    ...(typeof record.officialFirst === "boolean" ? { officialFirst: record.officialFirst } : {}),
    ...(typeof record.readerOnQualityFailure === "boolean" ? { readerOnQualityFailure: record.readerOnQualityFailure } : {}),
    ...(typeof record.browserOnQualityFailure === "boolean" ? { browserOnQualityFailure: record.browserOnQualityFailure } : {}),
    ...(typeof record.distributorFallback === "boolean" ? { distributorFallback: record.distributorFallback } : {}),
    ...(record.distributorConfidenceCap !== undefined ? { distributorConfidenceCap: clampOptionalNumber(record.distributorConfidenceCap, 0.05, 0.95) } : {}),
    ...(record.maxReaderAttempts !== undefined ? { maxReaderAttempts: clampInteger(Number(record.maxReaderAttempts), 0, 5) } : {}),
    ...(record.maxBrowserAttempts !== undefined ? { maxBrowserAttempts: clampInteger(Number(record.maxBrowserAttempts), 0, 3) } : {})
  };
  return Object.keys(policy).length ? policy : undefined;
}

function sanitizeConfidenceRules(input: unknown): ScrapeRecipeConfig["confidenceRules"] | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as NonNullable<ScrapeRecipeConfig["confidenceRules"]>;
  const rules: NonNullable<ScrapeRecipeConfig["confidenceRules"]> = {
    ...(record.foundMinScore !== undefined ? { foundMinScore: clampOptionalNumber(record.foundMinScore, 0, 100) } : {}),
    ...(record.partialMaxConfidence !== undefined ? { partialMaxConfidence: clampOptionalNumber(record.partialMaxConfidence, 0.05, 0.95) } : {}),
    ...(record.distributorMaxConfidence !== undefined ? { distributorMaxConfidence: clampOptionalNumber(record.distributorMaxConfidence, 0.05, 0.95) } : {}),
    ...(record.officialDocumentBonus !== undefined ? { officialDocumentBonus: clampOptionalNumber(record.officialDocumentBonus, 0, 20) } : {}),
    ...(record.browserPenalty !== undefined ? { browserPenalty: clampOptionalNumber(record.browserPenalty, 0, 20) } : {}),
    ...(record.readerPenalty !== undefined ? { readerPenalty: clampOptionalNumber(record.readerPenalty, 0, 20) } : {})
  };
  return Object.keys(rules).length ? rules : undefined;
}

function sanitizeStringList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map((item) => clean(String(item))).filter(Boolean))];
}

function sanitizeStringRecord(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>)
      .map(([key, value]) => [clean(key), clean(String(value))] as const)
      .filter(([key, value]) => key && value)
  );
}

function nonEmptyList<Key extends string, Value>(key: Key, value: Value[]): Record<Key, Value[]> | {} {
  return value.length ? { [key]: value } as Record<Key, Value[]> : {};
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function clampOptionalNumber(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return undefined;
  return Math.max(min, Math.min(max, numberValue));
}
