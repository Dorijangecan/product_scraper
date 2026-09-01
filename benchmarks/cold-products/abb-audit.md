# ABB cold-start audit — 2026-08-31

Every code below was searched before selection and had no hit in prior fixtures, cache or benchmark reports. ABB's official PIS API confirmed the product identity before benchmarking. The final individual re-run was 10/10: `found`, exact identity, official URL, expected device type, document/image requirement and PDT audit all passed.

| Catalog number | Official family / expected type | Extracted identity / type | Official source | Verified extracted data | Documents / image | Final duration | Result / fix |
| --- | --- | --- | --- | --- | --- | ---: | --- |
| 1SBL137001R1310 | AF contactor / Contactor | AF09-30-10-13 / Contactor | https://new.abb.com/products/1SBL137001R1310 | 690 V; IP20 | Datasheet, image | 7,982 ms | Pass |
| 1SAM250000R1011 | MS116 manual motor starter / Motor Circuit Breaker | MS116-16 / Motor Circuit Breaker | https://new.abb.com/products/1SAM250000R1011 | 690 V AC; 16 A; IP20/IP10 | Datasheet, image | 7,622 ms | Pass |
| 1SVR427034R0000 | CP-E power supply / Power Supply | CP-E 24/5.0 / Power Supply | https://new.abb.com/products/1SVR427034R0000 | 24 V DC; 5 A; IP20 | Datasheet, image | 6,251 ms | Pass |
| 1SCA105332R1001 | OT switch-disconnector / Disconnect Switch | OT63F3 / Disconnect Switch | https://new.abb.com/products/1SCA105332R1001 | 750 V; 60 A; IP20 | Datasheet, image | 6,442 ms | Pass |
| 2CDS272001R0064 | S200M MCB / Miniature Circuit Breaker | S202M-C6 / Miniature Circuit Breaker | https://new.abb.com/products/2CDS272001R0064 | 6 A; 400/440 V AC; IP20/IP40 | Datasheet, image | 6,962 ms | Pass |
| 1SFA611199R1190 | MEPY emergency-stop enclosure / Enclosure | MEPY1-1190 / Enclosure | https://new.abb.com/products/1SFA611199R1190 | IP66; material is not published by the official page/datasheet and is left empty | Manual, CAD, certificates, image | 5,905 ms | Enclosure rule added; no guessed material |
| 2CCA183440R0001 | SMISSLINE busbar accessory / Busbar | ZLS918 / Busbar | https://new.abb.com/products/2CCA183440R0001 | 32 A | Datasheet, image | 5,985 ms | Pass |
| 2CSG273095R1000 | Split-core current transformer / Transformer | CT1M-C 100 / Transformer | https://new.abb.com/products/2CSG273095R1000 | 5 A secondary | Manual, certificates, image | 7,124 ms | Pass |
| 1SFA611100R1001 | Modular pushbutton / Pushbutton / Operator | MP1-10R / Pushbutton / Operator | https://new.abb.com/products/1SFA611100R1001 | 230 V; 6 A; plastic; IP66 | Manual, certificates, image | 8,043 ms | Pushbutton precedence fixed |
| 1SAP130300R0271 | AC500 PLC CPU / Programmable Logic Controller | PM573-ETH / Programmable Logic Controller | https://new.abb.com/products/1SAP130300R0271 | 20.4...28.8 V DC; 512 kB; Ethernet, 2x RS232/485, FBP | CE certificate, image | 3,923 ms | ETIM PLC CPU + AC500 rule added |

The unit/parser regression set passed 448 tests after the final change, and TypeScript type checking passed.
