import { describe, expect, it } from "vitest";
import {
  isForeignVariantOptionValue,
  isPlausibleSpecLabel,
  isPlausibleSpecPair,
  isPlausibleSpecValue,
  looksLikeHeaderRowValue
} from "../src/server/scrapers/spec-plausibility.js";

/**
 * Every rejection case below is a value this scraper really produced from a real vendor document
 * (see fixtures/ and the cold-start plan). Every acceptance case is a real specification that must
 * survive the gate — those matter more: dropping a real value is worse than keeping some noise.
 */
describe("isPlausibleSpecValue — rejects", () => {
  it("control-character garbage from a PDF whose font cmap does not decode", () => {
    expect(isPlausibleSpecValue(" PP")).toBe(false);
  });

  it("table-of-contents dot leaders", () => {
    expect(isPlausibleSpecValue(". . . . . . . . . . . . . . . . . . . 4")).toBe(false);
    expect(isPlausibleSpecValue("......... 12")).toBe(false);
  });

  it("inline CSS that leaked out of a style block", () => {
    expect(isPlausibleSpecValue("normal !important;")).toBe(false);
    expect(isPlausibleSpecValue("font-size: 14px;")).toBe(false);
  });

  it("a CSS declaration remainder left after the property name was split off", () => {
    for (const value of ["1em;", "1.1em;", "80px;", "left;", "right;", "both;", "none;", "normal;"]) {
      expect(isPlausibleSpecValue(value), value).toBe(false);
    }
  });

  it("keeps a real value whose table cell happens to end in a semicolon", () => {
    // Caught by the audit over real vendor documents: rejecting every trailing semicolon threw away
    // a published rating.
    expect(isPlausibleSpecValue("AC 100 V; 120 V; 230/240 V (50/60 Hz);")).toBe(true);
    expect(isPlausibleSpecValue("IP66; IP69K;")).toBe(true);
  });

  it("a bare function word", () => {
    expect(isPlausibleSpecValue("and")).toBe(false);
    expect(isPlausibleSpecValue("of")).toBe(false);
    expect(isPlausibleSpecValue("und")).toBe(false);
  });

  it("page footers and imprint lines", () => {
    expect(isPlausibleSpecValue("© 2018 Hoffman Enclosures Inc. PH 763 422 2211 • nVent.com/HOFFMAN")).toBe(false);
  });

  it("installation instructions — an instruction is never a specification", () => {
    expect(isPlausibleSpecValue("The temperature control should only be installed by qualified")).toBe(false);
    expect(isPlausibleSpecValue("against incidental contact is to be ensured")).toBe(false);
    expect(isPlausibleSpecValue("Der Anschluss darf nur durch Fachpersonal erfolgen")).toBe(false);
  });

  it("severed sentence halves", () => {
    expect(isPlausibleSpecValue("current) as stated on the")).toBe(false);
    expect(isPlausibleSpecValue("drop or power failure. When the")).toBe(false);
  });

  it("a clause cut mid-bracket", () => {
    expect(isPlausibleSpecValue("Certificate LCIE (Laboratoire Central des Industries, File No. E249700, Listed")).toBe(false);
  });

  it("a complete prose sentence", () => {
    expect(isPlausibleSpecValue("Catalog numbers ending with “C” are Celsius Thermostat Controllers.")).toBe(false);
  });
});

