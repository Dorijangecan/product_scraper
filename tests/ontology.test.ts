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

  it("understands motor / drive spec labels (WEG, SEW, Lenze, Danfoss, ABB, Siemens)", () => {
    expect(matchProperty("Rated speed")?.key).toBe("ratedSpeed");
    expect(matchProperty("RPM")?.key).toBe("ratedSpeed");
    expect(matchProperty("Nenndrehzahl")?.key).toBe("ratedSpeed");
    expect(matchProperty("Output speed na")?.key).toBe("ratedSpeed");
    expect(matchProperty("IE3")?.key).toBe("efficiencyClass");
    expect(matchProperty("Efficiency class")?.key).toBe("efficiencyClass");
    expect(matchProperty("Insulation class")?.key).toBe("insulationClass");
    expect(matchProperty("Wärmeklasse")?.key).toBe("insulationClass");
    expect(matchProperty("Service factor")?.key).toBe("serviceFactor");
    expect(matchProperty("Duty type S1")?.key).toBe("dutyType");
    expect(matchProperty("Moment of inertia")?.key).toBe("momentOfInertia");
    expect(matchProperty("Gear unit ratio i")?.key).toBe("gearRatio");
    expect(matchProperty("Reduction ratio")?.key).toBe("gearRatio");
    expect(matchProperty("Overload capability")?.key).toBe("overloadCapability");
    expect(matchProperty("Locked rotor current")?.key).toBe("lockedRotorCurrentRatio");
    expect(matchProperty("Starting current ratio")?.key).toBe("lockedRotorCurrentRatio");
    // expanded power: motor/drive output variants
    expect(matchProperty("Rated output")?.key).toBe("power");
    expect(matchProperty("Shaft power")?.key).toBe("power");
    expect(matchProperty("Typical shaft output")?.key).toBe("power");
  });

  it("understands circuit-protection / fuse / relay labels (Mersen, Bussmann, Littelfuse, Hager, Finder)", () => {
    expect(matchProperty("gG")?.key).toBe("fuseClass");
    expect(matchProperty("Class J")?.key).toBe("fuseClass");
    expect(matchProperty("Operating class")?.key).toBe("fuseClass");
    expect(matchProperty("Slow-Blow")?.key).toBe("fuseSpeed");
    expect(matchProperty("Fast-Acting")?.key).toBe("fuseSpeed");
    expect(matchProperty("Dual-element time-delay")?.key).toBe("fuseSpeed");
    expect(matchProperty("Rated residual current")?.key).toBe("ratedResidualCurrent");
    expect(matchProperty("Bemessungsdifferenzstrom")?.key).toBe("ratedResidualCurrent");
    expect(matchProperty("RCD type")?.key).toBe("rcdType");
    expect(matchProperty("Let-through current")?.key).toBe("letThroughCurrent");
    expect(matchProperty("Switching capacity")?.key).toBe("switchingCapacity");
    expect(matchProperty("Contact rating")?.key).toBe("switchingCapacity");
    expect(matchProperty("Coil power")?.key).toBe("coilPower");
    expect(matchProperty("Overvoltage category")?.key).toBe("overvoltageCategory");
    // expanded ratedCurrent / breakingCapacity symbols
    expect(matchProperty("Rated uninterrupted current Iu")?.key).toBe("ratedCurrent");
    expect(matchProperty("Current Rating")?.key).toBe("ratedCurrent");
    expect(matchProperty("Continuous rms current")?.key).toBe("ratedCurrent");
    expect(matchProperty("Rated breaking capacity Icn")?.key).toBe("breakingCapacity");
    expect(matchProperty("AC Interrupting Rating")?.key).toBe("breakingCapacity");
  });

  it("understands terminal-block labels (WAGO, Weidmüller, Phoenix)", () => {
    expect(matchProperty("Connection technology")?.key).toBe("connectionTechnology");
    expect(matchProperty("Push-in CAGE CLAMP")?.key).toBe("connectionTechnology");
    expect(matchProperty("Tension clamp connection")?.key).toBe("connectionTechnology");
    expect(matchProperty("Stripping length")?.key).toBe("strippingLength");
    expect(matchProperty("Abisolierlänge")?.key).toBe("strippingLength");
    expect(matchProperty("Rated cross-section")?.key).toBe("conductorCrossSection");
    expect(matchProperty("AWG")?.key).toBe("conductorCrossSection");
    expect(matchProperty("Number of connections")?.key).toBe("poles");
    expect(matchProperty("Number of levels")?.key).toBe("poles");
  });

  it("understands enclosure-climate labels (Rittal, Pfannenberg, STEGO)", () => {
    expect(matchProperty("Total cooling output")?.key).toBe("coolingOutput");
    expect(matchProperty("Cooling capacity")?.key).toBe("coolingOutput");
    expect(matchProperty("Nutzkühlleistung")?.key).toBe("coolingOutput");
    expect(matchProperty("Heating capacity")?.key).toBe("heatingCapacity");
    expect(matchProperty("Heizleistung")?.key).toBe("heatingCapacity");
    expect(matchProperty("Refrigerant")?.key).toBe("refrigerant");
    expect(matchProperty("Global Warming Potential (GWP)")?.key).toBe("gwp");
    expect(matchProperty("Air throughput")?.key).toBe("flowRate");
  });

  it("understands pneumatic / fluid labels (Festo, SMC, Bürkert)", () => {
    expect(matchProperty("Stroke length")?.key).toBe("stroke");
    expect(matchProperty("Hub")?.key).toBe("stroke");
    expect(matchProperty("Bore size")?.key).toBe("bore");
    expect(matchProperty("Piston diameter")?.key).toBe("bore");
    expect(matchProperty("Kv value")?.key).toBe("flowCoefficient");
    expect(matchProperty("Orifice")?.key).toBe("orificeSize");
    expect(matchProperty("Nominal diameter DN")?.key).toBe("orificeSize");
    expect(matchProperty("Operating medium")?.key).toBe("medium");
    expect(matchProperty("Fluid")?.key).toBe("medium");
    expect(matchProperty("Theoretical force at 6 bar")?.key).toBe("theoreticalForce");
    expect(matchProperty("Proof pressure")?.key).toBe("pressure");
    expect(matchProperty("Max operating pressure")?.key).toBe("pressure");
  });

  it("understands pneumatic and pump flow-rate values as structured quantities", () => {
    const nominalFlow = understand("Standard nominal flow rate", "500 l/min");
    expect(nominalFlow.property?.key).toBe("flowRate");
    expect(nominalFlow.quantities[0]).toMatchObject({ kind: "flowRate", unit: "l/min", value: 500 });

    const pumpFlow = understand("Volumetric flow", "12 m3/h");
    expect(pumpFlow.property?.key).toBe("flowRate");
    expect(pumpFlow.quantities[0]).toMatchObject({ kind: "flowRate", unit: "m3/h", value: 12 });
  });

  it("understands process-instrument / measuring-sensor labels (E+H, VEGA, WIKA, Keyence, Omron, SICK)", () => {
    expect(matchProperty("Accuracy")?.key).toBe("accuracy");
    expect(matchProperty("Measured error")?.key).toBe("accuracy");
    expect(matchProperty("Measuring range")?.key).toBe("measuringRange");
    expect(matchProperty("Full scale value")?.key).toBe("measuringRange");
    expect(matchProperty("Turndown ratio")?.key).toBe("turndown");
    expect(matchProperty("Resolution")?.key).toBe("resolution");
    expect(matchProperty("Linearity")?.key).toBe("linearity");
    expect(matchProperty("Hysteresis")?.key).toBe("hysteresis");
    expect(matchProperty("Differential travel")?.key).toBe("hysteresis"); // Omron's term
    expect(matchProperty("Blind zone")?.key).toBe("blindZone");
    expect(matchProperty("Correction factors")?.key).toBe("correctionFactor");
    expect(matchProperty("Reduction factor")?.key).toBe("correctionFactor"); // Turck
    expect(matchProperty("Voltage drop")?.key).toBe("voltageDrop");
    expect(matchProperty("Residual voltage")?.key).toBe("voltageDrop"); // Omron's term
    expect(matchProperty("Leakage current")?.key).toBe("leakageCurrent");
    expect(matchProperty("Light/Dark operate")?.key).toBe("lightDarkOperate");
    // expanded sensor variants
    expect(matchProperty("Sensing range Sn")?.key).toBe("sensingDistance");
    expect(matchProperty("Scanning range")?.key).toBe("sensingDistance");
    expect(matchProperty("Response frequency")?.key).toBe("switchingFrequency"); // Omron
    expect(matchProperty("Repeatability")?.key).toBe("repeatAccuracy");
    expect(matchProperty("Output signal")?.key).toBe("outputType");
    expect(matchProperty("Process connection")?.key).toBe("connectionType");
    expect(matchProperty("Port size")?.key).toBe("connectionType");
  });

  it("disambiguates false-friend labels across product families", () => {
    // Medium-* are NOT the fluid 'medium'
    expect(matchProperty("Medium voltage")?.key).not.toBe("medium");
    expect(matchProperty("Medium time-lag")?.key).not.toBe("medium");
    // Coil power is its own concept, not the coil control voltage
    expect(matchProperty("Coil power")?.key).toBe("coilPower");
    // RCD rated residual current must beat the generic sensor leakage 'residual current'
    expect(matchProperty("Rated residual current")?.key).toBe("ratedResidualCurrent");
    expect(matchProperty("Residual current")?.key).toBe("leakageCurrent");
    // sampling speed must not be taken as motor shaft speed
    expect(matchProperty("Max. sampling speed")?.key).not.toBe("ratedSpeed");
    // PN pressure designation must not be read as power (P_N)
    expect(matchProperty("PN16")?.key).not.toBe("power");
    // Bore is its own (cylinder) concept, not generic diameter
    expect(matchProperty("Bore")?.key).toBe("bore");
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
