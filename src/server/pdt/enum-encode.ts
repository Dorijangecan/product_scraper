function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export interface EnumLegendEntry {
  code: string;
  label: string;
}

/**
 * Parse a PDT enum legend embedded in a column description, e.g.
 * "Voltage type 1 - AC 2 - AC, alternating current 3 - AC/DC 4 - DC" ->
 * { ac: { code: "1", label: "AC" }, ... }.
 * Returns undefined when the column is NOT a strict enum - in particular when it explicitly
 * allows free text ("insert number or the name", "otherwise calculated"), so we never coerce a
 * free-text column into a code.
 */
export function parseEnumLegend(description: string): Map<string, EnumLegendEntry> | undefined {
  if (!description) return undefined;
  if (/insert (the )?number or|name of the|otherwise|ongoing|string\)/i.test(description)) return undefined;
  const text = description.replace(/\s+/g, " ").trim();
  const matches = [...text.matchAll(/(\d+)\s*[-\u2013]\s*(.+?)(?=\s+\d+\s*[-\u2013]\s|$)/g)];
  if (matches.length < 2) return undefined;
  const legend = new Map<string, EnumLegendEntry>();
  for (const m of matches) {
    const original = m[2].trim();
    const label = normalize(original);
    if (label && !legend.has(label)) legend.set(label, { code: m[1], label: original });
  }
  return legend.size >= 2 ? legend : undefined;
}

/**
 * Encode a raw scraped value to its enum code using the column's legend. Strict: only an exact
 * normalized match counts. Returns undefined when the column is not an enum or no option matches,
 * so the caller can leave the cell blank instead of writing an invalid code.
 */
export function encodeEnum(description: string, rawValue: string): string | undefined {
  return matchEnumEntry(description, rawValue)?.code;
}

/**
 * Resolve a raw scraped value to the legend's canonical label text (strict match). Returns
 * undefined when the column is not a strict enum or no option matches. Use this when you want
 * to write the human-readable label into a cell instead of an opaque numeric code.
 */
export function encodeEnumLabel(description: string, rawValue: string): string | undefined {
  return matchEnumEntry(description, rawValue)?.label ?? standardEnumLabel(description, rawValue);
}

function matchEnumEntry(description: string, rawValue: string): EnumLegendEntry | undefined {
  const legend = parseEnumLegend(description);
  if (!legend) return undefined;
  return legend.get(normalize(rawValue)) ?? matchNumericEnumEntry(legend, rawValue) ?? matchEnumCodeEntry(legend, rawValue);
}

function matchNumericEnumEntry(legend: Map<string, EnumLegendEntry>, rawValue: string): EnumLegendEntry | undefined {
  const rawVoltage = numericUnitValue(rawValue, "V") ?? (legendHasUnit(legend, "V") ? plainNumber(rawValue) : undefined);
  if (rawVoltage === undefined) return undefined;

  for (const entry of legend.values()) {
    const label = entry.label.replace(/\s+/g, " ").trim();
    const lessThan = label.match(/^<\s*(-?\d+(?:\.\d+)?)\s*V\b/i);
    if (lessThan && rawVoltage < Number(lessThan[1])) return entry;

    const upTo = label.match(/^up to\s*(-?\d+(?:\.\d+)?)\s*V\b/i);
    if (upTo && rawVoltage <= Number(upTo[1])) return entry;

    const greaterThan = label.match(/^greater than\s*(-?\d+(?:\.\d+)?)\s*V\b/i);
    if (greaterThan && rawVoltage > Number(greaterThan[1])) return entry;

    const range = label.match(/\b(-?\d+(?:\.\d+)?)\s*V\s*(?:up to|to|-)\s*(-?\d+(?:\.\d+)?)\s*V\b/i);
    if (range && rawVoltage >= Number(range[1]) && rawVoltage <= Number(range[2])) return entry;

    const compactRange = label.match(/\b(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)\s*V\b/i);
    if (compactRange && rawVoltage >= Number(compactRange[1]) && rawVoltage <= Number(compactRange[2])) return entry;

    const slashValues = label.match(/^((?:-?\d+(?:\.\d+)?\s*\/\s*)+-?\d+(?:\.\d+)?)\s*V\b/i);
    if (slashValues && slashValues[1].split("/").some((part) => rawVoltage === Number(part.trim()))) return entry;

    const exact = label.match(/^(-?\d+(?:\.\d+)?)\s*V\b/i);
    if (exact && rawVoltage === Number(exact[1])) return entry;
  }
  return undefined;
}

function matchEnumCodeEntry(legend: Map<string, EnumLegendEntry>, rawValue: string): EnumLegendEntry | undefined {
  if (legendHasUnit(legend, "V")) return undefined;
  const code = rawValue.trim();
  if (!/^\d+$/.test(code)) return undefined;
  return [...legend.values()].find((entry) => entry.code === code);
}

