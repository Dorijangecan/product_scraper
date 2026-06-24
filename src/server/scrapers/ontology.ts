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
import { matchTechnicalAttributeAlias } from "./technical-attribute-aliases.js";

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
      /operating\s+voltage\s+range/i,
      /nominal\s+voltage/i,
      /line\s+voltage/i,
      /supply\s+voltage/i,
      /supply\s+voltage\s+range/i,
      /rated\s+supply\s+voltage/i,                   // Schneider [Us]
      /field\s+power\s+voltage\s+range/i,
      /module\s+supply\s+voltage/i,
      /sensor\s+supply\s+voltage/i,
      /auxiliary\s+voltage/i,
      /load\s+voltage/i,
      /mains\s+voltage/i,
      /working\s+voltage/i,
      /(?:min(?:imum)?|max(?:imum)?)\s+(?:rated\s+|operating\s+|supply\s+)?voltage/i,
      /voltage\s+rating(?:\s*-\s*(?:min|max))?/i,    // Eaton "Voltage rating - max"
      /voltage\s+(?:range|rated\s+value|nominal\s+value|limits?)/i,
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
      /\bnapon\b/i,
      /\u7535\u538b/i,
      /\u989d\u5b9a\u7535\u538b/i,
      /\u8f93\u5165\u7535\u538b/i,
      /\u8f93\u51fa\u7535\u538b/i
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
      /nominal\s+load\s+current/i,
      /full[-\s]?load\s+current/i,
      /\bFLA\b/,                                        // Full-load amps
      /line\s+(?:rated\s+)?current/i,
      /load\s+current/i,
      /base[-\s]?load\s+current/i,                      // Rockwell / Siemens drive base-load
      /(?:rated\s+)?uninterrupted\s+current/i,          // ABB Iu
      /rated\s+frame\s+current/i,                        // Schneider Inm
      /continuous\s+(?:rms\s+|output\s+)?current/i,      // ABB/Danfoss drives
      /intermittent\s+(?:output\s+)?current/i,           // Danfoss overload current
      /rated\s+(?:output|input)\s+current/i,             // drives
      /(?:max(?:imum)?\s+)?(?:load|output|operating|continuous)\s+current(?:\s+rating|\s+range)?/i,
      /permissible\s+(?:load\s+)?current/i,
      /current[-\s]?carrying\s+capacity/i,
      /\bcurrent\s+rating\b/i,                            // Littelfuse/Bussmann
      // ABB utilization-category currents: AC-1, AC-3, AC-3e, AC-15, AC-21A, AC-22A, AC-23A, DC-1, DC-3, DC-5, DC-13
      /rated\s+operational\s+current\s+(?:AC|DC)[-\s]?\d{1,2}[a-eA-E]?/i,
      /(?:AC|DC)[-\s]?\d{1,2}[a-eA-E]?\s+thermal\s+current/i,
      /\bIn\b/,
      /\bIe\b/,
      /\bIu\b/,
      /\bIth\b/,
      /\bInm\b/,                                          // Schneider rated frame current
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
      /\bstruja\b/i,
      /\u7535\u6d41/i,
      /\u989d\u5b9a\u7535\u6d41/i,
      /\u8f93\u5165\u7535\u6d41/i,
      /\u8f93\u51fa\u7535\u6d41/i
    ],
    exclude: [
      // \binterrupt avoids matching "unINTERRUPTed current" (ABB Iu), which IS a rated current.
      /short[-\s]?circuit|breaking|making|\binterrupt(?:ing)?|inrush|leakage|residual|test|fault/i,
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
      /(?:ac|dc)\s+interrupt(?:ing)?\s+rating/i,                                   // Littelfuse AC/DC Interrupting Rating
      /interrupt(?:ing)?\s+(?:rating|capacity)/i,                                  // Eaton "Interrupt rating"
      /maximum\s+interrupt(?:ing)?\s+rating/i,
      /rated\s+breaking\s+capacity/i,                                              // Mersen / Schneider Icn
      /rupture\s+capacity/i,                                                       // distributor wording
      /making\s+capacity/i,
      /energy\s+limiting\s+(?:class|category)/i,                                   // ABB
      /prospective\s+(?:line\s+)?Isc/i,                                            // Schneider
      /\bIcu\b/,
      /\bIcs\b/,
      /\bIcw\b/,
      /\bIcm\b/,
      /\bIcn\b/,                                                                   // Schneider rated breaking capacity
      /\bIq\b/,
      /\bSCCR\b/,
      /\bAIC\b/,                                                                   // US Amps Interrupting Capacity
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
      /(?:output|input)\s+power/i,
      /rated\s+(?:output\s+)?power/i,
      /rated\s+output\b/i,                              // WEG "Rated output"
      /nominal\s+power/i,
      /motor\s+power/i,
      /shaft\s+(?:power|output)/i,                       // P2 / shaft power
      /typical\s+shaft\s+output/i,                       // Danfoss
      /\bP2\b/,                                          // shaft power symbol
      /\bPm\b/,                                          // SEW motor power
      /\bP_N\b/,                                         // rated power P_N (underscore form; avoids "PN" pressure)
      /\bleistung\b/i,
      /nennleistung/i,
      /ausgangsleistung/i,
      /motorleistung/i,
      /\bwattage\b/i,
      /\bhorsepower\b/i,
      /\bhp\s+rating\b/i,
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
      /nazivna\s+snaga/i,
      /\u529f\u7387/i,
      /\u989d\u5b9a\u529f\u7387/i,
      /\u8f93\u51fa\u529f\u7387/i
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
      /power\s+loss(?:es)?\s*(?:\[?W\]?)?(?:\s*\/\s*(?:maximum|rated|per\s+pole))?/i,
      /total\s+power\s+loss(?:es)?/i,
      /internal\s+power\s+loss(?:es)?/i,
      /loss\s+power/i,
      /power\s+dissipation(?:\s+(?:per\s+pole|in\s+W))?/i,                // Schneider "Power dissipation per pole / in W"
      /module\s+power\s+dissipation/i,
      /dissipation\s+power/i,
      /(?:heat|thermal)\s+dissipation/i,
      /static\s+heat\s+dissipation/i,                                     // Eaton "Static heat dissipation, non-current-dependent Pvs"
      /heat\s+dissipation,?\s+non[-\s]?current[-\s]?dependent/i,
      /heat\s+(?:loss(?:es)?|generated)/i,
      /dissipated\s+power/i,
      /power\s+dissipated/i,
      /watts?\s+loss(?:es)?/i,
      /\bP(?:_|-)?loss\b/i,
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
      /toplinski\s+gubici/i,
      /\u529f\u8017/i,
      /\u529f\u7387\u635f\u8017/i,
      /\u6563\u70ed/i
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
      /operating\s+pressure(?:\s+range)?/i,
      /working\s+pressure/i,
      /nominal\s+pressure/i,
      /max(?:imum)?\s+(?:operating\s+)?pressure/i,             // SMC/Bürkert
      /min(?:imum)?\s+operating\s+pressure/i,
      /proof\s+pressure/i,                                     // SMC proof
      /burst\s+pressure/i,
      /permissible\s+(?:operating\s+)?pressure/i,              // Rittal "Permissible operating pressure"
      /pressure\s+range/i,
      /\bPN\s*\d+\b/,                                          // nominal pressure designation PN16/PN40
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
      /\bmaterials?\b/i,
      /housing\s+materials?/i,                                  // ifm/SICK plural "Housing materials"
      /enclosure\s+material/i,
      /basic\s+material/i,                                      // Rittal "Basic material"
      /insulating\s+material/i,                                 // WAGO/Phoenix terminal blocks
      /wetted\s+(?:parts?\s+)?materials?/i,                     // E+H/VEGA process "Wetted materials"
      /materials?\s+\(wetted\s+parts?\)/i,
      /material,?\s+wetted\s+parts/i,
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
      /protection\s+category\s+(?:to\s+iec|nema)/i,          // Rittal "Protection category to IEC 60 529"
      /protective\s+(?:treatment|structure)/i,               // Schneider treatment, Omron structure
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
      /\u9632\u62a4\u7b49\u7ea7/i,
      /\u4fdd\u62a4\u7b49\u7ea7/i,
      /\u5916\u58f3\u9632\u62a4/i,
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
      /number\s+of\s+(?:connections?|connection\s+points?|levels?|potentials?|tiers?|positions?)/i, // WAGO/Weidmüller/Phoenix terminal blocks
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
      /(?:rated|nominal)\s+cross[-\s]?section/i,                 // WAGO/Weidmüller "Rated cross-section"
      /(?:solid|stranded|fine[-\s]?stranded|rigid|flexible)\s+conductor/i, // WAGO/Phoenix conductor rows
      /conductor\s+cross[-\s]?section\s+(?:rigid|flexible|solid|stranded|AWG)/i,
      /(?:with|without)\s+ferrule/i,                             // ferrule rows
      /wire\s+(?:gauge|size|range|cross[-\s]?section)/i,         // wire range / AWG
      /\bclamping\s+range\b/i,                                   // terminal clamping range
      /\bAWG(?:\/kcmil)?\b/,                                     // AWG / kcmil
      /cable\s+(?:cross[-\s]?section|size)/i,
      /terminal\s+capacity/i,
      /querschnitt/i,
      /leiterquerschnitt/i,
      /anschlussquerschnitt/i,                                   // Weidmüller
      /nennquerschnitt/i,                                        // rated cross-section DE
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
      /mounting\s+(?:position|orientation|attitude|arrangement)/i,   // WEG "Mounting arrangement"
      /\bIM\s*B\s?\d{1,2}\b/,                                        // IEC mounting designation IM B3/B5/B14
      /\bIM\s*V\s?\d{1,2}\b/,                                        // IM V1/V18 vertical
      /(?:foot|flange)[-\s]?mounted/i,                               // SEW foot/flange
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
      /sensing\s+(?:distance|range)/i,                          // SICK "Sensing range"
      /(?:rated|nominal|real|assured|safe)\s+(?:switching|operating|sensing)\s+(?:distance|range)/i, // Sn/Sr/Sa variants
      /operating\s+(?:distance|range)/i,
      /switching\s+distance/i,
      /scanning\s+range/i,                                      // photoelectric (P+F/SICK)
      /adjustment\s+range/i,
      /detection\s+(?:range|distance)/i,
      /\bSn\b/,
      /\bSa\b/,                                                  // assured/working distance
      /\bSr\b/,                                                  // real sensing distance (ifm)
      /\bSao\b/, /\bSar\b/,                                      // Balluff assured on/off
      /schaltabstand/i,
      /bemessungsschaltabstand/i,                               // P+F rated switching distance
      /realschaltabstand/i,
      /tastweite/i,                                             // SICK photoelectric
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
      /response\s+frequency/i,                                  // Omron's term for switching frequency
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
      /\brepeatability\b/i,                                     // Keyence/Baumer bare "Repeatability"
      /reproducib(?:ility|ilit[àa])/i,                          // SICK "Reproducibility" / IT
      /reproduzierbarkeit/i,                                    // SICK DE
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
    unitKind: "flowRate",
    synonyms: [
      /flow\s+rate/i,
      /(?:standard\s+)?nominal\s+flow(?:\s+rate)?/i,            // Festo "Standard nominal flow rate"
      /volumetric\s+flow/i,
      /air\s*flow/i,
      /air\s+throughput/i,                                      // Rittal "Air throughput"
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
      /\bconnection\b/i,                                        // ifm/Turck/Banner bare "Connection"
      /electrical\s+connection/i,
      /process\s+connection/i,                                  // E+H/VEGA/WIKA process instruments
      /pneumatic\s+connection/i,                                // Festo
      /(?:piping\s+)?port\s+size/i,                             // SMC port size
      /port\s+connection/i,                                     // Bürkert
      /\bM(?:8|12|16|23)\b/,                                    // sensor connector sizes
      /terminal\s+(?:type)/i,
      /(?:screw|spring|push[-\s]?in|cage|clamp)\s+(?:terminal|connection)/i,
      /anschlussart/i,
      /elektrischer\s+anschluss/i,
      /pneumatischer\s+anschluss/i,                             // Festo DE
      /prozessanschluss/i,                                      // E+H DE
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
      /output\s+(?:signal|function|configuration)/i,           // ifm/Turck/E+H/VEGA "Output signal/function"
      /signal\s+output/i,
      /control\s+output/i,                                     // Omron
      /(?:current|voltage|switching)\s+output/i,
      /\bIO[-\s]?Link\b/i,
      /\b(?:PNP|NPN|push[-\s]?pull|open\s+collector|relay)\s+output\b/i,
      /\b(?:analog|analogue|digital)\s+output\b/i,
      /\b4[-\s]?20\s*mA\b/i,
      /\b0[-\s]?10\s*V\b/i,
      /ausgangs(?:art|typ|signal|funktion)/i,
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
    key: "currentConsumption",
    label: "Current consumption / current draw",
    unitKind: "current",
    synonyms: [
      /current\s+consumption(?:\s+max\.?)?/i,
      /operating\s+current\s+consumption/i,
      /(?:input|supply|module|electronics|sensor)\s+current(?:\s+consumption|\s+draw|\s+max\.?|\s+typical)?/i,
      /current\s+draw(?:\s+(?:at|@)\s+\d+\s*V(?:\s*(?:AC|DC))?)?/i,
      /no[-\s]?load\s+current(?:\s+I[o0])?(?:\s+max\.?)?/i,
      /quiescent\s+current/i,
      /idle\s+current/i,
      /standby\s+current/i,
      /stromaufnahme/i,
      /eigenstromaufnahme/i,
      /leerlaufstrom/i,
      /consommation\s+(?:de\s+)?courant/i,
      /courant\s+absorbe/i,
      /consumo\s+(?:di\s+)?corrente/i,
      /corrente\s+assorbita/i,
      /consumo\s+(?:de\s+)?corriente/i,
      /corriente\s+absorbida/i,
      /stroomverbruik/i,
      /stroomopname/i,
      /potrosnja\s+struje/i
    ],
    exclude: [/leakage|residual|fault|short[-\s]?circuit|breaking|interrupt/i]
  },
  {
    key: "powerConsumption",
    label: "Power consumption",
    unitKind: "power",
    synonyms: [
      /power\s+consumption(?:,?\s+typical)?/i,                 // Eaton "Power consumption, typical"
      /no[-\s]?load\s+(?:power|loss)/i,
      /standby\s+(?:power|consumption)/i,
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
  },
  // ── Motors / drives ───────────────────────────────────────────────────────
  {
    key: "ratedSpeed",
    label: "Rated speed",
    synonyms: [
      /rated\s+speed/i,
      /(?:rotational|output|shaft|full[-\s]?load|no[-\s]?load|synchronous|nominal)\s+speed/i,
      /\brpm\b/i,
      /\bmin-?\s?1\b/,                                          // min⁻¹
      /\bn[_\s]?N\b/,                                           // rated speed symbol nN
      /\bna\b\s*\[?r\/min\]?/i,                                 // SEW output speed na
      /nenndrehzahl/i,
      /\bdrehzahl\b/i,
      /vitesse\s+(?:de\s+rotation|nominale)/i,
      /velocit[àa]\s+(?:nominale|di\s+rotazione)/i,
      /velocidad\s+(?:nominal|de\s+rotaci[óo]n)/i,
      /\btoerental\b/i,
      /brzina\s+vrtnje/i
    ],
    exclude: [/sampling|switching|transfer|baud|data|bit|response/i]
  },
  {
    key: "efficiencyClass",
    label: "Efficiency class (IE)",
    synonyms: [
      /efficiency\s+class/i,
      /\bIE[1-5]\b/,                                            // IE1..IE4 (IE5 emerging)
      /\bIE[-\s]?class\b/i,
      /\bIES\d?\b/,                                             // variable-speed efficiency class
      /energieeffizienzklasse/i,
      /wirkungsgradklasse/i,
      /classe\s+de\s+rendement/i,
      /classe\s+di\s+efficienza/i,
      /clase\s+de\s+(?:rendimiento|eficiencia)/i,
      /rendementsklasse/i
    ]
  },
  {
    key: "insulationClass",
    label: "Insulation / thermal class",
    synonyms: [
      /insulation\s+class/i,
      /thermal\s+class(?:ification)?/i,
      /temperature\s+class/i,
      /insulation\s+classification/i,
      /(?:insulating\s+material|insulation)\s+class/i,
      /w[äa]rmeklasse/i,
      /isolier(?:stoff)?klasse/i,
      /isolationsklasse/i,
      /classe\s+(?:d['e]isolation|thermique)/i,
      /classe\s+(?:di\s+)?isolamento/i,
      /clase\s+(?:de\s+)?aislamiento/i,
      /isolatieklasse/i,
      /klasa\s+izolacije/i
    ]
  },
  {
    key: "serviceFactor",
    label: "Service factor",
    synonyms: [
      /\bservice\s+factor\b/i,
      /\bS\.F\.\b/,
      /servicefaktor/i,
      /betriebsfaktor/i,
      /facteur\s+de\s+service/i,
      /fattore\s+di\s+servizio/i,
      /factor\s+de\s+servicio/i
    ]
  },
  {
    key: "dutyType",
    label: "Duty type / cycle",
    synonyms: [
      /duty\s+(?:type|cycle|rating)/i,
      /duty\s+(?:type\s+)?S[1-9]/i,                             // S1/S3/S6
      /cyclic\s+duration\s+factor/i,
      /\b%\s?ED\b/,
      /einschaltdauer/i,
      /betriebsart/i,
      /mode\s+de\s+service/i,
      /tipo\s+di\s+servizio/i,
      /tipo\s+de\s+servicio/i,
      /bedrijfssoort/i,
      /vrsta\s+rada/i
    ]
  },
  {
    key: "momentOfInertia",
    label: "Moment of inertia",
    synonyms: [
      /moment\s+of\s+inertia/i,
      /(?:mass\s+|rotor\s+|external\s+)?inertia\b/i,
      /\bWR2\b/i,
      /tr[äa]gheitsmoment/i,
      /moment\s+d['e]inertie/i,
      /momento\s+d['e]inerzia/i,
      /momento\s+de\s+inercia/i,
      /traagheidsmoment/i,
      /moment\s+tromosti/i
    ]
  },
  {
    key: "gearRatio",
    label: "Gear ratio",
    synonyms: [
      /gear(?:\s+unit)?\s+ratio/i,
      /reduction\s+ratio/i,
      /transmission\s+ratio/i,
      /total\s+ratio/i,
      /[üu]bersetzung(?:sverh[äa]ltnis)?/i,
      /untersetzung/i,
      /rapport\s+de\s+r[ée]duction/i,
      /rapporto\s+di\s+riduzione/i,
      /relaci[óo]n\s+de\s+reducci[óo]n/i,
      /overbrengingsverhouding/i,
      /prijenosni\s+omjer/i
    ]
  },
  {
    key: "lockedRotorCurrentRatio",
    label: "Starting / locked-rotor current ratio",
    synonyms: [
      /locked[-\s]?rotor\s+current/i,
      /starting\s+current(?:\s+ratio)?/i,
      /\bIp\/In\b/i,
      /\bIA\/IN\b/i,
      /anlaufstrom(?:verh[äa]ltnis)?/i,
      /anzugsstrom/i,
      /courant\s+de\s+d[ée]marrage/i,
      /corrente\s+di\s+spunto/i,
      /corriente\s+de\s+arranque/i,
      /aanloopstroom/i,
      /struja\s+pokretanja/i
    ]
  },
  {
    key: "overloadCapability",
    label: "Overload capability",
    synonyms: [
      /overload\s+(?:capability|capacity|torque|current)/i,
      /overloadability/i,
      /[üu]berlast(?:barkeit|f[äa]higkeit|moment)/i,
      /capacit[ée]\s+de\s+surcharge/i,
      /capacit[àa]\s+di\s+sovraccarico/i,
      /capacidad\s+de\s+sobrecarga/i,
      /overbelasting(?:scapaciteit)?/i,
      /preopteret/i
    ]
  },
  // ── Circuit protection / fuses / relays ───────────────────────────────────
  {
    key: "fuseClass",
    label: "Fuse class / operating class",
    synonyms: [
      /\b(?:gG|gL|aM|aR|gR|gPV|gS|aR)\b/,                      // IEC operating classes
      /\bgL\/gG\b/,
      /(?:fuse\s+|operating\s+)?class\s+(?:CC|J|T|RK1|RK5|L|G|H|K5)\b/i, // UL fuse classes
      /operating\s+class/i,
      /fuse\s+class/i,
      /betriebsklasse/i,
      /classe\s+de\s+fusible/i,
      /classe\s+(?:di\s+)?fusibile/i
    ]
  },
  {
    key: "fuseSpeed",
    label: "Fuse speed / acting characteristic",
    synonyms: [
      /(?:super[-\s]?)?(?:quick|fast)[-\s]?acting/i,
      /slow[-\s]?blow/i,
      /time[-\s]?(?:lag|delay)/i,
      /dual[-\s]?element\s+time[-\s]?delay/i,
      /very\s+fast[-\s]?acting/i,
      /tr[äa]ge\b/i,                                            // DE slow
      /flink\b/i,                                              // DE fast
      /mitteltr[äa]ge/i,                                        // DE medium time-lag
      /\b(?:FF|F|T|TT|M)\b\s*(?:characteristic)?/               // Schurter FF/F/T/TT/M
    ]
  },
  {
    key: "ratedResidualCurrent",
    label: "Rated residual current (RCD)",
    synonyms: [
      /rated\s+residual\s+(?:operating\s+)?current/i,
      /residual\s+operating\s+current/i,
      /\bI[ΔdD]n\b/,
      /earth[-\s]?leakage\s+(?:current\s+)?rating/i,
      /bemessungs(?:differenz|fehler)strom/i,
      /courant\s+diff[ée]rentiel\s+(?:assign[ée]|r[ée]siduel)/i,
      /corrente\s+differenziale\s+(?:nominale|residua)/i,
      /corriente\s+diferencial\s+(?:nominal|residual)/i,
      /nazivna\s+diferencijalna\s+struja/i
    ]
  },
  {
    key: "rcdType",
    label: "RCD type",
    synonyms: [
      /\bRCD\s+type\b/i,
      /residual\s+current\s+(?:device\s+)?type/i,
      /\btype\s+(?:AC|A|B|F|B\+|EV)\b\s*(?:RCD|residual|rcbo|rccb)/i,
      /\brcd\s+(?:class|characteristic)\b/i
    ]
  },
  {
    key: "letThroughCurrent",
    label: "Let-through current / I²t",
    synonyms: [
      /(?:peak\s+)?let[-\s]?through\s+current/i,
      /(?:nominal\s+|total\s+|melting\s+|clearing\s+)?I\s?2\s?t/i, // I2t / I²t
      /\bI[²2]t\b/i,
      /durchlassstrom/i,
      /schmelzintegral/i,
      /joule\s+integral/i,
      /\bIp\b\s*(?:let[-\s]?through)?/i
    ]
  },
  {
    key: "switchingCapacity",
    label: "Switching capacity (relay output)",
    synonyms: [
      /switching\s+(?:capacity|power)/i,
      /max(?:imum)?\.?\s+switching\s+(?:voltage|current|power)/i,
      /switching\s+(?:voltage|current)/i,
      /contact\s+rating/i,                                     // relay contact rating
      /schaltleistung/i,
      /schalt(?:spannung|strom)/i,
      /pouvoir\s+de\s+commutation/i,
      /potere\s+di\s+commutazione/i,
      /capacidad\s+de\s+conmutaci[óo]n/i,
      /schakelvermogen/i
    ]
  },
  {
    key: "coilPower",
    label: "Coil power",
    unitKind: "power",
    synonyms: [
      /coil\s+(?:power|consumption|wattage)/i,
      /coil\s+(?:VA|W)\b/,
      /spulenleistung/i,
      /leistungsaufnahme\s+der\s+spule/i,
      /puissance\s+de\s+(?:la\s+)?bobine/i,
      /potenza\s+(?:della\s+)?bobina/i,
      /potencia\s+de\s+(?:la\s+)?bobina/i
    ]
  },
  {
    key: "overvoltageCategory",
    label: "Overvoltage category",
    synonyms: [
      /over[-\s]?voltage\s+categor/i,
      /[üu]berspannungskategorie/i,
      /cat[ée]gorie\s+de\s+surtension/i,
      /categoria\s+di\s+sovratensione/i,
      /categor[íi]a\s+de\s+sobretensi[óo]n/i,
      /overspanningscategorie/i,
      /kategorija\s+prenapona/i
    ]
  },
  // ── Terminal blocks / connection technology ───────────────────────────────
  {
    key: "connectionTechnology",
    label: "Connection technology",
    synonyms: [
      /connection\s+technology/i,
      /\bCAGE\s?CLAMP\b/i,
      /push[-\s]?in(?:\s+CAGE\s?CLAMP)?(?:\s+connection)?/i,
      /\bPUSH[-\s]?X\b/i,
      /tension[-\s]?(?:clamp|spring)(?:\s+connection)?/i,
      /spring[-\s]?cage(?:\s+connection)?/i,
      /spring[-\s]?clamp/i,
      /screw[-\s]?clamp/i,
      /\bIDC\b/,
      /insulation[-\s]?displacement/i,
      /fast[-\s]?on/i,
      /anschlusstechnik/i,
      /(?:zugfeder|federzug|k[äa]figzug)(?:anschluss|klemme)?/i,
      /schraubanschluss/i
    ]
  },
  {
    key: "strippingLength",
    label: "Stripping length",
    unitKind: "length",
    synonyms: [
      /strip(?:ping)?\s+length/i,
      /wire\s+strip\s+length/i,
      /abisolierl[äa]nge/i,
      /longueur\s+(?:de\s+d[ée]nudage|[àa]\s+d[ée]nuder)/i,
      /lunghezza\s+(?:di\s+)?spelatura/i,
      /longitud\s+de\s+pelado/i,
      /striplengte/i,
      /duljina\s+skidanja\s+izolacije/i
    ]
  },
  // ── Enclosure climate (cooling / heating) ─────────────────────────────────
  {
    key: "coolingOutput",
    label: "Cooling output / capacity",
    unitKind: "power",
    synonyms: [
      /(?:total\s+|useful\s+|rated\s+)?cooling\s+(?:output|capacity|power)/i,
      /refrigeration\s+(?:capacity|output)/i,
      /(?:gesamt|nutz)?k[üu]hlleistung/i,
      /puissance\s+frigorifique/i,
      /potenza\s+frigorifera/i,
      /potencia\s+frigor[íi]fica/i,
      /koelvermogen/i,
      /rashladni\s+u[čc]inak/i
    ]
  },
  {
    key: "heatingCapacity",
    label: "Heating capacity",
    unitKind: "power",
    synonyms: [
      /heating\s+(?:capacity|output|power)/i,
      /heater\s+(?:power|output|wattage|rating)/i,
      /heizleistung/i,
      /puissance\s+de\s+chauffage/i,
      /potenza\s+(?:riscaldante|di\s+riscaldamento)/i,
      /potencia\s+(?:calef|de\s+calefacci[óo]n)/i,
      /verwarmingsvermogen/i,
      /u[čc]inak\s+grijanja/i
    ]
  },
  {
    key: "refrigerant",
    label: "Refrigerant",
    synonyms: [
      /\brefrigerant\b/i,
      /\bR[-\s]?\d{2,4}[A-Za-z]?\b/,                            // R-513A, R134a, R410A
      /k[äa]ltemittel/i,
      /fluide\s+frigorig[èe]ne/i,
      /\brefrigerante\b/i,
      /koudemiddel/i,
      /rashladni\s+medij/i
    ]
  },
  {
    key: "gwp",
    label: "Global warming potential",
    synonyms: [
      /\bGWP\b/,
      /global\s+warming\s+potential/i,
      /treibhauspotenzial/i,
      /potentiel\s+de\s+r[ée]chauffement/i,
      /potenziale\s+di\s+riscaldamento\s+globale/i,
      /potencial\s+de\s+calentamiento\s+global/i
    ]
  },
  // ── Pneumatics / fluid ────────────────────────────────────────────────────
  {
    key: "stroke",
    label: "Stroke length",
    unitKind: "length",
    synonyms: [
      /stroke(?:\s+length)?/i,
      /\bhub\b/i,
      /hubl[äa]nge/i,
      /\bcourse\b/i,
      /\bcorsa\b/i,
      /\bcarrera\b/i,
      /\bslag\b/i,
      /\bhod\b/i
    ]
  },
  {
    key: "bore",
    label: "Bore / piston diameter",
    unitKind: "length",
    synonyms: [
      /\bbore(?:\s+(?:size|diameter))?\b/i,
      /piston\s+diameter/i,
      /piston[-\s]?[øo]/i,
      /kolben(?:durchmesser|[-\s]?[øo])/i,
      /\bal[ée]sage\b/i,
      /\balesaggio\b/i,
      /di[áa]metro\s+del\s+pist[óo]n/i,
      /zuiger(?:diameter|[-\s]?[øo])/i,
      /promjer\s+(?:klipa|cilindra)/i
    ]
  },
  {
    key: "flowCoefficient",
    label: "Flow coefficient (Kv/Cv)",
    synonyms: [
      /\bKv(?:s)?(?:[-\s]?(?:value|wert))?\b/i,
      /\bCv(?:[-\s]?value)?\b/,
      /flow\s+coefficient/i,
      /durchflusskoeffizient/i,
      /valeur\s+kv/i,
      /valore\s+kv/i,
      /coeficiente\s+de\s+(?:caudal|flujo)/i
    ]
  },
  {
    key: "orificeSize",
    label: "Orifice / nominal diameter",
    unitKind: "length",
    synonyms: [
      /orifice(?:\s+(?:size|diameter))?/i,
      /nominal\s+diameter\s*(?:DN)?/i,
      /\bDN\s?\d{1,4}\b/,
      /nennweite/i,
      /diam[èe]tre\s+nominal/i,
      /diametro\s+nominale/i,
      /di[áa]metro\s+nominal/i,
      /nominale\s+diameter/i,
      /nazivni\s+promjer/i
    ]
  },
  {
    key: "medium",
    label: "Operating medium / fluid",
    synonyms: [
      /operating\s+medium/i,
      /\bworking\s+fluid\b/i,
      /\bfluid\b/i,
      /\bmedium\b/i,
      /betriebsmedium/i,
      /(?:f[öo]rder|prozess)medium/i,
      /\bfluide\b/i,
      /\bfluido\b/i,
      /\bmedij\b/i
    ],
    exclude: [/medium\s+(?:voltage|time|wave|size|access|temperature)/i, /\bmedium[-\s]?time[-\s]?lag\b/i]
  },
  {
    key: "theoreticalForce",
    label: "Theoretical force",
    synonyms: [
      /theoretical\s+force/i,
      /(?:advancing|retracting|pushing|pulling|actuating|holding)\s+force/i,
      /theoretische\s+kraft/i,
      /force\s+th[ée]orique/i,
      /forza\s+teorica/i,
      /fuerza\s+te[óo]rica/i
    ]
  },
  // ── Process instrumentation / measuring sensors ───────────────────────────
  {
    key: "accuracy",
    label: "Accuracy",
    synonyms: [
      /\baccuracy\b/i,
      /accuracy\s+(?:class|at\s+reference)/i,
      /measured?\s+error/i,
      /measurement\s+error/i,
      /reference\s+accuracy/i,
      /non[-\s]?linearity(?:\s+\(?BFSL\)?)?/i,
      /(?:total\s+)?deviation/i,
      /messabweichung/i,
      /messgenauigkeit/i,
      /genauigkeit/i,
      /\bpr[ée]cision\b/i,
      /\bprecisione\b/i,
      /\bprecisi[óo]n\b/i,
      /nauwkeurigheid/i,
      /to[čc]nost/i
    ],
    exclude: [/repeat|reproducib|wiederhol/i]
  },
  {
    key: "measuringRange",
    label: "Measuring range / span",
    synonyms: [
      /measuring\s+range/i,
      /measurement\s+range/i,
      /\bspan\b/i,
      /full[-\s]?scale(?:\s+value)?/i,
      /measuring\s+span/i,
      /messbereich/i,
      /messspanne/i,
      /plage\s+de\s+mesure/i,
      /campo\s+di\s+misura/i,
      /rango\s+de\s+medici[óo]n/i,
      /meetbereik/i,
      /mjerno\s+podru[čc]je/i
    ]
  },
  {
    key: "turndown",
    label: "Turndown ratio",
    synonyms: [
      /turn[-\s]?down(?:\s+ratio)?/i,
      /\bTD\s+ratio\b/i,
      /adjustment\s+ratio/i,
      /messspannenverh[äa]ltnis/i,
      /rapport\s+de\s+r[ée]glage/i,
      /rapporto\s+di\s+campo/i,
      /relaci[óo]n\s+de\s+ajuste/i
    ]
  },
  {
    key: "resolution",
    label: "Resolution",
    synonyms: [
      /\bresolution\b/i,
      /aufl[öo]sung/i,
      /\br[ée]solution\b/i,
      /\brisoluzione\b/i,
      /\bresoluci[óo]n\b/i,
      /\bresolutie\b/i,
      /\brezolucija\b/i
    ]
  },
  {
    key: "linearity",
    label: "Linearity",
    synonyms: [
      /\blinearity\b/i,
      /linearity\s+error/i,
      /linearit[äa]t(?:sfehler)?/i,
      /lin[ée]arit[ée]/i,
      /linearit[àa]/i,
      /linealidad/i,
      /lineariteit/i,
      /linearnost/i
    ]
  },
  // ── Switching / measuring sensors ─────────────────────────────────────────
  {
    key: "hysteresis",
    label: "Hysteresis",
    synonyms: [
      /\bhysteresis\b/i,
      /\bhysterese\b/i,
      /differential\s+travel/i,                                // Omron's term for hysteresis
      /\bhist[ée]resis\b/i,
      /\bisteresi\b/i,
      /\bhistereza\b/i
    ]
  },
  {
    key: "blindZone",
    label: "Blind zone / dead band",
    unitKind: "length",
    synonyms: [
      /blind\s+(?:zone|spot)/i,
      /dead\s+(?:zone|band)/i,
      /\btotzone\b/i,
      /blindbereich/i,
      /zone\s+morte/i,
      /zona\s+(?:cieca|muerta)/i,
      /dode\s+zone/i,
      /mrtva\s+zona/i
    ]
  },
  {
    key: "correctionFactor",
    label: "Correction / reduction factor",
    synonyms: [
      /correction\s+factor/i,
      /reduction\s+factor/i,
      /korrektur(?:faktor)?/i,
      /reduktionsfaktor/i,
      /facteur\s+de\s+(?:correction|r[ée]duction)/i,
      /fattore\s+di\s+(?:correzione|riduzione)/i,
      /factor\s+de\s+(?:correcci[óo]n|reducci[óo]n)/i,
      /reductiefactor/i
    ]
  },
  {
    key: "voltageDrop",
    label: "Voltage drop",
    unitKind: "voltage",
    synonyms: [
      /voltage\s+drop/i,
      /residual\s+voltage/i,                                   // Omron's term for voltage drop
      /spannungs(?:fall|abfall)/i,
      /chute\s+de\s+tension/i,
      /caduta\s+di\s+tensione/i,
      /ca[íi]da\s+de\s+tensi[óo]n/i,
      /spanningsval/i,
      /pad\s+napona/i
    ]
  },
  {
    key: "leakageCurrent",
    label: "Leakage / off-state current",
    unitKind: "current",
    synonyms: [
      /leakage\s+current/i,
      /off[-\s]?state\s+current/i,
      /residual\s+current/i,                                   // 2-wire sensor leakage (NOT the RCD IΔn)
      /reststrom/i,
      /leckstrom/i,
      /courant\s+de\s+fuite/i,
      /corrente\s+di\s+dispersione/i,
      /corriente\s+de\s+fuga/i,
      /lekstroom/i,
      /struja\s+curenja/i
    ],
    exclude: [/rated\s+residual|differential|fehlerstrom|differenzstrom/i]
  },
  {
    key: "lightDarkOperate",
    label: "Light/dark operate",
    synonyms: [
      /light\s*\/\s*dark\s+(?:operate|switching|on)/i,
      /(?:light|dark)[-\s]?on\b/i,
      /\bL\.?O\.?\s*\/\s*D\.?O\.?\b/,
      /hell[-\s]?dunkel/i,
      /(?:hell|dunkel)schaltung/i
    ]
  }
];

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
    if (matchTechnicalAttributeAlias("global", label, { includeCrossManufacturer: false })) continue;
    if (parseQuantities(attribute.value).length === 0) continue;
    unmapped.add(attribute.name.trim());
  }
  return [...unmapped];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
