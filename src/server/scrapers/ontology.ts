/**
 * Property ontology (Understanding Engine, workstream B-2) — the deterministic KNOWLEDGE BASE.
 *
 * This is the opposite of per-manufacturer templates: a general, data-driven dictionary of what
 * a spec LABEL *means*, across languages, regardless of which manufacturer wrote it. "Nennstrom",
 * "rated operational current", "courant assigné" all mean the same canonical property. Paired with
 * the quantity grammar (which understands the VALUE), this lets the scraper understand a page from
 * a manufacturer it has never seen — and FLAG what it cannot map instead of guessing.
 *
 * To teach it more, add entries/synonyms here (data), not new regexes scattered through scrapers.
 */
import { parseQuantities, type ParsedQuantity, type QuantityKind } from "./quantity.js";

export interface CanonicalProperty {
  /** Stable canonical id. */
  key: string;
  /** Human-readable English label. */
  label: string;
  /** Expected physical quantity kind (drives value parsing + sanity); omit for non-numeric props. */
  unitKind?: QuantityKind;
  /** Multilingual label matchers (EN/DE first; extend freely). Matched case-insensitively. */
  synonyms: RegExp[];
  /** Labels that must NOT be treated as this property (kills look-alikes, e.g. "colour temperature"). */
  exclude?: RegExp[];
}

const COLOUR_TEMP = /colou?r\s*temp(?:erature)?|farbtemperatur/i;

export type ExpectedFinalPropertyKey = "color" | "operatingTemperature" | "typeCode";

export interface ExpectedFinalPropertyProfile {
  deviceType: RegExp;
  properties: ExpectedFinalPropertyKey[];
}

