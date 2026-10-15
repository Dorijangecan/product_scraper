# E-T-A cold batch 02

Five new models were selected after checking the prior ETA benchmark manifests, stored ETA run history, and benchmark notes. The batch covers a miniature circuit breaker, switch-mode power supply, battery isolation switch, external alarm I/O module, and high-voltage hybrid relay. The exact-product pages and published data were checked before the cold baseline.

The fixture assertions are in `eta.json`. They check exact official product URL, required datasheet, device type, normalized ratings where the official page publishes them, and source-backed attributes. No current is asserted for E-1073-437 because the official page lists a configurable 40–240 A range and does not identify the current rating from this partial order code. The EAI300 page does not publish a device supply-current rating.

## Official source review

- `4230-T110-K0CE-10A`: the ordering code is given as E-T-A's 4230-T example in the official datasheet. It is a single-pole, 10 A breaker, IEC/EN 60947-2 / UL 1077 version; the source's IEC rating is 240 V AC and 80 V DC for one pole.
- `SMPS-T 10A`: the exact E-T-A page publishes 120–240 V AC rated input (90–264 V input range), 24 V DC output (22–29 V range), 10 A output, DC-OK contact, and a datasheet.
- `E-1073-437`: exact E-T-A product page and datasheet identify a remotely operated battery isolation switch. The page lists a configurable 40–240 A range (up to 350 A optional), 24 V DC, single- or double-pole variants, socket mounting, and screw terminals. Current remains unnormalized because this partial ordering code does not select one rating. The page's image is labeled E-1073-921, so it is excluded as a sibling image; no exact PDP image is claimed.
- `EAI300`: the exact E-T-A page describes an external alarm interface with eight digital inputs, one analog input, two digital outputs, 20–75 V DC nominal supply, and a datasheet.
- `HVR10`: the exact E-T-A page describes a hybrid high-voltage relay with a 900 V DC rating, 300 A continuous current, up to 2,000 A/1,000 V interruption, and a datasheet.

## Cold baseline

Pending first isolated benchmark run.
