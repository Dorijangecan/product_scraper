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

  it("knows sensor/enclosure domain properties", () => {
    expect(matchProperty("Schaltabstand")?.key).toBe("sensingDistance");
    expect(matchProperty("Switching frequency")?.key).toBe("switchingFrequency");
    expect(matchProperty("Ansprechzeit")?.key).toBe("responseTime");
    expect(matchProperty("Wiederholgenauigkeit")?.key).toBe("repeatAccuracy");
    expect(matchProperty("Connection type")?.key).toBe("connectionType");
    expect(matchProperty("Output type")?.key).toBe("outputType");
    expect(matchProperty("Durchfluss")?.key).toBe("flowRate");
  });

  it("adds Spanish/Dutch synonyms to core properties", () => {
    expect(matchProperty("Corriente")?.key).toBe("ratedCurrent");
    expect(matchProperty("Tensión nominal")?.key).toBe("ratedVoltage");
    expect(matchProperty("Vermogen")?.key).toBe("power");
    expect(matchProperty("Kleur")?.key).toBe("color");
  });

  it("maps real ABB EmPower spec labels", () => {
    expect(matchProperty("Power loss")?.key).toBe("powerLoss");
    expect(matchProperty("Power loss output capacity")?.key).toBe("powerLoss");
    expect(matchProperty("Conventional Free-air Thermal Current")?.key).toBe("ratedCurrent");
    expect(matchProperty("Rated Operational Current AC-3")?.key).toBe("ratedCurrent");
    expect(matchProperty("Maximum Operating Voltage UL/CSA")?.key).toBe("ratedVoltage");
    expect(matchProperty("Rated Ultimate Short-Circuit Breaking Capacity")?.key).toBe("breakingCapacity");
    expect(matchProperty("Rated Service Short-Circuit Breaking Capacity")?.key).toBe("breakingCapacity");
    expect(matchProperty("Rated Short-time Withstand Current")?.key).toBe("breakingCapacity");
    expect(matchProperty("Extended Product Type")?.key).toBe("typeCode");
    expect(matchProperty("Product Main Type")?.key).toBe("typeCode");
    expect(matchProperty("Number of Protected Poles")?.key).toBe("poles");
    expect(matchProperty("Product Net Weight")?.key).toBe("weight");
    expect(matchProperty("DIN Place Units")?.key).toBe("displayUnits");
    expect(matchProperty("Rated Control Circuit Voltage")?.key).toBe("controlVoltage");
  });

  it("maps real Schneider IEC bracket-prefixed labels", () => {
    expect(matchProperty("[Ue] rated operational voltage")?.key).toBe("ratedVoltage");
    expect(matchProperty("[Ie] rated operational current")?.key).toBe("ratedCurrent");
    expect(matchProperty("[Ith] conventional free air thermal current")?.key).toBe("ratedCurrent");
    expect(matchProperty("[Ics] rated service short-circuit breaking capacity")?.key).toBe("breakingCapacity");
    expect(matchProperty("[Ui] rated insulation voltage")?.key).toBe("insulationVoltage");
    expect(matchProperty("[Uimp] rated impulse withstand voltage")?.key).toBe("impulseVoltage");
    expect(matchProperty("Power dissipation per pole")?.key).toBe("powerLoss");
    expect(matchProperty("Power dissipation in W")?.key).toBe("powerLoss");
    expect(matchProperty("Range of Product")?.key).toBe("typeCode");
    expect(matchProperty("Fixing mode")?.key).toBe("mountingType");
  });

  it("maps real Eaton skuPage + datasheet labels", () => {
    expect(matchProperty("Amperage Rating")?.key).toBe("ratedCurrent");
    expect(matchProperty("Voltage rating - max")?.key).toBe("ratedVoltage");
    expect(matchProperty("Interrupt rating")?.key).toBe("breakingCapacity");
    expect(matchProperty("Static heat dissipation, non-current-dependent Pvs")?.key).toBe("powerLoss");
    expect(matchProperty("Rated impulse withstand voltage (Uimp)")?.key).toBe("impulseVoltage");
    expect(matchProperty("Model Code")?.key).toBe("typeCode");
    expect(matchProperty("Catalog Number")?.key).toBe("partNumber");
    expect(matchProperty("NEMA rating")?.key).toBe("protection");
    expect(matchProperty("Trip Type")?.key).toBe("tripCharacteristic");
    expect(matchProperty("Frame size")?.key).toBe("frameSize");
    expect(matchProperty("Coil")?.key).toBe("controlVoltage");
  });

  it("maps real Siemens / Rockwell / Balluff / Spelsberg labels", () => {
    expect(matchProperty("MLFB")?.key).toBe("typeCode");
    expect(matchProperty("Bemessungsbetriebsstrom")?.key).toBe("ratedCurrent");
    expect(matchProperty("Continuous Operating Current")?.key).toBe("ratedCurrent"); // Rockwell
    expect(matchProperty("SCCR")?.key).toBe("breakingCapacity"); // Rockwell
    expect(matchProperty("Enclosure Type")?.key).toBe("protection"); // Rockwell
    expect(matchProperty("Operating voltage Ub")?.key).toBe("ratedVoltage"); // Balluff
    expect(matchProperty("Cable temperature, fixed routing")?.key).toBe("operatingTemperature"); // Balluff
    expect(matchProperty("SCHUTZART")?.key).toBe("protection"); // Spelsberg
    expect(matchProperty("BEMISOLATIONSSPANAC")?.key).toBe("insulationVoltage"); // Spelsberg
    expect(matchProperty("GEW")?.key).toBe("weight"); // Spelsberg
  });

  it("recognizes NEMA-only enclosure types and DIN-rail mounting standards", () => {
    expect(matchProperty("Type 4X")?.key).toBe("protection"); // Hoffman/SCE NEMA
    expect(matchProperty("Type 12")?.key).toBe("protection");
    expect(matchProperty("Mounting on standard rails")?.key).toBe("mountingType"); // ABB
    expect(matchProperty("Top-hat rail TH35")?.key).toBe("mountingType");
    expect(matchProperty("TS35")?.key).toBe("mountingType");
  });

  it("does NOT mis-map look-alike electrical specs onto identity/voltage fields", () => {
    // Short-token regexes must not steal these:
    expect(matchProperty("Coil resistance")?.key).not.toBe("controlVoltage");
    expect(matchProperty("Series resistance")?.key).not.toBe("typeCode");
    expect(matchProperty("Series connection")?.key).not.toBe("typeCode");
    // Power loss / consumption must stay distinct from raw "power":
    expect(matchProperty("Power loss")?.key).toBe("powerLoss");
    expect(matchProperty("Power consumption, typical")?.key).toBe("powerConsumption");
    expect(matchProperty("Power dissipation")?.key).toBe("powerLoss");
    // Storage temperature must not be operating temperature:
    expect(matchProperty("Ambient Air Temperature for Storage")?.key).toBe("storageTemperature");
    // Output/Input type must not be the manufacturer type code:
    expect(matchProperty("Output type")?.key).toBe("outputType");
    expect(matchProperty("Input type")?.key).toBe("inputType");
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
