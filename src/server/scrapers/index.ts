import type { ManufacturerId } from "../../shared/types.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";
import { ABBConnector } from "./abb.js";
import { BalluffConnector } from "./balluff.js";
import { EatonConnector } from "./eaton.js";
import { SCEConnector } from "./sce.js";
import { SchneiderConnector } from "./schneider.js";
import { SiemensConnector } from "./siemens.js";
import { SpelsbergConnector } from "./spelsberg.js";
import { emptyResult } from "./normalizer.js";
import { templateContainsCatalogPlaceholder } from "./catalog-number.js";

const connectors: Record<string, ManufacturerConnector> = {
  abb: new ABBConnector(),
  balluff: new BalluffConnector(),
  eaton: new EatonConnector(),
  sce: new SCEConnector(),
  schneider: new SchneiderConnector(),
  siemens: new SiemensConnector(),
  spelsberg: new SpelsbergConnector()
};

export function getConnector(manufacturerId: ManufacturerId): ManufacturerConnector {
  return connectors[manufacturerId] ?? new ConfiguredManufacturerConnector(manufacturerId);
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
