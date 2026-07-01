import { dedupeAttributes as dedupeAttributesBase } from "./dedupe.js";
import { uniqueStrings as uniqueStringsBase } from "../text-util.js";
import type { AttributeRecord } from "../../shared/types.js";
import { cleanText } from "./normalizer.js";
import { parseQuantities, type ParsedQuantity, type QuantityKind } from "./quantity.js";

interface ElectricalSpecDefinition {
  name: string;
  kind: QuantityKind;
  labels: RegExp[];
  exclude?: RegExp[];
}

const ELECTRICAL_SPEC_DEFINITIONS: ElectricalSpecDefinition[] = [
  {
    name: "Control voltage",
    kind: "voltage",
    labels: [
      /\b(?:rated\s+)?control(?:\s+circuit)?\s+voltage\b/i,
      /\bcoil\s+voltage\b/i,
      /\bUc\b/
    ],
    exclude: [/resistance|power|consumption|current|inrush|pickup|drop[-\s]?out/i]
  },
  {
    name: "Rated insulation voltage",
    kind: "voltage",
    labels: [
      /\b(?:rated\s+)?insulation\s+voltage\b/i,
      /\bisolation\s+voltage\b/i,
      /\bUi\b/
    ]
  },
  {
    name: "Rated impulse withstand voltage",
    kind: "voltage",
    labels: [
      /\b(?:rated\s+)?impulse\s+(?:withstand\s+)?voltage\b/i,
      /\brated\s+surge\s+voltage\b/i,
      /\bUimp\b/
    ]
  },
  {
    name: "Voltage drop",
    kind: "voltage",
    labels: [
      /\bvoltage\s+drop\b/i,
      /\bon[-\s]?state\s+voltage\s+drop\b/i,
      /\bresidual\s+voltage\b/i
    ]
  },
  {
    name: "Rated voltage",
    kind: "voltage",
    labels: [
      /\b(?:rated|nominal|operating|operational|supply|input|output|working|mains|auxiliary|load)\s+voltage(?:\s+range|\s+rating|\s+limits?)?\b/i,
      /\b(?:field\s+power|module\s+supply|sensor\s+supply)\s+voltage(?:\s+range)?\b/i,
      /\b(?:min(?:imum)?|max(?:imum)?)\s+(?:rated\s+|operating\s+|supply\s+)?voltage\b/i,
      /\bvoltage\s+(?:range|rating|rated\s+value|nominal\s+value|limits?)\b/i,
      /\bU[esbnr]\b/,
      /\u7535\u538b/,
      /\u8f93\u5165\u7535\u538b/,
      /\u8f93\u51fa\u7535\u538b/,
      /\u989d\u5b9a\u7535\u538b/
    ],
    exclude: [/insulation|isolation|impulse|surge|withstand|control|coil|drop|short[-\s]?circuit|trip/i]
  },
  {
    name: "Breaking capacity",
    kind: "current",
    labels: [
      /\b(?:short[-\s]?circuit\s+)?current\s+rating\s*\(?SCCR\)?\b/i,
      /\bshort[-\s]?circuit\s+(?:current|capacity|breaking|withstand|rating)\b/i,
      /\b(?:interrupting?|breaking)\s+(?:rating|capacity)\b/i,
      /\b(?:Icu|Ics|Icw|Icm|Icn|SCCR|AIC)\b/i
    ]
  },
  {
    name: "Leakage current",
    kind: "current",
    labels: [
      /\bleakage\s+current\b/i,
      /\boff[-\s]?state\s+leakage(?:\s+current)?\b/i,
      /\boff[-\s]?state\s+current\b/i,
      /\bresidual\s+current\b/i
    ],
    exclude: [/rated\s+residual|differential/i]
  },
  {
    name: "Current consumption",
    kind: "current",
    labels: [
      /\bcurrent\s+consumption(?:\s+max\.?)?\b/i,
      /\boperating\s+current\s+consumption\b/i,
      /\b(?:input|supply|module|electronics|sensor)\s+current(?:\s+consumption|\s+draw|\s+max\.?|\s+typical)?\b/i,
      /\bcurrent\s+draw(?:\s+(?:at|@)\s+\d+\s*V(?:\s*(?:AC|DC))?)?\b/i,
      /\bno[-\s]?load\s+current(?:\s+I[o0])?(?:\s+max\.?)?\b/i,
      /\b(?:quiescent|idle|standby)\s+current\b/i
    ],
    exclude: [/leakage|residual|fault|short[-\s]?circuit|breaking|interrupt/i]
  },
  {
    name: "Rated current",
    kind: "current",
    labels: [
      /\b(?:rated|nominal|operating|operational|continuous|thermal|load|output|line|full[-\s]?load)\s+current(?:\s+rating|\s+range|\s+value)?\b/i,
      /\b(?:rated\s+)?operational\s+current\s+(?:AC|DC)[-\s]?\d{1,2}[a-eA-E]?\b/i,
      /\b(?:permissible|maximum|max\.?)\s+(?:load\s+)?current\b/i,
      /\bcurrent[-\s]?carrying\s+capacity\b/i,
      /\b(?:In|Ie|Iu|Ith|Inm|Inom)\b/,
      /\u7535\u6d41/,
      /\u989d\u5b9a\u7535\u6d41/,
      /\u8f93\u5165\u7535\u6d41/,
      /\u8f93\u51fa\u7535\u6d41/
    ],
    exclude: [/consumption|draw|input\s+current|supply\s+current|no[-\s]?load|quiescent|standby|leakage|residual|short[-\s]?circuit|breaking|interrupt/i]
  },
  {
    name: "Power loss",
    kind: "power",
    labels: [
      /\bpower\s+loss(?:es)?(?:\s+\[?W\]?)?(?:\s*\/\s*(?:maximum|rated|per\s+pole))?\b/i,
      /\b(?:total|internal|static)\s+power\s+loss(?:es)?\b/i,
      /\bpower\s+dissipation(?:\s+(?:per\s+pole|in\s+W))?\b/i,
      /\bmodule\s+power\s+dissipation\b/i,
      /\bpower\s+loss\s+per\s+pole\b/i,
      /\bdissipation\s+power\b/i,
      /\bdissipated\s+power\b/i,
      /\bpower\s+dissipated\b/i,
      /\b(?:heat|thermal)\s+dissipation\b/i,
      /\bheat\s+(?:loss(?:es)?|generated)\b/i,
      /\bwatts?\s+loss(?:es)?\b/i,
      /\bP(?:_|-)?loss\b/i,
      /\bP(?:v|vs|ls|le|lIp)\b/i
    ]
  },
  {
    name: "Power consumption",
    kind: "power",
    labels: [
      /\bpower\s+consumption(?:,?\s+typical)?\b/i,
      /\bmodule\s+power\s+consumption\b/i,
      /\b(?:input\s+power|power\s+input)(?:,?\s+max\.?)?\b/i,
      /\b(?:standby|idle|no[-\s]?load)\s+power\b/i,
      /\u529f\u7387/,
      /\u989d\u5b9a\u529f\u7387/,
      /\u8f93\u51fa\u529f\u7387/
    ],
    exclude: [/loss|dissipation/i]
  }
];

