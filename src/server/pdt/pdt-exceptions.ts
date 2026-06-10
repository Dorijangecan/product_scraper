export interface PdtExceptionContext {
  manufacturerId?: string;
  catalogNumber: string;
  sheetName?: string;
}

export interface PdtExceptionEclassDefault {
  code: string;
  system: string;
}

export interface PdtExceptionRule {
  name: string;
  manufacturerId: string;
  catalogPattern: RegExp;
  sheetPattern?: RegExp;
  eclassDefault?: PdtExceptionEclassDefault;
  rationale: string;
}

export const PDT_EXCEPTION_RULES: PdtExceptionRule[] = [
  {
    name: "rockwell-compact-5000-io-eclass",
    manufacturerId: "rockwell",
    catalogPattern: /^\s*5069-[IO][A-Z0-9-]*/i,
    sheetPattern: /^\s*PLC\s*$/i,
    eclassDefault: { code: "27242604", system: "14" },
    rationale: "Manual PDT examples classify Rockwell Compact 5000 5069-I/O catalog numbers as I/O modules on the PLC tab."
  },
  {
    name: "rockwell-controllogix-l9-eclass",
    manufacturerId: "rockwell",
    catalogPattern: /^\s*1756-L9/i,
    sheetPattern: /^\s*PLC\s*$/i,
    eclassDefault: { code: "27242208", system: "14" },
    rationale: "Manual PDT examples use the ControlLogix processor ECLASS class for 1756-L9 controllers."
  },
  {
    name: "rockwell-1492-pde-terminal-eclass",
    manufacturerId: "rockwell",
    catalogPattern: /^\s*1492-PD(?:E|ME)/i,
    sheetPattern: /^\s*terminal\s*$/i,
    eclassDefault: { code: "27250101", system: "14" },
    rationale: "Manual PDT examples route Rockwell 1492-PDE/PDME power distribution blocks to the terminal class."
  },
  {
    name: "rockwell-stratix-2100-eclass",
    manufacturerId: "rockwell",
    catalogPattern: /^\s*1783-US/i,
    sheetPattern: /^\s*PLC\s*$/i,
    eclassDefault: { code: "27242201", system: "13" },
    rationale: "Manual PDT examples classify Rockwell Stratix 2100 unmanaged switches as PLC communication gateways."
  },
  {
    name: "rockwell-powerflex-755ts-eclass",
    manufacturerId: "rockwell",
    catalogPattern: /^\s*20G21FC/i,
    sheetPattern: /^\s*power\s+supply\s+devices\s*$/i,
    eclassDefault: { code: "27023101", system: "13" },
    rationale: "Manual PDT examples include Rockwell PowerFlex 755TS drives on the power supply devices tab with ECLASS 13."
  },
  {
    name: "rockwell-852-led-indicator-eclass",
    manufacturerId: "rockwell",
    catalogPattern: /^\s*852[CD]-/i,
    sheetPattern: /^\s*command\s+and\s+alarm\s+device\s*$/i,
    eclassDefault: { code: "27143221", system: "13" },
    rationale: "Manual PDT examples classify Rockwell 852C/852D LED indicators as command and alarm devices."
  },
  {
    name: "rockwell-armorkinetix-dsd-eclass",
    manufacturerId: "rockwell",
    catalogPattern: /^\s*2198-DSD/i,
    sheetPattern: /^\s*motors?\s*$/i,
    eclassDefault: { code: "27023101", system: "14" },
    rationale: "Manual PDT examples classify Rockwell ArmorKinetix DSD distributed drives on the motors tab."
  },
  {
    name: "rockwell-armorkinetix-dsm-eclass",
    manufacturerId: "rockwell",
    catalogPattern: /^\s*2198-DSM/i,
    sheetPattern: /^\s*motors?\s*$/i,
    eclassDefault: { code: "27022602", system: "14" },
    rationale: "Manual PDT examples classify Rockwell ArmorKinetix DSM motors with ECLASS 27022602."
  },
  {
    name: "rockwell-panelview-5510-eclass",
    manufacturerId: "rockwell",
    catalogPattern: /^\s*2715P-/i,
    sheetPattern: /^\s*PLC\s*$/i,
    eclassDefault: { code: "27330201", system: "14" },
    rationale: "Manual PDT examples classify Rockwell PanelView 5510 terminals on the PLC tab."
  },
  {
    name: "rockwell-micro820-eclass",
    manufacturerId: "rockwell",
    catalogPattern: /^\s*2080-LC20-/i,
    sheetPattern: /^\s*PLC\s*$/i,
    eclassDefault: { code: "27242202", system: "14" },
    rationale: "Manual PDT examples classify Rockwell Micro820 L20 controllers as PLC controllers when family-page evidence is used."
  }
];

export function pdtExceptionEclassDefault(ctx: PdtExceptionContext): PdtExceptionEclassDefault | undefined {
  return pdtExceptionRule(ctx)?.eclassDefault;
}

export function pdtExceptionRule(ctx: PdtExceptionContext): PdtExceptionRule | undefined {
  const manufacturerId = ctx.manufacturerId?.trim().toLowerCase();
  const catalog = ctx.catalogNumber.trim();
  const sheet = ctx.sheetName?.trim();
  return PDT_EXCEPTION_RULES.find((rule) => {
    if (rule.manufacturerId !== manufacturerId) return false;
    if (!rule.catalogPattern.test(catalog)) return false;
    if (!rule.sheetPattern || !sheet) return true;
    return rule.sheetPattern.test(sheet);
  });
}
