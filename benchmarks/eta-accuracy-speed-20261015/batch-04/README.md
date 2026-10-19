# E-T-A cold batch 04

This SKU-only batch contains five product families absent from the prior E-T-A campaign manifests: a rack power monitoring/reporting unit, an automotive thermal circuit protector, a smart power relay, a C14/C20 power-entry module, and a vehicle power-distribution mini module. Novelty was checked against the prior E-T-A batch manifests, benchmark reports, run-item history, and product-alias records.

The manifest requires exact official-page patterns, datasheets, product images, device types, normalized values where the official page supports a clear value, and source attribute assertions. X3120's normalized current retains both C14/C20 ratings with their inlet labels. The MM500 page marks that type discontinued and publishes final-order and final-delivery dates; these lifecycle facts are part of the audit.

## Official source review

- `MRU10`: [E-T-A product page](https://www.e-t-a.com/products/power_management_systems/rack_mount_power_management_systems/p/monitoring_reporting_unit_mru10/) describes a Monitoring & Reporting Unit that processes sensor data from up to ten High Power-D-Boxes. It lists maximum rated voltage DC -80 V, redundant supply, -30 to +60 °C operating temperature, UL, datasheet and operating instructions. It does not publish device current.
- `1610-92`: [E-T-A product page](https://www.e-t-a.com/products/circuit_protection_devices/thermal_overcurrent_circuit_breakers/p/1610_92/) identifies a single-pole automotive thermal circuit protector: DC 12 V, 5–30 A family range, socket mounting and blade terminals. Its 150 A and 2,000 A interrupting capacities are not operating-current values.
- `E-1048-8I`: [E-T-A product page](https://global.e-t-a.com/products/relays_ssrpcs/solid_state_remote_power_controllers/p/e_1048_8i/) describes a remotely controlled smart power relay with electronic overcurrent protection, 1–10 A current variants and 9–32 V operating range for DC 12/24 V loads. The partial family designation does not select one current variant.
- `X3120`: [E-T-A product page](https://www.e-t-a.com/products/circuit_protection_devices/power_entry_modules/p/x3120/) describes a C14/C20 appliance-inlet module combining up to five functions. It lists AC 250 V and distinct 10 A C14 / 16 A C20 inlet ratings. The normalized current keeps both ratings and their inlet contexts rather than choosing one.
- `MM500` (PowerPlex Mini Module): [E-T-A product page](https://www.e-t-a.de/produkte/stromverteilungssysteme/intelligente_stromverteilung/powerplex/produktuebersicht/p/powerplex_mini_modul_mm500/) describes a vehicle power module with eight configurable multifunction inputs, eight dimmable 4 A outputs, 18 A total module current, DC 12/24 V ratings and IP22. The page marks it discontinued, with final order 30 September 2026 and final delivery 29 January 2027. The English `.com` overview URL is indexed but currently returns 404; the live German exact-product page remains the correct route.

## Cold runs and current status

The first batch-04 cold report, before learning direct PDP routes, found 0/5 products. Report: `../../benchmark-report.manufacturer-eta.limit-5.fixtureDir-benchmarks-eta-accuracy-speed-20261015-batch-04.isolatedStorage-1.tag-eta-batch-04-initial-cold-01.json`.

After learning the four live product routes, the latest completed isolated run (`accuracy-run-04`) found and verified MRU10, 1610-92, E-1048-8I, and X3120. Their core scrape times were 1,023 / 668 / 655 / 728 ms. All four passed exact identity, URL, required documents, device type, normalized fields, expected source attributes (re-evaluated against the current manifest), and PDT audit. Wrong products: 0; unproven PDT writes: 0. The fifth item timed out before returning a scrape result; it is not accepted. Report: `../../benchmark-report.manufacturer-eta.limit-5.fixtureDir-benchmarks-eta-accuracy-speed-20261015-batch-04.isolatedStorage-1.tag-eta-batch-04-accuracy-run-04.json`.

For 1610-92, normalization uses the exact datasheet's `5...25 A (medium delay trip curve)` range; the product page's 5–30 A describes the broader family range. E-1048-8I now uses the exact PDF's 1–10 A load-current range instead of its 5 mA maximum analogue-output current. The shared normalizer fix has a focused regression test. X3120 retains the C14 10 A and C20 16 A ratings as labeled contexts.

MM500's exact discontinued-product PDP returned HTTP 200 in an earlier probe, but later cold requests to the PDP, E-T-A's discontinued-products index, and its exact datasheet timed out during connection. The first full batch consequently waited to the 180-second fixture timeout. Learned `eta-product-*` routes now stop after the bounded curl/HTTP attempts instead of entering alternate-UA and 30-second PowerShell retries. A cold, one-item retry ended as a network failure in 16,243 ms; it has no scrape result and is not a passing speed measurement. The focused regression test confirms the PowerShell rescue is skipped for learned exact-product routes. The batch remains unaccepted pending a complete cold rerun when the official host is reachable. The 2.5-second success gate applies to core scrape time; document/PDF/image processing and PDT export remain separately reported.

### Retry after the official host briefly returned HTTP 200

The full five-product rerun (`eta-batch04-after-host-return-01`) passed the exact identity, official URL, documents, device type, expected fields/source attributes, and PDT checks for MRU10, 1610-92, E-1048-8I, and X3120. Their core scrape times were 831 / 679 / 675 / 775 ms; complete item times were 10,276 / 4,246 / 4,527 / 8,958 ms. MM500 still timed out after 180,016 ms, so this run is 4/5 and is not accepted. Report: `../../benchmark-report.manufacturer-eta.limit-5.fixtureDir-benchmarks-eta-accuracy-speed-20261015-batch-04.isolatedStorage-1.tag-eta-batch04-after-host-return-01.json`.

A bounded single-item diagnostic (`eta-mm500-diagnostic-after-host-return-02`) separated the transport behavior: an HTTP HEAD probe returned 200, but the product-page GET could not connect. The scraper's curl-primary attempt timed out after 5,011 ms, then the bounded HTTP attempt returned no exact result; the connector ended in 15,118 ms with no identity, attributes, documents, image, or normalized values. This is a network failure, not a successful core scrape measurement. Report: `../../benchmark-report.manufacturer-eta.limit-1.catalogNumber-MM500.fixtureDir-benchmarks-eta-accuracy-speed-20261015-batch-04.isolatedStorage-1.tag-eta-mm500-diagnostic-after-host-return-02.json`.

The follow-up GET check also failed to connect to the same known-good MRU10, X3120, and E-1048-8I product URLs (4,002–4,016 ms each). This indicates the current access failure spans E-T-A hosts/pages rather than being specific to MM500 parsing. No route, identity, or field rule was weakened; retry the unchanged five-item cold batch after official-page GET requests work again.

### 19 October transport diagnosis

This section records the state before the extraction and official-domain fixes documented below.

The isolated cold batch was repeated after an initial direct MM500 PDP GET returned HTTP 200 in 0.42 s. During the five-product repeat, MRU10, 1610-92, E-1048-8I, and X3120 again passed exact identity, source, required-document, device-type, normalized-field, and PDT checks; their core scrape times were 970 / 867 / 2,421 / 1,241 ms. MM500 then timed out before the connector returned a result, so the run remains 4/5 and has no valid MM500 scrape-time measurement. Report: `../../benchmark-report.fixtureDir-benchmarks-eta-accuracy-speed-20261015-batch-04.isolatedStorage-1.tag-eta-batch04-host-recovery-01.json`.

A cold one-item trace reproduced the transport failure: the learned exact route's bounded curl-first request timed out while connecting after 5,009 ms, followed by the bounded HTTP/curl rescue; the connector returned no identity, fields, documents, or image in 15,099 ms. A subsequent direct probe, both with curl's default headers and with the scraper's Chrome 148 User-Agent and Accept header, also timed out at connection setup. This means the earlier 0.42 s response was transient; it does not establish a User-Agent parser or extraction fault. The repeated attempts target the same official URL and do not improve evidence after a connection-level outage. Trace report: `../../benchmark-report.catalogNumber-MM500.fixtureDir-benchmarks-eta-accuracy-speed-20261015-batch-04.isolatedStorage-1.tag-eta-mm500-isolation-trace-02.json`.

The source itself remains intermittent, so this batch cannot yet be accepted or optimized against the 2.5-second target for all five products. The four passing rows remain valid; MM500 must be cold-rerun when the official GET route is reachable for the full run. No exact-PDP, identity, image, or field gate was relaxed.

### Route check — 19 October 2026

The English `.com` URL appeared in current search results but direct retrieval returned HTTP 404. A fresh fetch of the German `.de` exact-product page succeeded and verified the MM500 identity, technical data, discontinuation dates, and datasheet link. The learned route and expected URL pattern remain on that live German page. At that point the isolated scraper had not yet confirmed identity, image, fields, and PDT output; those gates are covered by the acceptance runs below.

Scraper-side probes on 19 October showed intermittent connection-level failures on that exact `.de` URL: one curl-first request returned HTTP 200, while subsequent attempts ended in `curl 28` after the 2.5-second connect timeout. A bounded curl retry was also tested, but the second connection attempt timed out too; it raised the failure latency to about 12 s without returning product data, so it was rejected. The exact route and strict identity/document gates remain unchanged. The batch stays unaccepted until a cold five-item run passes.

### Accuracy repair and acceptance — 19 October 2026

The successful HTTP 200 capture isolated the actual extraction blockers. ETA labels the linked exact-model PDF `Datenblatt`; the generic classifier returned document type `other`, so the ETA direct-route filter dropped it and the quality gate launched slow broad discovery. The connector now promotes a PDF to `datasheet` only when its URL is under ETA's product-data library and its label or URL contains the exact requested SKU. The German official host `www.e-t-a.de` was also missing from `officialBaseUrls`, causing valid exact PDP evidence to fail the authoritative-source gate. Added that host and the verified PowerPlex Mini Module device-family mapping. The expected source-attribute patterns now match the German PDP's inputs and LOD/LDD labels.

The same five products then passed two isolated cold runs. Each run found 5/5 exact products, official pages, datasheets/images, device types, normalized fields, source attributes, and PDT audits; wrong products and unproven PDT writes were both 0.

| Run | Core scrape mean | Median | Maximum | Full benchmark mean | Full maximum |
|---|---:|---:|---:|---:|---:|
| Cold 01 | 0.925 s | 0.940 s | 1.080 s | 7.754 s | 13.006 s |
| Cold 02 | 0.863 s | 0.846 s | 1.003 s | 7.661 s | 13.578 s |

Every core scrape is below the 2.5-second target. Full benchmark time also includes document downloads, PDF parsing, workbook generation, and PDT export. Reports: [cold 01](report-cold-01.json) and [cold 02](report-cold-02.json).
