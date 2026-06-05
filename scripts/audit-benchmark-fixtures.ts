import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DocumentRecord, ProductResult } from "../src/shared/types.js";
import { initializeManufacturerConfig, listManufacturerConfigs } from "../src/server/config/manufacturers.js";
import { deviceSheetsFor, knownDeviceSheets } from "../src/server/pdt/device-sheet-map.js";
import { knownDeviceTypes } from "../src/server/scrapers/device-type.js";
import { DEVICE_TYPE_FAMILIES } from "../src/server/scrapers/device-type-families.js";
import { createAppPaths } from "../src/server/paths.js";

interface BenchmarkFixture {
  manufacturerId?: string;
  catalogNumber?: string;
  caseType?: string;
  expectedDeviceType?: string;
  riskTags?: unknown;
  expectedOfficialUrlPatterns?: unknown;
  requiredDocuments?: DocumentRecord["type"][];
  expectedNormalizedFields?: Array<keyof ProductResult["normalized"]>;
  knownRawAttributes?: string[];
  customerDocuments?: unknown;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const benchmarkDir = path.join(rootDir, "benchmarks");
const fixtureDir = path.join(benchmarkDir, "products");
const fixtureTargetsPath = path.join(benchmarkDir, "fixture-targets.json");
const allowedCaseTypes = new Set(["electrical", "mechanical", "accessory", "edge"]);
const allowedDocumentTypes = new Set<DocumentRecord["type"]>(["datasheet", "certificate", "manual", "cad", "image", "other"]);
const allowedNormalizedFields = new Set<keyof ProductResult["normalized"]>([
  "weight",
  "dimensions",
  "material",
  "wallThickness",
  "finish",
  "color",
  "voltage",
  "current",
  "protection",
  "certificates"
]);

initializeManufacturerConfig(createAppPaths(rootDir).dataDir);

const manufacturers = new Set(listManufacturerConfigs().map((manufacturer) => manufacturer.id));
const fixtures = await readFixtures(fixtureDir);
const errors: string[] = [];
const warnings: string[] = [];
const byManufacturer = new Map<string, BenchmarkFixture[]>();
const coveredDeviceTypes = new Map<string, Set<string>>();
const coveredDeviceSheets = new Map<string, Set<string>>();

for (const fixture of fixtures) {
  const label = `${fixture.manufacturerId ?? "<missing manufacturer>"}/${fixture.catalogNumber ?? "<missing catalog>"}`;
  if (!fixture.manufacturerId) {
    errors.push(`${label}: missing manufacturerId`);
    continue;
  }
  if (!manufacturers.has(fixture.manufacturerId)) errors.push(`${label}: manufacturer is not configured`);
  if (!fixture.catalogNumber) errors.push(`${label}: missing catalogNumber`);
  if (!fixture.caseType || !allowedCaseTypes.has(fixture.caseType)) {
    errors.push(`${label}: caseType must be one of ${[...allowedCaseTypes].join(", ")}`);
  }
  if (!fixture.expectedDeviceType?.trim()) {
    errors.push(`${label}: missing expectedDeviceType`);
  } else {
    const sheets = deviceSheetsFor(fixture.expectedDeviceType);
    if (!sheets.length) errors.push(`${label}: expectedDeviceType "${fixture.expectedDeviceType}" is not mapped to any PDT device sheet`);
    const manufacturersForType = coveredDeviceTypes.get(fixture.expectedDeviceType) ?? new Set<string>();
    manufacturersForType.add(fixture.manufacturerId);
    coveredDeviceTypes.set(fixture.expectedDeviceType, manufacturersForType);
    for (const sheetName of sheets) {
      const manufacturersForSheet = coveredDeviceSheets.get(sheetName) ?? new Set<string>();
      manufacturersForSheet.add(fixture.manufacturerId);
      coveredDeviceSheets.set(sheetName, manufacturersForSheet);
    }
  }
  if (!Array.isArray(fixture.riskTags) || !fixture.riskTags.every((tag) => typeof tag === "string" && tag.trim())) {
    errors.push(`${label}: riskTags must be a non-empty string array`);
  }
  if (!Array.isArray(fixture.expectedOfficialUrlPatterns) || fixture.expectedOfficialUrlPatterns.length === 0) {
    warnings.push(`${label}: no expectedOfficialUrlPatterns declared`);
  } else {
    for (const pattern of fixture.expectedOfficialUrlPatterns) {
      if (typeof pattern !== "string" || !pattern.trim()) {
        errors.push(`${label}: expectedOfficialUrlPatterns must contain non-empty strings`);
        continue;
      }
      try {
        new RegExp(pattern);
      } catch {
        errors.push(`${label}: expectedOfficialUrlPattern is not a valid regular expression: ${pattern}`);
      }
    }
  }
  if (fixture.requiredDocuments !== undefined) {
    if (!Array.isArray(fixture.requiredDocuments)) {
      errors.push(`${label}: requiredDocuments must be an array when present`);
    } else {
      for (const type of fixture.requiredDocuments) {
        if (!allowedDocumentTypes.has(type)) errors.push(`${label}: unknown requiredDocuments type "${type}"`);
      }
    }
  }
  if (fixture.expectedNormalizedFields !== undefined) {
    if (!Array.isArray(fixture.expectedNormalizedFields)) {
      errors.push(`${label}: expectedNormalizedFields must be an array when present`);
    } else {
      for (const field of fixture.expectedNormalizedFields) {
        if (!allowedNormalizedFields.has(field)) errors.push(`${label}: unknown expectedNormalizedFields entry "${String(field)}"`);
      }
    }
  }
  if (fixture.customerDocuments !== undefined) {
    if (!Array.isArray(fixture.customerDocuments) || !fixture.customerDocuments.every((entry) => typeof entry === "string" && entry.trim())) {
      errors.push(`${label}: customerDocuments must be a non-empty string array when present`);
    } else {
      for (const entry of fixture.customerDocuments) {
        if (path.isAbsolute(entry)) {
          errors.push(`${label}: customerDocument path must be relative to benchmarks/: ${entry}`);
          continue;
        }
        const documentPath = path.resolve(benchmarkDir, entry);
        if (!isWithinDirectory(documentPath, benchmarkDir)) {
          errors.push(`${label}: customerDocument path escapes benchmarks/: ${entry}`);
          continue;
        }
        try {
          const stat = await fs.stat(documentPath);
          if (!stat.isFile()) errors.push(`${label}: customerDocument is not a file: ${entry}`);
        } catch {
          errors.push(`${label}: customerDocument file does not exist: ${entry}`);
        }
      }
    }
  }
  const manufacturerFixtures = byManufacturer.get(fixture.manufacturerId) ?? [];
  manufacturerFixtures.push(fixture);
  byManufacturer.set(fixture.manufacturerId, manufacturerFixtures);
}

for (const manufacturerId of manufacturers) {
  const manufacturerFixtures = byManufacturer.get(manufacturerId) ?? [];
  if (!manufacturerFixtures.length) {
    warnings.push(`${manufacturerId}: no benchmark fixture`);
  } else if (manufacturerFixtures.length < 2) {
    warnings.push(`${manufacturerId}: thin fixture coverage (${manufacturerFixtures.length}/2 minimum target)`);
  }
}

const uncoveredDeviceSheets = knownDeviceSheets().filter((sheetName) => !coveredDeviceSheets.has(sheetName)).sort();
const recommendations = coverageRecommendations(uncoveredDeviceSheets);
const thinManufacturers = [...manufacturers].filter((manufacturerId) => (byManufacturer.get(manufacturerId)?.length ?? 0) < 2).sort();
if (uncoveredDeviceSheets.length) {
  warnings.push(`PDT device-sheet fixture coverage is incomplete (${coveredDeviceSheets.size}/${knownDeviceSheets().length}); uncovered: ${uncoveredDeviceSheets.join(", ")}`);
}
try {
  await writeFixtureTargets({
    manufacturers: [...manufacturers].sort(),
    thinManufacturers,
    coveredDeviceTypes,
    coveredDeviceSheets,
    recommendations
  });
} catch (error) {
  warnings.push(`Could not update fixture target manifest (${fixtureTargetsPath}): ${error instanceof Error ? error.message : "write failed"}`);
}

console.log("=== Benchmark fixture audit ===");
console.log(`Fixtures: ${fixtures.length}`);
console.log(`Manufacturers with fixtures: ${byManufacturer.size}/${manufacturers.size}`);
console.log(`Expected device types covered: ${coveredDeviceTypes.size}`);
console.log(`PDT device sheets covered: ${coveredDeviceSheets.size}/${knownDeviceSheets().length}`);
console.log(`Fixture target manifest: ${fixtureTargetsPath}`);
if (recommendations.length) {
  console.log("\nSuggested next PDT sheet fixtures:");
  for (const recommendation of recommendations.slice(0, 12)) {
    const example = recommendation.examples[0];
    const hint = example
      ? `${example.manufacturerId} ${example.pattern} (${example.deviceType}${example.notes ? ` - ${example.notes}` : ""})`
      : recommendation.deviceTypes.slice(0, 3).join(", ") || "no family hint";
    console.log(`- ${recommendation.sheetName}: ${hint}`);
  }
}
if (warnings.length) {
  console.log("\nWarnings:");
  for (const warning of warnings) console.log(`- ${warning}`);
}

if (errors.length) {
  console.error("\nBenchmark fixture audit failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
}

async function readFixtures(dir: string): Promise<BenchmarkFixture[]> {
  const files = (await fs.readdir(dir)).filter((file) => file.endsWith(".json")).sort();
  const fixtures: BenchmarkFixture[] = [];
  for (const file of files) {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, file), "utf8")) as BenchmarkFixture | BenchmarkFixture[];
    fixtures.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  }
  return fixtures;
}

