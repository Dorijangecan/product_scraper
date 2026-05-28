function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export interface EnumLegendEntry {
  code: string;
  label: string;
}

/**
 * Parse a PDT enum legend embedded in a column description, e.g.
 * "Voltage type 1 - AC 2 - AC, alternating current 3 - AC/DC 4 - DC" →
 * { ac: { code: "1", label: "AC" }, ... }.
 * Returns undefined when the column is NOT a strict enum — in particular when it explicitly
 * allows free text ("insert number or the name", "otherwise calculated"), so we never coerce a
 * free-text column into a code.
 */
export function parseEnumLegend(description: string): Map<string, EnumLegendEntry> | undefined {
  if (!description) return undefined;
  if (/insert (the )?number or|name of the|otherwise|ongoing|string\)/i.test(description)) return undefined;
  const matches = [...description.matchAll(/(\d+)\s*[-–]\s*(.+?)(?=\s+\d+\s*[-–]\s|$)/g)];
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
  return matchEnumEntry(description, rawValue)?.label;
}

function matchEnumEntry(description: string, rawValue: string): EnumLegendEntry | undefined {
  const legend = parseEnumLegend(description);
  if (!legend) return undefined;
  return legend.get(normalize(rawValue));
}

/** True when the column description is a strict enum (code list) rather than free text. */
export function isEnumColumn(description: string): boolean {
  return parseEnumLegend(description) !== undefined;
}
