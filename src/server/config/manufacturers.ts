import fs from "node:fs";
import path from "node:path";
import type { FallbackSourceConfig, ManufacturerConfig, ManufacturerId } from "../../shared/types.js";

const builtInManufacturerConfigs: Record<string, ManufacturerConfig> = {
  abb: {
    id: "abb",
    canonicalName: "ABB",
    shortName: "ABB",
    rateLimitMs: 1500,
    officialBaseUrls: ["https://new.abb.com/products", "https://new.abb.com/smartlinks"],
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
    ]
  },
  sce: {
    id: "sce",
    canonicalName: "Saginaw Control and Engineering",
    shortName: "SCE",
    rateLimitMs: 1500,
    officialBaseUrls: ["https://www.saginawcontrol.com"],
    fallbackSources: [
      {
        id: "kele-sce",
        label: "Kele distributor SKU page",
        enabled: true,
        sourceType: "distributor",
        directUrlTemplates: ["https://www.kele.com/product/sku?kid={partCompact}"]
      }
    ]
  },
  balluff: {
    id: "balluff",
    canonicalName: "Balluff",
    shortName: "BAL",
    rateLimitMs: 1200,
    officialBaseUrls: ["https://www.balluff.com/en-us/products"],
    fallbackSources: []
  },
  nvent: {
    id: "nvent",
    canonicalName: "nVent HOFFMAN",
    shortName: "NVE",
    rateLimitMs: 1500,
    officialBaseUrls: ["https://www.nvent.com/en-us/hoffman"],
    fallbackSources: [
      {
        id: "nvent-hoffman",
        label: "nVent HOFFMAN product page",
        enabled: true,
        sourceType: "official-fallback",
        directUrlTemplates: [
          "https://www.nvent.com/en-us/hoffman/products/enc{partLower}",
          "https://www.nvent.com/en-us/hoffman/products/enc{partLower}/pdf",
          "https://www.nvent.com/en-us/hoffman/products/{partLower}",
          "https://www.nvent.com/en-us/hoffman/products/{partLower}/pdf"
        ]
      }
    ]
  },
  rockwell: {
    id: "rockwell",
    canonicalName: "Rockwell Automation",
    shortName: "RA",
    rateLimitMs: 1800,
    officialBaseUrls: ["https://www.rockwellautomation.com/en-us/products"],
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
  eaton: {
    id: "eaton",
    canonicalName: "Eaton",
    shortName: "EAT",
    rateLimitMs: 1500,
    officialBaseUrls: ["https://www.eaton.com"],
    fallbackSources: [
      {
        id: "eaton-sku-page",
        label: "Eaton SKU page",
        enabled: true,
        sourceType: "official-fallback",
        directUrlTemplates: [
          "https://www.eaton.com/us/en-us/skuPage.{part}.html",
          "https://images.eaton.com/us/en-us/skuPage.{part}.html"
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
  schneider: {
    id: "schneider",
    canonicalName: "Schneider Electric",
    shortName: "SE",
    rateLimitMs: 1800,
    officialBaseUrls: ["https://www.se.com"],
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
      }
    ]
  },
  siemens: {
    id: "siemens",
    canonicalName: "Siemens",
    shortName: "SIE",
    rateLimitMs: 1800,
    officialBaseUrls: ["https://mall.industry.siemens.com"],
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
  return Object.values({ ...builtInManufacturerConfigs, ...customManufacturerConfigs }).sort((left, right) =>
    left.shortName.localeCompare(right.shortName, undefined, { sensitivity: "base" })
  );
}

export function getManufacturerConfig(id: string): ManufacturerConfig | undefined {
  return customManufacturerConfigs[id] ?? builtInManufacturerConfigs[id];
}

export async function saveManufacturerConfig(input: unknown): Promise<ManufacturerConfig> {
  if (!customConfigPath) throw new Error("Manufacturer config store was not initialized.");
  const config = sanitizeManufacturerConfig(input);
  if (!config) throw new Error("Manufacturer config is invalid.");
  customManufacturerConfigs = {
    ...customManufacturerConfigs,
    [config.id]: config
  };
  await fs.promises.writeFile(customConfigPath, JSON.stringify(Object.values(customManufacturerConfigs), null, 2), "utf8");
  return config;
}

export function isBuiltInManufacturer(id: ManufacturerId): boolean {
  return Boolean(builtInManufacturerConfigs[id]);
}

function sanitizeManufacturerConfig(input: unknown): ManufacturerConfig | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Partial<ManufacturerConfig>;
  const id = slugify(String(record.id ?? ""));
  const canonicalName = clean(String(record.canonicalName ?? ""));
  const shortName = clean(String(record.shortName ?? "")).toUpperCase();
  const rateLimitMs = clampInteger(Number(record.rateLimitMs ?? 1500), 250, 10000);
  const officialBaseUrls = sanitizeStringList(record.officialBaseUrls);
  const fallbackSources = sanitizeFallbackSources(record.fallbackSources, id);

  if (!id || !canonicalName || !shortName) return undefined;
  return {
    id,
    canonicalName,
    shortName,
    rateLimitMs,
    officialBaseUrls,
    fallbackSources
  };
}

function sanitizeFallbackSources(input: unknown, manufacturerId: string): FallbackSourceConfig[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((source, index) => {
      const record = source as Partial<FallbackSourceConfig>;
      const label = clean(String(record.label ?? `Source ${index + 1}`));
      const id = slugify(String(record.id ?? (label || `${manufacturerId}-source-${index + 1}`)));
      const sourceType = record.sourceType === "distributor" ? "distributor" : "official-fallback";
      const directUrlTemplates = sanitizeStringList(record.directUrlTemplates).filter((template) =>
        /{part(?:Upper|Lower|Compact|Snake|Dash|AfterColon|AfterColonLower|AfterColonCompact)?}/.test(template)
      );
      if (!id || !label || directUrlTemplates.length === 0) return undefined;
      return {
        id,
        label,
        enabled: record.enabled !== false,
        sourceType,
        directUrlTemplates
      } satisfies FallbackSourceConfig;
    })
    .filter((source): source is FallbackSourceConfig => Boolean(source));
}

function sanitizeStringList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map((item) => clean(String(item))).filter(Boolean))];
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
