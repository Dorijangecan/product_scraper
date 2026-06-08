import { describe, expect, it } from "vitest";
import {
  isQuantityPlausible,
  parseQuantities,
  parseTemperatureRange,
  quantityMax,
  quantityMin
} from "../src/server/scrapers/quantity.js";

describe("quantity grammar — temperature understanding", () => {
  it("reads an English operating-temperature range into min/max", () => {
    expect(parseTemperatureRange("ambient temperature -40 to +80 °C")).toEqual({ min: -40, max: 80 });
  });

  it("reads ellipsis ranges", () => {
    expect(parseTemperatureRange("-25...+60 °C")).toEqual({ min: -25, max: 60 });
  });

  it("reads a German 'bis' range with units on both numbers", () => {
    expect(parseTemperatureRange("Umgebungstemperatur -20 °C bis +55 °C")).toEqual({ min: -20, max: 55 });
  });

  it("reads en-dash + unicode-ellipsis ranges", () => {
    expect(parseTemperatureRange("Operating temperature: –40…85°C")).toEqual({ min: -40, max: 85 });
  });

  it("reads a labelled range that has no °C unit", () => {
    expect(parseTemperatureRange("Temperature range -40 do 70")).toEqual({ min: -40, max: 70 });
  });

  it("does NOT treat a current de-rating condition as operating temperature", () => {
    expect(parseTemperatureRange("Rated operational current AC-1: 70 A at 40 °C")).toEqual({});
  });

  it("does NOT treat bracketed de-rating temps (no label) as operating temperature", () => {
    expect(parseTemperatureRange("16 A 40 °C 12 A 60 °C")).toEqual({});
  });

  it("prefers operating temperature over storage temperature", () => {
    expect(
      parseTemperatureRange("storage temperature -40 to 85 °C; operating temperature -25 to 70 °C")
    ).toEqual({ min: -25, max: 70 });
  });

  it("orders the bounds numerically", () => {
    expect(parseTemperatureRange("ambient temperature +5 °C to +40 °C")).toEqual({ min: 5, max: 40 });
  });

  it("never reports a storage-only range as operating temperature", () => {
    expect(parseTemperatureRange("storage temperature -40 to 85 °C")).toEqual({});
  });

  it("picks operating over storage in a comma-separated list", () => {
    expect(parseTemperatureRange("operating -25 to 70 °C, storage -40 to 85 °C")).toEqual({ min: -25, max: 70 });
  });
});

describe("quantity grammar — voltage/current/power", () => {
  it("parses a voltage range", () => {
    const [voltage] = parseQuantities("24-60 V", { kind: "voltage" });
    expect(voltage).toMatchObject({ kind: "voltage", unit: "V", min: 24, max: 60, qualifier: "range" });
  });

  it("parses a ≤ current cap as a max", () => {
    const [current] = parseQuantities("≤ 16 A", { kind: "current" });
    expect(current).toMatchObject({ kind: "current", unit: "A", max: 16, qualifier: "max" });
    expect(quantityMax(current)).toBe(16);
  });

  it("parses 'max. 400 V' as a max", () => {
    const [voltage] = parseQuantities("max. 400 V", { kind: "voltage" });
    expect(voltage).toMatchObject({ unit: "V", max: 400, qualifier: "max" });
  });

  it("parses 230/400 V as discrete alternatives", () => {
    const [voltage] = parseQuantities("230/400 V", { kind: "voltage" });
    expect(voltage).toMatchObject({ values: [230, 400], qualifier: "alternatives" });
    expect(quantityMax(voltage)).toBe(400);
    expect(quantityMin(voltage)).toBe(230);
  });

  it("understands DC type and percent tolerance", () => {
    const [voltage] = parseQuantities("24 V DC ±20%", { kind: "voltage" });
    expect(voltage).toMatchObject({
      value: 24,
      unit: "V",
      currentType: "DC",
      qualifier: "nominal",
      tolerance: { type: "percent", value: 20 }
    });
  });

  it("understands VAC/VDC fused unit+type tokens", () => {
    const acdc = parseQuantities("120-250 VAC", { kind: "voltage" });
    expect(acdc[0]).toMatchObject({ min: 120, max: 250, currentType: "AC" });
    const dc = parseQuantities("24VDC", { kind: "voltage" });
    expect(dc[0]).toMatchObject({ value: 24, currentType: "DC" });
  });

  it("extracts both current and voltage from a switch-capacity sentence", () => {
    const quantities = parseQuantities("switch capacity 10 amp 120-250 VAC Resistive load, 1.25 amp 24VDC");
    const currents = quantities.filter((q) => q.kind === "current").map((q) => q.value);
    const voltages = quantities.filter((q) => q.kind === "voltage");
    expect(currents).toContain(10);
    expect(currents).toContain(1.25);
    expect(voltages.some((q) => q.min === 120 && q.max === 250)).toBe(true);
  });

  it("parses power in kW", () => {
    const [power] = parseQuantities("18.5 kW", { kind: "power" });
    expect(power).toMatchObject({ kind: "power", unit: "kW", value: 18.5, qualifier: "point" });
  });

  it("keeps a value's operating condition instead of dropping or misreading it", () => {
    const [current] = parseQuantities("70 A at 40 °C", { kind: "current" });
    expect(current).toMatchObject({ kind: "current", value: 70 });
    expect(current.condition).toContain("40");
    // the 40 °C must NOT appear as a temperature quantity
    expect(parseQuantities("70 A at 40 °C", { kind: "temperature" })).toHaveLength(0);
  });

  it("handles decimal comma", () => {
    const [mass] = parseQuantities("0,112 kg", { kind: "mass" });
    expect(mass).toMatchObject({ kind: "mass", unit: "kg", value: 0.112 });
  });

  it("does not invent quantities from unit-less part-number-like text", () => {
    expect(parseQuantities("Type S201-C6 order code 2CDS251001R0064")).toHaveLength(0);
  });
});

