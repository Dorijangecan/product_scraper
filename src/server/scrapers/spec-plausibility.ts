/**
 * Is this label/value pair a SPECIFICATION at all?
 *
 * Both the HTML and the PDF path build label/value pairs by splitting text on a separator, and
 * neither ever asks whether the left side is a label or just the first half of a sentence. The
 * offline eval corpus made the cost obvious: nVent's 2-page installation instruction (which contains
 * no specification table at all) yielded eight attributes and every one was garbage —
 *   "The safety and protection"            = "against incidental contact is to be ensured"
 *   "The technical specifications (voltage and" = "current) as stated on the"
 *   "© 2018 Hoffman Enclosures Inc."       = "PH 763 422 2211 • nVent.com/HOFFMAN …"
 * while an ABB product page produced `letter-spacing = "normal !important;"` (inline CSS as a product
 * attribute), a broken-cmap PDF produced `finish = "\x15\x11\x19\x17…"`, another produced
 * `finish = "and"`, and a family catalog turned table-of-contents dot leaders into five
 * "Technical data = . . . . . . . . 4" attributes.
 *
 * These are one bug class, not eight, so they get one gate at the boundary rather than eight patches
 * in eight extractors — the same lesson as the concatenated-measurement backstop in `normalizer.ts`
 * (whack-a-mole across independent parsers does not converge; reject at the edge instead).
 *
 * Bias: conservative. Every rule here must be one that CANNOT fire on a real specification, because
 * dropping a real value is worse than keeping a bit of noise. Anything ambiguous is left alone.
 *
 * Leaf module — depends only on `text-util`, so every extractor can import it.
 */
import { collapseWhitespace } from "../text-util.js";

/** C0/C1 control characters (tab and newline excluded) — the signature of a PDF whose embedded font
 * cmap does not decode, which yields values like "\x15\x11\x19\x17\x03 \x19\x1a\x03PP". */
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

/** A run of dot/·/– leaders, as used in a table of contents ("Technical data . . . . . . . 4"). */
const LEADER_RUN_PATTERN = /(?:\.\s*){4,}|[·•]{4,}|[–—-]{6,}/;

/** Nothing but separators, punctuation and an optional page number. */
const PUNCTUATION_ONLY_PATTERN = /^[\s.,;:·•*†‡_–—|/\\()\[\]-]*\d{0,4}[\s.,;:·•*†‡_–—|/\\()\[\]-]*$/;

