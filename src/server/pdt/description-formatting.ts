function clean(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed || undefined;
}

export function compactFamilyShortDescription(value: string | undefined): string | undefined {
  const cleaned = clean(value);
  if (!cleaned) return undefined;
  const withoutFamily = cleaned.replace(/^Compact\s+5000\s+/i, "").trim();
  const compacted = withoutFamily
    .replace(/\bDC\s+Input\b/i, "DC-Input")
    .replace(/\bDC\s+Output\b/i, "DC-Output");
  return compacted !== cleaned ? compacted : undefined;
}
