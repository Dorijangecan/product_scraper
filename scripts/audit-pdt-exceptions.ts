import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listManufacturerConfigs } from "../src/server/config/manufacturers.js";
import { CURATED_ACCESSORY_RULES } from "../src/server/pdt/product-accessory-sheet.js";
import { PDT_EXCEPTION_RULES } from "../src/server/pdt/pdt-exceptions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const factsPath = path.join(rootDir, "src", "server", "pdt", "facts.ts");
const pdtRulesPath = path.join(rootDir, "src", "server", "pdt", "rules.ts");
const source = fs.readFileSync(factsPath, "utf8");
const pdtRulesSource = fs.readFileSync(pdtRulesPath, "utf8");
const manufacturersPath = path.join(rootDir, "src", "server", "config", "manufacturers.ts");
const manufacturersSource = fs.readFileSync(manufacturersPath, "utf8");

const deterministicCalls = [...source.matchAll(/addDeterministicRepair\(([\s\S]*?)\n\s*\);/g)];
const appliedRuleNames = [...pdtRulesSource.matchAll(/\bname:\s*"([^"]+)"/g)];
let profilePolicyExceptions = 0;
const errors: string[] = [];

const MANUFACTURER_RULE_PREFIX = /^(?:rockwell|abb|eaton|sce|saginaw|schneider|siemens|phoenix|balluff|eta|fath|schmersal|nvent|spelsberg)-/i;
const EVIDENCE_TERMS = /\b(?:manual PDTs?|PDT examples?|PDT Additional Documents|Additional Documents|source PDF|official|curated|source-backed|localized specification PDF|column allowlist|deterministic)\b/i;

for (const match of deterministicCalls) {
  const call = match[1];
  const line = lineNumberAt(source, match.index ?? 0);
  const strings = [...call.matchAll(/"((?:\\"|[^"])*)"/g)].map((entry) => entry[1]);
  const ruleName = strings.find((value) => /^[a-z0-9-]+-(?:default|defaults)$/i.test(value));
  const reason = [...strings].reverse().find((value) => EVIDENCE_TERMS.test(value));

  if (!ruleName) {
    errors.push(`${relative(factsPath)}:${line}: deterministic PDT repair is missing a documented rule name ending in -default/-defaults.`);
    continue;
  }
  validateRuleMetadata({
    filePath: factsPath,
    line,
    ruleName,
    rationale: reason,
    context: "manufacturer-specific deterministic PDT repair"
  });
}

for (const rule of PDT_EXCEPTION_RULES) {
  const line = lineForLiteral(fs.readFileSync(path.join(rootDir, "src", "server", "pdt", "pdt-exceptions.ts"), "utf8"), rule.name);
  if (!rule.name || !rule.manufacturerId || !rule.rationale) {
    errors.push(`${relative(path.join(rootDir, "src", "server", "pdt", "pdt-exceptions.ts"))}:${line}: PDT exception rule is missing name, manufacturerId, or rationale.`);
    continue;
  }
  if (!rule.name.startsWith(`${rule.manufacturerId}-`)) {
    errors.push(`${relative(path.join(rootDir, "src", "server", "pdt", "pdt-exceptions.ts"))}:${line}: PDT exception rule "${rule.name}" must start with manufacturer id "${rule.manufacturerId}-".`);
  }
  validateRuleMetadata({
    filePath: path.join(rootDir, "src", "server", "pdt", "pdt-exceptions.ts"),
    line,
    ruleName: rule.name,
    rationale: rule.rationale,
    context: "PDT exception registry rule"
  });
}

for (const rule of CURATED_ACCESSORY_RULES) {
  const line = lineForLiteral(fs.readFileSync(path.join(rootDir, "src", "server", "pdt", "product-accessory-sheet.ts"), "utf8"), rule.name);
  if (!rule.name || !rule.manufacturerId || !rule.catalogPattern || !rule.accessoryCatalog || !rule.rationale) {
    errors.push(`${relative(path.join(rootDir, "src", "server", "pdt", "product-accessory-sheet.ts"))}:${line}: curated accessory rule is missing name, manufacturerId, catalogPattern, accessoryCatalog, or rationale.`);
    continue;
  }
  if (!rule.name.startsWith(`${rule.manufacturerId}-`)) {
    errors.push(`${relative(path.join(rootDir, "src", "server", "pdt", "product-accessory-sheet.ts"))}:${line}: curated accessory rule "${rule.name}" must start with manufacturer id "${rule.manufacturerId}-".`);
  }
  validateRuleMetadata({
    filePath: path.join(rootDir, "src", "server", "pdt", "product-accessory-sheet.ts"),
    line,
    ruleName: rule.name,
    rationale: rule.rationale,
    context: "curated Product Accessory rule"
  });
}

for (const match of appliedRuleNames) {
  const ruleName = match[1];
  const line = lineNumberAt(pdtRulesSource, match.index ?? 0);
  const chunk = pdtRulesSource.slice(match.index ?? 0, Math.min(pdtRulesSource.length, (match.index ?? 0) + 700));
  const rationale = chunk.match(/\brationale:\s*"([^"]+)"/)?.[1];
  validateRuleMetadata({
    filePath: pdtRulesPath,
    line,
    ruleName,
    rationale,
    context: "PDT applied rule"
  });
}

