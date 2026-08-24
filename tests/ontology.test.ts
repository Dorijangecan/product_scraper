import { describe, expect, it } from "vitest";
import { findUnmappedSpecLabels, inferPropertyFromQuantities, looksLikeUnderstandableSpec, matchProperty, understand, isDisqualifiedForQuantityKind } from "../src/server/scrapers/ontology.js";

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

  it("maps only real NEMA enclosure type codes to protection, not arbitrary 'Type N' designations (Phase A5)", () => {
    expect(matchProperty("Type 12")?.key).toBe("protection");
    expect(matchProperty("Type 4X")?.key).toBe("protection");
    expect(matchProperty("Type 3R")?.key).toBe("protection");
    // Not NEMA type codes — must NOT be claimed as a protection rating.
    expect(matchProperty("Type 20")?.key).not.toBe("protection");
    expect(matchProperty("Type 7")?.key).not.toBe("protection");
  });

  it("recognizes real-world manufacturer labels found via the unmapped-label audit", () => {
    // German reverse-compound and input/output voltage variants ("Spannungsversorgung",
    // "Eingangsspannung") — confirmed unmapped in production run history before this fix.
    expect(matchProperty("Spannungsversorgung")?.key).toBe("ratedVoltage");
    expect(matchProperty("Eingangsspannung, nom.")?.key).toBe("ratedVoltage");
    expect(matchProperty("Ausgangsspannung")?.key).toBe("ratedVoltage");
    // "Summenstrom" (total/sum current) — IO-Link/fieldbus sensor+actuator supply current.
    expect(matchProperty("Summenstrom US, Sensor")?.key).toBe("ratedCurrent");
    // Motor/transformer idle-running losses.
    expect(matchProperty("Idle running losses")?.key).toBe("powerLoss");
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

  it("understands broad electrical catalog labels for voltage, current, current draw, and losses", () => {
    expect(matchProperty("Electrical data - supply voltage range")?.key).toBe("ratedVoltage");
    expect(matchProperty("Module supply voltage")?.key).toBe("ratedVoltage");
    expect(matchProperty("Sensor supply voltage")?.key).toBe("ratedVoltage");
    expect(matchProperty("Auxiliary voltage")?.key).toBe("ratedVoltage");
    expect(matchProperty("Load voltage")?.key).toBe("ratedVoltage");
    expect(matchProperty("Max. operating voltage")?.key).toBe("ratedVoltage");

    expect(matchProperty("Load current")?.key).toBe("ratedCurrent");
    expect(matchProperty("Nominal load current")?.key).toBe("ratedCurrent");
    expect(matchProperty("Maximum load current")?.key).toBe("ratedCurrent");
    expect(matchProperty("Output current range")?.key).toBe("ratedCurrent");
    expect(matchProperty("Current-carrying capacity")?.key).toBe("ratedCurrent");
    expect(matchProperty("Permissible current")?.key).toBe("ratedCurrent");

    expect(matchProperty("Current consumption max.")?.key).toBe("currentConsumption");
    expect(matchProperty("Input current max.")?.key).toBe("currentConsumption");
    expect(matchProperty("No-load current Io max.")?.key).toBe("currentConsumption");
    expect(matchProperty("Quiescent current")?.key).toBe("currentConsumption");
    expect(matchProperty("Current Draw at 24V DC")?.key).toBe("currentConsumption");

    expect(matchProperty("Power loss [W] / maximum")?.key).toBe("powerLoss");
    expect(matchProperty("Module power dissipation")?.key).toBe("powerLoss");
    expect(matchProperty("Total power loss")?.key).toBe("powerLoss");
    expect(matchProperty("Internal power loss")?.key).toBe("powerLoss");
    expect(matchProperty("Heat loss")?.key).toBe("powerLoss");
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

  it("maps Eaton's Polish localized product dimension labels", () => {
    expect(matchProperty("Wysoko\u015b\u0107 produktu")?.key).toBe("height");
    expect(matchProperty("Szeroko\u015b\u0107 produktu")?.key).toBe("width");
    expect(matchProperty("D\u0142ugo\u015b\u0107/g\u0142\u0119boko\u015b\u0107 produktu")?.key).toBe("depth");
  });

  describe("unit-driven property inference (unknown-language labels)", () => {
    it("infers the plain rated property from an unambiguous unit when the label is unknown", () => {
      // Polish — a language the synonym lists don't cover
      expect(inferPropertyFromQuantities("Prąd znamionowy", "20 A")?.property.key).toBe("ratedCurrent");
      expect(inferPropertyFromQuantities("Napięcie zasilania", "400 V")?.property.key).toBe("ratedVoltage");
      expect(inferPropertyFromQuantities("Częstotliwość", "50 Hz")?.property.key).toBe("frequency");
      // Czech ambient-temperature range and weight
      expect(inferPropertyFromQuantities("Teplota okolí", "-25...70 °C")?.property.key).toBe("operatingTemperature");
      expect(inferPropertyFromQuantities("Hmotnost", "1.2 kg")?.property.key).toBe("weight");
    });

    it("reroutes qualifiers it understands to the specific property instead", () => {
      expect(inferPropertyFromQuantities("Straty mocy", "5 W")?.property.key).toBe("powerLoss"); // PL power loss
      expect(inferPropertyFromQuantities("Güç tüketimi", "10 W")?.property.key).toBe("powerConsumption"); // TR consumption
      expect(inferPropertyFromQuantities("Skladovací teplota", "-40...85 °C")?.property.key).toBe("storageTemperature"); // CS storage
    });

    it("stays silent on dangerous qualifiers instead of guessing the rated property", () => {
      expect(inferPropertyFromQuantities("Napięcie izolacji", "690 V")).toBeUndefined(); // insulation
      expect(inferPropertyFromQuantities("Fusible recomendado", "20 A")).toBeUndefined(); // fuse
      expect(inferPropertyFromQuantities("Eigenfrequenz", "50 Hz")).toBeUndefined(); // natural frequency
      // a lone temperature could mean anything — only ranges read as environment ratings
      expect(inferPropertyFromQuantities("Teplota", "70 °C")).toBeUndefined();
      // mixed kinds in one value are ambiguous
      expect(inferPropertyFromQuantities("Zasilanie", "230 V / 50 Hz")).toBeUndefined();
      // switching frequencies in kHz are not the mains frequency
      expect(inferPropertyFromQuantities("Frekvencja kluczowania", "4 kHz")).toBeUndefined();
      // kA is a breaking capacity, kV an impulse/insulation level — never the plain rating
      expect(inferPropertyFromQuantities("Prąd zwarciowy", "6 kA")).toBeUndefined();
      expect(inferPropertyFromQuantities("Wytrzymałość udarowa", "6 kV")).toBeUndefined();
      // prose that merely mentions a quantity is not a spec value
      expect(inferPropertyFromQuantities("Opis", "SIMATIC IPC427E, 24 V DC industrial power supply")).toBeUndefined();
      expect(inferPropertyFromQuantities("Product name", "24 V power supply")).toBeUndefined();
    });
  });

  it("flags numeric and text spec labels it does not understand, with the value kind for review", () => {
    const gaps = findUnmappedSpecLabels([
      { name: "Nennstrom", value: "16 A" }, // mapped → not a gap
      { name: "Eigenfrequenz", value: "50 Hz" }, // recognizable quantity, unknown label → gap
      // A text-valued specification has no unit fallback, so hiding it makes the teach-list
      // systematically blind to precisely the ontology gap an operator needs to review.
      { group: "Technical Data", name: "Contact metallurgy", value: "Silver alloy" },
      // Real historical review noise: captions, URL-bearing instructions and values emitted as
      // labels are page furniture, even when a numeric token makes them look actionable.
      { group: "Technical Data", name: "Table 36: Technical data of the", value: "230 V" },
      { group: "Technical Data", name: "Install the accessory; see https://library.vendor.test/", value: "16 A" },
      { group: "Technical Data", name: "220V", value: "24 V" },
      { group: "Technical Data", name: "Push STOP to cancel the position selection", value: "16 A" },
      { group: "Technical Data", name: "Premere STOP per annullare la selezione", value: "16 A" },
      { group: "Technical Data", name: "STOPPEN drücken, um die Stellungswahl abzubrechen", value: "16 A" },
      { group: "Technical Data", name: "Pulse PARO para cancelar la selección", value: "16 A" },
      { group: "Technical Data", name: "switch set. In the example", value: "16 A" },
      { group: "Technical Data", name: "dip configurado. En el ejemplo", value: "16 A" },
      { group: "Technical Data", name: "按下 STOP 取消位置选择", value: "16 A" },
      // A long technical property must remain reviewable; the noise filter cannot be a length cap.
      { group: "Technical Data", name: "Electrostatic Discharge (ESD Immunity) acc. to IEC 61000-4-2", value: "8 kV" },
      { name: "Marketing blurb", value: "best in class" },
      { group: "Meta", name: "og:title", value: "ABC | Vendor" }
    ]);
    expect(gaps).toContainEqual({ label: "Eigenfrequenz", valueKind: "quantity" });
    expect(gaps).toContainEqual({ label: "Contact metallurgy", valueKind: "text" });
    expect(gaps).not.toContainEqual(expect.objectContaining({ label: "Nennstrom" }));
    expect(gaps).not.toContainEqual(expect.objectContaining({ label: "Table 36: Technical data of the" }));
    expect(gaps).not.toContainEqual(expect.objectContaining({ label: expect.stringContaining("library.vendor.test") }));
    expect(gaps).not.toContainEqual(expect.objectContaining({ label: "220V" }));
    expect(gaps).not.toContainEqual(expect.objectContaining({ label: expect.stringMatching(/^(?:Push|Premere|STOPPEN|Pulse|switch set|dip configurado|按下 STOP)/i) }));
    expect(gaps).toContainEqual({ label: "Electrostatic Discharge (ESD Immunity) acc. to IEC 61000-4-2", valueKind: "quantity" });
    expect(gaps).not.toContainEqual(expect.objectContaining({ label: "Marketing blurb" }));
    expect(gaps).not.toContainEqual(expect.objectContaining({ label: "og:title" }));
  });
});

/**
 * The admission test that replaces hand-written English keyword lists. Every label below was missed by
 * `isGlobalTechnicalLine`'s keyword list in document-enrichment.ts and is mapped correctly by the
 * ontology — measured against Eaton's E6 catalogue (fixtures/eaton-cbe03319-family-catalog).
 */
describe("looksLikeUnderstandableSpec", () => {
  it("recognises labels the English keyword lists missed", () => {
    for (const label of [
      "Casing protection degree",
      "Design standard",
      "Rated breaking capacity Icn",
      "Terminal screw fastening torque",
      "Mounting method",
      "Pollution degree",
      "Part number",
      "Article number"
    ]) {
      expect(looksLikeUnderstandableSpec(label), label).toBe(true);
    }
  });

  it("recognises non-English labels, which is the whole point", () => {
    for (const label of ["Bemessungsstrom", "Corrente nominale", "Rango de temperatura de empleo", "Tension nominale"]) {
      expect(looksLikeUnderstandableSpec(label), label).toBe(true);
    }
  });

  it("falls back to unit inference when no synonym matches", () => {
    // Label unknown, but the value's unit identifies the property.
    expect(looksLikeUnderstandableSpec("Widerstandswert XYZ", "24 V")).toBe(true);
    expect(looksLikeUnderstandableSpec("Widerstandswert XYZ")).toBe(false);
  });

  it("says no to text carrying no recognisable property", () => {
    for (const label of ["Unit per package", "Terminal wiring capacity", "Ordering example", "See page 12"]) {
      expect(looksLikeUnderstandableSpec(label), label).toBe(false);
    }
  });
});

/**
 * P1.1b — precision. `matchProperty` takes the longest synonym matching ANYWHERE in the string, which is
 * the right bias for admission and the wrong one for deciding WHICH property a label is. These pin the
 * over-matches found while wiring the ontology into the admission gates.
 */
describe("ontology precision", () => {
  it("does not read a selectivity class as a degree of protection", () => {
    // Eaton E6 page 4: "Selective protection level 3". A selectivity class is not an IP rating, and
    // letting it through would overwrite a real IP20 with "3".
    expect(matchProperty("Selective protection level")?.key).not.toBe("protection");
    expect(matchProperty("Selectivity level")?.key).not.toBe("protection");
  });

  it("still maps genuine protection labels", () => {
    for (const label of [
      "Degree of protection",
      "Protection level",
      "Protection class",
      "Casing protection degree",
      "Ingress protection",
      "Schutzart"
    ]) {
      expect(matchProperty(label)?.key, label).toBe("protection");
    }
  });

  it("does not read a sentence-initial 'In' as the nominal-current symbol", () => {
    // "In" is the IEC symbol for nominal current, but also an English word. The synonym is
    // case-sensitive, which already excludes "in"; these are the title-case traps that remain.
    expect(matchProperty("In accordance with IEC 60947")?.key).not.toBe("ratedCurrent");
    expect(matchProperty("In case of overload")?.key).not.toBe("ratedCurrent");
  });

  it("still maps the nominal-current symbol where it really is one", () => {
    expect(matchProperty("In")?.key).toBe("ratedCurrent");
    expect(matchProperty("In (A)")?.key).toBe("ratedCurrent");
    expect(matchProperty("Rated current In")?.key).toBe("ratedCurrent");
    expect(matchProperty("Bemessungsstrom In")?.key).toBe("ratedCurrent");
  });
});

describe("synonyms must not fire inside unrelated words", () => {
  it("does not read the English word 'definition' as the French word for finish", () => {
    // `Definition List` is the group name the generic parser gives every <dl> spec block, and the
    // ontology label it is matched against is `group + name`. With the French synonym unanchored, every
    // page whose specs sit in a <dl> assigned that block's first value to the shipped `finish` column —
    // 60 pages in the recorded corpus, across Turck, nVent and Doepke.
    expect(matchProperty("Definition List Dimensions")?.key).not.toBe("finish");
    expect(matchProperty("Definition List Weight")?.key).not.toBe("finish");
    expect(matchProperty("High definition display")?.key).not.toBe("finish");
  });

  it("still maps the French and Italian finish vocabulary", () => {
    expect(matchProperty("Finition")?.key).toBe("finish");
    expect(matchProperty("Traitement de finition")?.key).toBe("finish");
    expect(matchProperty("Finitions")?.key).toBe("finish");
    expect(matchProperty("Finitura")?.key).toBe("finish");
  });
});

describe("isDisqualifiedForQuantityKind — one owner for the kA/Ui vocabulary", () => {
  it("rejects fault-level figures for the current field", () => {
    for (const label of [
      "Nominal discharge current In",
      "Impulse current Iimp",
      "Lightning impulse current",
      "Rated short-circuit breaking capacity Icu",
      "Breaking capacity",
      "Inrush current",
      "Starting current",
      "Peak current"
    ]) {
      expect(isDisqualifiedForQuantityKind(label, "25 kA", "current"), label).toBe(true);
    }
  });

  it("keeps switching capacity, which really is a contact current rating", () => {
    // A relay or thermostat sells on this figure; the nVent thermostat test depends on it.
    expect(isDisqualifiedForQuantityKind("Switching capacity", "10 A", "current")).toBe(false);
    expect(isDisqualifiedForQuantityKind("Switching current", "10 A", "current")).toBe(false);
    expect(isDisqualifiedForQuantityKind("Rated operational current Ie", "16 A", "current")).toBe(false);
  });

  it("rejects the RCD test-circuit and per-sensitivity voltages", () => {
    expect(isDisqualifiedForQuantityKind("min. operating voltage", "range of test circuit 150 V", "voltage")).toBe(true);
    expect(isDisqualifiedForQuantityKind("Minimum rated operating voltage (Type A/AC operation)", "110 V", "voltage")).toBe(true);
    expect(isDisqualifiedForQuantityKind("Rated impulse withstand voltage Uimp", "8 kV", "voltage")).toBe(true);
  });

  it("checks the value as well as the label, since a PDF split can land the qualifier on either side", () => {
    expect(isDisqualifiedForQuantityKind("Prüfeinrichtung", "", "voltage")).toBe(true);
    expect(isDisqualifiedForQuantityKind("", "of test circuit 150 V", "voltage")).toBe(true);
  });

  it("keeps a standard's own scope out of both electrical fields", () => {
    const label = "NEMA 250 Enclosures for Electrical Equipment (1000 Volts Maximum)";
    expect(isDisqualifiedForQuantityKind(label, "1000 V", "voltage")).toBe(true);
    expect(isDisqualifiedForQuantityKind(label, "1000 V", "current")).toBe(true);
    // …and does not touch unrelated kinds.
    expect(isDisqualifiedForQuantityKind(label, "5 kg", "mass")).toBe(false);
  });

  it("leaves non-electrical kinds alone", () => {
    expect(isDisqualifiedForQuantityKind("Breaking capacity", "25 kA", "mass")).toBe(false);
    expect(isDisqualifiedForQuantityKind("Weight", "0.3 kg", "mass")).toBe(false);
  });
});
