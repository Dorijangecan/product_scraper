import { describe, expect, it } from "vitest";
import { findUnmappedSpecLabels, matchProperty, understand } from "../src/server/scrapers/ontology.js";

describe("property ontology — general multilingual understanding", () => {
  it("maps multilingual labels to the same canonical property", () => {
    expect(matchProperty("Nennstrom")?.key).toBe("ratedCurrent");
    expect(matchProperty("Rated operational current AC-1")?.key).toBe("ratedCurrent");
    expect(matchProperty("Bemessungsspannung")?.key).toBe("ratedVoltage");
    expect(matchProperty("Umgebungstemperatur")?.key).toBe("operatingTemperature");
    expect(matchProperty("Schutzart")?.key).toBe("protection");
    expect(matchProperty("Gewicht")?.key).toBe("weight");
    expect(matchProperty("Werkstoff")?.key).toBe("material");
  });

  it("prefers the most specific property", () => {
    expect(matchProperty("Control circuit voltage")?.key).toBe("controlVoltage");
    expect(matchProperty("Operating voltage")?.key).toBe("ratedVoltage");
    expect(matchProperty("Power loss per pole")?.key).toBe("powerLoss");
  });

  it("rejects look-alikes instead of mis-mapping", () => {
    expect(matchProperty("Colour temperature")).toBeUndefined();
    expect(matchProperty("Storage temperature")?.key).toBe("storageTemperature");
  });

  it("understands label + value together via the quantity grammar", () => {
    const current = understand("Nennstrom", "16 A");
    expect(current.property?.key).toBe("ratedCurrent");
    expect(current.quantities[0]).toMatchObject({ kind: "current", value: 16 });
    const temp = understand("Umgebungstemperatur", "-25 ... +60 °C");
    expect(temp.property?.key).toBe("operatingTemperature");
    expect(temp.quantities[0]).toMatchObject({ kind: "temperature", min: -25, max: 60 });
  });

  it("understands French and Italian labels", () => {
    expect(matchProperty("Courant assigné")?.key).toBe("ratedCurrent");
    expect(matchProperty("Tension nominale")?.key).toBe("ratedVoltage");
    expect(matchProperty("Puissance")?.key).toBe("power");
    expect(matchProperty("Matériau")?.key).toBe("material");
    expect(matchProperty("Couleur")?.key).toBe("color");
  });

  it("knows the newly taught canonical properties", () => {
    expect(matchProperty("Rated insulation voltage")?.key).toBe("insulationVoltage");
    expect(matchProperty("Rated impulse withstand voltage")?.key).toBe("impulseVoltage");
    expect(matchProperty("Utilization category")?.key).toBe("utilizationCategory");
    expect(matchProperty("Pollution degree")?.key).toBe("pollutionDegree");
    expect(matchProperty("Conductor cross-section")?.key).toBe("conductorCrossSection");
    expect(matchProperty("Mechanical durability")?.key).toBe("mechanicalLife");
  });

  it("flags labels it does not understand (knowledge-base gaps), never guesses them", () => {
    const gaps = findUnmappedSpecLabels([
      { name: "Nennstrom", value: "16 A" }, // mapped → not a gap
      { name: "Eigenfrequenz", value: "50 Hz" }, // recognizable quantity, unknown label → gap
      { name: "Marketing blurb", value: "best in class" } // no quantity → not a gap
    ]);
    expect(gaps).toContain("Eigenfrequenz");
    expect(gaps).not.toContain("Nennstrom");
    expect(gaps).not.toContain("Marketing blurb");
  });
});
