/**
 * Exact imperial→metric factors — the single source of truth.
 *
 * These are *definitions*, not measurements: the international avoirdupois pound and the
 * international inch are defined exactly, so a finite decimal input always has a finite decimal
 * result and no conversion here needs to lose precision.
 *
 * The codebase used to carry five copies of the pound factor and three of them were truncated
 * (`0.453592`, `453.592`, `0.0283495`), so the same Saginaw enclosure produced a different weight
 * depending on which module answered — the products workbook said 12.70058636 kg while the PDT
 * resolver computed 12.700576. Leaf module, no dependencies: import from here, never re-declare.
 */

/** 1 lb = 0.45359237 kg, exactly. */
export const POUND_TO_KILOGRAM = 0.45359237;

/** 1 lb = 453.59237 g, exactly. */
export const POUND_TO_GRAM = 453.59237;

/** 1 oz = 1/16 lb = 0.028349523125 kg, exactly. */
export const OUNCE_TO_KILOGRAM = 0.028349523125;

/** 1 oz = 28.349523125 g, exactly. */
export const OUNCE_TO_GRAM = 28.349523125;

/** 1 in = 25.4 mm, exactly. */
export const INCH_TO_MILLIMETER = 25.4;

/** Multiply finite decimal text by an exact decimal factor without binary-float rounding. */
export function multiplyDecimalExactly(value: string, factor: string): string | undefined {
  const parse = (raw: string): { digits: bigint; scale: number; negative: boolean } | undefined => {
    const match = raw.trim().match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
    if (!match) return undefined;
    const fraction = match[3] ?? "";
    return {
      digits: BigInt(`${match[2]}${fraction}`),
      scale: fraction.length,
      negative: match[1] === "-"
    };
  };
  const left = parse(value);
  const right = parse(factor);
  if (!left || !right) return undefined;

  const product = left.digits * right.digits;
  const negative = left.negative !== right.negative && product !== 0n;
  const scale = left.scale + right.scale;
  const padded = product.toString().padStart(scale + 1, "0");
  const whole = scale ? padded.slice(0, -scale) : padded;
  const fraction = scale ? padded.slice(-scale).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