/** An inline CSS declaration that leaked out of a <style> block or a style attribute. */
const CSS_DECLARATION_PATTERN = /!important|(?:^|\s)-{0,2}[a-z-]+\s*:\s*[^;]*(?:px|rem|em|vh|vw|pt|%|#[0-9a-f]{3,8}|rgba?\()/i;
const CSS_VALUE_KEYWORD_PATTERN = /^(?:normal|inherit|initial|unset|auto|none|revert)\b[\s\S]{0,30};?$/i;

/**
 * Function words that carry no specification meaning on their own. A value that is nothing but one of
 * these is a fragment ("and"), never a spec. Multilingual because the corpus is (EN/DE/FR/IT/ES/NL).
 */
const FUNCTION_WORDS = new Set([
  "and", "or", "the", "a", "an", "of", "for", "with", "to", "in", "on", "at", "by", "as", "is", "are",
  "be", "from", "that", "this", "these", "those", "it", "its", "not", "no", "yes", "all", "any", "per",
  "und", "oder", "der", "die", "das", "des", "dem", "den", "mit", "für", "von", "zu", "im", "am",
  "et", "ou", "le", "la", "les", "de", "du", "des", "avec", "pour", "dans", "par",
  "e", "o", "il", "lo", "gli", "con", "per", "da", "del", "della",
  "y", "el", "los", "las", "con", "para", "en", "por",
  "en", "van", "het", "met", "voor"
]);

/** A trailing word that leaves the phrase dangling — the giveaway that a sentence was cut in half. */
const DANGLING_TAIL_WORDS = new Set([
  "and", "or", "of", "for", "with", "to", "the", "a", "an", "in", "on", "at", "by", "as", "from",
  "that", "which", "when", "if", "than", "into", "onto", "über", "und", "oder", "mit", "für", "von",
  "et", "ou", "avec", "pour", "e", "o", "con", "per", "y", "para"
]);

/** A leading word that marks the SECOND half of a sentence ("against incidental contact is …"). */
const CONTINUATION_HEAD_WORDS = new Set([
  "against", "because", "although", "whereas", "unless", "until", "while", "whether", "however",
  "therefore", "thereby", "thus", "hence", "moreover", "furthermore", "otherwise", "instead",
  "according", "depending", "regarding", "concerning", "including", "excluding", "provided"
]);

/**
 * Web-shop chrome: price, stock, cart. Never a product specification.
 *
 * Found by the HTML corpus on a real Turck page, which produced the attribute
 * "In StockPrice GroupE1List Price102,70 € | Item Total102,70 €Quantity-+add_shopping_cartAdd to cart".
 * A currency amount and a cart action are unambiguous markers — no datasheet value contains them — so
 * this is one of the safest rejections in this module.
 */
const COMMERCE_CHROME_PATTERN =
  /\b(?:add[_\s-]?(?:to[_\s-]?)?(?:cart|basket)|shopping[_\s-]?cart|list\s+price|item\s+total|price\s+group|unit\s+price|in\s+stock|out\s+of\s+stock|on\s+request|incl\.?\s*vat|excl\.?\s*vat|plus\s+shipping|lieferzeit|verf[üu]gbarkeit|warenkorb|panier|carrello)\b|\d[\d.,]*\s*(?:€|\$|£|CHF|USD|EUR|GBP)|(?:€|\$|£)\s*\d/i;

/**
 * A fragment of raw HTML source, not content.
 *
 * `splitNameValue` splits on `=`, and an HTML tag is full of `=` — so a tag that reaches the text layer
 * gets torn into a "label/value pair". A real Rockwell page produced attributes like
 *   `<details id` = `"ra-product-new__documentation-table-mobile" class="…"`
 *   `<ra-footer origin="https` = `//www.rockwellautomation.com" path="/en-us/config-pages/footer" …`
 * `stripHtmlMarkup` cannot help here: the splitter already cut the tag, so there is no closing `>` left
 * to recognise. It has to be rejected on its shape instead.
 */
const RAW_MARKUP_FRAGMENT_PATTERN =
  // A tag-shaped run ANYWHERE, not just at the start: a torn tag can leave the label as
  // "Multiple<div class". Requiring a letter after "<" plus a following space or ">" keeps threshold
  // values safe — "< 5 mA" has a space and "<0.5 W" a digit, so neither is tag-shaped.
  // The hyphen in the tag name is required for custom elements — web components always contain one, and
  // this page ships `<ra-footer>`, `<ra-header>` and `<select-styler>`.
  /<\/?[a-z][a-z0-9-]*(?:[\s>/]|$)|^\s*<!--|-->|<!\[CDATA\[|\b(?:class|id|href|src|origin|colspan|rowspan|style|target|rel|type|name|value|placeholder|aria-[a-z-]+|data-[a-z-]+)\s*=\s*["']/i;

/**
 * Contact / inquiry form chrome. A form asks for input; a datasheet states facts.
 *
 * From the same Rockwell page: `Environmental compliance inquiry …` = `Business Email Address* This field
 * is required Company Name* …`.
 *
 * Deliberately keyed on FULL phrases. A bare "required" would be wrong — Schmersal legitimately ships
 * "Required rated short-circuit current = 1,000 A", and losing that to a form filter would be a worse
 * bug than the noise being removed.
 */
const FORM_CHROME_PATTERN =
  /\b(?:this field is required|field is required|is a required field|enter your|please enter|please select|business email|email address\s*\*|first name\s*\*|last name\s*\*|company name\s*\*|i agree to|privacy (?:notice|policy)|subscribe to|sign up for|all fields marked)\b/i;

/**
 * A legal / policy document name.
 *
 * Vendors list these right next to their certificate marks, and a Fath page put one straight into the
 * CERTIFICATES field: `RoHS, Data Protection Declaration, REACH Regulation`. A GDPR notice is not a
 * product approval — and unlike most noise this one reached a shipped field, not just the attribute list.
 */
const LEGAL_DOCUMENT_PATTERN =
  /\b(?:data protection (?:declaration|notice|policy)|datenschutz(?:erkl[äa]rung)?|privacy (?:notice|policy|statement)|terms (?:and conditions|of (?:use|sale|service))|legal notice|imprint|impressum|gdpr|cookie (?:policy|notice|settings)|declaration of consent|whistleblow)/i;

/**
 * A DOWNLOAD-LINK label, carrying the file's size and language rather than a specification.
 *
 * nVent decorates its certificate links with them, and the labels flowed into the certificates field:
 * `CERT-00070 653 KB English Declaration of Conformity`. A specification never states a file size.
 *
 * TWO signals required. A bare file-size rule would be wrong — "512 KB" is a real memory spec for a PLC —
 * so the size must appear together with a language name or a document word.
 */
const FILE_SIZE_PATTERN = /\b\d+(?:[.,]\d+)?\s*(?:[KMG]B|bytes?)\b/i;
const DOWNLOAD_DECORATION_PATTERN =
  /\b(?:english|german|deutsch|french|fran[çc]ais|italian|italiano|spanish|espa[ñn]ol|dutch|chinese|declaration|certificate|datasheet|data\s*sheet|brochure|manual|drawing|pdf|download)\b/i;

function looksLikeDownloadLinkLabel(text: string): boolean {
  return FILE_SIZE_PATTERN.test(text) && DOWNLOAD_DECORATION_PATTERN.test(text);
}

/** A bare boolean/null literal — JavaScript config, never a specification value. Trailing `;`/`,` allowed
 * because the `=` split leaves them attached: `a.async` = `true;`. */
const BOOLEAN_LITERAL_VALUE = /^(?:true|false|null|undefined|nan)\s*[;,]?$/i;

/**
 * A JavaScript statement remainder left by the `=` split.
 *
 * Two ABB pages leaked their inline scripts as attributes — `a.async` = `true;`, `a.src` = `src;`,
 * `heading.textContent` = `desired;`, `lastWindowHeight` = `$(window).height();`, `pathname` =
 * `pathname + '.html';`. The existing code rule missed them: they name no DOM global and, apart from the
 * jQuery one, call no method.
 *
 * `;` alone is deliberately NOT enough — a real table cell can end in one
 * (`AC 100 V; 120 V; 230/240 V (50/60 Hz);`), and the corpus asserts that value must survive. So the
 * semicolon must accompany a bare identifier, a quoted literal, a jQuery call, or a zero-argument call:
 * the corpus audit later surfaced `lockUntil` = `now() + ms;`, where `now()` is the only giveaway.
 */
const JS_STATEMENT_VALUE =
  /^[A-Za-z_$][\w$.]*\s*;$|^['"][^'"]*['"]\s*;?$|\$\s*\(|^[A-Za-z_$][\w$]*\s*\+\s*['"]|[A-Za-z_$][\w$]*\(\s*\)/;

/**
 * A dotted lowercase identifier is a code path, not a label — `a.async`, `heading.textContent`.
 *
 * Two segments is enough here (unlike DOTTED_IDENTIFIER_LABEL's three) because the lowercase-on-both-sides
 * requirement already excludes real labels: an abbreviation carries a capital or a space
 * ("Ref. No.", "Max. Cont. Current"), and a decimal carries digits.
 */
const DOTTED_CODE_LABEL = /^[a-z_$][\w$]*(?:\.[a-z_$][\w$]*)+$/;

/**
 * A `//` line comment — commented-out JavaScript that reached the text layer and got split on its `=`.
 * The corpus audit found `// hit._highlightResult[key].value` = `_.escape(hit._highlightResult[key].value);`
 * on an ABB regional site.
 *
 * The space after `//` is REQUIRED, and that is what makes the rule safe: a protocol-relative URL
 * (`//www.vendor.com/…`) never has one, so this cannot fire on the torn-tag fragments handled elsewhere.
 */
const LINE_COMMENT_PATTERN = /^\/\/\s+\S/;

/**
 * A method call that ends a statement — `_.escape(hit._snippetResult[key].value);`, the VALUE half of the
 * commented-out line above (the comment marker stays with the label, so the value needs its own signature).
 *
 * Two independent code signals are required together, deliberately: a dotted identifier immediately
 * followed by `(`, AND a terminating semicolon. Either alone has a plausible counter-example — a vendor
 * can write `Length(mm) 25;` in a semicolon-separated run — but not both.
 */
const JS_METHOD_CALL_STATEMENT = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\([\s\S]*;$/;

/**
 * A method call taking a quoted argument — `wp.template('autocomplete-empty')`, `_.escape(config['label'])`.
 * Same site as the commented-out lines, but no semicolon, so the statement rule above cannot see them.
 *
 * The quoted argument is the second signal here, standing in for the semicolon: a specification value can
 * contain parentheses (`(50/60 Hz)`) and it can contain a quote (the inch prime, `1.5"`), but not a
 * dotted identifier calling into a quoted string.
 */
const JS_CALL_WITH_STRING_ARGUMENT = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\([^)]*['"[]/;

/**
 * A camelCase dotted identifier standing alone — `algoliaResponse.query`.
 *
 * The inner capital is what makes this safe to reject as a VALUE, where `DOTTED_CODE_LABEL` would be too
 * broad: vendors do publish dotted lowercase values (`datasheet.pdf`, `art.nr`), but camelCase is a
 * programming convention that no datasheet uses.
 */
const CAMEL_CASE_CODE_PATH = /^[a-z_$][a-z0-9_$]*[A-Z][\w$]*(?:\.[\w$]+)+$/;

/**
 * A digit-free value ending in a comma is a fragment cut out of running text — `removal,`,
 * `essentialsArray,`. The digit requirement keeps a genuine (if untidy) list safe: `1 A, 3 A, 6 A,`.
 */
const TRAILING_COMMA_FRAGMENT = /^[^\d]*,$/;

/**
 * A value opening with a preposition or conjunction continues a sentence rather than stating a fact —
 * ABB's marketing paragraph produced `Compliance` = `with versatile 50Hz/60Hz compatibility across …`.
 *
 * Needs three words, so a terse real value cannot trip it. Kept to a SHORT list on purpose: a broader
 * "digit-free lowercase prose" rule was tried against the corpus first and would have destroyed
 * Schmersal's real material value, `glass-fibre reinforced thermoplastic`.
 */
const LEADING_PREPOSITION_VALUE =
  /^(?:with|without|and|or|for|of|to|from|in|on|at|by|as|per|via|including|based on|according to)\b/i;

/** Commerce/OpenGraph meta keys that arrive as labels (`product:price:amount` = `0`). */
const COMMERCE_META_LABEL = /^(?:product|og|twitter|fb|al):[a-z_:]+$/i;

/**
 * A fragment of source CODE, not content.
 *
 * Same root cause as the raw-markup case: `splitNameValue` splits on `=`, and a JavaScript assignment is
 * built around one. Inline `<script>` blocks on a real Rockwell page therefore produced
 *   `const catalogNumber` = `window.location.pathname.split('/details.')[1].replace('.html', '');`
 *   `const repairLinks`    = `document.querySelectorAll('.repair-options-available-link');`
 * Keyed on DOM globals, declaration keywords and method-call syntax, all of which are impossible in a
 * datasheet value. A bare trailing `;` is deliberately NOT a signal — "cULus; IFA; CCC" is a real
 * certificate list.
 */
const CODE_FRAGMENT_PATTERN =
  /^\s*(?:const|let|var|function|return|import|export|typeof|await|async|new)\s|document\.|window\.|querySelector|addEventListener|getElementBy|createElement|insertBefore|appendChild|=>|\.(?:split|replace|push|map|filter|forEach|then|catch)\s*\(|\bfunction\s*\(/i;

/**
 * A JavaScript string escape. `\/` and `\uXXXX` are how a JS literal encodes characters that need no
 * encoding in a specification — Rockwell's analytics assignment reached the text layer as
 * `'\/content\/rockwell-automation\/…'`.
 */
const CODE_ESCAPE_PATTERN = /\\\/|\\u[0-9a-f]{4}|\\x[0-9a-f]{2}/i;

/**
 * A JavaScript boolean/comparison EXPRESSION.
 *
 * Alpine.js and Tailwind write conditional classes as an object literal —
 * `:class="{ 'shadow-md': !searchOpen && !mobileMenuOpen, 'w-0': menuOpenedId !== '0' }"` — and splitting
 * that on `:` yields pairs like `'shadow-md'` = `!searchOpen && !mobileMenuOpen`. Found on a real Balluff
 * page. `CODE_FRAGMENT_PATTERN` misses these because they name no DOM global and call no method.
 *
 * `&&`, `||`, `!=`, `===` and `!identifier` cannot occur in a specification value. Neither can a ternary
 * whose branch is a quoted literal — ABB's Google Tag Manager snippet reached the text layer whole and was
 * split into the pair `j=d.createElement(s),dl=l!='dataLayer'?'&l='+l` = `'';j.async=true;j.src=`.
 */
const JS_EXPRESSION_PATTERN = /&&|\|\||!=|===|==\s*['"]|\?\s*['"]|^\s*!\s*[A-Za-z_$]/;

/**
 * A run of JavaScript statements: a semicolon followed by an assignment to an identifier or its property.
 *
 * The single-statement rules cannot see this shape, because the fragment that survives the label/value
 * split starts mid-statement (`'';j.async=true;j.src=`) — it has no leading keyword and no trailing
 * terminator. A specification value never assigns to anything.
 */
const JS_ASSIGNMENT_SEQUENCE = /;\s*[A-Za-z_$][\w$]*(?:\.[\w$]+)*\s*=/;

/**
 * A label wrapped in quotes is a code or JSON KEY, not a specification label — `'shadow-md'`,
 * `"@friendlycaptcha/sdk"`. Vendors never quote their own spec labels.
 */
const QUOTED_LABEL = /^\s*(['"`])[\s\S]*\1\s*$/;

/**
 * A code fragment torn apart mid-quote.
 *
 * Alpine class objects also get split at a colon INSIDE the class name — Tailwind's responsive prefix —
 * so `'absolute inset-x-0 px-2 mx-2 lg:mx-0 …': searchOpen` becomes the label
 * `'absolute inset-x-0 px-2 mx-2 lg` and the value `mx-0 md:relative … flex-grow': searchOpen,`.
 *
 * The opening quote must be at the START, and an object-literal `':` is required for the value form —
 * an apostrophe alone would wrongly condemn "Manufacturer's data".
 */
function hasTornQuoteFragment(text: string): boolean {
  const opener = /^\s*(['"`])/.exec(text)?.[1];
  if (opener) {
    const occurrences = text.split(opener).length - 1;
    if (occurrences % 2 === 1) return true;
  }
  return /['"]\s*:\s|['"]\s*,\s*$/.test(text);
}

/**
 * A dotted identifier chain of three or more segments (`CQ_Analytics.TestTarget.currentPagePath`) is a
 * code path, never a specification label. Three segments, not two, so a real label containing an
 * abbreviation with a dot cannot trip it.
 */
const DOTTED_IDENTIFIER_LABEL = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){2,}$/;

/**
 * A JavaScript assignment operator left dangling by the `=` split — `pageName +="` becomes a "label".
 *
 * Narrow on purpose. A first attempt also rejected any label ending in `:`, `-` or `/`, and the unit
 * tests caught it: real labels end with a colon all the time ("• Certifications:", "Weight:").
 */
const OPERATOR_TAIL_LABEL = /(?:[+\-*/%&|^]=|=)\s*["'(]$|(?:\+\+|--|&&|\|\|)\s*$/;

/**
 * An HTML attribute NAME standing alone as a label.
 *
 * When a tag is torn apart on `=`, the label can end up being just the attribute name with the quoted
 * value beside it: `class` = `"ra-product-new__content-frame-technical-specifications …"`. Neither half
 * then contains the contiguous `class="` that RAW_MARKUP_FRAGMENT_PATTERN looks for, so the name has to
 * be recognised on its own.
 *
 * Deliberately narrow. A first attempt also listed `width`, `height`, `d`, `type`, `name`, `value`,
 * `title` and `alt` — and the value-verified fixtures caught it immediately: those are REAL spec labels
 * (`d` is diameter), so ABB's dimensions collapsed from "155 x 120 x 190 mm" to "D 190 mm". Only names
 * that cannot plausibly label a specification belong here.
 */
const HTML_ATTRIBUTE_NAME_LABEL =
  // Framework directives belong here too: Alpine (`x-on`, `x-data`, `x-show`), Vue (`v-if`, `v-model`) and
  // their shorthands (`@click`, `:class`). A Balluff page produced `x-on` = `search-open.window="openSearch"`
  // because the directive `x-on:search-open.window="…"` was split on its colon.
  /^(?:class|id|style|href|src|srcset|rel|target|colspan|rowspan|tabindex|xmlns|viewbox|placeholder|aria-[a-z-]+|data-[a-z-]+|x-[a-z-]+|v-[a-z-]+|[@:][a-z][a-z-]*)$/i;

/**
 * A CSS property or DOM/data-attribute hook that survived as a label.
 *
 * Page mining strips a leading `data-`, so `<header data-height-onload="30">` arrives as
 * `height-onload` = `30` — and that is exactly how "H 30" was exported as a Saginaw enclosure's
 * dimensions for every catalog number the site does not publish. A closed vocabulary of CSS first
 * segments plus DOM hook suffixes, matched only on lowercase hyphenated identifiers: real labels are
 * spaced words ("Wall thickness", "Nenn-Spannung"), never `line-height`.
 */
const STYLE_IDENTIFIER_LABEL =
  /^-{0,2}(?:webkit|moz|ms)-[a-z-]+$|^(?:line|max|min|font|letter|word|text|vertical|box|border|background|padding|margin|grid|flex|white|list|object|overflow|scroll|transform|transition|animation)-[a-z-]+$|^[a-z]+-(?:onload|onclick|onchange|onsubmit|percentage|percent|toggle|target|slug)$/;

/**
 * What is left of a CSS declaration once the property name has been split off on `=` or `:`
 * (`line-height` = `1em;`, `float` = `left;`). This catches the single-word CSS properties that are
 * too English to reject by name (`float`, `clear`, `content`).
 *
 * The whole value must have CSS shape — a bare CSS length/keyword. A first attempt simply rejected
 * any value ending in a semicolon, and the audit over real vendor documents caught it at once:
 * `Voltage ratings = AC 100 V; 120 V; 230/240 V (50/60 Hz);` is a real published rating whose table
 * cell happens to end in one.
 */
const CSS_DECLARATION_TAIL_PATTERN =
  /^(?:-?\d*\.?\d+(?:px|r?em|%|vh|vw|pt|ch)|none|auto|inherit|initial|unset|normal|left|right|center|both|bold|italic|hidden|visible|block|inline(?:-block)?|flex|grid|absolute|relative|fixed|sticky|static|pointer|transparent|currentcolor|nowrap|uppercase|lowercase|capitalize)\s*(?:!important)?\s*;\s*$/i;

/**
 * A postal address, which is never a specification value.
 *
 * Rockwell's certification list legitimately contains its EU representative's address (that is part of a
 * declaration of conformity), and the list branch in `extractCertificationAttributes` trusts the list
 * wholesale — deliberately, because requiring a token allowlist there once dropped real
 * country-qualified marks like "Korean KC". So the address has to be rejected on its own shape:
 * `Certification = Rockwell Automation N.V Pegasus Park De Kleet`.
 *
 * TWO signals required — a street/place word AND at least four words. A place word alone is not enough:
 * "Park brake" is a real product term, and "TÜV SÜD AG" must not be mistaken for an address either, which
 * is why a legal-entity suffix is deliberately NOT one of the signals (certification bodies carry them).
 */
const ADDRESS_PLACE_WORD =
  /\b(?:park|street|str\.|avenue|ave\.|road|rd\.|weg|platz|via|rue|boulevard|blvd|lane|suite|floor|postbus|p\.?\s?o\.?\s?box)\b/i;
/** German street names are COMPOUNDS ("Hauptstraße", "Bahnhofstrasse"), so no leading word boundary. */
const ADDRESS_STREET_SUFFIX = /stra(?:ß|ss)e\b/i;
const ADDRESS_MIN_WORDS = 4;

function looksLikePostalAddress(text: string): boolean {
  if (!ADDRESS_PLACE_WORD.test(text) && !ADDRESS_STREET_SUFFIX.test(text)) return false;
  return words(text).length >= ADDRESS_MIN_WORDS;
}

/**
 * Site chrome that is neither commerce nor a form: UI controls, bundled asset paths, and whole site
 * SECTIONS that happen to sit next to the product.
 *
 * All three came off one real Ganter page:
 *   `Connection type`        = `Show / Hide columns Werkstoff a d h l1 l2 l3 t Show filter …`
 *   `"@friendlycaptcha/sdk"` = `"/fileadmin/templates/dist/assets/plugins/friendly-captcha/sdk.js",`
 *   `Upcoming Trade Shows`   = `Automation Expo 07/22/26 - 07/25/26 Mumbai AMTEX …`
 */
const UI_CONTROL_PATTERN =
  /\b(?:show\s*\/\s*hide|hide\s+columns?|show\s+(?:all|more|less|filter|columns?)|sort\s+by|filter\s+by|select\s+all|clear\s+(?:all|filters?)|compare\s+products?|back\s+to\s+top|read\s+more|load\s+more|spalten\s+(?:ein|aus)blenden|afficher\s*\/\s*masquer)\b/i;

/** A path to a bundled front-end asset — never a specification value. */
const ASSET_PATH_PATTERN = /\.(?:js|mjs|cjs|css|scss|woff2?|ttf|eot|map|json)(?:["'?,;)\s]|$)/i;

/** A label naming a whole site section rather than a product property. */
const SITE_SECTION_LABEL =
  /^(?:upcoming\s+)?(?:trade\s+shows?|events?|news|newsletter|press|blog|careers?|jobs|webinars?|downloads?|contact|imprint|impressum|sitemap|catalogue|catalog)$/i;

/**
 * A label that is really a VALUE — specifically an option/variant description.
 *
 * Ganter pages carry thumbnails of sibling variants whose `alt`/`title` holds that variant's whole
 * option list as escaped markup (`Finish: SR - Silver, RAL 9006…&lt;br /&gt;`). Mining that produced the
 * pair `"SR - Silver, RAL 9006, textured finish"` = `"SW - Black, RAL 9005, textured finish"` — one
 * variant's finish as the LABEL for another variant's finish. Both halves are values.
 *
 * `isValueFragmentLabel` in normalizer.ts catches numeric shapes ("120 W", "(0.60 lb)"); this covers the
 * descriptive ones.
 *
 * Two independent signals, each chosen against the real labels in the corpus:
 *  - a colour-standard code (`RAL 9006`, NCS, Pantone) appears in values, never in labels;
 *  - two or more commas AND five or more words is a descriptive phrase, not a noun phrase. Real labels
 *    with one comma survive — Schmersal ships "Material of the contacts, electrical" and
 *    "Cable jacket, material".
 */
const COLOUR_STANDARD_CODE = /\b(?:ral|ncs|pantone)\s*[\d-]{3,}/i;

function looksLikeOptionValue(text: string): boolean {
  if (COLOUR_STANDARD_CODE.test(text)) return true;
  const commas = (text.match(/,/g) ?? []).length;
  return commas >= 2 && words(text).length >= 5;
}

/**
 * Both halves are the SAME KIND of value, so this is not a label/value pair at all.
 *
 * This has to be judged on the PAIR, not on the label alone. A first attempt rejected any label that
 * looked like an option value — and the audit over real vendor documents immediately reported ten lost
 * values: Ganter's own standard sheets legitimately use the option string AS the label
 * (`SW - Black, RAL 9005, textured finish` = `black`), and the pipeline correctly derives finish and
 * colour from it. Only when the VALUE is also an option string is the pair bogus, which is exactly the
 * sibling-thumbnail case: `"SR - Silver, RAL 9006…"` = `"SW - Black, RAL 9005…"`.
 */
function isSameShapeValuePair(label: string, value: string): boolean {
  return looksLikeOptionValue(collapseWhitespace(label)) && looksLikeOptionValue(collapseWhitespace(value));
}

/** Determiners a real specification label never begins with. */
const LABEL_LEADING_DETERMINERS = new Set(["the", "a", "an", "this", "these", "those", "their", "its", "his", "her", "our", "your"]);

/** Legal/marketing boilerplate that is never a specification label. */
const BOILERPLATE_LABEL_PATTERN = /^(?:[©®™]|\(c\)\s*\d|copyright\b|all rights reserved\b|tel\.?\s*:|phone\b|fax\b|https?:\/\/|www\.)/i;

/** A page footer / imprint line, wherever it appears in the text. */
const BOILERPLATE_TEXT_PATTERN = /[©]\s*\d{4}|\ball rights reserved\b|\bcopyright\s+\d{4}/i;

/**
 * An INSTRUCTION, not a specification: modal verbs and passive imperatives are how a manual tells an
 * installer what to do. A datasheet value never contains them, so this is one of the safest possible
 * discriminators between "this document describes the product" and "this document instructs the
 * installer" — which is exactly the distinction nVent's 87920846 installation sheet needed.
 */
const INSTRUCTION_SENTENCE_PATTERN =
  /\b(?:should|must|shall|do not|does not|make sure|only be|be ensured|be installed|be performed|be carried out|is to be|are to be|darf|muss|müssen|sollte|ne doit|doit être|deve essere)\b/i;

function words(text: string): string[] {
  return collapseWhitespace(text).split(/\s+/).filter(Boolean);
}

function stripEdgePunctuation(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
}

/**
 * True when `value` can plausibly be a specification value.
 *
 * Returns true for anything it is not confident about, including short cryptic values — plenty of
 * real specs are terse ("IP20", "B", "M8", "-", "2P").
 */
export function isPlausibleSpecValue(value: string): boolean {
  const text = collapseWhitespace(value);
  if (!text) return false;
  if (CONTROL_CHARACTER_PATTERN.test(value)) return false;
  if (LEADER_RUN_PATTERN.test(text)) return false;
  if (PUNCTUATION_ONLY_PATTERN.test(text) && !/\d/.test(text)) return false;
  if (CSS_DECLARATION_PATTERN.test(text) || CSS_VALUE_KEYWORD_PATTERN.test(text)) return false;
  if (CSS_DECLARATION_TAIL_PATTERN.test(text)) return false;
  if (BOILERPLATE_LABEL_PATTERN.test(text) || BOILERPLATE_TEXT_PATTERN.test(text)) return false;
  if (INSTRUCTION_SENTENCE_PATTERN.test(text)) return false;
  if (COMMERCE_CHROME_PATTERN.test(text)) return false;
  if (RAW_MARKUP_FRAGMENT_PATTERN.test(text)) return false;
  if (FORM_CHROME_PATTERN.test(text)) return false;
  if (LEGAL_DOCUMENT_PATTERN.test(text)) return false;
  if (CODE_FRAGMENT_PATTERN.test(text) || CODE_ESCAPE_PATTERN.test(text) || JS_EXPRESSION_PATTERN.test(text) || JS_ASSIGNMENT_SEQUENCE.test(text) || LINE_COMMENT_PATTERN.test(text) || JS_METHOD_CALL_STATEMENT.test(text) || JS_CALL_WITH_STRING_ARGUMENT.test(text) || CAMEL_CASE_CODE_PATH.test(text)) return false;
  if (hasTornQuoteFragment(text)) return false;
  if (BOOLEAN_LITERAL_VALUE.test(text)) return false;
  if (JS_STATEMENT_VALUE.test(text)) return false;
  if (TRAILING_COMMA_FRAGMENT.test(text)) return false;
  if (LEADING_PREPOSITION_VALUE.test(text) && words(text).length >= 3) return false;
  if (looksLikeDownloadLinkLabel(text)) return false;
  if (looksLikePostalAddress(text)) return false;
  if (UI_CONTROL_PATTERN.test(text) || ASSET_PATH_PATTERN.test(text)) return false;

  const tokens = words(text);
  // Digits mean this is data, not prose — and that matters for more than confidence: several UNIT
  // symbols collide with function words ("A" ampere vs the article, "in" inch, "F" Fahrenheit, "K"
  // kelvin). Without this guard the fragment rules below reject genuine values, which the audit over
  // real vendor documents caught immediately ("Current rating range 0.1...20 A" was being dropped).
  // Prose fragments are recognised by the word-shape rules that do not depend on digits, above.
  const hasDigits = /\d/.test(text);

  // A lone function word ("and", "und", "or") is a fragment, never a value.
  if (!hasDigits && tokens.length === 1 && FUNCTION_WORDS.has(stripEdgePunctuation(tokens[0]))) return false;

  // Sentence-fragment shapes. Both need enough words to be a clause rather than a terse spec, so a
  // real value like "up to" or "max. 5 A" cannot trip them.
  if (tokens.length >= 3) {
    if (CONTINUATION_HEAD_WORDS.has(stripEdgePunctuation(tokens[0]))) return false;
    if (!hasDigits && DANGLING_TAIL_WORDS.has(stripEdgePunctuation(tokens[tokens.length - 1]))) return false;
  }

  // A complete sentence. Long enough that a terse spec ("Max. 5 A", "Type B, C, D") cannot reach it,
  // and it must actually terminate — a spec value does not end in a full stop.
  if (tokens.length >= 6 && /[.!?]["”']?$/.test(text) && /\b(?:is|are|was|were|has|have|can|will|ist|sind|est|sono)\b/i.test(text)) {
    return false;
  }

  // Unbalanced brackets over several words mean the clause was cut mid-way — e.g.
  // 'Certificate LCIE (Laboratoire Central des Industries, File No. E249700, Listed'.
  if (tokens.length >= 4 && (text.match(/\(/g) ?? []).length !== (text.match(/\)/g) ?? []).length) return false;

  return true;
}

/**
 * True when `label` can plausibly be a specification label.
 *
 * A spec label is a noun phrase, not a sentence: it does not start with an article, does not end
 * dangling, is not legal boilerplate, and does not run on for a whole clause.
 */
/**
 * True when a `. ` + capital-letter boundary really separates two sentences instead of just
 * following an abbreviation.
 *
 * A spec label made of abbreviations keeps one or two words per segment ("Est. Ship Weight",
 * "Max. Cont. Current"); running prose puts a whole clause before the period ("Suitable for
 * outdoor use. Rated current"). Three words is the threshold — a clause needs at least that.
 */
function hasProseSentenceBoundary(text: string): boolean {
  const segments = text.split(/(?<=[.!?])\s+(?=\p{Lu})/u);
  if (segments.length < 2) return false;
  return segments.slice(0, -1).some((segment) => words(segment).length >= 3);
}

export function isPlausibleSpecLabel(label: string): boolean {
  const text = collapseWhitespace(label);
  if (!text) return false;
  if (CONTROL_CHARACTER_PATTERN.test(label)) return false;
  if (LEADER_RUN_PATTERN.test(text)) return false;
  if (BOILERPLATE_LABEL_PATTERN.test(text)) return false;
  if (CSS_DECLARATION_PATTERN.test(text)) return false;
  if (COMMERCE_CHROME_PATTERN.test(text)) return false;
  if (RAW_MARKUP_FRAGMENT_PATTERN.test(text)) return false;
  if (FORM_CHROME_PATTERN.test(text)) return false;
  if (LEGAL_DOCUMENT_PATTERN.test(text)) return false;
  if (CODE_FRAGMENT_PATTERN.test(text) || CODE_ESCAPE_PATTERN.test(text) || JS_EXPRESSION_PATTERN.test(text) || JS_ASSIGNMENT_SEQUENCE.test(text) || LINE_COMMENT_PATTERN.test(text) || JS_METHOD_CALL_STATEMENT.test(text) || JS_CALL_WITH_STRING_ARGUMENT.test(text) || CAMEL_CASE_CODE_PATH.test(text)) return false;

  // A label split out of running prose keeps the sentence's opening bracket without its closer.
  const openCount = (text.match(/\(/g) ?? []).length;
  const closeCount = (text.match(/\)/g) ?? []).length;
  if (openCount !== closeCount) return false;

  // Two sentences' worth of text is prose, not a label — but an abbreviation's period is not a
  // sentence end. Saginaw's own weight label is literally "Est. Ship Weight", and datasheets are
  // full of "Max. Current", "No. of Poles", "Approx. Weight": rejecting those threw away published
  // weights, which is how a Saginaw enclosure reached the export with no weight at all.
  if (hasProseSentenceBoundary(text)) return false;

  if (HTML_ATTRIBUTE_NAME_LABEL.test(text)) return false;
  if (SITE_SECTION_LABEL.test(text)) return false;
  if (COMMERCE_META_LABEL.test(text)) return false;
  if (looksLikeDownloadLinkLabel(text)) return false;
  if (QUOTED_LABEL.test(text) || hasTornQuoteFragment(text)) return false;
  if (STYLE_IDENTIFIER_LABEL.test(text)) return false;
  if (DOTTED_IDENTIFIER_LABEL.test(text) || DOTTED_CODE_LABEL.test(text)) return false;
  if (OPERATOR_TAIL_LABEL.test(text)) return false;

  const tokens = words(text);
  const first = stripEdgePunctuation(tokens[0] ?? "");
  // Leading determiner: "The safety and protection", "The technical specifications". No vendor
  // labels a spec row "The …". Requires a SECOND word: a bare single-letter column header ("A",
  // "B") case-folds to the same set ("a"), but real ordering tables genuinely use bare A/B/C/L
  // letters as column names (confirmed on a real Saginaw/SCE floor-stand-kit table) — there is no
  // severed sentence to detect when the label is only one word long.
  if (tokens.length >= 2 && LABEL_LEADING_DETERMINERS.has(first)) return false;
  // Same unit-vs-function-word collision as in isPlausibleSpecValue: a label may legitimately end in
  // a unit ("Rated current in A", "Dimensions in mm", "Torque (A)"), so the dangling-tail rule only
  // applies to digit-free text, where a trailing conjunction really does mean a severed sentence.
  if (!/\d/.test(text) && tokens.length >= 2 && DANGLING_TAIL_WORDS.has(stripEdgePunctuation(tokens[tokens.length - 1]))) {
    return false;
  }
  return true;
}

/**
 * True when `value` is really a row of OTHER column headers, i.e. the table's header row got parsed
 * as data ("Rated current In (A)" = "Part number | Article number | Unit per package").
 *
 * `isKnownLabel` is injected so this module stays a leaf: callers pass their own vocabulary
 * (`field-registry` document labels, `catalog-table-vocabulary`, the ontology…) instead of this
 * module growing a fourth competing label list.
 */
export function looksLikeHeaderRowValue(value: string, isKnownLabel: (candidate: string) => boolean): boolean {
  const text = collapseWhitespace(value);
  if (!text) return false;

  const cells = text
    .split(/\s*\|\s*|\t+/)
    .map((cell) => cell.trim())
    .filter(Boolean);
  if (cells.length >= 2 && cells.every((cell) => !hasValueDigit(cell) && isKnownLabel(cell))) return true;

  // pdf-parse and the DOM sweeps both collapse a header row's separators to plain spaces, so the
  // cell split above finds a single cell. Fall back to greedy longest-match segmentation: if the whole
  // string is nothing but known label phrases butted together, it is a header row, not a value —
  // "Rated current In (A) Part number Article number Unit per package".
  return isFullyCoveredByKnownLabels(text, isKnownLabel);
}

/** A digit that carries data, ignoring a parenthesised unit hint like "In (A)" or "(mm)". */
function hasValueDigit(cell: string): boolean {
  return /\d/.test(cell.replace(/\([^)]*\)/g, ""));
}

const HEADER_SEGMENTATION_MAX_WORDS = 14;
const HEADER_SEGMENTATION_MIN_LABELS = 3;
const HEADER_LABEL_MAX_WORDS = 5;

/**
 * A quantity SYMBOL as printed in a table header next to its label — "Rated current In (A)",
 * "Rated voltage Un", "Rated breaking capacity Icn", "Rated insulation voltage Ui". One capital
 * followed by at most two more letters, at least one of which is lower-case, so ordinary words
 * ("Part", "Unit") and all-caps codes ("IP", "AC") do not qualify.
 */
const QUANTITY_SYMBOL_PATTERN = /^[A-Z][a-z]{1,2}$/;

function isFullyCoveredByKnownLabels(text: string, isKnownLabel: (candidate: string) => boolean): boolean {
  // Parenthesised unit hints ("(A)", "(mm)", "(°C)") are header decoration, not content.
  const stripped = collapseWhitespace(text.replace(/\([^)]*\)/g, " "));
  const tokens = words(stripped);
  if (tokens.length < 2 || tokens.length > HEADER_SEGMENTATION_MAX_WORDS) return false;
  if (hasValueDigit(text)) return false;

  let index = 0;
  let matched = 0;
  let skipped = 0;
  while (index < tokens.length) {
    let consumed = 0;
    // SHORTEST match first, deliberately. A header cell is the smallest recognisable label, and the
    // vocabulary predicates match a label ANYWHERE in the candidate — so taking the longest match
    // first makes "Part number Article" match (on "Part number") and swallow a word belonging to the
    // next cell, leaving an unsegmentable remainder. That is precisely how a real Eaton header row
    // kept escaping detection.
    const maxLength = Math.min(HEADER_LABEL_MAX_WORDS, tokens.length - index);
    for (let length = 1; length <= maxLength; length += 1) {
      if (isKnownLabel(tokens.slice(index, index + length).join(" "))) {
        consumed = length;
        break;
      }
    }
    if (consumed) {
      index += consumed;
      matched += 1;
      continue;
    }
    // A quantity symbol trailing the label we just matched is still header text. Budgeted at one per
    // matched label so an unrecognised stretch of REAL content can never be skipped into looking
    // like a header.
    if (matched > 0 && skipped < matched && QUANTITY_SYMBOL_PATTERN.test(tokens[index])) {
      index += 1;
      skipped += 1;
      continue;
    }
    return false; // a stretch of text that is not a label ⇒ this is real content
  }
  return matched >= HEADER_SEGMENTATION_MIN_LABELS;
}

/**
 * An option value belonging to a DIFFERENT variant of the same product.
 *
 * Ganter's `GN 422-33-RO-RK-K5-SR` page lists both finishes as option codes — `SR - Silver, RAL 9006`
 * and `SW - Black, RAL 9005` — because it also shows thumbnails of sibling variants. Our ordering code
 * ends in `-SR`, so silver is ours; the generic path was reporting the black one. No shape rule can catch
 * that: `Finish = SW - Black, RAL 9005` is a perfectly ordinary pair. The only thing that distinguishes
 * them is the ordering code itself.
 *
 * Two conditions before rejecting, so this cannot fire on ordinary `CODE - description` values (a
 * certificate "CE - Conformité Européenne", a thread "M8 - coarse"):
 *  - the value's code is NOT one of our catalog number's segments, and
 *  - our catalog number DOES carry a segment of the same shape, i.e. it really is an option-coded
 *    ordering number and we can see which option is ours.
 */
const OPTION_CODED_VALUE = /^([A-Z][A-Z0-9]{0,4})\s*[-–—:]\s*\S/;

function catalogSegments(catalogNumber: string): string[] {
  return catalogNumber
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

export function isForeignVariantOptionValue(value: string, catalogNumber: string): boolean {
  const match = OPTION_CODED_VALUE.exec(collapseWhitespace(value).toUpperCase());
  if (!match) return false;
  const code = match[1];
  const segments = catalogSegments(catalogNumber);
  if (segments.includes(code)) return false; // this option IS ours
  // Only trust the comparison when our own ordering number carries a segment of the same shape — that is
  // what tells us it is option-coded at all.
  const sameShape = segments.some(
    (segment) => segment.length === code.length && /^[A-Z]/.test(segment) && segment !== code
  );
  return sameShape;
}

/**
 * The full pair check: both halves plausible on their own, AND not two values sitting next to each other.
 * Prefer this over calling the two predicates separately — the same-shape rule needs both sides.
 */
export function isPlausibleSpecPair(label: string, value: string): boolean {
  if (!isPlausibleSpecLabel(label) || !isPlausibleSpecValue(value)) return false;
  return !isSameShapeValuePair(label, value);
}

/**
 * Kill switch, read at CALL time (not module load) so `scripts/audit-spec-plausibility.ts` can run the
 * real extraction pipeline twice in one process — gated and ungated — and diff the result. Measuring a
 * gate by re-implementing it in the audit tool measures the re-implementation, not the gate.
 *
 * It doubles as an operational escape hatch: if the gate is ever found rejecting a real value on some
 * vendor, `PRODUCT_SCRAPER_DISABLE_SPEC_GATE=1` recovers the old behaviour without a code change.
 */
export function specPlausibilityGateDisabled(): boolean {
  return process.env.PRODUCT_SCRAPER_DISABLE_SPEC_GATE === "1";
}
