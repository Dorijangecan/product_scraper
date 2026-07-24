import { cleanText } from "./normalizer.js";

/**
 * Single source of truth for recognizing product-comparison / ordering table headers in datasheets
 * — the "identifier" column (catalog / order / part number), the row-label vocabulary (weight,
 * dimensions, voltage, ...), and the multilingual synonyms that manufacturer PDFs actually use.
 *
 * Before this module the same header regex was copy-pasted across document-enrichment.ts
 * (looksLikeCatalogTableHeader, nearestCatalogTableHeader, genericCatalogTableKey) and drifted:
 * each copy accreted slightly different keywords, so a table header a whitespace reader recognized
 * a positioned reader didn't, and vice versa. Consolidating here also let us widen coverage to the
 * German / French / Italian labels EU catalogs use ("Bestell-Nr.", "Artikelnummer", "Référence",
 * "Codice", "Typ-Code", ...), which the English-only originals silently skipped — leaving those
 * catalogs to the fragile tab-text fallback instead of the structured column reader.
 *
 * Keep the vocabulary here and import it; do not reintroduce local header regexes elsewhere.
 */

/** Strong, unambiguous "identifier column" header labels (EN/DE/FR/IT). Anchored to a whole cell:
 * used to recognize the id column of an ordering table, e.g. as the positioned-table reader's
 * header anchor. Deliberately excludes bare ambiguous words like "Type" or "Model" (which routinely
 * appear as ordinary row labels) — those are handled structurally by variant-token clustering, not
 * by label text. */
const CATALOG_ID_CELL_RE =
  /^(?:catalog(?:ue)?\s*(?:number|no\.?|nr\.?)?|cat\.?\s*no\.?|part\s*(?:number|no\.?)|order(?:ing)?\s*(?:code|number|no\.?)|article\s*(?:number|no\.?)|art\.?[-\s]*nr\.?|artikel(?:nummer|[-\s]*nr\.?)|bestell(?:nummer|[-\s]*nr\.?)|sach(?:nummer|[-\s]*nr\.?)|ident(?:[-\s]*nr\.?|\s*number)|type[-\s]*code|typ[-\s]*code|mlfb|r[ée]f(?:\.|[ée]rence)?|codice(?:\s*articolo)?|item\s*(?:number|no\.?)|model\s*(?:number|no\.?)|modell[-\s]*nr\.?)\s*[:.]?\s*$/i;

/** Broad "does this joined header-row text mention any ordering-table column keyword" test — id
 * column OR any recognized spec/description/dimension column. Used to decide whether a candidate
 * line is a table header worth mapping at all. */
const CATALOG_TABLE_HEADER_KEYWORD_RE =
  /\b(?:catalog(?:ue)?|cat(?:alog)?\.?\s*no|part\s*(?:number|no)|order(?:ing)?\s*(?:code|number|no)|article\s*(?:number|no)|art\.?[-\s]*nr|artikel(?:nummer)?|bestell(?:nummer|[-\s]*nr)|sach(?:nummer|[-\s]*nr)|ident[-\s]*nr|mlfb|type\s*code|typ[-\s]*code|r[ée]f[ée]?rence|codice|description|beschreibung|d[ée]signation|descrizione|material|werkstoff|mat[ée]riau|weight|mass|gewicht|poids|peso|width|height|depth|breite|h[öo]he|tiefe|dimensions?|abmessung(?:en)?|voltage|spannung|tension|current|strom|courant)\b/i;

/** Whole-cell test for the id ("catalog number") column label. */
export function isCatalogIdHeaderCell(cell: string): boolean {
  const label = cleanText(cell);
  return Boolean(label) && CATALOG_ID_CELL_RE.test(label);
}

/** True when a joined header-row text names any ordering-table column keyword. */
export function isCatalogTableHeaderText(headerText: string): boolean {
  return CATALOG_TABLE_HEADER_KEYWORD_RE.test(headerText);
}

/**
 * Maps ONE header cell to its canonical ordering-table key, or undefined if it isn't a recognized
 * column. Multilingual (EN/DE/FR/IT) where the label is unambiguous. Order matters: the id column
 * and combined "dimensions" are checked before the single-letter W/H/D shorthands they'd otherwise
 * shadow.
 */
export function catalogTableKeyFor(header: string): string | undefined {
  const label = cleanText(header);
  if (!label) return undefined;
  if (
    /\b(?:catalog(?:ue)?|cat(?:alog)?\.?\s*no|part\s*(?:number|no)|order(?:ing)?\s*(?:code|number|no)|article\s*(?:number|no)|art\.?[-\s]*nr|artikel(?:nummer)?|bestell(?:nummer|[-\s]*nr)|sach(?:nummer|[-\s]*nr)|ident[-\s]*nr|mlfb|type\s*code|typ[-\s]*code|r[ée]f[ée]?rence|codice)\b/i.test(
      label
    )
  )
    return "catalogNumber";
  if (/\b(?:description|beschreibung|d[ée]signation|descrizione|product\s+(?:short\s+)?text|name)\b/i.test(label)) return "description";
  if (/\b(?:product\s+type|device\s+type|type\s+description|ger[äa]tetyp|type\s+d'appareil)\b/i.test(label)) return "productType";
  if (/\b(?:material|werkstoff|mat[ée]riau|materiale)\b/i.test(label)) return "material";
  if (/\b(?:weight|mass|wgt|gewicht|poids|peso)\b|^\s*w\s*(?:\[|\(|$)/i.test(label)) return "weight";
  // A bare "Dimensions" column header (as opposed to separate Width/Height/Depth columns) holds
  // one already-combined "W x H x D" value per row. Checked before the width/height/depth cases
  // below since "dimensions" doesn't match any of those individually.
  if (/\b(?:dimensions?|abmessung(?:en)?|dimensioni)\b/i.test(label)) return "dimensions";
  if (/\b(?:voltage|supply|input|output|spannung|tension|tensione)\b/i.test(label) && /\b(?:v|voltage|supply|spannung|tension)\b/i.test(label)) return "voltage";
  if (/\b(?:current|amp|load|strom|courant|corrente)\b/i.test(label)) return "current";
  if (/\b(?:width|breite|largeur|larghezza)\b|^\s*w(?:idth)?\s*(?:\[|\(|$)/i.test(label)) return "width";
  if (/\b(?:height|hoehe|höhe|hauteur|altezza)\b|^\s*h(?:eight)?\s*(?:\[|\(|$)/i.test(label)) return "height";
  if (/\b(?:depth|tiefe|profondeur|profondità)\b|^\s*d(?:epth)?\s*(?:\[|\(|$)/i.test(label)) return "depth";
  if (/\b(?:length|lange|länge|longueur|lunghezza)\b|^\s*l(?:ength)?\s*(?:\[|\(|$)/i.test(label)) return "length";
  if (/\b(?:diameter|dia\.?|durchmesser|diamètre|diametro)\b|ø|^\s*d[ia]*\s*(?:\[|\()/i.test(label)) return "diameter";
  if (/^dn\b/i.test(label)) return "dn";
  return undefined;
}