describe("isPlausibleSpecValue — keeps real specifications", () => {
  it("keeps terse values", () => {
    for (const value of ["IP20", "B", "M8", "2P", "6 kA", "230/400 V", "50/60 Hz", "2.5 Nm", "-25 °C to 70 °C"]) {
      expect(isPlausibleSpecValue(value), value).toBe(true);
    }
  });

  it("rejects a bare dash, consistently with the existing not-available sentinel", () => {
    // generic.ts's isAvailableSpecValue already treats "-" / "n/a" / "none" as "the vendor did not
    // state this", so the plausibility gate must agree rather than reintroduce it as a value.
    expect(isPlausibleSpecValue("-")).toBe(false);
    expect(isPlausibleSpecValue("—")).toBe(false);
  });

  it("keeps a value whose unit collides with a function word", () => {
    // "A" (ampere) vs the article "a", "in" (inch), "F"/"K" (temperature). The audit over real vendor
    // documents caught the gate dropping these, so they are pinned.
    expect(isPlausibleSpecValue("Current rating range 0.1...20 A")).toBe(true);
    expect(isPlausibleSpecValue("Overall depth 2.64 in")).toBe(true);
    expect(isPlausibleSpecValue("Control range 40 to 140 F")).toBe(true);
  });

  it("keeps multi-value and qualified values", () => {
    expect(isPlausibleSpecValue("1 A, 3 A, 6 A, 8 A, 10 A")).toBe(true);
    expect(isPlausibleSpecValue("max. 5 A")).toBe(true);
    expect(isPlausibleSpecValue("CE, REACH, RoHS, CCC")).toBe(true);
    expect(isPlausibleSpecValue("1 x 25 / 2 x 10 mm²")).toBe(true);
  });

  it("keeps non-numeric material and finish values", () => {
    expect(isPlausibleSpecValue("stainless steel")).toBe(true);
    expect(isPlausibleSpecValue("powder coated, RAL 7035")).toBe(true);
  });
});

describe("isPlausibleSpecLabel", () => {
  it("rejects a sentence masquerading as a label", () => {
    expect(isPlausibleSpecLabel("The safety and protection")).toBe(false);
    expect(isPlausibleSpecLabel("The technical specifications (voltage and")).toBe(false);
    expect(isPlausibleSpecLabel("© 2018 Hoffman Enclosures Inc.")).toBe(false);
    expect(isPlausibleSpecLabel("For the protection of the")).toBe(false);
  });

  it("rejects an unbalanced bracket", () => {
    expect(isPlausibleSpecLabel("Interrupting capacity (UL")).toBe(false);
  });

  it("keeps a bare single-letter column header even though it case-folds to an English determiner", () => {
    // Real Saginaw/SCE floor-stand-kit ordering table columns are literally "A" and "B" (dimension
    // letters). stripEdgePunctuation lowercases before the determiner check, so "A" alone used to
    // collide with the "a"/"the"/... leading-determiner rejection meant for severed sentences like
    // "The safety and protection" — a genuine one-word label was never the case that rule targeted.
    for (const label of ["A", "B", "a", "The"]) {
      expect(isPlausibleSpecLabel(label), label).toBe(true);
    }
    // Two words starting with the same determiner is still the real severed-sentence shape.
    expect(isPlausibleSpecLabel("A remote")).toBe(false);
  });

  it("keeps abbreviated labels — an abbreviation's period is not a sentence end", () => {
    // Saginaw's published weight label is literally "Est. Ship Weight". Treating that period as a
    // sentence boundary dropped the weight from the generic extraction path entirely.
    for (const label of [
      "Est. Ship Weight",
      "Approx. Weight",
      "Max. Cont. Current",
      "No. of Poles",
      "Temp. Range",
      "Ref. No."
    ]) {
      expect(isPlausibleSpecLabel(label), label).toBe(true);
    }
  });

  it("still rejects a real sentence boundary", () => {
    expect(isPlausibleSpecLabel("Suitable for outdoor use. Rated current")).toBe(false);
    expect(isPlausibleSpecLabel("Do not install indoors. Weight")).toBe(false);
  });

  it("rejects CSS properties and DOM data hooks that arrive as labels", () => {
    // `<header data-height-onload="30">` reaches mining as `height-onload` = `30`, and that is how
    // "H 30" was exported as a Saginaw enclosure's dimensions.
    for (const label of ["height-onload", "height-percentage", "line-height", "max-height", "text-align", "white-space", "-webkit-box-shadow"]) {
      expect(isPlausibleSpecLabel(label), label).toBe(false);
    }
    // Hyphenated real labels must survive — German vendors write them all the time.
    for (const label of ["Nenn-Spannung", "Schutz-Art", "wall-thickness"]) {
      expect(isPlausibleSpecLabel(label), label).toBe(true);
    }
  });

  it("keeps ordinary labels, including ones ending in a unit", () => {
    for (const label of [
      "Rated current",
      "Rated voltage Un",
      "Casing protection degree",
      "Allowable ambient temperature range",
      "Dimensions (mm)",
      "Weight in kg",
      "Unit per package",
      "Bemessungsstrom",
      "Corrente nominale",
      "• Certifications:"
    ]) {
      expect(isPlausibleSpecLabel(label), label).toBe(true);
    }
  });
});