export const PROPERTY_ONTOLOGY: CanonicalProperty[] = [
  {
    key: "controlVoltage",
    label: "Control / coil voltage",
    unitKind: "voltage",
    synonyms: [
      /control(?:\s+circuit)?\s+voltage/i,
      /rated\s+control\s+circuit\s+voltage/i,         // ABB RatConCirVol
      /coil\s+voltage/i,
      /\bcoil\b/i,                                    // Eaton (often just "Coil")
      /\bUc\b/,
      /steuerspannung/i,
      /spulenspannung/i,
      /tension\s+(?:de\s+)?(?:commande|bobine)/i,
      /tensione\s+(?:di\s+)?(?:comando|bobina)/i,
      /tensi[óo]n\s+(?:de\s+)?(?:mando|bobina|control)/i,
      /stuurspanning/i,
      /spoelspanning/i,
      /napon\s+(?:upravlj|svitka)/i
    ],
    // Bare "Coil" (Eaton) means coil VOLTAGE; reject other coil specs that carry their own quantity.
    exclude: [/coil\s+(?:resistance|power|consumption|current|data|inrush|pickup|drop[-\s]?out|sealed|terminal)/i]
  },
  {
    key: "ratedVoltage",
    label: "Rated / operational voltage",
    unitKind: "voltage",
    synonyms: [
      /rated\s+(?:operational\s+|maximum\s+|minimum\s+|nominal\s+)?voltage/i,
      /operational\s+voltage/i,
      /operating\s+voltage/i,
      /nominal\s+voltage/i,
      /line\s+voltage/i,
      /supply\s+voltage/i,
      /rated\s+supply\s+voltage/i,                   // Schneider [Us]
      /mains\s+voltage/i,
      /working\s+voltage/i,
      /voltage\s+rating(?:\s*-\s*(?:min|max))?/i,    // Eaton "Voltage rating - max"
      /maximum\s+operating\s+voltage(?:\s+UL\/CSA)?/i,// ABB MaxOpeVolUlCsa
      /rated\s+(?:input|output)\s+voltage/i,         // ABB Rat(Input/Output)Vol
      /(?:input|output)\s+nominal\s+voltage/i,       // Eaton Input/Output nominal voltage
      /(?:input|output)\s+voltage(?:\s+range)?/i,
      /\bUe\b/,
      /\bUn\b/,
      /\bUr\b/,
      /\bUs\b/,
      /\bUb\b/,                                       // Balluff "Operating voltage Ub"
      /\bvoltage\b/i,
      /nennspannung/i,
      /bemessungsspannung/i,
      /betriebsspannung/i,
      /netzspannung/i,
      /versorgungsspannung/i,
      /\bspannung\b/i,
      /tension\s+(?:assign[ée]e|nominale|de\s+service|d['e]alimentation|du\s+r[ée]seau)/i,
      /\btension\b/i,
      /tensione\s+(?:nominale|d['e]esercizio|di\s+alimentazione|di\s+rete)/i,
      /\btensione\b/i,
      /tensi[óo]n\s+(?:nominal|de\s+servicio|de\s+alimentaci[óo]n|de\s+red)/i,
      /\btensi[óo]n\b/i,
      /\bvoltaje\b/i,
      /nominale\s+spanning/i,
      /bedrijfsspanning/i,
      /netspanning/i,
      /\bspanning\b/i,
      /nazivni\s+napon/i,
      /radni\s+napon/i,
      /\bnapon\b/i
    ],
    exclude: [
      /insulation/i, /impulse/i, /surge/i, /withstand/i, /control/i, /coil/i,
      /storage|test|drop|tolerance|range\s+across/i,
      /short[-\s]?circuit|magnetic|tripping/i
    ]
  },
  {
    key: "ratedCurrent",
    label: "Rated / operational current",
    unitKind: "current",
    synonyms: [
      /rated\s+(?:operational\s+|continuous\s+|thermal\s+|maximum\s+|minimum\s+|nominal\s+)?current/i,
      /operational\s+current/i,
      /continuous\s+current/i,
      /continuous\s+operating\s+current/i,             // Rockwell
      /continuous\s+(?:ampere|amp)\s+rating/i,         // Eaton
      /(?:amperage|ampere|amp)\s+rating/i,             // Eaton "Amperage Rating"
      /thermal\s+current/i,
      /conventional\s+(?:free[-\s]?air\s+)?thermal\s+current/i,  // ABB/Schneider ConFreAirTheCur, Ith
      /nominal\s+current/i,
      /nominal\s+(?:input|output)\s+current/i,
      /full[-\s]?load\s+current/i,
      /\bFLA\b/,                                        // Full-load amps
      /line\s+(?:rated\s+)?current/i,
      /base\s+load\s+current/i,                         // Rockwell base load
      // ABB utilization-category currents: AC-1, AC-3, AC-3e, AC-15, AC-21A, AC-22A, AC-23A, DC-1, DC-3, DC-5, DC-13
      /rated\s+operational\s+current\s+(?:AC|DC)[-\s]?\d{1,2}[a-eA-E]?/i,
      /(?:AC|DC)[-\s]?\d{1,2}[a-eA-E]?\s+thermal\s+current/i,
      /\bIn\b/,
      /\bIe\b/,
      /\bIu\b/,
      /\bIth\b/,
      /\bInom\b/i,
      /\bIN\b/,                                          // Phoenix "IN"
      /\bcurrent\b/i,
      /nennstrom/i,
      /bemessungsstrom/i,
      /bemessungsbetriebsstrom/i,                       // Siemens
      /dauerstrom/i,
      /\bstrom\b/i,
      /courant\s+(?:assign[ée]|nominal|d['e]emploi|de\s+service|permanent|thermique)/i,
      /\bcourant\b/i,
      /corrente\s+(?:nominale|d['e]impiego|di\s+servizio|termica)/i,
      /\bcorrente\b/i,
      /corriente\s+(?:nominal|de\s+empleo|de\s+servicio|t[ée]rmica)/i,
      /\bcorriente\b/i,
      /nominale\s+stroom/i,
      /\bstroom\b/i,
      /nazivna\s+struja/i,
      /\bstruja\b/i
    ],
    exclude: [
      /short[-\s]?circuit|breaking|making|interrupt(?:ing)?|inrush|leakage|residual|test|fault/i,
      /tripping|trip\s+current|magnetic/i,
      /transient|prospective/i,
      /consumption|standby|no[-\s]?load/i
    ]
  },
  {
    key: "breakingCapacity",
    label: "Breaking / short-circuit capacity",
    unitKind: "current",
    synonyms: [
      /breaking\s+capacity/i,
      /ultimate\s+(?:breaking|short[-\s]?circuit)\s+(?:capacity|current|breaking\s+capacity)/i,
      /service\s+(?:breaking|short[-\s]?circuit)\s+(?:capacity|current|breaking\s+capacity)/i,
      /rated\s+(?:ultimate|service)\s+short[-\s]?circuit\s+breaking\s+capacity/i,  // ABB RatUltShoCirBreCap, RatSerShoCirBreCap
      /rated\s+short[-\s]?circuit(?:\s+(?:making|breaking|withstand|capacity))?/i,
      /rated\s+short[-\s]?time\s+withstand\s+current/i,                            // ABB RatShoTimWitCur
      /rated\s+conditional\s+short[-\s]?circuit\s+current/i,                       // Eaton/ABB Iq
      /short[-\s]?circuit\s+(?:current|capacity|breaking|withstand|making|rating)/i,
      /short[-\s]?circuit\s+current\s+rating/i,                                    // Rockwell SCCR
      /interrupt(?:ing)?\s+(?:rating|capacity)/i,                                  // Eaton "Interrupt rating"
      /maximum\s+interrupt(?:ing)?\s+rating/i,
      /making\s+capacity/i,
      /energy\s+limiting\s+(?:class|category)/i,                                   // ABB
      /prospective\s+(?:line\s+)?Isc/i,                                            // Schneider
      /\bIcu\b/,
      /\bIcs\b/,
      /\bIcw\b/,
      /\bIcm\b/,
      /\bIq\b/,
      /\bSCCR\b/,
      /\bkAIC\b/i,
      /schaltverm[öo]gen/i,
      /kurzschluss(?:strom|festigkeit|ausschalt(?:verm[öo]gen)?)?/i,
      /bemessungskurzschluss(?:ausschaltverm[öo]gen)?/i,
      /pouvoir\s+de\s+coupure/i,
      /courant\s+de\s+court[-\s]?circuit/i,
      /potere\s+di\s+interruzione/i,
      /corrente\s+di\s+corto/i,
      /poder\s+de\s+corte/i,
      /corriente\s+de\s+cortocircuito/i,
      /uitschakelverm[oö]gen/i,
      /kortsluit(?:vermogen|stroom)/i,
      /prekidna\s+mo[ćc]/i
    ]
  },
  {
    key: "power",
    label: "Power",
    unitKind: "power",
    synonyms: [
      /\bpower\b/i,
      /output\s+power/i,
      /rated\s+power/i,
      /nominal\s+power/i,
      /motor\s+power/i,
      /\bleistung\b/i,
      /nennleistung/i,
      /ausgangsleistung/i,
      /motorleistung/i,
      /\bwattage\b/i,
      /\bpuissance\b/i,
      /puissance\s+(?:nominale|de\s+sortie|moteur)/i,
      /\bpotenza\b/i,
      /potenza\s+(?:nominale|d['e]uscita|motore)/i,
      /\bpotencia\b/i,
      /potencia\s+(?:nominal|de\s+salida|del\s+motor)/i,
      /\bvermogen\b/i,
      /nominaal\s+vermogen/i,
      /uitgangsvermogen/i,
      /\bsnaga\b/i,
      /nazivna\s+snaga/i
    ],
    exclude: [
      /power\s+loss/i, /verlustleistung/i, /power\s+supply/i,
      /power\s+(?:factor|consumption|dissipation|connector|cord|cable|button|switch|input|output\s+type|range|over|on|off|fail)/i,
      /pertes?\s+de\s+puissance/i, /perdita\s+di\s+potenza/i
    ]
  },
  {
    key: "powerLoss",
    label: "Power loss",
    unitKind: "power",
    synonyms: [
      /power\s+loss(?:\s+(?:per\s+pole|at\s+Ie|output\s+capacity))?/i,    // ABB "Power loss at Ie", AAS577 "Power loss output capacity"
      /power\s+dissipation(?:\s+(?:per\s+pole|in\s+W))?/i,                // Schneider "Power dissipation per pole / in W"
      /dissipation\s+power/i,
      /(?:heat|thermal)\s+dissipation/i,
      /static\s+heat\s+dissipation/i,                                     // Eaton "Static heat dissipation, non-current-dependent Pvs"
      /heat\s+dissipation,?\s+non[-\s]?current[-\s]?dependent/i,
      /dissipated\s+power/i,
      /watt\s+loss/i,
      /\bPv\b/,
      /\bPvs\b/,                                                          // Eaton static
      /\bPls\b/,                                                          // current-independent
      /\bPle\b/,                                                          // load-dependent
      /\bPlIp\b/,                                                         // Phoenix
      /verlustleistung/i,
      /w[äa]rmeverlust/i,
      /w[äa]rmeabgabe/i,
      /pertes?\s+(?:de\s+puissance|thermiques?|calorifiques?|joule)/i,
      /dissipation\s+(?:thermique|de\s+chaleur)/i,
      /perdit[ae]\s+(?:di\s+potenza|termich[ae])/i,
      /dissipazione\s+(?:di\s+potenza|termica)/i,
      /p[ée]rdid[ao]s?\s+(?:de\s+potencia|t[ée]rmicas?)/i,
      /disipaci[óo]n\s+(?:de\s+potencia|t[ée]rmica)/i,
      /vermogensverlies/i,
      /warmteafgifte/i,
      /gubitak\s+snage/i,
      /toplinski\s+gubici/i
    ]
  },
  {
    key: "frequency",
    label: "Frequency",
    unitKind: "frequency",
    synonyms: [
      /\bfrequency\b/i,
      /rated\s+frequency/i,
      /line\s+frequency/i,
      /mains\s+frequency/i,
      /supply\s+frequency/i,
      /operating\s+frequency/i,
      /\bfrequenz\b/i,
      /nennfrequenz/i,
      /netzfrequenz/i,
      /\bfr[ée]quence\b/i,
      /\bfrequenza\b/i,
      /\bfrecuencia\b/i,
      /\bfrequentie\b/i,
      /\bfrekvencija\b/i
    ],
    exclude: [/switching|schalt|commutation/i]
  },
  {
    key: "operatingTemperature",
    label: "Operating / ambient temperature",
    unitKind: "temperature",
    synonyms: [
      /(?:operating|operational|ambient|working|surrounding|service|environmental|in[-\s]?use)\s+temperature/i,
      /(?:operating|ambient|surrounding|working|service)\s+air\s+temperature/i,    // Schneider/Rockwell "Ambient air temperature for operation"
      /ambient\s+(?:air\s+)?temperature(?:\s+(?:for\s+operation|in\s+operation))?/i,
      /surrounding\s+air\s+temperature(?:,?\s*(?:min|max))?/i,                      // Rockwell
      /temperature(?:\s*,)?\s+operating/i,                                          // Rockwell "Temperature, Operating"
      /temperature\s+(?:range|in\s+operation|of\s+(?:operation|use))/i,
      /cable\s+temperature,?\s+(?:fixed|flexible)\s+routing/i,                      // Balluff sensor cable
      /umgebungstemperatur/i,
      /betriebstemperatur/i,
      /arbeitstemperatur/i,
      /einsatztemperatur/i,
      /temp[ée]rature\s+(?:de\s+(?:fonctionnement|service|travail)|ambiante|d['e]utilisation)/i,
      /temperatura\s+(?:di\s+(?:funzionamento|esercizio|lavoro)|ambiente|d['e]utilizzo)/i,
      /temperatura\s+(?:de\s+(?:funcionamiento|servicio|trabajo|operaci[óo]n)|ambiente)/i,
      /(?:bedrijfs|omgevings|werk)temperatuur/i,
      /(?:radn|okoli[šs]n)a\s+temperatura/i
    ],
    exclude: [COLOUR_TEMP, /storage|lager|transport|skladi[šs]te|media\s+temperature/i]
  },
  {
    key: "storageTemperature",
    label: "Storage temperature",
    unitKind: "temperature",
    synonyms: [
      /storage\s+temperature/i,
      /temperature\s+for\s+storage/i,                          // Schneider "Ambient Air Temperature for Storage"
      /(?:ambient\s+)?(?:air\s+)?temperature\s+(?:range\s+)?(?:for|during)\s+(?:storage|transport)/i,
      /transport(?:ation)?\s+temperature/i,
      /lagertemperatur/i,
      /transporttemperatur/i,
      /temp[ée]rature\s+(?:de\s+)?(?:stockage|transport|d['e]entreposage)/i,
      /temperatura\s+(?:di\s+)?(?:stoccaggio|magazzino|trasporto|immagazzinamento)/i,
      /temperatura\s+(?:de\s+)?(?:almacenamiento|transporte|almacenaje)/i,
      /opslagtemperatuur/i,
      /transporttemperatuur/i,
      /temperatura\s+skladi[šs]tenja/i
    ]
  },
  {
    key: "weight",
    label: "Weight",
    unitKind: "mass",
    synonyms: [
      /\bweight\b/i,
      /net\s+weight/i,
      /gross\s+weight/i,
      /product\s+(?:net\s+)?weight/i,                           // ABB ProductNetWeight
      /pole\s+net\s+weight/i,                                   // ABB PoleNetWeight (multi-pole device, per pole)
      /package\s+(?:level\s*\d+\s+)?(?:gross|net)\s+weight/i,   // ABB PacLev1GroWei
      /shipping\s+weight/i,
      /est(?:imated)?\.?\s+ship(?:ping)?\s+weight/i,            // SCE
      /\bGEW\b/,                                                // Spelsberg Algolia key
      /\bmass\b/i,
      /\bgewicht\b/i,
      /nettogewicht/i,
      /bruttogewicht/i,
      /\bmasse\b/i,
      /poids\s+(?:net|brut|d['e]exp[ée]dition)?/i,
      /\bpoids\b/i,
      /peso\s+(?:netto|lordo|di\s+spedizione)?/i,
      /\bpeso\b/i,
      /(?:netto|bruto)\s*gewicht/i,
      /te[zž]ina/i,
      /masa\s+(?:neto|bruta|netto|bruto)?/i
    ],
    exclude: [/molecular|atomic|cube\s+weight/i]
  },
  {
    key: "torque",
    label: "Tightening torque",
    unitKind: "torque",
    synonyms: [
      /\btorque\b/i,
      /tightening\s+torque/i,
      /screw\s+torque/i,
      /terminal\s+torque/i,
      /drehmoment/i,
      /anzugsdrehmoment/i,
      /klemmendrehmoment/i,
      /couple\s+de\s+serrage/i,
      /coppia\s+di\s+serraggio/i,
      /par\s+de\s+apriete/i,
      /aandraaikoppel/i,
      /moment\s+pritezanja/i
    ]
  },
  {
    key: "pressure",
    label: "Pressure",
    unitKind: "pressure",
    synonyms: [
      /\bpressure\b/i,
      /operating\s+pressure/i,
      /working\s+pressure/i,
      /nominal\s+pressure/i,
      /\bdruck\b/i,
      /betriebsdruck/i,
      /nenndruck/i,
      /\bpression\b/i,
      /pression\s+(?:de\s+service|nominale|d['e]exercice)/i,
      /\bpressione\b/i,
      /pressione\s+(?:di\s+esercizio|nominale)/i,
      /\bpresi[óo]n\b/i,
      /presi[óo]n\s+(?:de\s+(?:trabajo|servicio)|nominal)/i,
      /\bdruk\b/i,
      /werkdruk/i,
      /\btlak\b/i
    ],
    exclude: [/pressure\s+(?:switch|sensor|transmitter|gauge|drop|loss|compensat|regulator|relief|reducer)/i]
  },
  {
    key: "width",
    label: "Width",
    unitKind: "length",
    synonyms: [
      /\bwidth\b/i,
      /product\s+net\s+width/i,
      /enclosure\s+width/i,
      /outer\s+width/i,
      /\bbreite\b/i,
      /au[ßs]enbreite/i,
      /innenbreite/i,
      /\blargeur\b/i,
      /\blarghezza\b/i,
      /\banchur[ae]\b/i,
      /\bancho\b/i,
      /\bbreedte\b/i,
      /[šs]irina/i
    ]
  },
  {
    key: "height",
    label: "Height",
    unitKind: "length",
    synonyms: [
      /\bheight\b/i,
      /product\s+net\s+height/i,
      /enclosure\s+height/i,
      /outer\s+height/i,
      /overall\s+height/i,
      /\bh[öo]he\b/i,
      /au[ßs]enh[öo]he/i,
      /innenh[öo]he/i,
      /gesamth[öo]he/i,
      /\bhauteur\b/i,
      /\baltezza\b/i,
      /\baltura\b/i,
      /\bhoogte\b/i,
      /visina/i
    ]
  },
  {
    key: "depth",
    label: "Depth / length",
    unitKind: "length",
    synonyms: [
      /\bdepth\b/i,
      /product\s+net\s+depth(?:\s*\/\s*length)?/i,
      /enclosure\s+depth/i,
      /outer\s+depth/i,
      /\btiefe\b/i,
      /au[ßs]entiefe/i,
      /einbautiefe/i,
      /\bprofondeur\b/i,
      /\bprofondit[àa]\b/i,
      /\bprofundidad\b/i,
      /\bdiepte\b/i,
      /dubina/i
    ]
  },
  {
    key: "diameter",
    label: "Diameter",
    unitKind: "length",
    synonyms: [
      /\bdiameter\b/i,
      /outer\s+diameter/i,
      /inner\s+diameter/i,
      /\bbore\b/i,
      /\bdurchmesser\b/i,
      /au[ßs]endurchmesser/i,
      /innendurchmesser/i,
      /\bdiam[èe]tre\b/i,
      /\bdiametro\b/i,
      /\bdi[áa]metro\b/i,
      /promjer/i
    ]
  },
  {
    key: "wallThickness",
    label: "Wall thickness",
    unitKind: "length",
    synonyms: [
      /wall\s+thickness/i,
      /material\s+thickness/i,
      /sheet\s+thickness/i,
      /plate\s+thickness/i,
      /wand(?:st[äa]rke|dicke)/i,
      /materialst[äa]rke/i,
      /blechst[äa]rke/i,
      /[ée]paisseur(?:\s+(?:de\s+(?:paroi|t[ôo]le|mat[ée]riau)))?/i,
      /spessore(?:\s+(?:della\s+parete|del\s+materiale|della\s+lamiera))?/i,
      /espesor(?:\s+(?:de\s+(?:pared|material|chapa)))?/i,
      /(?:wand|plaat|materiaal)dikte/i,
      /debljina\s+(?:stijenke|materijala|lima)/i
    ]
  },
  {
    key: "material",
    label: "Material",
    unitKind: undefined,
    synonyms: [
      /\bmaterial\b/i,
      /housing\s+material/i,
      /enclosure\s+material/i,
      /body\s+material/i,
      /case\s+material/i,
      /case\s+construction/i,
      /\bwerkstoff\b/i,
      /geh[äa]usewerkstoff/i,
      /geh[äa]usematerial/i,
      /\bmat[ée]riau\b/i,
      /mat[ée]riau\s+(?:du\s+)?(?:bo[îi]tier|carter|coffret)/i,
      /\bmateriale\b/i,
      /materiale\s+(?:della\s+)?(?:custodia|involucro|cassa)/i,
      /\bmaterial\s+(?:de\s+(?:la\s+)?(?:caja|carcasa|envolvente))\b/i,
      /materijal/i,
      /materijal\s+ku[ćc]i[šs]ta/i
    ],
    exclude: [/declaration|compliance|rohs|reach|safety\s+data/i]
  },
  {
    key: "color",
    label: "Colour",
    unitKind: undefined,
    synonyms: [
      /\bcolou?r\b/i,
      /housing\s+colou?r/i,
      /\bRAL\s*(?:colou?r|number)?\b/i,
      /\bfarbe\b/i,
      /geh[äa]usefarbe/i,
      /\bboja\b/i,
      /boja\s+ku[ćc]i[šs]ta/i,
      /\bcouleur\b/i,
      /couleur\s+du\s+bo[îi]tier/i,
      /\bcolore\b/i,
      /colore\s+(?:della\s+)?(?:custodia|involucro)/i,
      /\bcolor\b/i,
      /color\s+(?:de\s+(?:la\s+)?(?:caja|carcasa))/i,
      /\bkleur\b/i,
      /behuizingskleur/i
    ],
    exclude: [COLOUR_TEMP, /colou?r\s+(?:code|number|chart|index|space|depth)/i]
  },
  {
    key: "finish",
    label: "Surface finish",
    unitKind: undefined,
    synonyms: [
      /\bfinish\b/i,
      /surface\s+(?:finish|treatment|coating|protection)/i,
      /\bcoating\b/i,
      /paint(?:ing)?\s+(?:type|finish|coating)/i,
      /\bplating\b/i,
      /\bpowder\s*coat/i,
      /ober(?:fl[äa]che|fl[äa]chenbehandlung|fl[äa]chenschutz)/i,
      /beschichtung/i,
      /pulverbeschichtung/i,
      /lackierung/i,
      /finition/i,
      /traitement\s+de\s+surface/i,
      /rev[êe]tement/i,
      /\bfinitura\b/i,
      /trattamento\s+(?:di\s+)?superficie/i,
      /rivestimento/i,
      /\bacabado\b/i,
      /tratamiento\s+(?:de\s+)?superficie/i,
      /recubrimiento/i,
      /afwerking/i,
      /oppervlaktebehandeling/i,
      /coating/i,
      /\bzavr[šs]na\b\s+obrada/i,
      /premaz/i
    ]
  },
  {
    key: "protection",
    label: "Degree of protection (IP/NEMA)",
    unitKind: undefined,
    synonyms: [
      /degree\s+of\s+protection/i,
      /protection\s+(?:class|rating|degree|level|category|type)/i,
      /protective\s+treatment/i,                            // Schneider
      /ingress\s+protection/i,
      /enclosure\s+(?:rating|type|protection)/i,            // Eaton/Rockwell "Enclosure Rating"
      /environmental\s+rating/i,                            // Eaton
      /type\s+rating/i,                                     // Rockwell "Type Rating"
      /climatic\s+withstand/i,                              // Schneider
      /fire\s+resistance/i,                                 // Schneider
      /\bip\s*(?:rating|code|class|degree)?\b/i,
      /\bIP\s*[0-6][0-9]K?\b/,                              // IP54, IP65, IP66K, IP67, IP6X
      /\bIP6[57]\/IP6[89]\b/,                               // composite IP markings (Phoenix style)
      /schutzart/i,
      /schutzklasse/i,
      /schutzart\s*(?:IP|nach)/i,
      /\bnema\s+(?:type|rating|enclosure|\d)/i,
      /\bnema\s*type\s*[1-9][0-9]?[a-zR]?\b/i,              // NEMA Type 4, 4X, 12, 13, 3R
      /\btype\s*[1-9][0-9]?[xrXR]?\b/i,                     // Type 4X, Type 12, Type 3R (US enclosure, case-insensitive)
      /\bUL\s*type\s*\d+[xrXR]?\b/i,
      /indice\s+de\s+protection/i,
      /degr[ée]\s+de\s+protection/i,
      /grado\s+(?:di|de)\s+protezi[óo]n?[e]?/i,
      /beschermingsgraad/i,
      /stupanj\s+za[šs]tite/i,
      /\bza[šs]tita\b/i
    ]
  },
  {
    key: "ikRating",
    label: "Impact protection (IK)",
    unitKind: undefined,
    synonyms: [
      /\bIK\s*(?:rating|code|class)?\b/i,
      /\bIK\d{2}\b/,
      /impact\s+(?:protection|resistance|rating)/i,
      /mechanical\s+impact\s+(?:protection|rating)/i,
      /schlagfestigkeit/i,
      /sto[ßs]festigkeit/i,
      /r[ée]sistance\s+(?:m[ée]canique|aux\s+chocs|aux\s+impacts)/i,
      /resistenza\s+(?:meccanica|agli\s+urti|all['e]impatto)/i,
      /resistencia\s+(?:mec[áa]nica|al\s+impacto|a\s+los\s+impactos)/i,
      /schokbestendigheid/i,
      /otpornost\s+na\s+udar/i
    ]
  },
  {
    key: "poles",
    label: "Number of poles",
    unitKind: undefined,
    synonyms: [
      /number\s+of\s+poles/i,
      /number\s+of\s+protected\s+poles/i,                 // ABB NumProPol
      /poles?\s+description/i,                            // Schneider
      /pole\s+(?:count|number)/i,
      /\bpoles\b/i,
      /\bno\.?\s+of\s+positions\b/i,                      // Phoenix
      /polzahl/i,
      /\bpolig\b/i,
      /anzahl\s+pole/i,
      /nombre\s+de\s+p[ôo]les/i,
      /numero\s+(?:di\s+)?poli/i,
      /n[úu]mero\s+de\s+polos/i,
      /aantal\s+polen/i,
      /broj\s+polova/i
    ]
  },
  {
    key: "certificates",
    label: "Approvals / standards",
    unitKind: undefined,
    synonyms: [
      /\bapprovals?\b/i,
      /approval\s*\/\s*conformity/i,                            // Balluff
      /certificat/i,
      /certifications?/i,
      /product\s+certifications?/i,                             // Schneider
      /compliances?/i,                                          // Eaton "Compliances"
      /\bconformity\b/i,
      /\bstandards?\b/i,
      /standardization\s+body/i,                                // ABB
      /\bnormas?\b/i,
      /\bzulassung\b/i,
      /\bnormen?\b/i,
      /\bmarking\b/i,
      /\bREACH\s+declaration\b/i,                               // ABB REACH Declaration
      /\bRoHS\s+declaration\b/i,                                // ABB RoHS Declaration
      /environmental\s+product\s+declaration|\bEPD\b/i,         // ABB EPD
      /(?:CE|UL|CSA|EAC|RCM|RoHS|REACH|FCC|ATEX|IECEx|UKCA|CCC|UL\s+listed|UL\s+recognized)\s*(?:mark|marking|certification|approval|listed|DOC|scheme)?/i,
      /(?:UK\s+EX|UL\s+listed\s+hazardous|australian\s+RCM|china\s+CCC|morocco\s+DOC)\s*(?:certificate|approval)?/i,
      /homologa(?:tion|ci[óo]n)/i,
      /omologazion[ei]/i,
      /goedkeuring/i,
      /odobrenj[ae]/i
    ]
  },
  {
    key: "typeCode",
    label: "Manufacturer type code",
    unitKind: undefined,
    synonyms: [
      /\btype\s*code\b/i,
      /\bmodel\s*code\b/i,                              // Eaton "Model Code"
      /\bmodellcode\b/i,
      /\bextended\s+product\s+type\b/i,                 // ABB ExtendedProductType
      /\babb\.?type(?:\s+designation)?\b/i,             // ABB.Type / ABB Type Designation
      /global\s+commercial\s+alias/i,                   // ABB GlobalCommercialAlias
      /\btype\s+designation\b/i,
      /typenbezeichnung/i,
      /\bproduct\s+main\s+type\b/i,                     // ABB ProductMainType
      /\bmain\s+type\b/i,
      /\bproduct\s+range\b/i,                           // Schneider
      /\b(?:main|master)\s+range(?:\s+of\s+product)?\b/i,// Schneider Main/Master Range
      /\brange\s+of\s+product\b/i,                      // Schneider
      /product\s+or\s+component\s+type/i,               // Schneider
      /\bdevice\s+short\s+name\b/i,                     // Schneider
      /\bbulletin\b/i,                                  // Rockwell (e.g. "2198", "5069")
      /\bseries\b/i,                                    // Eaton/Balluff
      /\bproduct\s+family\b/i,                          // Rockwell/Balluff
      /\bcatalog(?:ue)?\s+type\b/i,
      /\border\s+(?:type|code)\b/i,                     // Balluff "Order code"
      /bestelltyp/i,
      /\bMLFB\b/i,                                      // Siemens
      /(?:r[ée]f[ée]rence|d[ée]signation)\s+(?:du\s+)?(?:type|mod[èe]le|fabricant)/i,
      /codice\s+(?:tipo|modello|articolo)/i,
      /c[óo]digo\s+(?:de\s+)?(?:tipo|modelo)/i,
      /typecode/i,
      /modelcode/i,
      /[šs]ifra\s+(?:tipa|modela)/i
    ],
    exclude: [
      // Reject the GENERIC "Product type" category label, but NOT ABB's "Extended Product Type"
      // (its real orderable type code) — guarded by a negative lookbehind.
      /(?<!extended\s)\bproduct\s+type\b/i,
      /\boutput\s+type\b/i, /\binput\s+type\b/i,
      // "Series resistance/impedance/..." is an electrical spec, not a product-series identity.
      /series\s+(?:resistance|impedance|inductance|reactance|capacitance|connection|number)/i
    ]
  },
  {
    key: "partNumber",
    label: "Catalog / part number",
    unitKind: undefined,
    synonyms: [
      /\bpart\s*(?:number|no\.?|num)\b/i,
      /\bproduct\s*(?:number|no\.?|id)\b/i,                    // ABB ProductID
      /\bcatalog(?:ue)?\s*(?:number|no\.?|id)\b/i,              // Rockwell/Eaton "Catalog Number"
      /catalog(?:ue)?\s+description/i,                          // ABB CatalogDescription
      /\blong\s+description\b/i,                                // ABB LongDescription
      /\bcommercial\s+reference\b/i,                            // Schneider
      /\bsku\b/i,
      /\bmpn\b/i,
      /\bUPC\b/,                                                // Eaton
      /\barticle\s*(?:number|no\.?)\b/i,
      /\bitem\s*(?:number|no\.?)\b/i,                           // Phoenix
      /\border(?:ing)?\s+(?:number|code|reference|no\.?)/i,
      /unique\s+product\s+identifier/i,                         // Rockwell DPP
      /material\s+short\s+text/i,                               // Siemens API
      /product\s+short\s+text/i,                                // Siemens
      /artikelnummer/i,
      /bestellnummer/i,
      /sachnummer/i,
      /artikel[-\s]?nr\.?/i,                                    // Spelsberg
      /(?:r[ée]f[ée]rence|num[ée]ro)\s+(?:de\s+)?(?:commande|article|produit|catalogue)/i,
      /codice\s+(?:articolo|ordinazione|prodotto)/i,
      /c[óo]digo\s+(?:de\s+)?(?:pedido|art[íi]culo|producto)/i,
      /artikelnummer/i,
      /bestelnummer/i,
      /\bkataloški\s+broj\b/i,
      /(?:broj|šifra)\s+artikla/i
    ]
  },
  {
    key: "ean",
    label: "EAN / GTIN",
    unitKind: undefined,
    synonyms: [
      /\bEAN\b/,
      /\bGTIN\b/,
      /european\s+article\s+number/i,
      /global\s+trade\s+item/i,
      /barcode/i,
      /strichcode/i,
      /code[-\s]?barre/i,
      /codice\s+(?:a\s+)?barre/i,
      /c[óo]digo\s+de\s+barras/i,
      /streepjescode/i,
      /crtični\s+kod/i
    ]
  },
  {
    key: "insulationVoltage",
    label: "Rated insulation voltage",
    unitKind: "voltage",
    synonyms: [
      /(?:rated\s+)?insulation\s+voltage/i,
      /rated\s+insulation/i,
      /\bUi\b/,
      /bemessungsisolationsspannung/i,
      /isolationsspannung/i,
      /BEMISOLATIONSSPAN(?:AC|DC)?/i,                           // Spelsberg AC/DC split
      /tension\s+assign[ée]e\s+d['e]isolement/i,
      /tensione\s+(?:nominale\s+)?(?:di\s+)?isolamento/i,
      /tensi[óo]n\s+(?:nominal\s+)?de\s+aislamiento/i,
      /isolatiespanning/i,
      /napon\s+izolacije/i
    ]
  },
  {
    key: "impulseVoltage",
    label: "Rated impulse withstand voltage",
    unitKind: "voltage",
    synonyms: [
      /(?:rated\s+)?impulse\s+(?:withstand\s+)?voltage/i,
      /rated\s+surge\s+voltage/i,                               // Phoenix
      /\bUimp\b/i,
      /\bUp\b/,                                                 // Phoenix abbreviation
      /impuls(?:steh)?spannung/i,
      /bemessungssto[ßs]spannung/i,
      /tension\s+(?:assign[ée]e\s+)?(?:de\s+tenue\s+aux\s+chocs|de\s+choc)/i,
      /tensione\s+(?:nominale\s+)?(?:di\s+tenuta\s+all['e]impulso|impulsiva)/i,
      /tensi[óo]n\s+(?:nominal\s+)?(?:de\s+impulso|de\s+choque)/i,
      /(?:impuls|stoot)spanning/i,
      /udarni\s+napon/i
    ]
  },
  {
    key: "conductorCrossSection",
    label: "Conductor cross-section",
    synonyms: [
      /conductor\s+cross[-\s]?section/i,
      /cross[-\s]?section/i,
      /wire\s+(?:gauge|size|cross[-\s]?section)/i,
      /cable\s+(?:cross[-\s]?section|size)/i,
      /terminal\s+capacity/i,
      /querschnitt/i,
      /leiterquerschnitt/i,
      /\bsezione\b/i,
      /sezione\s+(?:del\s+)?conduttore/i,
      /section\s+(?:du\s+)?conducteur/i,
      /secci[óo]n\s+(?:del\s+)?conductor/i,
      /(?:ader|leider)doorsnede/i,
      /presjek\s+(?:vodi[čc]a|kabela)/i
    ]
  },
  {
    key: "utilizationCategory",
    label: "Utilization category",
    synonyms: [
      /utili[sz]ation\s+categor/i,
      /(?:AC|DC)[-\s]?\d{1,2}[a-eA-E]?\s*(?:utilization|category)?/i,
      /(?:AC|DC)[-\s]?\d{1,2}[a-eA-E]?\b/,                       // AC-1, AC-3, AC-3e, AC-15, AC-21A, AC-22A, AC-23A, DC-1, DC-3, DC-5, DC-13
      /gebrauchskategorie/i,
      /cat[ée]gorie\s+d['e]emploi/i,
      /categoria\s+d'?\s*(?:impiego|utilizzo)/i,
      /categor[íi]a\s+de\s+(?:empleo|utilizaci[óo]n)/i,
      /gebruikscategorie/i,
      /kategorija\s+upotrebe/i
    ]
  },
  {
    key: "pollutionDegree",
    label: "Pollution degree",
    synonyms: [
      /pollution\s+degree/i,
      /degree\s+of\s+pollution/i,
      /verschmutzungsgrad/i,
      /degr[ée]\s+de\s+pollution/i,
      /grado\s+(?:di|de)\s+(?:inquinamento|contaminaci[óo]n|polluci[óo]n)/i,
      /vervuilingsgraad/i,
      /stupanj\s+one[čc]i[šs][ćc]enja/i
    ]
  },
  {
    key: "mechanicalLife",
    label: "Mechanical life / operating cycles",
    synonyms: [
      /mechanical\s+(?:life|durability|endurance)/i,
      /electrical\s+(?:life|durability|endurance)/i,
      /(?:operating|switching)\s+cycles/i,
      /service\s+life/i,
      /lifecycle/i,
      /schaltspiele/i,
      /mechanische\s+lebensdauer/i,
      /elektrische\s+lebensdauer/i,
      /(?:dur[ée]e\s+de\s+vie|endurance)\s+(?:m[ée]canique|[ée]lectrique)/i,
      /cycles\s+de\s+(?:fonctionnement|man[oœ]uvre)/i,
      /(?:durata|vita)\s+(?:meccanica|elettrica)/i,
      /vita\s+utile/i,
      /(?:duraci[óo]n|vida)\s+(?:mec[áa]nica|el[ée]ctrica)/i,
      /levensduur/i,
      /mehani[čc]ki\s+vijek/i,
      /vijek\s+trajanja/i
    ]
  },
  {
    key: "mtbf",
    label: "MTBF / reliability",
    synonyms: [
      /\bMTBF\b/,
      /\bMTTF\b/,
      /mean\s+time\s+(?:between|to)\s+failure/i,
      /reliability/i,
      /zuverl[äa]ssigkeit/i,
      /fiabilit[ée]/i,
      /affidabilit[àa]/i,
      /fiabilidad/i,
      /betrouwbaarheid/i,
      /pouzdanost/i
    ]
  },
  {
    key: "mountingType",
    label: "Mounting type",
    synonyms: [
      /mounting\s+(?:type|method|style|mode|hardware)/i,        // Eaton "Mounting hardware/Method"
      /(?:fixing|mounting)\s+mode/i,                            // Schneider "Fixing mode"
      /(?:type\s+of\s+)?installation/i,
      /device\s+mounting/i,                                     // Rockwell
      /\bdin[-\s]?rail(?:\s+mount(?:ing)?)?\b/i,
      /top[-\s]?hat\s+rail(?:\s+TH35)?/i,                       // Phoenix/Siemens
      /\bTH35\b/i,
      /\bTS35\b/i,
      /\bEN\s*50022\b/i,
      /\bIEC\s*60715\b/i,
      /symmetric(?:al)?\s+din\s+rail/i,
      /\bNS\s*35\b/i,                                           // Phoenix NS 35/7.5
      /panel\s+mount/i,
      /wall\s+mount/i,
      /surface\s+mount/i,
      /flush\s+mount/i,
      /pole\s+mount/i,
      /PCB\s+mount(?:ing)?/i,
      /through[-\s]?hole\s+mount(?:ing)?/i,
      /snap[-\s]?on\s+mount(?:ing)?/i,
      /screw[-\s]?on\s+mount(?:ing)?/i,
      /rail\s+mount(?:ing)?/i,
      /mounting\s+on\s+standard\s+rails/i,                      // ABB
      /thickness\s+of\s+mounting\s+plate/i,                     // Eaton
      /montageart/i,
      /befestigungsart/i,
      /einbauart/i,
      /hutschiene/i,
      /tragschiene/i,
      /hutschienenmontage/i,
      /tragschienenmontage/i,
      /(?:type|mode)\s+de\s+(?:montage|fixation|installation)/i,
      /tipo\s+(?:di\s+)?(?:montaggio|fissaggio|installazione)/i,
      /tipo\s+de\s+(?:montaje|fijaci[óo]n|instalaci[óo]n)/i,
      /montagewijze/i,
      /(?:vrsta|na[čc]in)\s+monta[zž]e/i
    ]
  },
  {
    key: "mountingPosition",
    label: "Mounting position",
    synonyms: [
      /mounting\s+(?:position|orientation|attitude)/i,
      /einbau(?:lage|position)/i,
      /position\s+de\s+montage/i,
      /posizione\s+(?:di\s+)?montaggio/i,
      /posici[óo]n\s+de\s+montaje/i,
      /montagepositie/i,
      /polo[zž]aj\s+monta[zž]e/i
    ]
  },
  {
    key: "sensingDistance",
    label: "Sensing / operating distance",
    unitKind: "length",
    synonyms: [
      /sensing\s+distance/i,
      /operating\s+distance/i,
      /switching\s+distance/i,
      /detection\s+(?:range|distance)/i,
      /\bSn\b/,
      /schaltabstand/i,
      /erfassungsbereich/i,
      /distance\s+de\s+(?:d[ée]tection|commutation)/i,
      /port[ée]e\s+(?:de\s+)?d[ée]tection/i,
      /distanza\s+di\s+(?:commutazione|rilevamento)/i,
      /portata\s+di\s+rilevamento/i,
      /distancia\s+de\s+(?:conmutaci[óo]n|detecci[óo]n)/i,
      /(?:detectie|schakel)afstand/i,
      /razmak\s+detekcije/i
    ]
  },
  {
    key: "switchingFrequency",
    label: "Switching frequency",
    unitKind: "frequency",
    synonyms: [
      /switching\s+frequency/i,
      /switching\s+rate/i,
      /\bPWM\s+frequency\b/i,
      /schaltfrequenz/i,
      /fr[ée]quence\s+de\s+commutation/i,
      /frequenza\s+di\s+commutazione/i,
      /frecuencia\s+de\s+conmutaci[óo]n/i,
      /schakelfrequentie/i,
      /(?:frekvencija|brzina)\s+sklapanja/i
    ]
  },
  {
    key: "responseTime",
    label: "Response time",
    synonyms: [
      /response\s+time/i,
      /reaction\s+time/i,
      /pickup\s+time/i,
      /operate\s+time/i,
      /release\s+time/i,
      /ansprechzeit/i,
      /reaktionszeit/i,
      /tempo\s+di\s+risposta/i,
      /tempo\s+di\s+reazione/i,
      /tiempo\s+de\s+(?:respuesta|reacci[óo]n)/i,
      /reactietijd/i,
      /vrijeme\s+(?:odziva|reakcije)/i,
      /temps\s+de\s+r[ée]ponse/i
    ]
  },
  {
    key: "repeatAccuracy",
    label: "Repeat accuracy",
    synonyms: [
      /repeat(?:ability)?\s+accuracy/i,
      /repeat\s+accuracy/i,
      /reproducibility/i,
      /wiederholgenauigkeit/i,
      /r[ée]p[ée]tabilit[ée]/i,
      /ripetibilit[àa]/i,
      /repetibilidad/i,
      /herhaalbaarheid/i,
      /ponovljivost/i
    ]
  },
  {
    key: "flowRate",
    label: "Flow rate",
    synonyms: [
      /flow\s+rate/i,
      /volumetric\s+flow/i,
      /air\s*flow/i,
      /mass\s+flow/i,
      /durchfluss(?:menge|rate)?/i,
      /volumenstrom/i,
      /luftstrom/i,
      /\bportata\b/i,
      /portata\s+(?:d['e]aria|volumetrica)/i,
      /d[ée]bit/i,
      /d[ée]bit\s+(?:volumique|massique|d['e]air)/i,
      /caudal/i,
      /caudal\s+(?:de\s+aire|volum[ée]trico|m[áa]sico)/i,
      /(?:lucht|massa|volume)stroom/i,
      /protok/i
    ]
  },
  {
    key: "humidity",
    label: "Operating humidity",
    synonyms: [
      /(?:operating|ambient|relative)\s+humidity/i,
      /humidity\s+range/i,
      /\brel\.?\s+humidity\b/i,
      /\bRH\b/,
      /luftfeuchte/i,
      /luftfeuchtigkeit/i,
      /humidit[ée]\s+(?:relative|ambiante|de\s+fonctionnement)/i,
      /umidit[àa]\s+(?:relativa|ambiente|di\s+esercizio)/i,
      /humedad\s+(?:relativa|ambiente|de\s+funcionamiento)/i,
      /(?:lucht|relatieve)\s*vochtigheid/i,
      /(?:relativna|radna)\s+vlažnost/i
    ]
  },
  {
    key: "altitude",
    label: "Operating altitude",
    unitKind: "length",
    synonyms: [
      /(?:operating|max(?:imum)?|installation)\s+altitude/i,
      /\baltitude\b/i,
      /elevation\s+limit/i,
      /einsatzh[öo]he/i,
      /aufstellungsh[öo]he/i,
      /altitude\s+(?:de\s+(?:fonctionnement|service|installation))?/i,
      /altitudine\s+(?:di\s+esercizio|massima)?/i,
      /altitud\s+(?:de\s+(?:funcionamiento|servicio))?/i,
      /(?:opstellings|installatie)\s*hoogte/i,
      /nadmorska\s+visina/i
    ]
  },
  {
    key: "vibrationResistance",
    label: "Vibration resistance",
    synonyms: [
      /vibration\s+(?:resistance|withstand|rating|test)/i,
      /shock\s+(?:resistance|withstand|rating|test)/i,
      /schwingfestigkeit/i,
      /sto[ßs](?:festigkeit|pr[üu]fung)/i,
      /r[ée]sistance\s+(?:aux\s+)?vibrations/i,
      /r[ée]sistance\s+aux\s+chocs/i,
      /resistenza\s+(?:alle\s+)?vibrazioni/i,
      /resistenza\s+(?:agli\s+)?urti/i,
      /resistencia\s+(?:a\s+las\s+)?vibraciones/i,
      /resistencia\s+(?:a\s+los\s+)?choques/i,
      /trilling(?:s)?bestendigheid/i,
      /schokbestendigheid/i,
      /otpornost\s+na\s+vibracije/i,
      /otpornost\s+na\s+udarce/i
    ]
  },
  {
    key: "noiseLevel",
    label: "Noise level",
    synonyms: [
      /(?:noise|sound)\s+(?:level|pressure|emission|power)/i,
      /acoustic\s+(?:noise|pressure)/i,
      /ger[äa]uschpegel/i,
      /schalldruck(?:pegel)?/i,
      /schalleistung(?:spegel)?/i,
      /niveau\s+(?:sonore|de\s+bruit|acoustique)/i,
      /livello\s+(?:sonoro|di\s+rumore|acustico)/i,
      /nivel\s+(?:sonoro|de\s+ruido|ac[úu]stico)/i,
      /(?:geluids|geluid)(?:niveau|druk)/i,
      /razina\s+(?:buke|zvuka)/i
    ]
  },
  {
    key: "coolingMethod",
    label: "Cooling method",
    synonyms: [
      /cooling\s+(?:method|type|mode|system)/i,
      /(?:forced|natural)\s+(?:air\s+)?cooling/i,
      /\bventilation\b/i,
      /k[üu]hl(?:ung|art|system)/i,
      /(?:m[ée]thode|type|syst[èe]me)\s+de\s+refroidissement/i,
      /(?:metodo|tipo|sistema)\s+di\s+raffreddamento/i,
      /(?:m[ée]todo|tipo|sistema)\s+de\s+refrigeraci[óo]n/i,
      /koel(?:ing|methode|systeem)/i,
      /(?:na[čc]in|tip)\s+hla[đd]enja/i
    ]
  },
  {
    key: "efficiency",
    label: "Efficiency",
    synonyms: [
      /\befficiency\b/i,
      /\beta\b/i,
      /power\s+factor/i,
      /\bcos\s*[φϕp]hi\b/i,
      /wirkungsgrad/i,
      /leistungsfaktor/i,
      /\brendement\b/i,
      /facteur\s+de\s+puissance/i,
      /\brendimento\b/i,
      /fattore\s+di\s+potenza/i,
      /eficiencia/i,
      /factor\s+de\s+potencia/i,
      /efficiency/i,
      /rendement/i,
      /u[čc]inkovitost/i,
      /faktor\s+snage/i
    ]
  },
  {
    key: "silLevel",
    label: "Safety integrity / SIL / PL",
    synonyms: [
      /\bSIL\s*\d?\b/i,
      /safety\s+integrity\s+level/i,
      /\bPL\s*[abcde]?\b/i,
      /performance\s+level/i,
      /\bcategory\s+\d\b/i,
      /\bSILCL\b/i,
      /sicherheits(?:integrit[äa]ts)?(?:stufe|niveau)/i,
      /niveau\s+de\s+performance/i,
      /livello\s+di\s+(?:integrit[àa]\s+)?sicurezza/i,
      /nivel\s+de\s+integridad\s+de\s+seguridad/i,
      /(?:nivo|razina)\s+sigurnosti/i
    ]
  },
  {
    key: "contactConfiguration",
    label: "Contact configuration",
    synonyms: [
      /contact\s+(?:configuration|arrangement|form|type)/i,
      /(?:number|count)\s+of\s+contacts/i,
      /\bNO\s*\/\s*NC\b/,
      /(?:auxiliary\s+)?contact\s+(?:NO|NC)/i,
      /\bform\s+[ABC]\b/,
      /kontaktbest[üu]ckung/i,
      /kontaktanordnung/i,
      /(?:configuration|disposition)\s+(?:des\s+)?contacts/i,
      /configurazione\s+(?:dei\s+)?contatti/i,
      /configuraci[óo]n\s+de\s+contactos/i,
      /contactconfiguratie/i,
      /konfiguracija\s+kontakata/i
    ]
  },
  {
    key: "connectionType",
    label: "Connection type",
    synonyms: [
      /connection\s+(?:type|method)/i,
      /type\s+of\s+connection/i,
      /terminal\s+(?:type|technology)/i,
      /(?:screw|spring|push[-\s]?in|cage|clamp)\s+(?:terminal|connection)/i,
      /anschlussart/i,
      /anschlusstechnik/i,
      /klemmentechnik/i,
      /type\s+de\s+(?:connexion|raccordement|borne)/i,
      /tipo\s+di\s+(?:connessione|collegamento|morsetto)/i,
      /tipo\s+de\s+(?:conexi[óo]n|terminal|borne)/i,
      /aansluittype/i,
      /(?:vrsta|tip)\s+(?:priklju[čc]ka|spoja)/i
    ]
  },
  {
    key: "outputType",
    label: "Output type",
    synonyms: [
      /output\s+type/i,
      /type\s+of\s+output/i,
      /\b(?:PNP|NPN|push[-\s]?pull|open\s+collector|relay)\s+output\b/i,
      /\b(?:analog|analogue|digital)\s+output\b/i,
      /\b4[-\s]?20\s*mA\b/i,
      /\b0[-\s]?10\s*V\b/i,
      /ausgangsart/i,
      /ausgangstyp/i,
      /type\s+de\s+sortie/i,
      /tipo\s+di\s+uscita/i,
      /tipo\s+de\s+salida/i,
      /uitgangstype/i,
      /(?:vrsta|tip)\s+izlaza/i
    ]
  },
  {
    key: "inputType",
    label: "Input type",
    synonyms: [
      /input\s+type/i,
      /type\s+of\s+input/i,
      /\b(?:analog|analogue|digital)\s+input\b/i,
      /\b(?:source|sink)ing\s+input\b/i,
      /eingangsart/i,
      /eingangstyp/i,
      /type\s+d['e]entr[ée]e/i,
      /tipo\s+di\s+ingresso/i,
      /tipo\s+de\s+entrada/i,
      /ingangstype/i,
      /(?:vrsta|tip)\s+ulaza/i
    ]
  },
  {
    key: "tripCharacteristic",
    label: "Trip characteristic / curve",
    unitKind: undefined,
    synonyms: [
      /trip\s+(?:type|curve|characteristic|class)/i,           // Eaton "Trip Type"
      /tripping\s+(?:characteristic|curve|class|element)/i,
      /trip\s+unit\s+type/i,
      /thermal[-\s]?magnetic\s+trip/i,
      /\b(?:B|C|D|K|Z|MA)[-\s]?curve\b/,                       // MCB curves
      /ausl[öo]secharakteristik/i,
      /caract[ée]ristique\s+de\s+d[ée]clenchement/i,
      /caratteristica\s+di\s+intervento/i,
      /caracter[íi]stica\s+de\s+disparo/i,
      /afschakelkarakteristiek/i,
      /karakteristika\s+okidanja/i
    ]
  },
  {
    key: "powerConsumption",
    label: "Power consumption",
    unitKind: "power",
    synonyms: [
      /power\s+consumption(?:,?\s+typical)?/i,                 // Eaton "Power consumption, typical"
      /current\s+consumption(?:\s+max\.?)?/i,                  // Balluff
      /input\s+current(?:\s+max\.?)?/i,                        // Balluff
      /total\s+current(?:\s+max\.?)?/i,
      /no[-\s]?load\s+(?:power|loss)/i,
      /standby\s+(?:power|consumption)/i,
      /quiescent\s+current/i,
      /idle\s+power/i,
      /stromaufnahme/i,
      /leistungsaufnahme/i,
      /consommation\s+(?:de\s+)?(?:puissance|[ée]lectrique|courant)/i,
      /consumo\s+(?:di\s+)?(?:potenza|energia|corrente)/i,
      /consumo\s+(?:de\s+)?(?:potencia|energ[íi]a|corriente)/i,
      /(?:opname|verbruik)/i,
      /potro[šs]nja/i
    ],
    exclude: [/loss/i, /dissipation/i]
  },
  {
    key: "frameSize",
    label: "Frame size",
    unitKind: undefined,
    synonyms: [
      /\bframe\s+size\b/i,                                      // Eaton
      /\bcase\s+size\b/i,
      /\bbreaker\s+frame\b/i,
      /\bbauform\b/i,
      /\bbaugr[öo][ßs]e\b/i,                                    // DE size
      /taille\s+(?:du\s+)?bo[îi]tier/i,
      /grandezza\s+(?:della\s+)?custodia/i,
      /tama[ñn]o\s+(?:de\s+)?(?:la\s+)?carcasa/i
    ]
  },
  {
    key: "displayUnits",
    label: "DIN modules / display units",
    unitKind: undefined,
    synonyms: [
      /\bDIN\s+(?:place\s+)?units\b/i,                          // ABB DIN Place Units
      /\bmodular\s+(?:units|widths?)\b/i,
      /width\s+in\s+modules/i,
      /(?:number\s+of\s+)?modules\b/i,
      /teilungseinheiten/i,
      /modulteilung/i,
      /m[óo]dulos\s+de\s+ancho/i
    ]
  }
];

/**
 * Data-driven final completeness expectations by general device class. These are not
 * manufacturer rules: they say which ontology-backed facts are typically useful enough to
 * trigger one final evidence pass when the device classifier has a confident type.
 */
export const EXPECTED_FINAL_PROPERTY_PROFILES: ExpectedFinalPropertyProfile[] = [
  {
    deviceType: /\b(?:enclosure|cabinet|box|wireway|rack|panel|plate|bracket|cover|door)\b/i,
    properties: ["color", "typeCode"]
  },
  {
    deviceType: /\b(?:sensor|hmi|controller|plc|module|gateway|drive|starter|relay|contactor|switch|breaker|power supply|light|fan|heater|thermostat|conditioner|exchanger)\b/i,
    properties: ["operatingTemperature", "typeCode"]
  }
];

export function expectedFinalPropertiesForDeviceType(deviceType: string | undefined): ExpectedFinalPropertyKey[] {
  if (!deviceType) return [];
  return uniqueStrings(EXPECTED_FINAL_PROPERTY_PROFILES
    .filter((profile) => profile.deviceType.test(deviceType))
    .flatMap((profile) => profile.properties)) as ExpectedFinalPropertyKey[];
}

/** Map any spec label (any supported language) to the canonical property it MEANS. */
export function matchProperty(label: string): CanonicalProperty | undefined {
  if (!label) return undefined;
  let best: { property: CanonicalProperty; score: number } | undefined;
  for (const property of PROPERTY_ONTOLOGY) {
    if (property.exclude?.some((pattern) => pattern.test(label))) continue;
    let matched = 0;
    for (const pattern of property.synonyms) {
      const found = label.match(pattern);
      if (found) matched = Math.max(matched, found[0].length);
    }
    // Most-specific match wins ("control voltage" beats the generic "voltage").
    if (matched > 0 && (!best || matched > best.score)) best = { property, score: matched };
  }
  return best?.property;
}

export interface UnderstoodValue {
  property?: CanonicalProperty;
  quantities: ParsedQuantity[];
}

/** Understand a labelled spec: what property it is + the structured quantity in its value. */
export function understand(label: string, value: string): UnderstoodValue {
  const property = matchProperty(label);
  const quantities = parseQuantities(value, property?.unitKind ? { kind: property.unitKind } : {});
  return { property, quantities };
}

export interface LabelledValue {
  group?: string;
  name: string;
  value: string;
}

/**
 * Self-diagnosis (workstream I): spec attributes whose VALUE contains a recognizable quantity but
 * whose LABEL maps to no known property — i.e. a real knowledge-base gap to teach, not a guess to make.
 */
export function findUnmappedSpecLabels(attributes: LabelledValue[]): string[] {
  const unmapped = new Set<string>();
  for (const attribute of attributes) {
    const label = `${attribute.group ?? ""} ${attribute.name}`.trim();
    if (!label || matchProperty(label)) continue;
    if (parseQuantities(attribute.value).length === 0) continue;
    unmapped.add(attribute.name.trim());
  }
  return [...unmapped];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