describe("quantity grammar — sanity bounds", () => {
  it("flags physically impossible values", () => {
    const [tooHot] = parseQuantities("9000 °C", { kind: "temperature" });
    expect(isQuantityPlausible(tooHot)).toBe(false);
    const [voltage] = parseQuantities("230 V", { kind: "voltage" });
    expect(isQuantityPlausible(voltage)).toBe(true);
  });

  it("accepts real industrial extremes", () => {
    const [current] = parseQuantities("6300 A", { kind: "current" });
    expect(isQuantityPlausible(current)).toBe(true);
    const [temp] = parseQuantities("-40 °C", { kind: "temperature" });
    expect(isQuantityPlausible(temp)).toBe(true);
  });
});

describe("quantity grammar — extended units & qualifiers", () => {
  it("parses apparent/reactive power, charge, energy and area units", () => {
    expect(parseQuantities("2.5 kVA")[0]).toMatchObject({ kind: "apparentPower", unit: "kVA", value: 2.5 });
    expect(parseQuantities("10 kvar")[0]).toMatchObject({ kind: "reactivePower", unit: "kvar", value: 10 });
    expect(parseQuantities("2.2 Ah")[0]).toMatchObject({ kind: "charge", unit: "Ah", value: 2.2 });
    expect(parseQuantities("1.5 kWh")[0]).toMatchObject({ kind: "energy", unit: "kWh", value: 1.5 });
    expect(parseQuantities("2.5 mm²")[0]).toMatchObject({ kind: "area", unit: "mm²", value: 2.5 });
  });

  it("understands < and > as max / min", () => {
    expect(parseQuantities("< 16 A", { kind: "current" })[0]).toMatchObject({ max: 16, qualifier: "max" });
    expect(parseQuantities("> 12 V", { kind: "voltage" })[0]).toMatchObject({ min: 12, qualifier: "min" });
  });

  it("still parses the base units after the additions", () => {
    expect(parseQuantities("18.5 kW")[0]).toMatchObject({ kind: "power", unit: "kW", value: 18.5 });
    expect(parseQuantities("16 A", { kind: "current" })[0]).toMatchObject({ kind: "current", value: 16 });
    expect(parseQuantities("100 mm", { kind: "length" })[0]).toMatchObject({ kind: "length", unit: "mm", value: 100 });
  });
});

describe("quantity grammar — real-world disambiguation set", () => {
  it("separates voltage + AC type + frequency on one line", () => {
    const quantities = parseQuantities("230 V AC 50/60 Hz");
    expect(quantities.find((q) => q.kind === "voltage")).toMatchObject({ value: 230, currentType: "AC" });
    expect(quantities.find((q) => q.kind === "frequency")).toMatchObject({ values: [50, 60] });
  });

  it("reads a decimal-comma pressure range", () => {
    expect(parseQuantities("0,5 ... 6 bar", { kind: "pressure" })[0]).toMatchObject({ kind: "pressure", min: 0.5, max: 6 });
  });

  it("reads a torque range and an AC/DC voltage type", () => {
    expect(parseQuantities("Tightening torque 2.5...3 Nm", { kind: "torque" })[0]).toMatchObject({ min: 2.5, max: 3 });
    expect(parseQuantities("24 V AC/DC", { kind: "voltage" })[0]).toMatchObject({ value: 24, currentType: "AC/DC" });
  });

  it("reads a max power qualifier", () => {
    expect(parseQuantities("power consumption max. 2.5 W", { kind: "power" })[0]).toMatchObject({
      kind: "power",
      max: 2.5,
      qualifier: "max"
    });
  });

  it("never invents quantities from IP ratings or thread sizes", () => {
    expect(parseQuantities("IP66 / IP67")).toHaveLength(0);
    expect(parseQuantities("M12 x 1")).toHaveLength(0);
  });

  it("reads an operating temperature range with a trailing label", () => {
    expect(parseTemperatureRange("-25 °C … +70 °C (operating)")).toEqual({ min: -25, max: 70 });
  });
});
