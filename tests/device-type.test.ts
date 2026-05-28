import { describe, expect, it } from "vitest";
import { classifyDeviceType, knownDeviceTypes } from "../src/server/scrapers/device-type.js";
import { deviceSheetsFor } from "../src/server/pdt/device-sheet-map.js";
import type { ProductResult } from "../src/shared/types.js";

function product(
  attributes: ProductResult["attributes"],
  title = "Test product",
  overrides: Partial<ProductResult> = {}
): ProductResult {
  return {
    manufacturerId: "test",
    catalogNumber: "TEST-1",
    status: "found",
    confidence: 0.9,
    title,
    normalized: {},
    attributes,
    documents: [],
    sources: [],
    ...overrides
  };
}

describe("device type classifier", () => {
  it("recognizes every known device type when the vendor provides the exact category label", () => {
    const missed = knownDeviceTypes()
      .map((type) => ({
        type,
        classified: classifyDeviceType(
          product([{ group: "General", name: "Product Type", value: type, sourceType: "official" }], type)
        ).type
      }))
      .filter((entry) => entry.classified !== entry.type);

    expect(missed).toEqual([]);
  });

  it("uses explicit manufacturer product type before weaker text", () => {
    const result = product(
      [
        { group: "General specifications", name: "Product Type", value: "Contactor", sourceType: "official" },
        { group: "Product specifications", name: "Connector type", value: "Screw terminals", sourceType: "official" }
      ],
      "IEC control device with screw terminals"
    );

    expect(classifyDeviceType(result)).toMatchObject({
      type: "Contactor",
      evidence: "Product Type: Contactor"
    });
  });

  it("classifies common automation and sensor terms from precise attributes", () => {
    expect(
      classifyDeviceType(
        product([{ group: "Main", name: "Product or Component Type", value: "Programmable logic controller", sourceType: "official" }])
      ).type
    ).toBe("Programmable Logic Controller");

    expect(
      classifyDeviceType(
        product([{ group: "Balluff Key features", name: "Principle of operation", value: "Photoelectric sensor", sourceType: "official" }])
      ).type
    ).toBe("Photoelectric Sensor");
  });

  it("leaves type empty when evidence is only a model code", () => {
    expect(
      classifyDeviceType(product([{ group: "Structured Data", name: "alternateName", value: "BOS 18M-PA-IE21-S4", sourceType: "official" }])).type
    ).toBeUndefined();
  });

  it("uses ECLASS as an authoritative device-type signal when text is generic", () => {
    const result = product(
      [
        { group: "Classification", name: "ECLASS 14.0", value: "27-37-10-03", sourceType: "official" },
        { group: "General", name: "Product Type", value: "Switching device", sourceType: "official" }
      ],
      "ABB AF contact device"
    );
    const classification = classifyDeviceType(result);
    expect(classification.type).toBe("Contactor");
    expect(classification.evidence).toContain("ECLASS");
  });

  it("uses ECLASS classes for passive or terse Balluff products", () => {
    expect(
      classifyDeviceType(
        product([{ group: "Balluff Classifications", name: "ECLASS 14.0", value: "27-28-04-02", sourceType: "official" }], "HF read/write head")
      ).type
    ).toBe("RFID Device");

    expect(
      classifyDeviceType(
        product([{ group: "Balluff Classifications", name: "ECLASS 14.0", value: "27-44-01-14", sourceType: "official" }], "Cylindrical glass fibers")
      ).type
    ).toBe("Optical Connector");
  });

  it("maps locally observed ECLASS codes to PDT-backed device types without product-type text", () => {
    const samples = [
      ["27-27-09-01", "Photoelectric Sensor"],
      ["27-27-09-04", "Photoelectric Sensor"],
      ["27-27-07-02", "Encoder"],
      ["27-27-43-04", "Encoder"],
      ["27-27-11-01", "Sensor"],
      ["27-27-42-01", "Sensor"],
      ["27-27-26-03", "Safety Sensor"],
      ["27-28-04-02", "RFID Device"],
      ["27-11-03-50", "Luminaire"],
      ["27-06-03-11", "Cable"],
      ["27-44-01-02", "Connector"],
      ["27-44-01-14", "Optical Connector"],
      ["27-14-23-90", "Lock / Interlock"],
      ["27-37-10-03", "Contactor"],
      ["27-37-13-07", "Lock / Interlock"],
      ["27-37-13-92", "Accessory"],
      ["27-27-06-91", "Sensor"],
      ["27-27-06-02", "Sensor"]
    ] as const;

    for (const [code, expectedType] of samples) {
      const classification = classifyDeviceType(
        product([{ group: "Classifications", name: "ECLASS 14.0", value: code, sourceType: "official" }], "Product")
      );
      expect(classification.type, code).toBe(expectedType);
      expect(deviceSheetsFor(classification.type), code).not.toEqual([]);
    }
  });

  it("maps unambiguous locally observed ETIM codes to PDT-backed device types without product-type text", () => {
    const samples = [
      ["EC002716", "Photoelectric Sensor"],
      ["EC001825", "Photoelectric Sensor"],
      ["EC002544", "Encoder"],
      ["EC001852", "Sensor"],
      ["EC002593", "Safety Sensor"],
      ["EC000232", "Luminaire"],
      ["EC000030", "Sensor"],
      ["EC001829", "Sensor"],
      ["EC002998", "RFID Device"],
      ["EC002051", "Lock / Interlock"],
      ["EC002498", "Accessory"]
    ] as const;

    for (const [code, expectedType] of samples) {
      const classification = classifyDeviceType(
        product([{ group: "Classifications", name: "ETIM 9.0", value: code, sourceType: "official" }], "Product")
      );
      expect(classification.type, code).toBe(expectedType);
      expect(deviceSheetsFor(classification.type), code).not.toEqual([]);
    }
  });

  it("does not classify locally ambiguous ETIM codes by themselves", () => {
    for (const code of ["EC001855", "EC002715"]) {
      expect(
        classifyDeviceType(product([{ group: "Classifications", name: "ETIM 9.0", value: code, sourceType: "official" }], "Product")).type,
        code
      ).toBeUndefined();
    }
  });

  it("maps unambiguous locally observed UNSPSC codes to PDT-backed device types without product-type text", () => {
    const samples = [
      ["26121604", "Cable"],
      ["39100000", "Luminaire"],
      ["39121413", "Connector"],
      ["39121528", "Photoelectric Sensor"],
      ["39122205", "Safety Sensor"],
      ["46171501", "Lock / Interlock"],
      ["41111938", "Sensor"],
      ["41111945", "Encoder"]
    ] as const;

    for (const [code, expectedType] of samples) {
      const classification = classifyDeviceType(
        product([{ group: "Classifications", name: "UNSPSC 11", value: code, sourceType: "official" }], "Product")
      );
      expect(classification.type, code).toBe(expectedType);
      expect(deviceSheetsFor(classification.type), code).not.toEqual([]);
    }
  });

  it("does not classify locally ambiguous UNSPSC accessory codes by themselves", () => {
    expect(
      classifyDeviceType(product([{ group: "Classifications", name: "UNSPSC", value: "39122221", sourceType: "official" }], "Product")).type
    ).toBeUndefined();
  });

  it("covers local DB regression cases from terse vendor labels", () => {
    expect(
      classifyDeviceType(
        product([], "BDG FB058-BCR6-DSRB2-1417-0000-S8R1 (BDG - FXX58-BC Series - SSI) Absolute encoders", {
          manufacturerId: "balluff",
          catalogNumber: "BDG FB058-BCR6-DSRB2-1417-0000-S8R1"
        })
      ).type
    ).toBe("Encoder");

    expect(
      classifyDeviceType(
        product(
          [
            { group: "ABB Product Data", name: "Extended Product Type", value: "1st PLC E2.3..E6.3 Padlocks o.p. left", sourceType: "official" },
            { group: "ABB Product Data", name: "Product Name", value: "Accessory", sourceType: "official" },
            { group: "ABB Product Data", name: "ETIM 10", value: "EC002051 - Padlock barrier for switch", sourceType: "official" },
            { group: "ABB Product Data", name: "eClass", value: "V13.0 : 27371307", sourceType: "official" },
            { group: "ABB Product Data", name: "UNSPSC", value: "46171501", sourceType: "official" }
          ],
          "1st PLC E2.3..E6.3 Padlocks o.p. left",
          { manufacturerId: "abb", catalogNumber: "1SDA126387R1" }
        )
      ).type
    ).toBe("Lock / Interlock");

    expect(
      classifyDeviceType(product([], "CompactLogix DC 4A/2A Power Supply", { manufacturerId: "rockwell", catalogNumber: "1769-PB4" })).type
    ).toBe("Power Supply");

    expect(
      classifyDeviceType(
        product([{ group: "SCE Product Data", name: "Product Type", value: "Conditioner, Air - 3400 BTU/Hr. 120 Volt", sourceType: "official" }], "SCE-AC3400B120V", {
          manufacturerId: "sce",
          catalogNumber: "SCE-AC3400B120V"
        })
      ).type
    ).toBe("Thermal Management");

    expect(
      classifyDeviceType(
        product([{ group: "SCE Product Data", name: "Product Type", value: "Assembly, Fan Housing (6in.)", sourceType: "official" }], "SCE-FA66", {
          manufacturerId: "sce",
          catalogNumber: "SCE-FA66"
        })
      ).type
    ).toBe("Thermal Management");

    expect(
      classifyDeviceType(
        product([{ group: "SCE Product Data", name: "Product Type", value: "Port, Programming", sourceType: "official" }], "P-P11R2-K3RF0-U450", {
          manufacturerId: "sce",
          catalogNumber: "P-P11R2-K3RF0-U450"
        })
      ).type
    ).toBe("Connector");

    expect(
      classifyDeviceType(
        product([{ group: "SCE Product Data", name: "Product Type", value: "Stainless Steel Cleaner", sourceType: "official" }], "SCE-SSCLEAN", {
          manufacturerId: "sce",
          catalogNumber: "SCE-SSCLEAN"
        })
      ).type
    ).toBe("Accessory");

    expect(
      classifyDeviceType(
        product([], "E1.3 - ABB Low Voltage & Systems", {
          manufacturerId: "abb",
          catalogNumber: "1SDA124715R1",
          description: "ABB Low Voltage & Systems > Low Voltage Products & Systems > Circuit Breakers > Air Circuit Breakers > Emax 3 > E1.3 3D CAD models"
        })
      ).type
    ).toBe("Circuit Breaker");

    expect(
      classifyDeviceType(
        product([], "Type 1140-E", {
          manufacturerId: "eta",
          catalogNumber: "1140-E",
          description: "Thermal Overcurrent Circuit Breakers engineered for resettable protection against overloads and short circuits."
        })
      ).type
    ).toBe("Circuit Breaker");

    expect(
      classifyDeviceType(
        product([], "VSG519K15-5 - Siemens Field Control Equipment", {
          manufacturerId: "siemens",
          catalogNumber: "BPZ:VSG519K15-5",
          description: "SIEMENS branded, VSG519K15-5 diff.press.regulator, VSG519K15-5"
        })
      ).type
    ).toBe("Valve");
  });

  it("prefers a specific sensor kind over the generic Sensor fallback even when generic wins on source weight", () => {
    // The generic "sensor" word lives in the high-priority "Product Type" attribute, while the
    // specific "Inductive Proximity Sensor" phrase only appears in the title. The classifier
    // must still pick the specific kind — specificity beats source strength.
    const result = product(
      [{ group: "General", name: "Product Type", value: "Sensor", sourceType: "official" }],
      "Inductive Proximity Sensor M12 PNP"
    );
    expect(classifyDeviceType(result).type).toBe("Inductive Proximity Sensor");
  });

  it("classifies a circuit breaker without misfiring on the generic Switch rule", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "Miniature circuit breaker", sourceType: "official" }],
      "S201 MCB 1P C16"
    );
    expect(classifyDeviceType(result).type).toBe("Miniature Circuit Breaker");
  });

  it("classifies a residual current device (RCD/RCBO) independently from contactors", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "Residual current circuit breaker", sourceType: "official" }],
      "RCBO 1P+N 16A"
    );
    expect(classifyDeviceType(result).type).toBe("Residual Current Device");
  });

  it("classifies a variable speed drive on the drive keyword", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "Variable frequency drive", sourceType: "official" }],
      "ACS580 Drive 11 kW"
    );
    expect(classifyDeviceType(result).type).toBe("Variable Speed Drive");
  });

  it("classifies a soft starter distinctly from a general motor starter", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "Soft starter", sourceType: "official" }],
      "PSE soft starter 18A"
    );
    expect(classifyDeviceType(result).type).toBe("Soft Starter");
  });

  it("classifies a motion controller distinctly from a generic PLC", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "Motion controller", sourceType: "official" }],
      "MC3 Motion Controller"
    );
    expect(classifyDeviceType(result).type).toBe("Motion Controller");
  });

  it("classifies a three-phase motor", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "Three-phase induction motor", sourceType: "official" }],
      "M3BP 132SMA 4 IE3 3-phase motor"
    );
    expect(classifyDeviceType(result).type).toBe("Motor");
  });

  it("classifies a luminaire / machine light", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "Machine light", sourceType: "official" }],
      "LED machine light fixture 24 V"
    );
    expect(classifyDeviceType(result).type).toBe("Luminaire");
  });

  it("classifies a safety relay separately from a generic relay", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "Safety relay", sourceType: "official" }],
      "Pluto safety relay"
    );
    expect(classifyDeviceType(result).type).toBe("Safety Relay");
  });

  it("classifies a safety light curtain as a safety sensor", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "Safety light curtain", sourceType: "official" }],
      "Orion3 safety light curtain"
    );
    expect(classifyDeviceType(result).type).toBe("Safety Sensor");
  });

  it("classifies safety switches and guard locking devices as safety sensors", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "Guard locking safety switch", sourceType: "official" }],
      "RFID safety interlock"
    );
    expect(classifyDeviceType(result).type).toBe("Safety Sensor");
  });

  it("classifies an EMC line filter (not as Thermal Management 'filter fan')", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "EMC line filter", sourceType: "official" }],
      "EMC mains filter 16 A"
    );
    expect(classifyDeviceType(result).type).toBe("Filter");
  });

  it("does NOT classify a filter fan as Filter (it belongs to Thermal Management)", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "Filter fan", sourceType: "official" }],
      "Filter fan 230 V"
    );
    expect(classifyDeviceType(result).type).toBe("Thermal Management");
  });

  it("classifies a pressure transmitter as Pressure Sensor", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "Pressure transmitter", sourceType: "official" }],
      "PT5400 pressure transmitter"
    );
    expect(classifyDeviceType(result).type).toBe("Pressure Sensor");
  });

  it("classifies a temperature transmitter as Temperature Sensor", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "Temperature transmitter Pt100", sourceType: "official" }],
      "iTemp PA temperature transmitter"
    );
    expect(classifyDeviceType(result).type).toBe("Temperature Sensor");
  });

  it("classifies a rotary encoder", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "Absolute rotary encoder", sourceType: "official" }],
      "BES rotary encoder 12 mm"
    );
    expect(classifyDeviceType(result).type).toBe("Encoder");
  });

  it("classifies a fiber optic connector as Optical Connector", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "Fiber optic connector LC", sourceType: "official" }],
      "LC duplex fiber optic connector"
    );
    expect(classifyDeviceType(result).type).toBe("Optical Connector");
  });

  it("classifies a generator set", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "Diesel generator set", sourceType: "official" }],
      "Standby diesel generator 100 kVA"
    );
    expect(classifyDeviceType(result).type).toBe("Generator");
  });

  it("classifies a pneumatic solenoid valve as Directional Control Valve", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "5/2-way solenoid valve", sourceType: "official" }],
      "VUVS solenoid valve 24 V DC"
    );
    expect(classifyDeviceType(result).type).toBe("Directional Control Valve");
  });

  it("classifies a centrifugal pump", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "Centrifugal pump", sourceType: "official" }],
      "CR centrifugal pump 5 m³/h"
    );
    expect(classifyDeviceType(result).type).toBe("Pump");
  });

  it("classifies a server rack as Rack Cabinet (not generic Enclosure)", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "19-inch server rack", sourceType: "official" }],
      "DK 19-inch network rack 42U"
    );
    expect(classifyDeviceType(result).type).toBe("Rack Cabinet");
  });

  it("classifies a Modbus gateway as Communication Gateway (not I/O Module)", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "Modbus gateway RS485 to Ethernet", sourceType: "official" }],
      "MGate Modbus gateway"
    );
    expect(classifyDeviceType(result).type).toBe("Communication Gateway");
  });

  it("classifies an RS232 to Ethernet converter as Communication Gateway", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "RS232 to Ethernet converter", sourceType: "official" }],
      "NPort RS232 converter"
    );
    expect(classifyDeviceType(result).type).toBe("Communication Gateway");
  });

  it("classifies a fieldbus bus coupler as Communication Gateway", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "Profinet bus coupler", sourceType: "official" }],
      "BK1120 fieldbus coupler"
    );
    expect(classifyDeviceType(result).type).toBe("Communication Gateway");
  });

  it("classifies a pin header as PCB Connector (not generic Connector)", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "Pin header 2.54 mm pitch", sourceType: "official" }],
      "MTA pin header 1x10 PCB"
    );
    expect(classifyDeviceType(result).type).toBe("PCB Connector");
  });

  it("classifies a PCB screw terminal block as PCB Terminal Block", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "PCB terminal block 5 mm pitch", sourceType: "official" }],
      "MKDS PCB screw terminal block"
    );
    expect(classifyDeviceType(result).type).toBe("PCB Terminal Block");
  });

  it("classifies a DIN rail end bracket as Terminal Accessory", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "DIN rail end bracket", sourceType: "official" }],
      "E/UK end bracket"
    );
    expect(classifyDeviceType(result).type).toBe("Terminal Accessory");
  });

  it("classifies a ball valve as Valve (not Directional Control Valve)", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "Ball valve 1/2 inch brass", sourceType: "official" }],
      "Brass ball valve PN16"
    );
    expect(classifyDeviceType(result).type).toBe("Valve");
  });

  it("still classifies a 5/2-way solenoid valve as Directional Control Valve", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "5/2-way directional control valve", sourceType: "official" }],
      "Solenoid spool valve"
    );
    expect(classifyDeviceType(result).type).toBe("Directional Control Valve");
  });

  it("classifies a hydraulic cylinder as Hydraulic Actuator", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "Hydraulic cylinder double acting", sourceType: "official" }],
      "CDH1 hydraulic cylinder 100/56"
    );
    expect(classifyDeviceType(result).type).toBe("Hydraulic Actuator");
  });

  it("classifies a wire marker as Wire Marker (not Cable)", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "Wire marker tag printable", sourceType: "official" }],
      "WMS wire marker labels"
    );
    expect(classifyDeviceType(result).type).toBe("Wire Marker");
  });

  it("does NOT classify a hydraulic pump as Hydraulic Actuator (it stays Pump)", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "Hydraulic gear pump", sourceType: "official" }],
      "PGP gear pump 25 cc/rev"
    );
    expect(classifyDeviceType(result).type).toBe("Pump");
  });
});

