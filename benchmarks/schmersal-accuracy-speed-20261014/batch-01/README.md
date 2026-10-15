# Schmersal accuracy and speed — batch 01

Status: **complete for the current acceptance metric.** The five products pass exact identity, official PDP, device type, required normalized fields, required datasheet and image, and PDT evidence checks. The core connector scrape is below 2.5 seconds for all five. Datasheet generation and total benchmark time are reported separately because Schmersal's official PDF endpoint adds material latency.

## Selected devices and official PDPs

| Article | Device kind | Exact product page | Accuracy review |
|---|---|---|---|
| 103003590 | AZM400 solenoid interlock | [Schmersal PDP](https://products.schmersal.com/en_US/azm400z-st-1p2p-103003590) | Exact title/article in generated PDF; exact image reviewed. |
| 103014764 | RSS260 RFID safety sensor | [Schmersal PDP](https://products.schmersal.com/en_IO/rss260-i2-lstm12-4-0-25m-as-103014764) | Exact title/article in generated PDF; exact image reviewed. |
| 101163475 | SRB301LC safety relay | [Schmersal PDP](https://products.schmersal.com/en_US/srb301lc-24v-101163475) | Exact title/article in generated PDF; exact image reviewed. |
| 103015124 | PS315 safety limit switch | [Schmersal PDP](https://products.schmersal.com/en_US/ps315-t12-h300-103015124) | Exact title/article in generated PDF; exact image reviewed. |
| 101021009 | EDRR40RT emergency-stop operator | [Schmersal PDP](https://products.schmersal.com/en_GB/edrr40rt-101021009) | Exact title/article in generated PDF; exact image reviewed. |

All five were checked as new against local history, aliases, fixtures, reports and cached URLs. The earlier candidate 103008214 was replaced after its page/image repeatedly resolved to a family or sibling product; 101021009 passed the novelty check before selection.

## Accuracy review

The final isolated report is `../../benchmark-report.fixtureDir-benchmarks-schmersal-accuracy-speed-20261014-batch-01.isolatedStorage-1.tag-post-document-stage-split-accepted.json`. It records 100% exact official URL, device type, required documents, normalized-field and PDT audit matches, zero wrong products, zero unproven PDT writes, and zero unexplained required-field issues. The 11 PDT enum skips remain blank. The report's broader PDT-sheet fixture coverage is 3/41; that corpus-coverage measure is separate from these five products' passing PDT audits.

The downloaded PDFs were parsed and individually checked for both the requested article number and product title:

| Article | Product title in PDF | Article number in PDF | Pages |
|---|---:|---:|---:|
| 103003590 | Yes | Yes | 7 |
| 103014764 | Yes | Yes | 5 |
| 101163475 | Yes | Yes | 7 |
| 103015124 | Yes | Yes | 4 |
| 101021009 | Yes | Yes | 3 |

All five primary images were downloaded from the exact Schmersal PDPs and visually checked in the earlier accuracy review: AZM400 interlock, RSS260 sensor, SRB301LC relay, PS315 roller limit switch and EDRR40RT red emergency-stop operator.

Important values checked against the exact PDP tables:

- AZM400: 764 g; 156.7 × 77.8 × 46.7 mm; 24 V DC; 100 mA no-load current; IP66/IP67; −20…+55 °C.
- RSS260: 83 g; 29.5 × 40 × 18 mm; 18…31.6 V DC; 100 mA; IP65/IP67; −25…+60 °C.
- SRB301LC: 250 g; 100 × 22.5 × 121 mm; 24 V AC / 24 V DC; 6 A relay-output rating; enclosure IP40; −25…+45 °C. Installation-space IP54 and terminal IP20 were excluded from the enclosure rating.
- PS315: 388 g; 137 × 41 × 37 mm; AC-15 240 V AC and DC-13 24 V DC / 3 A; IP66/IP67; −30…+80 °C. The strip/settle length is not treated as a product dimension.
- EDRR40RT: 73 g; 38.5 mm operator diameter; 22.3 mm mounting diameter; anodised aluminium; red; IP65; −25…+75 °C.

## Speed and implementation

The report's `scrapeElapsedMs` is the connector's core acquisition time. In the final cold isolated run it was 1.076–2.219 seconds/device (mean 1.490 s, median 1.348 s), meeting the 2.5-second target for all five.

The official datasheet generator took 1.421–2.922 seconds per product (mean 2.160 s), measured from challenge creation through PDF response buffering. Full benchmark time, including document/image handling and workbook/PDT export, was 4.006–7.584 seconds/device (mean 5.687 s, median 5.828 s). These end-to-end figures remain visible and are not represented as the core scrape time.

To make the timing boundary real, an optional `ManufacturerConnector.enrichDocuments` hook runs after `scrape()` and is forwarded through the lazy connector. Schmersal reuses the exact PDP HTML fetched during the core scrape, parses its product-specific generator payload, then generates the required English datasheet. The `en_IO` official locale is accepted for RSS260. Generated PDF URLs include the article number so document parsing cannot cross-contaminate sibling products.

Validation: `npx tsc --noEmit` passed; the same five-item cold isolated benchmark passed all accuracy gates. No test suite was run.
