# ABB cold batch 04

This isolated batch covers five new ABB device types: a disconnect switch, selector operator, illuminated pushbutton, safety relay, and pilot light. Catalog numbers were checked against prior benchmark history before the run. Each exact product identity and official source was reviewed, and all five downloaded images were visually checked against the product type.

## Product review

| Catalog number | Verified type | Product facts checked against ABB |
| --- | --- | --- |
| `1SCA104811R1001` | Disconnect switch | OT16F3, 3 poles, front operated, DIN-rail/base mount, handle/shaft not included, 16 A at 380–415 V AC in the AC-23A table, IP20, 50 kA conditional short-circuit ratings as fuse/voltage dependent. The normalized voltage/current pair uses one published operating point; it does not combine the independent maximum voltage and current. [ABB product page](https://empower.abb.com/ecatalog/ec/EN_NA/p/1SCA104811R1001) · [ABB OT switch-disconnector catalog](https://library.e.abb.com/public/5406a48c0ae7461cb88eaeb3f73de4d7/Low_OT8GB_1SCC301020C0201_19-05.pdf) |
| `1SFA611202R1102` | Selector switch | M2SS3-11G, two-position momentary with spring return, short green illuminated handle, black plastic bezel, front IP66. ABB identifies it as an operator without a contact block, so no contact voltage/current is invented. [ABB product page](https://empower.abb.com/ecatalog/ec/EN_CA/p/1SFA611202R1102) |
| `1SFA619100R3112` | Pushbutton / operator | CP1-31G-10, momentary flush green illuminated button, chrome-metal bezel, one NO contact. LED supply is 24 V AC/DC; the 300 V insulation rating is not used as the operating voltage. The source also publishes AC-15 and DC-13 contact tables. [ABB product page](https://empower.abb.com/ecatalog/ec/EN_CA/p/1SFA619100R3112) |
| `2TLA010051R0001` | Safety relay | Sentry SSR20P, 3 NO + 1 NC relay outputs, +24 V DC supply, two-hand control, selectable manual/automatic reset, IP20, 120 × 22.5 × 120 mm, and safety ratings up to PL e / SIL 3. [ABB product page](https://empower.abb.com/ecatalog/ec/EN_NA/p/2TLA010051R0001) |
| `1SFA619403R5021` | Pilot light | CL2-502R, red LED pilot-light head, 24 V AC/DC, front IP66/IP67/IP69K and terminal IP20. The page does not publish a standalone operating current or confirmed material value, so those remain blank. [ABB product page](https://empower.abb.com/ecatalog/ec/EN_CA/p/1SFA619403R5021) |

The initial safety-relay candidate `2TLA010033R2000` (BT51) failed the exact-page acquisition gate. I replaced it with the novel, exact ABB-resolvable SSR20P `2TLA010051R0001`; the failed attempt remains in the earlier cold report and is not counted as one of the five accepted devices.

## Shared corrections

- ABB disconnect switches now normalize voltage and current from the same AC-23A operating point. OT16F3 is represented as 16 A at 380–415 V AC, while its other voltage/current combinations remain in the source-backed attributes.
- ABB illuminated command/pilot devices now take their normalized supply voltage from the official `Lamp Type` row, avoiding the contact insulation value in a mixed voltage field.
- Explicit safety-relay wording now outranks a broad control-relay taxonomy label.
- ABB pilot lights require an operating voltage, not a standalone current. A selector operator explicitly published without a contact block does not trigger a fruitless current/voltage fallback. ABB document links remain in the result; when PDF downloads are disabled, complete exact-page results can use the fast path.
- CP1's `Metal` bezel material did not fit the available controlled PDT legend, so the exporter left that cell blank rather than writing a non-enum value. The CL2 page does not publish its exact material, so its profile-critical material field also remains blank.

## Final isolated cold pass

Report: `../../benchmark-report.manufacturer-abb.fixtureDir-benchmarks-abb-accuracy-speed-20261014-batch-04.isolatedStorage-1.tag-final.json`

All five items passed exact identity, official URL, document-link, required-field, device-type, and PDT audit gates. There were no wrong products or unproven written values. The one PDT enum mismatch was safely skipped and left blank.

| Catalog number | Acquisition ms | Total benchmark ms |
| --- | ---: | ---: |
| `1SCA104811R1001` | 2,046 | 3,080 |
| `1SFA611202R1102` | 1,058 | 1,800 |
| `1SFA619100R3112` | 1,147 | 1,912 |
| `2TLA010051R0001` | 1,161 | 1,918 |
| `1SFA619403R5021` | 1,612 | 2,370 |

Acquisition averaged 1,405 ms (median 1,161 ms, maximum 2,046 ms), so all five were below the 2.5-second target on this cold pass. Total time includes workbook and PDT export; its mean was 2,216 ms, median 1,918 ms, and maximum 3,080 ms.

## Verification

- Focused ABB normalization, device-type, and electrical-requirement tests passed: 5 selected cases.
- `npx tsc --noEmit` passed.
- Product image files from the final pass are in `../../output/20261014113349/images/`.