function isWithinDirectory(filePath: string, dir: string): boolean {
  const relative = path.relative(dir, filePath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function coverageRecommendations(uncoveredDeviceSheets: string[]) {
  return uncoveredDeviceSheets.map((sheetName) => {
    const deviceTypes = knownDeviceTypes().filter((deviceType) => deviceSheetsFor(deviceType).includes(sheetName)).sort();
    return {
      sheetName,
      deviceTypes,
      examples: deviceTypes.flatMap((deviceType) => familyExamplesForDeviceType(deviceType)).slice(0, 5)
    };
  });
}

function familyExamplesForDeviceType(deviceType: string): Array<{ manufacturerId: string; pattern: string; deviceType: string; notes?: string }> {
  const examples: Array<{ manufacturerId: string; pattern: string; deviceType: string; notes?: string }> = [];
  for (const [manufacturerId, entries] of Object.entries(DEVICE_TYPE_FAMILIES)) {
    if (!manufacturers.has(manufacturerId)) continue;
    for (const entry of entries) {
      if (entry.type !== deviceType) continue;
      for (const pattern of entry.patterns.slice(0, 2)) {
        examples.push({ manufacturerId, pattern, deviceType, notes: entry.notes });
      }
    }
  }
  examples.sort((left, right) => left.manufacturerId.localeCompare(right.manufacturerId) || left.pattern.localeCompare(right.pattern));
  return examples;
}

async function writeFixtureTargets(input: {
  manufacturers: string[];
  thinManufacturers: string[];
  coveredDeviceTypes: Map<string, Set<string>>;
  coveredDeviceSheets: Map<string, Set<string>>;
  recommendations: ReturnType<typeof coverageRecommendations>;
}): Promise<void> {
  const targets = input.recommendations.map((recommendation) => ({
    sheetName: recommendation.sheetName,
    status: recommendation.examples.length ? "needs-catalog-fixture" : "needs-family-taxonomy-or-manual-catalog",
    deviceTypes: recommendation.deviceTypes,
    configuredFamilyHints: recommendation.examples
  }));
  const manifest = {
    summary: {
      manufacturersConfigured: input.manufacturers.length,
      thinManufacturers: input.thinManufacturers,
      deviceTypesCovered: input.coveredDeviceTypes.size,
      pdtDeviceSheetsCovered: input.coveredDeviceSheets.size,
      pdtDeviceSheetsTotal: knownDeviceSheets().length,
      uncoveredPdtDeviceSheets: targets.length
    },
    coveredDeviceTypes: mapSetToSortedRecord(input.coveredDeviceTypes),
    coveredDeviceSheets: mapSetToSortedRecord(input.coveredDeviceSheets),
    targets
  };
  await fs.writeFile(fixtureTargetsPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function mapSetToSortedRecord(map: Map<string, Set<string>>): Record<string, string[]> {
  return Object.fromEntries(
    [...map.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, values]) => [key, [...values].sort()])
  );
}