describe("device type classifier — family / series signals", () => {
  it("classifies an ABB AF-series catalog number as Contactor even with bare title", () => {
    const result = product([], "AF40B-30-00", { manufacturerId: "abb", catalogNumber: "AF40B-30-00-13" });
    const classification = classifyDeviceType(result);
    expect(classification.type).toBe("Contactor");
    expect(classification.evidence).toMatch(/Family AF/);
  });

  it("classifies an ABB ACS580 drive by family even with no rule-friendly title", () => {
    const result = product([], "ACS580-01-12A6-4", { manufacturerId: "abb", catalogNumber: "ACS580-01-12A6-4" });
    expect(classifyDeviceType(result).type).toBe("Variable Speed Drive");
  });

  it("classifies a Balluff BOS catalog number as Photoelectric Sensor via family", () => {
    const result = product([], "BOS025P", { manufacturerId: "balluff", catalogNumber: "BOS025P" });
    expect(classifyDeviceType(result).type).toBe("Photoelectric Sensor");
  });

  it("classifies a Phoenix Contact QUINT power supply via family", () => {
    const result = product([], "QUINT4-PS/1AC/24DC/10", { manufacturerId: "phoenix", catalogNumber: "QUINT4-PS/1AC/24DC/10" });
    expect(classifyDeviceType(result).type).toBe("Power Supply");
  });

  it("classifies a Siemens 3RT contactor via family", () => {
    const result = product([], "3RT2026-1AP00", { manufacturerId: "siemens", catalogNumber: "3RT2026-1AP00" });
    expect(classifyDeviceType(result).type).toBe("Contactor");
  });

  it("classifies SCE filter kits via family even with bare catalog input", () => {
    const result = product([], "SCE-FK0618", { manufacturerId: "sce", catalogNumber: "SCE-FK0618" });
    expect(classifyDeviceType(result).type).toBe("Thermal Management");
  });

  it("classifies Rockwell 100-series contactors via family", () => {
    const result = product([], "100-C09D10", { manufacturerId: "rockwell", catalogNumber: "100-C09D10" });
    expect(classifyDeviceType(result).type).toBe("Contactor");
  });

  it("classifies a Pilz PNOZ safety relay via family", () => {
    const result = product([], "PNOZ s3", { manufacturerId: "pilz", catalogNumber: "PNOZ-S3" });
    expect(classifyDeviceType(result).type).toBe("Safety Relay");
  });

  it("does NOT match an Eaton P5 family prefix on a Tripp Lite cable (P569-…)", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "Cable", sourceType: "official-fallback" }],
      "P569-006-2B-MF | Eaton Tripp Lite series cable",
      { manufacturerId: "eaton", catalogNumber: "P569-006-2B-MF" }
    );
    expect(classifyDeviceType(result).type).toBe("Cable");
  });
});

