# Balluff cold-start audit — 2026-08-31

All ten catalog numbers below are absent from the pre-existing regression fixtures, cached
benchmark inputs, and prior benchmark reports. Each final row was run individually after the
two targeted fixes described below. “Extracted key data” are values from the final generated
workbook; their source URL is the manufacturer PDP or its primary Balluff datasheet.

| Catalog number | Official family / expected type | Extracted type and confirmed identity | Official source | Extracted key data manually compared to source | Documents / image | Final duration | Result |
| --- | --- | --- | --- | --- | --- | ---: | --- |
| BES00TM | Inductive proximity switches / Inductive Proximity Sensor | Inductive Proximity Sensor; BES 516-343-E4-C-03 | https://www.balluff.com/en-gb/products/BES00TM | 10...30 V DC; 200 mA; IP68; 8 x 30 mm; stainless steel | Datasheet + image | 15,818 ms | Pass |
| BOS029M | Diffuse sensors / Photoelectric Sensor | Photoelectric Sensor; BOS R090K-PU-RH10-S75 | https://www.balluff.com/en-gb/products/BOS029M | 10...30 V DC; 100 mA; 10.7 x 43.5 x 19.5 mm; PNP NO/NC | Datasheet + image | 20,351 ms | Pass |
| BCS013E | Capacitive sensors with special properties / Capacitive Sensor | Capacitive Sensor; BCS Z094401-XXS20B-SZ02-T07 | https://www.balluff.com/en-gb/products/BCS013E | IP68; exact product label and capacitive-sensor family | Datasheet + image | 18,090 ms | Pass |
| BIS00Z5 | UHF RFID processors / RFID Device | RFID Device; BIS U-620-068-101-00-S115 | https://www.balluff.com/en-gb/products/BIS00Z5 | 19.2...28.8 V DC; RS232; IP65 | Datasheet + image | 19,485 ms | Pass |
| BVS01EN | 3D Stereo Camera / Vision Sensor | Vision Sensor; BVS 3D-RV1-0124AG-3111ZZ-001 | https://www.balluff.com/en-gb/products/BVS01EN | 22...26 V DC; GigE Vision 2.0; IP54 | Datasheet + image | 41,785 ms | Pass |
| BCC02N2 | Single-ended cordsets / Cable | Cable; BCC M314-0000-10-003-PX0434-020 | https://www.balluff.com/en-gb/products/BCC02N2 | 60 V DC / 60 V AC; 4.0 A; 2 m; IP67/IP69K | Datasheet + image | 18,886 ms | Pass |
| BMF000E | Cylindrical magnetic field sensors / Magnetic Field Sensor | Magnetic Field Sensor; BMF 07M-PS-C-2-KPU-02 | https://www.balluff.com/en-gb/products/BMF000E | 10...30 V DC; 200 mA; IP67; 6.5 x 30.5 mm | Datasheet + image | 18,205 ms | Pass |
| BCM0001 | Condition monitoring sensors / Sensor | Sensor; BCM R15E-001-DI00-01,5-S4 | https://www.balluff.com/en-gb/products/BCM0001 | 18...30 V DC; IO-Link 1.1; IP67/IP68/IP69K; vibration and temperature monitoring | Datasheet + image | 18,025 ms | Pass |
| BAE003E | Control-cabinet power supplies / Power Supply | Power Supply; BAE PS-XA-1W-12-050-002 | https://www.balluff.com/en-gb/products/BAE003E | 85...264 V AC; 5 A; IP20; 40.5 x 90 x 114 mm | Datasheet + image | 21,815 ms | Pass |
| BNI00K5 | EtherCAT network blocks / I/O Module | I/O Module; BNI XG3-508-0C5-R015 | https://www.balluff.com/en-gb/products/BNI00K5 | 18...30.2 V DC; EtherCAT; REST API/MQTT; IP67 | Datasheet + image | 21,196 ms | Pass |

## Reproduced fixes

1. Direct HTTP requests to valid Balluff PDPs returned 403. The connector now makes one bounded
   Playwright attempt against the already exact manufacturer PDP, and stops rather than launching
   unrelated broad discovery if all direct locales are access-blocked.
2. The rendered PDP's final `h2` can be a Livewire status message and a network fragment can have
   the generic title `www.balluff.com`. The parser now prefers the official variant-specific
   `og:title`/`product:plural_title`; a dedicated regression test covers both cases.
3. Condition-monitoring sensors contain a cable/connector description. The classifier now keeps
   the documented condition-monitoring family as `Sensor` instead of misclassifying BCM0001 as a
   connector.

Final focused parser tests, the full Vitest suite, TypeScript check, offline evaluation, and the
existing-manufacturer spec-plausibility gate were run after the final code change. Individual
benchmark reports and generated workbooks remain under `benchmarks/` and `benchmarks/output/`.