describe("looksLikeHeaderRowValue", () => {
  const KNOWN = new Set(["rated current", "part number", "article number", "unit per package", "description", "weight"]);
  const isKnown = (candidate: string): boolean => KNOWN.has(candidate.trim().toLowerCase());

  it("detects a pipe/tab separated header row", () => {
    expect(looksLikeHeaderRowValue("Part number | Article number | Unit per package", isKnown)).toBe(true);
  });

  it("detects a header row whose separators were collapsed to spaces", () => {
    // pdf-parse and the DOM sweeps both do this, so the cell split alone finds one cell.
    expect(looksLikeHeaderRowValue("Rated current In (A) Part number Article number Unit per package", isKnown)).toBe(true);
  });

  it("does not treat real data as a header row", () => {
    expect(looksLikeHeaderRowValue("1 E6-1/1/B CBE03319 12", isKnown)).toBe(false);
    expect(looksLikeHeaderRowValue("230/400 V", isKnown)).toBe(false);
    expect(looksLikeHeaderRowValue("Weight 1.5 kg", isKnown)).toBe(false);
  });

  it("accepts two cells when the separator is explicit, but needs three when it is not", () => {
    // An explicit "|" or tab IS the evidence that this was a row of cells, so two known labels are
    // enough. Space-collapsed text has no such evidence, so segmentation demands three labels before
    // it will call something a header — otherwise an ordinary two-word phrase could qualify.
    expect(looksLikeHeaderRowValue("Weight | Description", isKnown)).toBe(true);
    expect(looksLikeHeaderRowValue("Weight Description", isKnown)).toBe(false);
    expect(looksLikeHeaderRowValue("Description", isKnown)).toBe(false);
  });
});

describe("isPlausibleSpecPair", () => {
  it("requires both halves", () => {
    expect(isPlausibleSpecPair("Rated current", "16 A")).toBe(true);
    expect(isPlausibleSpecPair("The safety and protection", "16 A")).toBe(false);
    expect(isPlausibleSpecPair("Rated current", "and")).toBe(false);
  });
});

describe("looksLikeHeaderRowValue — shortest-match segmentation", () => {
  /**
   * The vocabulary predicates (ontology matchProperty, alias tables) match a label ANYWHERE inside the
   * candidate. This stub reproduces that, which is what makes the match order load-bearing.
   */
  const LABELS = ["rated current", "part number", "article number", "unit per package"];
  const containsLabel = (candidate: string): boolean => {
    const text = candidate.trim().toLowerCase();
    return LABELS.some((label) => text.includes(label)) || text === "in";
  };

  it("segments a space-collapsed header row whose cells the vocabulary matches loosely", () => {
    // Longest-match-first fails here: "Part number Article" matches on "Part number" and swallows a
    // word belonging to the next cell, leaving an unsegmentable "number Unit per package".
    expect(
      looksLikeHeaderRowValue("Rated current In (A) Part number Article number Unit per package", containsLabel)
    ).toBe(true);
  });

  it("still refuses real content that merely mentions a label", () => {
    expect(looksLikeHeaderRowValue("Rated current 16 A", containsLabel)).toBe(false);
    expect(looksLikeHeaderRowValue("Part number of the mating connector assembly", containsLabel)).toBe(false);
  });
});

