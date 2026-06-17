import type { ManufacturerId } from "../../shared/types.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";
import { emptyResult } from "./normalizer.js";
import { templateContainsCatalogPlaceholder } from "./catalog-number.js";

const connectorLoaders: Record<string, () => Promise<ManufacturerConnector>> = {
  abb: async () => new (await import("./abb.js")).ABBConnector(),
  balluff: async () => new (await import("./balluff.js")).BalluffConnector(),
  eaton: async () => new (await import("./eaton.js")).EatonConnector(),
  eta: async () => new (await import("./eta.js")).ETAConnector(),
  fath: async () => new (await import("./fath.js")).FathConnector(),
  rockwell: async () => new (await import("./rockwell.js")).RockwellConnector(),
  sce: async () => new (await import("./sce.js")).SCEConnector(),
  scame: async () => new (await import("./scame.js")).ScameConnector(),
  schmersal: async () => new (await import("./schmersal.js")).SchmersalConnector(),
  schneider: async () => new (await import("./schneider.js")).SchneiderConnector(),
  siemens: async () => new (await import("./siemens.js")).SiemensConnector(),
  spelsberg: async () => new (await import("./spelsberg.js")).SpelsbergConnector()
};
const connectorPromises = new Map<string, Promise<ManufacturerConnector>>();

export function getConnector(manufacturerId: ManufacturerId): ManufacturerConnector {
  const load = connectorLoaders[manufacturerId];
  return load ? new LazyManufacturerConnector(manufacturerId, load) : new ConfiguredManufacturerConnector(manufacturerId);
}

class LazyManufacturerConnector implements ManufacturerConnector {
  constructor(
    readonly id: ManufacturerId,
    private readonly load: () => Promise<ManufacturerConnector>
  ) {}

  async scrape(catalogNumber: string, context: ScrapeContext) {
    let connectorPromise = connectorPromises.get(this.id);
    if (!connectorPromise) {
      connectorPromise = this.load();
      connectorPromises.set(this.id, connectorPromise);
    }
    const connector = await connectorPromise;
    return connector.scrape(catalogNumber, context);
  }
}

class ConfiguredManufacturerConnector implements ManufacturerConnector {
  constructor(readonly id: ManufacturerId) {}

  async scrape(catalogNumber: string, context: ScrapeContext) {
    const officialTemplates = context.manufacturer.officialBaseUrls
      .filter(templateContainsCatalogPlaceholder)
      .map((url, index) => ({
        id: `${context.manufacturer.id}-official-${index + 1}`,
        label: `${context.manufacturer.shortName} official template`,
        enabled: true,
        sourceType: "official-fallback" as const,
        directUrlTemplates: [url]
      }));
    const searchTemplates = (context.manufacturer.scrapeRecipe?.searchUrlTemplates ?? [])
      .filter(templateContainsCatalogPlaceholder)
      .map((url, index) => ({
        id: `${context.manufacturer.id}-official-search-${index + 1}`,
        label: `${context.manufacturer.shortName} official search`,
        enabled: true,
        sourceType: "official-fallback" as const,
        directUrlTemplates: [url]
      }));
    const result = await context.fallback.scrape(catalogNumber, [
      ...officialTemplates,
      ...searchTemplates,
      ...context.manufacturer.fallbackSources
    ]);
    if (result) return result;

    return emptyResult(
      this.id,
      catalogNumber,
      `No configured URL template found a page for ${catalogNumber}. Add a source URL template containing {part}.`
    );
  }
}