for (const manufacturer of listManufacturerConfigs().filter((item) => item.origin === "built-in" || item.isBuiltIn)) {
  const quality = manufacturer.scrapeRecipe?.qualityPolicy;
  if (quality?.requiredFinalFields?.length) {
    profilePolicyExceptions += 1;
    validateProfilePolicyRationale({
      manufacturerId: manufacturer.id,
      policyKey: "requiredFinalFields",
      rationale: quality.rationales?.requiredFinalFields
    });
  }
  if (quality?.preferredFinalFields?.length) {
    profilePolicyExceptions += 1;
    validateProfilePolicyRationale({
      manufacturerId: manufacturer.id,
      policyKey: "preferredFinalFields",
      rationale: quality.rationales?.preferredFinalFields
    });
  }
  if (quality?.typeCodeFallback) {
    profilePolicyExceptions += 1;
    validateProfilePolicyRationale({
      manufacturerId: manufacturer.id,
      policyKey: "typeCodeFallback",
      rationale: quality.rationales?.typeCodeFallback
    });
  }
  const fallback = manufacturer.scrapeRecipe?.fallbackPolicy;
  if (fallback?.documentDownloadProfile && fallback.documentDownloadProfile !== "full") {
    profilePolicyExceptions += 1;
    validateProfilePolicyRationale({
      manufacturerId: manufacturer.id,
      policyKey: "documentDownloadProfile",
      rationale: fallback.rationales?.documentDownloadProfile
    });
  }
  if (fallback?.skipPreferredFinalCompletenessRetry) {
    profilePolicyExceptions += 1;
    validateProfilePolicyRationale({
      manufacturerId: manufacturer.id,
      policyKey: "skipPreferredFinalCompletenessRetry",
      rationale: fallback.rationales?.skipPreferredFinalCompletenessRetry
    });
  }
}

if (errors.length > 0) {
  console.error("=== PDT exception audit ===");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log("=== PDT exception audit ===");
  console.log(
    `  (clean - ${deterministicCalls.length} deterministic defaults, ${PDT_EXCEPTION_RULES.length} exception rules, ${CURATED_ACCESSORY_RULES.length} curated accessory rules, ${profilePolicyExceptions} profile policy exceptions, and ${appliedRuleNames.length} applied PDT rules carry documented rationale)`
  );
}

function validateRuleMetadata(input: {
  filePath: string;
  line: number;
  ruleName: string;
  rationale: string | undefined;
  context: string;
}): void {
  if (!MANUFACTURER_RULE_PREFIX.test(input.ruleName)) return;
  if (!input.rationale) {
    errors.push(`${relative(input.filePath)}:${input.line}: ${input.context} "${input.ruleName}" is missing rationale.`);
    return;
  }
  if (!EVIDENCE_TERMS.test(input.rationale)) {
    errors.push(
      `${relative(input.filePath)}:${input.line}: ${input.context} "${input.ruleName}" must cite manual PDT, official/source, curated, or source-backed evidence in its rationale.`
    );
  }
}

function validateProfilePolicyRationale(input: {
  manufacturerId: string;
  policyKey: string;
  rationale: string | undefined;
}): void {
  const ruleName = `${input.manufacturerId}-${input.policyKey}`;
  const line = lineForLiteral(manufacturersSource, input.policyKey);
  validateRuleMetadata({
    filePath: manufacturersPath,
    line,
    ruleName,
    rationale: input.rationale,
    context: "manufacturer profile policy exception"
  });
}

function lineForLiteral(text: string, literal: string): number {
  const index = text.indexOf(literal);
  return lineNumberAt(text, index >= 0 ? index : 0);
}

function lineNumberAt(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length;
}

function relative(filePath: string): string {
  return path.relative(rootDir, filePath).replace(/\\/g, "/");
}