/**
 * Web-shop chrome. Found by the HTML corpus on a real Turck page, which emitted
 * "In StockPrice GroupE1List Price102,70 € | Item Total102,70 €Quantity-+add_shopping_cartAdd to cart"
 * as a product attribute.
 */
describe("commerce chrome", () => {
  it("rejects prices, stock status and cart actions", () => {
    for (const value of [
      "In StockPrice GroupE1List Price102,70 € | Item Total102,70 €Quantity−+add_shopping_cartAdd to cart",
      "List Price 102,70 €",
      "$1,299.00",
      "Add to cart",
      "Out of stock",
      "incl. VAT",
      "Lieferzeit 5 Tage",
      "In den Warenkorb"
    ]) {
      expect(isPlausibleSpecValue(value), value).toBe(false);
    }
  });

  it("rejects commerce labels too", () => {
    expect(isPlausibleSpecLabel("List Price")).toBe(false);
    expect(isPlausibleSpecLabel("Add to cart")).toBe(false);
  });

  it("does not reject specifications that merely contain a number and a unit", () => {
    // The currency rule needs an actual currency symbol, so ordinary values are untouched.
    expect(isPlausibleSpecValue("102,70 mm")).toBe(true);
    expect(isPlausibleSpecValue("Price-free rating: 16 A")).toBe(true);
    expect(isPlausibleSpecValue("Stock removal 0.5 mm")).toBe(true);
  });
});

/**
 * `splitNameValue` splits on `=`, and both HTML tags and JavaScript assignments are built around one — so
 * markup and code that reach the text layer get torn into "label/value pairs". Found by promoting
 * fixtures/rockwell-1606-XLS120E-page to value-verified (230 → 144 attributes of noise removed, all 8
 * normalized fields unchanged).
 */
describe("raw markup and source code", () => {
  it("rejects torn HTML tags, including custom elements and comments", () => {
    for (const text of [
      "<details id",
      "<ra-footer origin=\"https",
      "<select-styler class",
      "Multiple<div class",
      "<!-- <div class",
      "ra-product-new__divider\"> -->",
      "<textarea aria-describedby"
    ]) {
      expect(isPlausibleSpecLabel(text), text).toBe(false);
    }
  });

  it("rejects an HTML attribute name standing alone as a label", () => {
    expect(isPlausibleSpecLabel("class")).toBe(false);
    expect(isPlausibleSpecLabel("aria-describedby")).toBe(false);
    expect(isPlausibleSpecLabel("data-product-id")).toBe(false);
  });

  it("keeps the dimension labels an over-broad attribute list would have eaten", () => {
    // A first version of that list included width/height/d/type/name/value/title — and the
    // value-verified fixtures caught it at once: "d" is diameter, so ABB's dimensions collapsed from
    // "155 x 120 x 190 mm" to "D 190 mm".
    for (const label of ["Width", "Height", "Depth", "D", "W", "H", "Type", "Name", "Value", "Title"]) {
      expect(isPlausibleSpecLabel(label), label).toBe(true);
    }
  });

  it("rejects JavaScript fragments", () => {
    expect(isPlausibleSpecLabel("const catalogNumber")).toBe(false);
    expect(isPlausibleSpecValue("document.querySelectorAll('.repair-options-available-link');")).toBe(false);
    expect(isPlausibleSpecValue("window.location.pathname.split('/details.')[1].replace('.html', '');")).toBe(false);
    expect(isPlausibleSpecLabel("CQ_Analytics.TestTarget.currentPagePath")).toBe(false);
    // String.raw so the JS escape sequences reach the predicate literally, as they do off the page.
    expect(isPlausibleSpecValue(String.raw`'\/content\/rockwell-automation\/global';`)).toBe(false);
    expect(isPlausibleSpecLabel('pageName +="')).toBe(false);
  });

  it("keeps labels that merely end in a colon", () => {
    // The operator-tail rule first rejected any label ending in ":" — real labels do that constantly.
    expect(isPlausibleSpecLabel("• Certifications:")).toBe(true);
    expect(isPlausibleSpecLabel("Weight:")).toBe(true);
  });

  it("rejects contact-form chrome but keeps a spec that contains the word 'required'", () => {
    expect(isPlausibleSpecValue("Business Email Address* This field is required Company Name*")).toBe(false);
    expect(isPlausibleSpecLabel("Environmental compliance inquiry")).toBe(true);
    // Schmersal really ships this label; a bare "required" filter would have destroyed it.
    expect(isPlausibleSpecPair("Required rated short-circuit current", "1,000 A")).toBe(true);
  });
});