const NEXT_LABEL_PATTERNS = ELECTRICAL_SPEC_DEFINITIONS.flatMap((definition) => definition.labels);

export function extractElectricalSpecAttributesFromText(input: {
  text: string;
  sourceUrl: string;
  group?: string;
  maxAttributes?: number;
}): AttributeRecord[] {
  const normalized = normalizeSpecMiningText(input.text);
  if (!normalized) return [];
  const group = input.group ?? "Electrical Spec Miner";
  const maxAttributes = input.maxAttributes ?? 80;
  const attributes: AttributeRecord[] = [];

  for (const definition of ELECTRICAL_SPEC_DEFINITIONS) {
    for (const labelPattern of definition.labels) {
      for (const match of normalized.matchAll(globalPattern(labelPattern))) {
        const label = cleanText(match[0]);
        const index = match.index ?? 0;
        const before = normalized.slice(Math.max(0, index - 40), index);
        const after = normalized.slice(index + match[0].length, index + match[0].length + 220);
        const labelContext = cleanText(`${before} ${label}`);
        if (definition.exclude?.some((pattern) => pattern.test(labelContext))) continue;

        const valueWindow = trimValuePrefix(after);
        const valueSlice = valueWindow.slice(0, nextLabelIndex(valueWindow));
        const value = valueFromQuantity(valueSlice, definition.kind);
        if (!value) continue;

        attributes.push({
          group,
          name: labelForAttribute(definition, label),
          value,
          sourceUrl: input.sourceUrl
        });
      }
    }
  }

  return dedupeAttributes(attributes).slice(0, maxAttributes);
}

function normalizeSpecMiningText(text: string): string {
  return cleanText(text)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&deg;/gi, "°")
    .replace(/["'{}[\]]/g, " ")
    .replace(/\s*[:=]\s*/g, ": ")
    .replace(/\s+/g, " ")
    .trim();
}

function trimValuePrefix(value: string): string {
  return cleanText(value)
    .replace(/^(?:[):=|,;./-]|\bis\b|\bare\b|\bof\b|\bvalue\b|\brange\b|\brated\s+value\b)\s*/i, "")
    .trim();
}

