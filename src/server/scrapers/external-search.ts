/**
 * What a person does when the vendor's own search is unusable: they give up on it and search the web
 * (COLD-START-PLAN §6.2, P4.12).
 *
 * **Off by default, and deliberately last in the plan.** Two independent reasons, both of which must
 * survive any later refactor:
 *
 * 1. **Privacy.** A query leaves this machine carrying the customer's catalog number and the vendor's
 *    domain. That is contrary to the "everything local, no cloud key" principle in PROJECT_MAP §1, so
 *    it is gated on an explicit opt-in exactly like the existing external reader
 *    (`PRODUCT_SCRAPER_ALLOW_EXTERNAL_READER`).
 * 2. **It would hide our own bugs.** Enabled early, it would paper over every weakness P4.1–P4.11
 *    exist to fix, and we would never again be able to tell whether our own discovery works.
 *
 * What it does NOT change: nothing here can publish anything. Every URL it returns still passes the
 * caller's official-domain guard and then the same post-fetch identity gate as every other candidate.
 * It widens where we may look, never what we may believe.
 */
import * as cheerio from "cheerio";
import type { FetchedText } from "./http-client.js";

export const EXTERNAL_SEARCH_ENV = "PRODUCT_SCRAPER_ALLOW_EXTERNAL_SEARCH";

export function externalSearchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[EXTERNAL_SEARCH_ENV];
  return value === "1" || value?.toLowerCase() === "true";
}

/**
 * DuckDuckGo's no-JavaScript endpoint. Chosen because it answers a plain GET with plain HTML, needs
 * no key, and sets no cookie — so the opt-in sends one query and nothing else.
 */
export function externalSearchUrl(hosts: string[], catalogNumber: string): string | undefined {
  const site = hosts
    .map((host) => host.trim().replace(/^www\./i, ""))
    .filter(Boolean)
    .slice(0, 2)
    .map((host) => `site:${host}`)
    .join(" OR ");
  if (!site || !catalogNumber.trim()) return undefined;
  const query = `${site} "${catalogNumber.trim()}"`;
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
}

/**
 * Pull the result links out of the answer.
 *
 * DuckDuckGo wraps each hit in a redirect (`/l/?uddg=<encoded target>`), so the real URL has to be
 * unwrapped — otherwise every candidate would be on duckduckgo.com and the caller's official-domain
 * guard would (correctly) reject all of them.
 */
export function parseExternalSearchResults(fetched: Pick<FetchedText, "text">, limit = 5): string[] {
  const $ = cheerio.load(fetched.text ?? "");
  const urls: string[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, element) => {
    if (urls.length >= limit) return;
    const href = $(element).attr("href") ?? "";
    const target = unwrapRedirect(href);
    if (!target || !/^https?:\/\//i.test(target)) return;
    // The engine's own pages are navigation, not results.
    if (/(?:^|\.)duckduckgo\.com$/i.test(hostOf(target) ?? "")) return;
    const key = target.replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    urls.push(target);
  });
  return urls;
}

function unwrapRedirect(href: string): string | undefined {
  try {
    const absolute = href.startsWith("//") ? `https:${href}` : href;
    const parsed = new URL(absolute, "https://html.duckduckgo.com/");
    const wrapped = parsed.searchParams.get("uddg");
    if (wrapped) return wrapped;
    return /^https?:$/i.test(parsed.protocol) ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}
