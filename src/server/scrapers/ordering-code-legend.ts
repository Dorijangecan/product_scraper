import { compactCatalogNumber } from "./catalog-number.js";

export interface OrderingCodeLegendMatch {
  /** Human-readable property decoded from the legend section. */
  property: string;
  /** Published value, never an inferred replacement. */
  value: string;
  /** The code character/token that was found in the requested ordering code. */
  code: string;
  /** One-based code position when the source declared one. */
  position?: number;
}

/**
 * Reads the small, common subset of ordering-code legends that survives PDF
 * text extraction: a property heading followed by `CODE = value` rows.  A
 * one-character code is accepted only when the PDF declares its position;
 * otherwise it is too easy to find a coincidental digit in another SKU.
 */
export function decodeOrderingCodeLegend(lines: string[], orderingCode: string): OrderingCodeLegendMatch[] {
  const compactCode = compactCatalogNumber(orderingCode);
  if (!compactCode) return [];

  const matches: OrderingCodeLegendMatch[] = [];
  let property: string | undefined;
  let position: number | undefined;

  for (const rawLine of lines) {
    const line = cleanLegendText(rawLine);
    if (!line) continue;

    const heading = legendHeading(line);
    if (heading) {
      property = heading.property;
      position = heading.position;
      continue;
    }

    const entry = line.match(/^(?:([A-Za-z][A-Za-z /-]{2,60})\s*[:\-]\s*)?([A-Z0-9]{1,12})\s*[=:]\s*(.{2,120})$/i);
    if (!entry) continue;
    const entryProperty = cleanLegendText(entry[1] ?? "") || property || propertyFromValue(entry[3]);
    const code = entry[2].toUpperCase();
    const value = cleanLegendText(entry[3]);
    if (!entryProperty || !value || !codeMatchesOrderingCode(compactCode, code, position)) continue;
    matches.push({ property: entryProperty, value, code, ...(position ? { position } : {}) });
  }

  const seen = new Set<string>();
  return matches.filter((match) => {
    const key = `${match.property}|${match.value}|${match.code}|${match.position ?? ""}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function orderingCodeLegendValue(lines: string[], orderingCode: string, propertyPattern: RegExp): string | undefined {
  return decodeOrderingCodeLegend(lines, orderingCode).find((match) => propertyPattern.test(match.property))?.value;
}

function codeMatchesOrderingCode(compactOrderingCode: string, code: string, position: number | undefined): boolean {
  const compactEntryCode = compactCatalogNumber(code);
  if (!compactEntryCode) return false;
  if (position) return compactOrderingCode[position - 1] === compactEntryCode;
  return compactEntryCode.length >= 2 && compactOrderingCode.includes(compactEntryCode);
}

function legendHeading(line: string): { property: string; position?: number } | undefined {
  if (/[=:]/.test(line)) return undefined;
  const positionMatch = line.match(/\b(?:position|pos\.?|character|digit)\s*(\d{1,2})\b/i);
  const property = cleanLegendText(line.replace(/\b(?:position|pos\.?|character|digit)\s*\d{1,2}\b/i, "").replace(/[()\[\]]/g, ""));
  if (!property || property.length > 80 || !/[a-z]/i.test(property)) return undefined;
  return { property, ...(positionMatch ? { position: Number(positionMatch[1]) } : {}) };
}

function propertyFromValue(value: string): string | undefined {
  if (/\bIP\s*\d{2}/i.test(value)) return "Degree of protection";
  return undefined;
}

function cleanLegendText(value: string): string {
  return value.replace(/\s+/g, " ").replace(/^[\s:;|]+|[\s:;|]+$/g, "").trim();
}
