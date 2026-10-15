# Phoenix Contact accuracy and speed batch 02

Five previously untested products across five device types were scraped and checked against their exact Phoenix Contact product pages. The fixture set is in `phoenix.json`; the final isolated cold benchmark report is `../../benchmark-report.manufacturer-phoenix.fixtureDir-benchmarks-phoenix-accuracy-speed-20261014-batch-02.isolatedStorage-1.tag-phoenix-batch-02-final.json`.

## Results

- All five exact products were found; identity, official PDP URL, device type, required image, expected normalized fields, and PDT audit passed for every fixture.
- Wrong products: 0. Unproven PDT writes: 0. Unexplained required-field issues: 0. Four controlled enum cells stayed blank.
- Each downloaded product image was visually checked against its exact model. The 2730077 official page does not publish device dimensions, so dimensions were not expected or inferred.
- The exact signal-conditioner PDP reports an input signal range of ±1 mA. That is not a product operating-current rating. A shared candidate-resolution step had reintroduced it after final normalization; the Phoenix signal-conditioner current exclusion now also applies there. The final report has no normalized `current` for 2811569 while retaining the source row as raw evidence.
- Exact product-detail PDF downloads for four articles returned HTTP 403. This did not affect the required image or exact-PDP checks; other official product documents remained available where listed.

## Products and source checks

| Article | Device type | Official source facts checked |
| --- | --- | --- |
| 0712194 | Circuit Breaker | TCP 1A; 250 V AC / 65 V DC; 1 A; 24.4 × 8.2 × 44.5 mm; IP40 actuator area; −20…60 °C; 10.089 g. [Exact PDP](https://www.phoenixcontact.com/en-us/products/thermal-device-circuit-breakers-tcp-1a-0712194) |
| 2811569 | Signal Conditioner | MACX MCR-UI; supply 24–230 V AC/DC (published range 19.2–253 V AC/DC); 107.9 × 12.5 × 113.7 mm; IP20; −20…70 °C; 150 g. Input signal ±1 mA was not written as operating current. [Exact PDP](https://www.phoenixcontact.com/en-us/products/signal-conditioner-macx-mcr-ui-ui-up-sp-nc-2811569) |
| 2730077 | I/O Module | IBS IP CDIO/R; IP65; 12 digital inputs and 4 digital outputs at 24 V; exact product weight 651 g. The page has no product dimensions. [Exact PDP](https://www.phoenixcontact.com/en-us/products/io-component-ibs-ip-cdior-24-1248-sf-2730077) |
| 1674507 | Power Meter | EEM-XM157; nominal 1 × 230 V AC; direct-measurement current 45 A AC; 118 × 18 × 66 mm; −40…70 °C; 85 g. [Exact PDP](https://www.phoenixcontact.com/en-us/products/measuring-device-eem-xm157-1674507) |
| 3211223 | Terminal Block | PT 2,5-TWIN RD; red; nominal 800 V / 24 A; 60.5 × 5.2 × 35.3 mm; 7.691 g. [Exact PDP](https://www.phoenixcontact.com/en-us/products/multi-conductor-terminal-block-pt-25-twin-rd-3211223) |

## Cold timings

The connector acquisition stage averaged **0.771 s/device** (median 0.729 s, range 0.523–1.047 s), below the 2.5 s target. Full benchmark wall time averaged 17.932 s/device (median 13.366 s, range 1.877–50.541 s), largely due to document retrieval, enrichment, and exports; it is reported separately from scrape acquisition.

The remaining PDT blanks were controlled enum skips, not unsupported values forced into the output. Phoenix Contact now has two accepted five-product batches; continue with another five new device types.