/**
 * P1.3e — a postal address is never a specification. Rockwell's certification list legitimately contains
 * its EU representative's address (part of a declaration of conformity), and the list branch trusts the
 * list wholesale on purpose — requiring a token allowlist there once dropped real country-qualified marks
 * like "Korean KC". So the address is rejected on its own shape instead.
 */
describe("postal addresses", () => {
  it("rejects an address that arrived as a certification", () => {
    expect(isPlausibleSpecValue("Rockwell Automation N.V Pegasus Park De Kleet")).toBe(false);
    expect(isPlausibleSpecValue("Hauptstraße 12, 90766 Fürth, Germany")).toBe(false);
    expect(isPlausibleSpecValue("1201 South Second Street Milwaukee WI")).toBe(false);
  });

  it("keeps real certification values, including country-qualified marks", () => {
    for (const value of ["Australian RCM", "Korean KC", "Eurasion Economic Community", "MOROCCO DOC", "cULus", "TÜV SÜD AG"]) {
      expect(isPlausibleSpecValue(value), value).toBe(true);
    }
  });

  it("needs both signals, so a short product term survives", () => {
    // A place word alone must not be enough — "Park brake" is a real product term.
    expect(isPlausibleSpecValue("Park brake")).toBe(true);
    expect(isPlausibleSpecValue("Parking brake release")).toBe(true);
    expect(isPlausibleSpecValue("DIN rail")).toBe(true);
  });
});

/**
 * Two values sitting next to each other are not a label/value pair. Ganter pages carry thumbnails of
 * SIBLING variants whose alt/title holds that variant's whole option list, and mining it produced
 * `"SR - Silver, RAL 9006, textured finish"` = `"SW - Black, RAL 9005, textured finish"` — one variant's
 * finish labelling another's.
 *
 * Judged on the PAIR, never on the label alone: Ganter's own standard sheets legitimately use the option
 * string AS a label, and the audit over real vendor documents caught a label-only rule losing ten values.
 */
describe("same-shape value pairs", () => {
  it("rejects two option values paired together", () => {
    expect(
      isPlausibleSpecPair("SR - Silver, RAL 9006, textured finish", "SW - Black, RAL 9005, textured finish")
    ).toBe(false);
  });

  it("keeps an option string used as a label when the value is a plain one", () => {
    // This is how Ganter's standard sheets are laid out; rejecting it lost real finish/colour values.
    expect(isPlausibleSpecPair("SW - Black, RAL 9005, textured finish", "black")).toBe(true);
    expect(isPlausibleSpecPair("SW - Black, RAL 9005, textured finish", "SW")).toBe(true);
  });

  it("keeps ordinary pairs untouched", () => {
    expect(isPlausibleSpecPair("Finish", "SW - Black, RAL 9005, textured finish")).toBe(true);
    expect(isPlausibleSpecPair("Material of the contacts, electrical", "Silver")).toBe(true);
    expect(isPlausibleSpecPair("Rated current", "16 A")).toBe(true);
  });
});

/**
 * P1.3f — a page that shows sibling variants lists EVERY option code, and only the ordering number says
 * which one is ours. Ganter's `GN 422-33-RO-RK-K5-SR` page carries both `SR - Silver, RAL 9006` and
 * `SW - Black, RAL 9005`; the generic path was reporting the black one.
 */
