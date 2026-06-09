# Understanding Engine — Plan & Progress (handoff for the next agent)

This document is self-contained so another agent (Codex) can continue without prior chat
context. Branch: **`feature/understanding-engine`** (17 commits, NOT merged/rebased).

State at handoff: **497 tests green**, `npx tsc --noEmit` clean, `npm run audit:pdt` exit 0.

## 0. Hard constraints (do not violate)
- Runs **offline on weak PCs for ~15 users, no API key** → **NO runtime LLM/model**.
- **Core directive from the owner:** *"mora znat i razumit — nemoj ga šablonama učit"* =
  build a **general semantic engine + a data-driven KNOWLEDGE BASE** (multilingual dictionary
  of meaning), **NOT per-manufacturer/per-product regex templates**. The Eaton family regexes
  are the anti-pattern; generalize via data, not new scattered regexes.
- **Never hallucinate.** Only write values backed by source/parse. When something can't be
  mapped/understood, **flag it** (self-diagnosis), never guess. Quality bar = "auto + flag uncertain".
- **Discipline:** every change MUST pass `npx tsc --noEmit` AND `npx vitest run` before commit.
  If red → fix or revert, never commit broken. Gold for accuracy = human-filled `primjeri PDTa/`
  (correct but INCOMPLETE — goal is to EXCEED the manual fill, so empty gold cell ≠ "no data").

## 1. Where the "understanding" lives (key files)
| File | Role |
|---|---|
| `src/server/scrapers/quantity.ts` | Quantity grammar: `parseQuantities`, `parseTemperatureRange`, `SANITY_BOUNDS`, `isQuantityPlausible`. Units, ranges, ≤/≥/`<`/`>`/max/min/nominal, alternatives (230/400), AC/DC + tolerance, condition separation ("70 A at 40 °C"), decimal comma. |
| `src/server/scrapers/ontology.ts` | **Knowledge base.** `PROPERTY_ONTOLOGY` (canonical props + EN/DE/FR/IT/ES/NL synonyms + unit kind + look-alike excludes), `matchProperty(label)`, `understand(label,value)`, `findUnmappedSpecLabels` (self-diagnosis). Extend by adding DATA here. |
| `src/server/scrapers/normalizer.ts` | `normalizeFields`; operating-temperature extraction (incl. from prose); multilingual material/colour lexicons (`FOREIGN_MATERIAL_SYNONYMS`, `FOREIGN_COLOR_SYNONYMS`); `ontologyFieldValue` gap-fill (material/colour/finish/protection). |
| `src/server/scrapers/tight-context.ts` | `buildVariantColumnContext` — picks the correct COLUMN for a catalog number in a multi-variant comparison datasheet. |
| `src/server/scrapers/document-enrichment.ts` | Prefers variant-column context, then line-window, then full text. |
| `src/server/scrapers/eaton.ts` | `parseEatonCbeCatalogRecords` (exported) — generic tab-delimited E6 catalog parser, all 1374 variants. |
| `src/server/scrapers/quality-gate.ts` | Records `diagnostics.unmappedSpecLabels` per result. |
| `src/server/pdt/pdt-compare.ts` | `comparePdtValues` — value-level precision (match/mismatch/manual-only/generated-only). |
| `src/server/excel.ts` | "Unmapped Spec Labels" diagnostics column. |
| `scripts/run-manual-pdt-parity.ts` | Live eval: scrape → export PDT → compare vs `primjeri PDTa/` (coverage + precision). **Needs network.** |

## 2. Plan status (workstreams A–K)
- **A** eval — DONE (offline precision comparator + wiring). Live run needs network.
- **B-1** quantity grammar — DONE. **B-2** ontology — DONE (+expanded). **B-4** multilingual lexicons — DONE.
  **B-6** sanity bounds — DONE.
