import { DEVICE_TYPE_PROFILES, deviceSheetsFromProfile } from "./device-type-profiles.js";

/**
 * Tabs that are filled for every product, regardless of device type. "Connection Point
 * Information" is intentionally excluded for now - it stays untouched in the template and will be
 * implemented in a later phase.
 */
export const CONSTANT_SHEETS = ["Material Master Data", "Additional Documents"] as const;

/** Device-specific tab(s) for a device type, or [] when the type has no clear tab. */
export function deviceSheetsFor(deviceType: string | undefined): string[] {
  return deviceSheetsFromProfile(deviceType);
}

/** Full set of tabs to fill for a product: constant tabs first, then any device-specific tabs. */
export function targetSheets(deviceType: string | undefined): string[] {
  return [...CONSTANT_SHEETS, ...deviceSheetsFor(deviceType)];
}

/** All distinct device-specific sheet names known to the profile registry (sorted). */
export function knownDeviceSheets(): string[] {
  const set = new Set<string>();
  for (const profile of Object.values(DEVICE_TYPE_PROFILES)) for (const sheet of profile.sheets) set.add(sheet);
  return [...set].sort((a, b) => a.localeCompare(b));
}