describe("isForeignVariantOptionValue", () => {
  const OURS = "GN 422-33-RO-RK-K5-SR";

  it("rejects a sibling variant's option value", () => {
    expect(isForeignVariantOptionValue("SW - Black, RAL 9005, textured finish", OURS)).toBe(true);
    expect(isForeignVariantOptionValue("K2 - Cable, end open, 2 m", OURS)).toBe(true);
  });

  it("keeps the option that is ours", () => {
    expect(isForeignVariantOptionValue("SR - Silver, RAL 9006, textured finish", OURS)).toBe(false);
    expect(isForeignVariantOptionValue("K5 - Cable, end open, 5 m", OURS)).toBe(false);
    expect(isForeignVariantOptionValue("RO - red / green (bi-color)", OURS)).toBe(false);
  });

  it("does nothing when the catalog number is not option-coded", () => {
    // Otherwise an ordinary "CODE - description" value would be destroyed: a certificate, a thread size.
    expect(isForeignVariantOptionValue("CE - Conformité Européenne", "1SDA126493R1")).toBe(false);
    expect(isForeignVariantOptionValue("M8 - coarse thread", "87920846")).toBe(false);
    expect(isForeignVariantOptionValue("SW - Black, RAL 9005", "CBE03319")).toBe(false);
  });

  it("ignores values that are not option-coded at all", () => {
    expect(isForeignVariantOptionValue("16 A", OURS)).toBe(false);
    expect(isForeignVariantOptionValue("Zinc die casting", OURS)).toBe(false);
  });
});

/**
 * P1.4c — front-end frameworks leak their conditional class bindings into the attribute list. Alpine.js
 * writes `:class="{ 'shadow-md': !searchOpen && !mobileMenuOpen, 'w-0': menuOpenedId !== '0' }"`, and
 * splitting that on `:` produces label/value pairs. Found on a real Balluff page.
 */
describe("front-end framework bindings", () => {
  it("rejects JS boolean expressions as values", () => {
    expect(isPlausibleSpecValue("!searchOpen && !mobileMenuOpen")).toBe(false);
    expect(isPlausibleSpecValue("menuOpenedId !== '0',")).toBe(false);
    expect(isPlausibleSpecValue("menuOpenedId == '0',")).toBe(false);
  });

  it("rejects quoted labels and torn-quote fragments", () => {
    expect(isPlausibleSpecLabel("'shadow-md'")).toBe(false);
    expect(isPlausibleSpecLabel('"@friendlycaptcha/sdk"')).toBe(false);
    // Split at a colon INSIDE the class name — Tailwind's responsive prefix.
    expect(isPlausibleSpecLabel("'absolute inset-x-0 px-2 mx-2 lg")).toBe(false);
    expect(isPlausibleSpecValue("mx-0 md:relative max-w-none flex-grow': searchOpen,")).toBe(false);
  });

  it("rejects framework directive names as labels", () => {
    for (const label of ["x-on", "x-data", "v-if", "v-model", "@click", ":class"]) {
      expect(isPlausibleSpecLabel(label), label).toBe(false);
    }
  });

  it("keeps a real apostrophe, which a naive quote rule would destroy", () => {
    expect(isPlausibleSpecValue("Manufacturer's data")).toBe(true);
    expect(isPlausibleSpecLabel("Manufacturer's part number")).toBe(true);
  });

  it("keeps values that merely contain comparison-like text", () => {
    expect(isPlausibleSpecValue("< 5 mA")).toBe(true);
    expect(isPlausibleSpecValue("230/400 V")).toBe(true);
    expect(isPlausibleSpecValue("-5 ... 55 °C")).toBe(true);
  });
});

/**
 * P1.4d — noise that reached a shipped FIELD, not just the attribute list. A Fath page produced
 * `certificates = "RoHS, Data Protection Declaration, REACH Regulation"`.
 */