describe("device type classifier — URL signals", () => {
  it("uses an ABB /contactors/ URL path to confirm Contactor even when title is ambiguous", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "Switching device", sourceType: "official" }],
      "ABB AF40B",
      {
        manufacturerId: "abb",
        catalogNumber: "AF40B",
        productUrl: "https://new.abb.com/products/contactors/AF40B"
      }
    );
    expect(classifyDeviceType(result).type).toBe("Contactor");
  });

  it("uses a Balluff /photoelectric/ URL path as a strong signal", () => {
    const result = product(
      [],
      "BOS sensor",
      {
        manufacturerId: "balluff",
        catalogNumber: "BOS-NN",
        productUrl: "https://www.balluff.com/en-gb/products/photoelectric/BOS-NN"
      }
    );
    expect(classifyDeviceType(result).type).toBe("Photoelectric Sensor");
  });

  it("uses a generic /motor-protection/ URL path even without manufacturer-specific entry", () => {
    const result = product(
      [],
      "Motor protection device",
      {
        manufacturerId: "unknown",
        catalogNumber: "ZZZ-1",
        productUrl: "https://example.test/products/motor-protection/ZZZ-1"
      }
    );
    expect(classifyDeviceType(result).type).toBe("Motor Circuit Breaker");
  });
});

