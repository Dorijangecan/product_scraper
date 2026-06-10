import {
  DEVICE_TYPE_PROFILES,
  electricalFieldsForDeviceType,
  finalCompletenessFieldsForDeviceType,
  type DeviceTypeElectricalField,
  type DeviceTypeFinalCompletenessField
} from "../src/server/pdt/device-type-profiles.js";
import { knownDeviceTypes } from "../src/server/scrapers/device-type.js";

type CriticalFactCoverage =
  | { kind: "base"; field: string }
  | { kind: "electrical"; field: DeviceTypeElectricalField }
  | { kind: "final"; field: DeviceTypeFinalCompletenessField };

const CRITICAL_FACT_COVERAGE: Record<string, CriticalFactCoverage> = {
  weight: { kind: "base", field: "weight" },
  material: { kind: "base", field: "material" },
  dimensions: { kind: "base", field: "dimensions" },
  ratedVoltage: { kind: "electrical", field: "voltage" },
  ratedCurrent: { kind: "electrical", field: "current" },
  voltageType: { kind: "electrical", field: "voltage" },
  pdtRatedVoltage: { kind: "electrical", field: "voltage" },
  pdtVoltageTypeText: { kind: "electrical", field: "voltage" },
  pdtSignalDiameter: { kind: "base", field: "dimensions" },
  color: { kind: "final", field: "color" },
  pdtLampColor: { kind: "final", field: "color" },
  protection: { kind: "final", field: "protection" }
};

const failures: string[] = [];

for (const deviceType of knownDeviceTypes()) {
  const profile = DEVICE_TYPE_PROFILES[deviceType];
  if (!profile) {
    failures.push(`${deviceType}: missing device-type PDT profile`);
    continue;
  }
  if (!profile.sheets.length) failures.push(`${deviceType}: profile has no PDT sheets`);
  if (profile.electricalFields === undefined) failures.push(`${deviceType}: profile does not declare electricalFields`);
}

for (const [deviceType, profile] of Object.entries(DEVICE_TYPE_PROFILES)) {
  const finalFields = finalCompletenessFieldsForDeviceType(deviceType);
  const electricalFields = electricalFieldsForDeviceType(deviceType) ?? [];
  for (const [sheetName, facts] of Object.entries(profile.criticalFactsBySheet ?? {})) {
    for (const fact of facts) {
      const coverage = CRITICAL_FACT_COVERAGE[fact];
      if (!coverage) {
        failures.push(`${deviceType}/${sheetName}: critical fact "${fact}" has no audit coverage rule`);
        continue;
      }
      if (coverage.kind === "final" && !finalFields.includes(coverage.field)) {
        failures.push(`${deviceType}/${sheetName}: critical fact "${fact}" requires final-completeness field "${coverage.field}"`);
      }
      if (coverage.kind === "electrical" && !electricalFields.includes(coverage.field)) {
        failures.push(`${deviceType}/${sheetName}: critical fact "${fact}" requires electrical field "${coverage.field}"`);
      }
    }
  }
}

console.log("=== PDT profile audit ===");
if (failures.length > 0) {
  console.error("PDT profile audit failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log("  (clean - device-type profiles route critical PDT facts through completeness/electrical coverage)");
}