- **B-3** prose mining — PARTIAL (temperature + material from descriptions done; **colour-from-prose NOT** — risks SCE logic, do carefully).
- **B-5** disambiguation — PARTIAL (rated/max/min/nominal, AC/DC, derating-vs-operating done; broader routing partial).
- **B-7** per-fact confidence calibration — NOT done (facts already carry confidence).
- **C** variant-column selection — DONE (conservative; generic non-tab PDF tables still limited).
- **D** real product photo — PARTIAL (schematic/drawing/CAD rejection done; **sharp dimension/aspect ranking + recover-from-candidateUrls + per-scraper generalization NOT done** — needs runtime).
- **E** new types/manufacturers — family prefixes were ALREADY complete in `device-type-families.ts` (do not guess new ones). Self-diagnosis added.
- **F** no-hallucination — sanity + evidence gating + flag done; no separate new "Review report" mechanism.
- **G** Tier-2 LLM hook — NOT done (owner chose no model).
- **H** "like a human" completeness loop (ontology-driven) — **NOT done** (offline-doable, good next).
- **I** self-diagnosis — DONE.
- **J** manufacturer profiles as data — **NOT done** (offline-doable, good next).
- **K** four manufacturers to "perfect":
  - **Eaton** E6 parser — DONE.
  - **ABB** — NOT done: encode colour/material/voltage-type/IP enums (see `src/server/pdt/enum-encode.ts`), datasheet-PDF parse fallback, type code from `ExtendedProductType`. Needs validation.
  - **Rockwell** — typeCode catalog-number fallback already exists; real `-td###.pdf` discovery NOT done (needs network).
  - **Saginaw/SCE** — colour/material/wallThickness already work; structural cabinet flags (doors/locks/mounting/wall-floor) NOT done. NOTE: `findProductImage` keeping a representative series image with a different part number is INTENTIONAL (test `parsers.test.ts`) — do not "tighten" it.

## 3. Do next
**Safe & offline (no network) — recommended order:**
1. **H** — make `src/server/scrapers/final-completeness.ts` ontology-driven: per device type, the
   ontology lists expected fields; if a relevant one is missing, trigger datasheet/other-locale
   acquisition, re-extract, re-check. Extend its field set to temperature/colour/type-code.
2. **J** — move manufacturer label-aliases / table-shapes / image markers into data files
   (partly in `scrapeRecipe`); the place learned rules and new manufacturers land without code.
3. **B-3** colour-from-prose (carefully; keep SCE behaviour), **B-5** broader disambiguation.

**Needs the owner's network / real PDFs / output validation — DO NOT guess values:**
- Live parity run (`scripts/run-manual-pdt-parity.ts --vendor abb|eaton|rockwell|sce`).
- ABB enum-encoding + datasheet-PDF fallback; Rockwell `-td` PDF discovery; D image `sharp` ranking;
  generic (non-tab) PDF table understanding.

## 4. How to teach it more (the right way — knowledge, not templates)
- New property meaning → add to `PROPERTY_ONTOLOGY` (`ontology.ts`) with multilingual synonyms + `unitKind`.
- New unit → `UNIT_TABLE` + `UNIT_PATTERN` (`quantity.ts`), longest token first; add `SANITY_BOUNDS`.
- New material/colour word → `FOREIGN_MATERIAL_SYNONYMS` / `FOREIGN_COLOR_SYNONYMS` (`normalizer.ts`).
- Always add a unit test; run `tsc` + `vitest`.
- **Read the real code/tests before any manufacturer fix** — prior audits were partly inaccurate
  (several "gaps" were already implemented). Verify, don't assume.

## 5. Commits (newest first)
`a5a86c6` excel unmapped-labels · `cca3340` ontology domain props+ES/NL · `1ae725c` disambiguation tests ·
`ac14aba` lexicon FR/IT · `47db08e` grammar units + `<`/`>` · `03da2e1` ontology gap-fill ·
`499a47f` ontology +7 props · `f181872` self-diagnosis · `2c9e437` ontology · `28323e7` Eaton E6 1374 ·
`be80e9c` eval precision · `c29b668` variant column · `13cfee5` temp prose · `cd1d301` sanity ·
`c509f5b` image schematic-reject · `97e4e5d` multilingual material/colour · `c02adc6` quantity grammar.
