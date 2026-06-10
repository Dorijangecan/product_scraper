function clean(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed || undefined;
}

export function compactFamilyShortDescription(value: string | undefined): string | undefined {
  const cleaned = clean(value);
  if (!cleaned) return undefined;
  if (/\bPanelView\s+5510\b/i.test(cleaned)) return "PanelView 5510";
  if (/\bControlLogix\s+(?:5590\s+XT\s+Controller|Processors?)\b/i.test(cleaned)) return "ControlLogix Processors";
  if (/\bEnclosed\s+Power\s+Distribution\s+Block\b/i.test(cleaned)) return "Power Terminal Block";
  if (/\bStratix\s+2000\b.*\bUnmanaged\s+Switch\b/i.test(cleaned)) return "Unmanaged switch";
  if (/\bPowerFlex\s+(?:TS\s+755|755TS)\b/i.test(cleaned)) return "PowerFlex 755TS";
  if (/\b(?:On-Machine\s+)?LED\s+Indicators?\b/i.test(cleaned)) return "LED indicator";
  if (/\bArmorKinetix\s+Distributed\s+Drive\b/i.test(cleaned)) return "ArmorKinetix Distributed Drive";
  if (/\bArmorKinetix\s+DSM\b/i.test(cleaned)) return "Armorkinetix DSM";

  const withoutFamily = cleaned.replace(/^Compact\s+5000\s+/i, "").trim();
  const compacted = withoutFamily
    .replace(/\bDC\s+Input\b/i, "DC-Input")
    .replace(/\bDC\s+Output\b/i, "DC-Output");
  return compacted !== cleaned ? compacted : undefined;
}