describe("device type classifier — multi-signal voting and confidence", () => {
  it("boosts confidence when multiple channels agree", () => {
    const result = product(
      [
        { group: "General", name: "Product Type", value: "Contactor", sourceType: "official" },
        { group: "Technical", name: "Number of poles", value: "3P", sourceType: "official" },
        { group: "Technical", name: "Rated operational current AC-1", value: "70 A", sourceType: "official" },
        { group: "Technical", name: "Rated control circuit voltage", value: "24-60 V", sourceType: "official" }
      ],
      "AF40B contactor",
      {
        manufacturerId: "abb",
        catalogNumber: "AF40B-30-00",
        productUrl: "https://new.abb.com/products/contactors/AF40B-30-00"
      }
    );
    const classification = classifyDeviceType(result);
    expect(classification.type).toBe("Contactor");
    // All three channels (text + family + url) agree AND signature attributes match → confidence near the ceiling.
    expect(classification.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it("returns up to 2 alternatives and a score margin", () => {
    const result = product(
      [{ group: "General", name: "Product Type", value: "Contactor", sourceType: "official" }],
      "AF40B contactor"
    );
    const classification = classifyDeviceType(result);
    expect(classification.type).toBe("Contactor");
    expect(classification.scoreMargin).toBeGreaterThanOrEqual(0);
    // alternatives may be empty when only one type fires, that's fine — but margin must be present.
    expect(classification.scoreMargin).toBeDefined();
  });

  it("attaches sanity warnings when the chosen type lacks signature attributes", () => {
    // "Contactor" wins by title only — no AC current / pole number / coil voltage exist.
    const result = product([], "AF40 contactor", { manufacturerId: "test", catalogNumber: "ZZZ" });
    const classification = classifyDeviceType(result);
    expect(classification.type).toBe("Contactor");
    expect(classification.warnings ?? []).toContain(
      "No contactor signature attributes (poles / AC current / coil voltage) found."
    );
  });

  it("warns when a Cable classification has switching-device signature attributes (mismatch)", () => {
    const result = product(
      [
        { group: "General", name: "Product Type", value: "Cable assembly", sourceType: "official" },
        { group: "Technical", name: "Number of poles", value: "3P", sourceType: "official" },
        { group: "Technical", name: "Rated operational power AC-3", value: "11 kW", sourceType: "official" }
      ],
      "Cable assembly"
    );
    const classification = classifyDeviceType(result);
    expect(classification.type).toBe("Cable");
    expect(classification.warnings ?? []).toContain(
      "Classified as Cable but has switching-device signature attributes — verify."
    );
  });
});