describe("legal documents, commerce meta and JS config", () => {
  it("rejects legal and policy document names", () => {
    for (const text of [
      "Data Protection Declaration",
      "Datenschutzerklärung",
      "Privacy Statement",
      "Terms and Conditions",
      "Cookie Settings",
      "Impressum"
    ]) {
      expect(isPlausibleSpecValue(text), text).toBe(false);
    }
  });

  it("keeps real declarations of conformity and approvals", () => {
    // The word "declaration" is legitimate on its own — only the data-protection sense is not.
    for (const value of ["Declaration of Conformity", "EU Declaration of Conformity", "RoHS", "REACH Regulation", "cULus"]) {
      expect(isPlausibleSpecValue(value), value).toBe(true);
    }
  });

  it("rejects commerce/OpenGraph meta keys as labels", () => {
    for (const label of ["product:price:amount", "product:price:currency", "og:type", "twitter:card"]) {
      expect(isPlausibleSpecLabel(label), label).toBe(false);
    }
  });

  it("rejects a bare boolean literal as a value", () => {
    for (const value of ["true", "false", "null", "undefined"]) {
      expect(isPlausibleSpecValue(value), value).toBe(false);
    }
  });

  it("keeps values that merely begin with such a word", () => {
    expect(isPlausibleSpecValue("false ceiling mount")).toBe(true);
    expect(isPlausibleSpecValue("null modem cable")).toBe(true);
  });
});

describe("inline script leakage (found on real ABB pages)", () => {
  it("rejects property assignments torn into label/value pairs", () => {
    // These name no DOM global and call no method, so the older code-fragment rule could not see them.
    for (const [label, value] of [
      ["a.async", "true;"],
      ["a.src", "src;"],
      ["a.type", "'text/javascript';"],
      ["heading.textContent", "desired;"],
      ["pathname", "pathname + '.html';"]
    ]) {
      expect(isPlausibleSpecPair(label, value), `${label} = ${value}`).toBe(false);
    }
  });

  it("rejects the Google Tag Manager snippet, whichever half it lands in", () => {
    const label = "j=d.createElement(s),dl=l!='dataLayer'?'&l='+l";
    const value = "'';j.async=true;j.src=";
    expect(isPlausibleSpecLabel(label)).toBe(false);
    expect(isPlausibleSpecValue(value)).toBe(false);
  });

  it("rejects commented-out script, without touching protocol-relative URLs", () => {
    expect(isPlausibleSpecLabel("// hit._highlightResult[key].value")).toBe(false);
    expect(isPlausibleSpecValue("_.escape(hit._snippetResult[key].value);")).toBe(false);
    // The space after `//` is what makes the rule safe — a URL never has one.
    expect(isPlausibleSpecValue("//www.vendor.com/datasheet.pdf")).toBe(true);
  });

  it("rejects autocomplete-widget script that carries no semicolon", () => {
    for (const value of ["wp.template('autocomplete-empty')", "_.escape(config['label'])", "algoliaResponse.query"]) {
      expect(isPlausibleSpecValue(value), value).toBe(false);
    }
    // The Norwegian ABB site publishes real values through the same reader — they must survive.
    expect(isPlausibleSpecValue("10 kA")).toBe(true);
    expect(isPlausibleSpecValue("IEC/EN 60898, IEC/EN 60947-2")).toBe(true);
    expect(isPlausibleSpecValue("Bolig, forretningsbygg og industri.")).toBe(true);
    // A dotted lowercase value is not camelCase and must not be caught by the code-path rule.
    expect(isPlausibleSpecValue("datasheet.pdf")).toBe(true);
  });

  it("keeps real values that merely contain a semicolon or a dotted token", () => {
    // The semicolon alone must never be the signal: vendors separate alternatives with it.
    expect(isPlausibleSpecValue("AC 100 V; 120 V; 230/240 V (50/60 Hz);")).toBe(true);
    expect(isPlausibleSpecValue("IP66; IP67; IP69K")).toBe(true);
    expect(isPlausibleSpecValue("EN 60947-5-1; IEC 60529")).toBe(true);
    // A dotted token is a standard number far more often than it is a code path.
    expect(isPlausibleSpecValue("GB/T 10963.1")).toBe(true);
    expect(isPlausibleSpecLabel("Rated current I.th")).toBe(true);
  });
});