function legendHasUnit(legend: Map<string, EnumLegendEntry>, unit: string): boolean {
  return [...legend.values()].some((entry) => new RegExp(String.raw`\b${unit}\b`, "i").test(entry.label));
}

function numericUnitValue(value: string, unit: string): number | undefined {
  const match = value.replace(",", ".").match(new RegExp(String.raw`(-?\d+(?:\.\d+)?)\s*${unit}\b`, "i"));
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function plainNumber(value: string): number | undefined {
  const match = value.replace(",", ".").match(/^-?\d+(?:\.\d+)?$/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function standardEnumLabel(description: string, rawValue: string): string | undefined {
  if (/\bNEMA\b/i.test(description)) {
    const nema = standardNemaLabel(description, rawValue);
    if (nema) return nema;
  }
  if (/degree of protection/i.test(description)) return standardIpLabel(rawValue);
  if (/\bimpact strength\b/i.test(description)) return standardImpactStrengthLabel(rawValue);
  if (/\bthread\b/i.test(description)) return standardThreadLabel(rawValue);
  if (/\bprotection class\b/i.test(description)) return standardProtectionClassLabel(rawValue);
  if (/\bdesign of (?:the )?display\b/i.test(description)) return standardDisplayLabel(rawValue);
  if (/\b(switching element function|design of control element|contact, type of)\b/i.test(description)) return standardSwitchingElementLabel(rawValue);
  if (/\b(certificate|approval|quality characteristic record)\b/i.test(description)) {
    return standardApprovalLabel(description, rawValue);
  }
  if (/^\s*material\b/i.test(description)) return standardMaterialLabel(description, rawValue);
  if (/^\s*colou?r\b/i.test(description)) return standardColorLabel(rawValue);
  return undefined;
}

function standardIpLabel(value: string): string | undefined {
  const matches = [...value.matchAll(/\bIP(?:X\d|\d{2}K?|\d{2})\b/gi)].map((match) => match[0].toUpperCase());
  const unique = [...new Set(matches)];
  if (unique.length === 0) return undefined;
  if (unique.length === 1) return unique[0];
  return unique.sort((left, right) => ipRank(right) - ipRank(left)).join("/");
}

function standardNemaLabel(description: string, value: string): string | undefined {
  const rawTokens = nemaTokens(value);
  if (rawTokens.length === 0) return undefined;
  if (rawTokens.length === 1) return `NEMA ${rawTokens[0]}`;

  const rawSet = new Set(rawTokens);
  const legend = parseEnumLegend(description);
  if (!legend) return undefined;

  const candidates = [...legend.values()]
    .map((entry) => ({ entry, tokens: nemaTokens(entry.label) }))
    .filter(({ tokens }) => tokens.length > 0)
    .filter(({ tokens }) => rawTokens.every((token) => tokens.includes(token)))
    .sort((left, right) => left.tokens.length - right.tokens.length || left.entry.label.localeCompare(right.entry.label));
  const exact = candidates.find(({ tokens }) => tokens.length === rawSet.size);
  return (exact ?? candidates[0])?.entry.label;
}

function nemaTokens(value: string): string[] {
  const tokens = [...value.matchAll(/\b(?:NEMA\s*)?(?:TYPE\s*)?([0-9][0-9A-Z]*)\b/gi)].map((match) => match[1].toUpperCase());
  return [...new Set(tokens)];
}

function standardMaterialLabel(description: string, value: string): string | undefined {
  const text = normalize(value);
  if (!text || /^(?=.*\d)[a-z0-9]{8,}$/i.test(value.trim())) return undefined;
  const labels = [...(parseEnumLegend(description)?.values() ?? [])].map((entry) => entry.label);
  const hasLabel = (pattern: RegExp): string | undefined => labels.find((label) => pattern.test(label));
  if (/\bpbtp?\b|\bpolybutylene terephthalate\b/.test(text)) return "Plastic (PBT)";
  if (/\babs\b/.test(text)) return hasLabel(/^Plastic \(ABS\)$/i) ?? hasLabel(/^Plastic$/i);
  if (/\bpa\b|\bpa66\b|\bpolyamide\b/.test(text)) return hasLabel(/^polyamide$/i) ?? hasLabel(/^Thermoplast$/i) ?? hasLabel(/^Plastic$/i);
  if (/\bthermoplast\b/.test(text)) return hasLabel(/^Thermoplast$/i) ?? hasLabel(/^Plastic$/i);
  if (/\bpolycarbonate\b/.test(text)) return hasLabel(/^polycarbonate$/i) ?? hasLabel(/^Thermoplast$/i) ?? hasLabel(/^Plastic$/i);
  if (/\bepoxy\b|\bfiberglass\b|\bfibreglass\b|\bglass fiber\b|\bglass fibre\b/.test(text)) return hasLabel(/^Plastic$/i);
  if (/\bstainless steel\b/.test(text)) return "stainless steel";
  if (/\b(?:carbon|mild|sheet|galvanized)?\s*steel\b/.test(text)) return "steel";
  if (/\baluminium\b|\baluminum\b/.test(text)) return "aluminum";
  if (/\bpolyamide\b|\bpa66\b/.test(text)) return "polyamide";
  if (/\bpvc\b|\bpolyvinyl chloride\b/.test(text)) return "PVC";
  if (/\bcopper\b/.test(text)) return "copper";
  if (/\bbrass\b/.test(text)) return "brass";
  if (/\bbronze\b/.test(text)) return "bronze";
  if (/\bzinc\b/.test(text)) return "zinc";
  return undefined;
}

function standardProtectionClassLabel(value: string): string | undefined {
  const text = normalize(value);
  if (!text) return undefined;
  if (/\bwithout\b|\bnone\b|\bno protection\b/.test(text)) return "without";
  if (/\b(?:class|protection class)?\s*0\b/.test(text)) return "Protection class 0";
  if (/\b(?:class|protection class)?\s*(?:1|i)\b/.test(text)) return "Protection class 1";
  if (/\b(?:class|protection class)?\s*(?:2|ii)\b/.test(text)) return "Protection class 2";
  if (/\b(?:class|protection class)?\s*(?:3|iii)\b/.test(text)) return "Protection class 3";
  return undefined;
}

function standardImpactStrengthLabel(value: string): string | undefined {
  return value.match(/\bIK(?:0\d|10)\b/i)?.[0].toUpperCase();
}

function standardThreadLabel(value: string): string | undefined {
  return value.match(/\bM\d+(?=\D|$)/i)?.[0].toUpperCase();
}

function standardSwitchingElementLabel(value: string): string | undefined {
  const text = normalize(value);
  if (!text) return undefined;
  if (/\bnormally open contact\b|\bnormally open\b/.test(text) || /\bNO\b/.test(value)) return "Normally open contact";
  if (/\bnormally close contact\b|\bnormally closed contact\b|\bnormally close\b|\bnormally closed\b/.test(text) || /\bNC\b/.test(value)) {
    return "Normally close contact";
  }
  if (/\bchangeover\b|\bchange over\b|\bno nc\b|\bnc no\b/.test(text)) return "Changeover contact (NO/NC)";
  return undefined;
}

function standardColorLabel(value: string): string | undefined {
  const text = normalize(value);
  if (!text) return undefined;
  if (/\b(?:gray|grey|ansi 61)\b/.test(text)) return "gray";
  if (/\bwhite\b/.test(text)) return "white";
  if (/\bblack\b/.test(text)) return "black";
  if (/\bblue\b/.test(text)) return "blue";
  if (/\bred\b/.test(text)) return "red";
  if (/\bgreen\b/.test(text)) return "green";
  if (/\byellow\b/.test(text)) return "yellow";
  if (/\borange\b/.test(text)) return "orange";
  if (/\bstainless steel\b/.test(text)) return "Stainless steel";
  if (/\baluminium\b|\baluminum\b/.test(text)) return "aluminum";
  return undefined;
}

function standardDisplayLabel(value: string): string | undefined {
  const text = normalize(value);
  if (/\bled\b/.test(text)) return "LED";
  if (/\bdigital\b/.test(text)) return "Digital";
  if (/\bbar display\b/.test(text)) return "Bar display";
  return undefined;
}

function standardApprovalLabel(description: string, value: string): string | undefined {
  const legend = parseEnumLegend(description);
  if (!legend) return undefined;
  const raw = normalize(value);
  const labels = [...legend.values()].map((entry) => entry.label);
  const known = [
    { raw: /\bce\b/, label: /^CE$/i },
    { raw: /\bcsa\b/, label: /^CSA$/i },
    { raw: /\bvde\b/, label: /^VDE mark of conformity$/i },
    { raw: /\bgs\b/, label: /^GS mark of conformity$/i },
    { raw: /\bcecc\b/, label: /^CECC mark of conformity$/i },
    { raw: /\bcertificate of conformity\b/, label: /^2\.1,\s*Certificate of conformity$/i },
    { raw: /\btest certificate\b/, label: /^2\.2,\s*Test certificate$/i }
  ];
  for (const candidate of known) {
    if (!candidate.raw.test(raw)) continue;
    const label = labels.find((entry) => candidate.label.test(entry));
    if (label) return label;
  }
  return undefined;
}

function ipRank(value: string): number {
  const numeric = Number(value.match(/\d+/)?.[0] ?? 0);
  const suffix = /K$/i.test(value) ? 0.5 : 0;
  const xPenalty = /IPX/i.test(value) ? -100 : 0;
  return numeric + suffix + xPenalty;
}

/** True when the column description is a strict enum (code list) rather than free text. */
export function isEnumColumn(description: string): boolean {
  return parseEnumLegend(description) !== undefined;
}