function valueFromQuantity(text: string, kind: QuantityKind): string | undefined {
  const cleaned = cleanText(text).replace(/^[,;:|/-]+/, "").trim();
  if (!cleaned || cleaned.length > 180) return undefined;
  const quantities = parseQuantities(cleaned, { kind });
  const composite = compositeQuantityValue(cleaned, quantities, kind);
  if (composite) return composite;
  const quantity = quantities[0];
  if (!quantity?.raw) return undefined;

  const rawIndex = cleaned.toLowerCase().indexOf(quantity.raw.toLowerCase());
  const start = rawIndex >= 0 ? rawIndex : 0;
  const before = safeLeadingQualifier(cleaned.slice(Math.max(0, start - 42), start));
  const after = cleaned.slice(start + quantity.raw.length);
  const currentType = kind === "voltage" || kind === "current"
    ? immediateCurrentTypeAfter(cleaned, quantity.raw)
    : undefined;
  const condition = after.match(/^\s*(?:at|@|bei|per|pri)\s*[+-]?\d+(?:[.,]\d+)?\s*(?:°\s*C|VAC|VDC|kV|mV|V|kA|mA|A|kW|mW|W|Hz|%|bar)/i)?.[0];
  const value = cleanText([before, quantity.raw, currentType, precedingConditionBefore(cleaned, quantity.raw) ?? quantity.condition ?? condition].filter(Boolean).join(" "))
    .replace(/^(?:[):=|,;./-]|\bis\b|\bare\b|\bvalue\b|\brange\b)\s*/i, "")
    .trim();
  if (!value || !/[0-9]/.test(value)) return undefined;
  return value.length <= 120 ? value : quantity.raw;
}

function compositeQuantityValue(text: string, quantities: ParsedQuantity[], kind: QuantityKind): string | undefined {
  if (quantities.length === 0) return undefined;
  const min = quantities.find((quantity) => quantity.min !== undefined);
  const max = quantities.find((quantity) => quantity.max !== undefined);
  if (min?.min !== undefined && max?.max !== undefined && min.unit && min.unit === max.unit) {
    const currentType = immediateCurrentTypeAfter(text, max.raw) ?? immediateCurrentTypeAfter(text, min.raw) ?? max.currentType ?? min.currentType;
    return cleanText(`${formatNumber(min.min)}...${formatNumber(max.max)} ${min.unit} ${currentType ?? ""}`);
  }

  const alternatives = quantities
    .filter((quantity) => quantity.value !== undefined && quantity.unit)
    .slice(0, 4)
    .map((quantity) => quantityValueWithImmediateContext(text, quantity, kind))
    .filter((value): value is string => Boolean(value));
  if (alternatives.length >= 2) return uniqueStrings(alternatives).join(" / ");

  return undefined;
}

function quantityValueWithImmediateContext(text: string, quantity: ParsedQuantity, kind: QuantityKind): string | undefined {
  const currentType = kind === "voltage" || kind === "current" ? immediateCurrentTypeAfter(text, quantity.raw) : undefined;
  const value = cleanText([quantity.raw, currentType, quantity.condition].filter(Boolean).join(" "));
  return value && /[0-9]/.test(value) ? value : undefined;
}

function immediateCurrentTypeAfter(text: string, raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const index = text.toLowerCase().indexOf(raw.toLowerCase());
  if (index < 0) return undefined;
  const after = text.slice(index + raw.length);
  return cleanText(after.match(/^\s*(?:AC\s*\/\s*DC|AC-DC|ACDC|AC|DC)\b/i)?.[0] ?? "");
}

function precedingConditionBefore(text: string, raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const index = text.toLowerCase().indexOf(raw.toLowerCase());
  if (index < 0) return undefined;
  const before = text.slice(Math.max(0, index - 40), index);
  return cleanText(before.match(/(?:at|@|bei|per|pri)\s*[+-]?\d+(?:[.,]\d+)?\s*(?:VAC|VDC|kV|mV|V)\s*(?:AC|DC)?\s*$/i)?.[0] ?? "");
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value).replace(/\.?0+$/g, "");
}

function safeLeadingQualifier(value: string): string | undefined {
  const cleaned = cleanText(value).replace(/^[,;:|/)-]+/, "").trim();
  if (!cleaned) return undefined;
  if (parseQuantities(cleaned).length > 0) return undefined;
  if (/\d/.test(cleaned)) return undefined;
  const qualifier = cleaned.match(/\b(?:AC|DC)[-\s]?\d{1,2}[a-eA-E]?|\bper\s+pole\b|\bRMS\b/i)?.[0];
  return qualifier ? cleanText(qualifier) : undefined;
}

function nextLabelIndex(text: string): number {
  let best = text.length;
  for (const pattern of NEXT_LABEL_PATTERNS) {
    const match = globalPattern(pattern).exec(text);
    if (!match || match.index < 3) continue;
    best = Math.min(best, match.index);
  }
  const separator = text.search(/\s(?:\||;|•)\s/);
  if (separator >= 8) best = Math.min(best, separator);
  return Math.max(0, best);
}

function labelForAttribute(definition: ElectricalSpecDefinition, matchedLabel: string): string {
  const label = cleanText(matchedLabel)
    .replace(/\s+/g, " ")
    .replace(/^([a-z])/, (char) => char.toUpperCase());
  return label.length >= 3 && label.length <= 80 ? label : definition.name;
}

function globalPattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
}

function dedupeAttributes(attributes: AttributeRecord[]): AttributeRecord[] {
  return dedupeAttributesBase(attributes, { includeSourceUrl: true, requireNameValue: false });
}

function uniqueStrings(values: string[]): string[] {
  return uniqueStringsBase(values, { filterEmpty: false });
}
