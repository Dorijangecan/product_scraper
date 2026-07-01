// Leaf URL-comparison utilities. No imports from the server subtree.
//
// These consolidate identical private `sameUrl`/`sameUrlOriginAndPath` copies. They are kept
// as THREE distinct functions on purpose — the call sites relied on genuinely different
// semantics (whether the query string and trailing slash matter, and case sensitivity), so
// collapsing them into one options-bag would risk silently changing URL matching. A couple of
// connector-local variants (eaton, scame) differ further still and are intentionally left in place.

/**
 * Equal when origin + path (trailing slash ignored) + query all match, case-insensitively.
 * Fallback on unparseable input: trailing-slash-stripped, lowercased string compare.
 * (Used by the Excel export and run-item summary.)
 */
export function sameNormalizedUrl(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return (
      leftUrl.origin.toLowerCase() === rightUrl.origin.toLowerCase() &&
      leftUrl.pathname.replace(/\/+$/, "").toLowerCase() === rightUrl.pathname.replace(/\/+$/, "").toLowerCase() &&
      leftUrl.searchParams.toString() === rightUrl.searchParams.toString()
    );
  } catch {
    return left.replace(/\/+$/, "").toLowerCase() === right.replace(/\/+$/, "").toLowerCase();
  }
}

/**
 * Equal when the full URLs match after stripping the hash (query string DOES matter),
 * case-insensitively. Returns false if either side is missing. Fallback: trimmed lowercase compare.
 */
export function sameUrlIgnoringHash(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    leftUrl.hash = "";
    rightUrl.hash = "";
    return leftUrl.toString().toLowerCase() === rightUrl.toString().toLowerCase();
  } catch {
    return left.trim().toLowerCase() === right.trim().toLowerCase();
  }
}

/**
 * Equal when origin + path match, CASE-SENSITIVELY (query ignored). Returns false on
 * unparseable input. (Used by evidence + technical-attribute source matching.)
 */
export function sameUrlOriginAndPath(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return leftUrl.origin === rightUrl.origin && leftUrl.pathname === rightUrl.pathname;
  } catch {
    return false;
  }
}
