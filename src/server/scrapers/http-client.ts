import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import sanitize from "sanitize-filename";
import sharp from "sharp";
import type { ScraperDb } from "../db.js";

const execFileAsync = promisify(execFile);
const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface FetchedText {
  requestedUrl: string;
  effectiveUrl: string;
  statusCode: number;
  contentType: string;
  text: string;
  fetchedAt: string;
  fromCache: boolean;
}

export class CachedHttpClient {
  private readonly hostQueues = new Map<string, Promise<void>>();
  private readonly hostNextAvailable = new Map<string, number>();
  /**
   * Self-tuning politeness: extra delay added on top of `hostMinIntervalMs` for a specific
   * host. Grows (exponentially) every time the host answers 429/503 and decays back toward
   * zero on healthy responses, so a run that starts hammering a rate-limiting host slows down
   * automatically instead of cascading into a wall of `failed` items.
   */
  private readonly hostPenaltyMs = new Map<string, number>();
  private hostMinIntervalMs = 350;
  private static readonly MAX_HOST_PENALTY_MS = 10000;

  constructor(
    private readonly db: ScraperDb,
    readonly cacheDir: string
  ) {}

  setHostMinIntervalMs(ms: number) {
    this.hostMinIntervalMs = Math.max(0, ms);
  }

  /**
   * Feed an observed response status back into the adaptive per-host throttle. 429/503 grow
   * the host penalty; any healthy (<400) response decays it. Called for every fetch/download
   * response so all hosts benefit, not just the ones with a dedicated connector.
   */
  private recordHostThrottleSignal(url: string, statusCode: number) {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return;
    }
    const current = this.hostPenaltyMs.get(host) ?? 0;
    if (statusCode === 429 || statusCode === 503) {
      const grown = current === 0 ? 1000 : current * 2;
      this.hostPenaltyMs.set(host, Math.min(grown, CachedHttpClient.MAX_HOST_PENALTY_MS));
    } else if (statusCode < 400 && current > 0) {
      const decayed = Math.floor(current / 2);
      if (decayed < 250) this.hostPenaltyMs.delete(host);
      else this.hostPenaltyMs.set(host, decayed);
    }
  }

  private async acquireHostSlot(url: string): Promise<void> {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return;
    }
    const interval = this.hostMinIntervalMs + (this.hostPenaltyMs.get(host) ?? 0);
    if (interval <= 0) return;
    const previous = this.hostQueues.get(host) ?? Promise.resolve();
    const next = previous.then(async () => {
      const earliest = this.hostNextAvailable.get(host) ?? 0;
      const now = Date.now();
      const waitMs = earliest - now;
      if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      this.hostNextAvailable.set(host, Date.now() + interval);
    });
    this.hostQueues.set(host, next.catch(() => undefined));
    await next;
  }

  async fetchText(
    url: string,
    options: {
      method?: "GET" | "POST";
      body?: URLSearchParams | string;
      headers?: Record<string, string>;
      timeoutMs?: number;
      cache?: boolean;
      cacheTtlMs?: number;
      maxAttempts?: number;
      retryBackoffMs?: number;
      signal?: AbortSignal;
    } = {}
  ): Promise<FetchedText> {
    throwIfAborted(options.signal);
    const method = options.method ?? "GET";
    const bodyText = options.body instanceof URLSearchParams ? options.body.toString() : options.body ?? "";
    const headers = {
      "user-agent": DEFAULT_USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
      ...options.headers
    };
    const requestHash = hash(`${method}\n${url}\n${bodyText}\n${headerFingerprint(headers)}`);
    const cacheKey = requestHash;
    const useCache = options.cache ?? true;
    const cached = useCache ? this.db.getPageCache(cacheKey) : undefined;
    if (cached && isCacheFresh(cached.fetched_at, options.cacheTtlMs) && isCacheableTextStatus(cached.status_code)) {
      try {
        const text = await fs.readFile(cached.path, "utf8");
        if (!text.trim()) throw new Error("Empty cached response");
        return {
          requestedUrl: url,
          effectiveUrl: cached.effective_url ?? url,
          statusCode: cached.status_code ?? 200,
          contentType: cached.content_type ?? "text/html",
          text,
          fetchedAt: cached.fetched_at,
          fromCache: true
        };
      } catch {
        // Cache row is stale; fetch again and overwrite it.
      }
    }

    await this.acquireHostSlot(url);
    let response: Response;
    let text: string;
    try {
      ({ response, text } = await this.fetchTextWithRetry(url, {
        method,
        body: options.body,
        headers: {
          ...headers
        },
        timeoutMs: options.timeoutMs ?? 30000,
        maxAttempts: options.maxAttempts,
        retryBackoffMs: options.retryBackoffMs,
        signal: options.signal
      }));
    } catch (error) {
      if (method === "GET") {
        return this.fetchTextViaCurl(url, {
          headers,
          timeoutMs: options.timeoutMs ?? 30000,
          cache: useCache,
          cacheTtlMs: options.cacheTtlMs,
          signal: options.signal
        }, error);
      }
      throw error;
    }
    if (method === "GET" && isRetryableStatus(response.status)) {
      return this.fetchTextViaCurl(url, {
        headers,
        timeoutMs: options.timeoutMs ?? 30000,
        cache: useCache,
        cacheTtlMs: options.cacheTtlMs,
        signal: options.signal
      }, new Error(`HTTP ${response.status}`));
    }
    const fetchedAt = new Date().toISOString();
    const contentType = response.headers.get("content-type") ?? "";
    const cachePath = path.join(this.cacheDir, `${cacheKey}.html`);
    await fs.mkdir(this.cacheDir, { recursive: true });
    if (useCache && shouldCacheTextResponse(response.status, text)) {
      await fs.writeFile(cachePath, text, "utf8");
      this.db.setPageCache({
        cache_key: cacheKey,
        method,
        url,
        request_hash: requestHash,
        path: cachePath,
        status_code: response.status,
        content_type: contentType,
        effective_url: response.url || url,
        fetched_at: fetchedAt
      });
    }
    return {
      requestedUrl: url,
      effectiveUrl: response.url || url,
      statusCode: response.status,
      contentType,
      text,
      fetchedAt,
      fromCache: false
    };
  }

  async fetchTextViaPowerShell(
    url: string,
    options: {
      headers?: Record<string, string>;
      timeoutMs?: number;
      cache?: boolean;
      cacheTtlMs?: number;
      signal?: AbortSignal;
    } = {}
  ): Promise<FetchedText> {
    throwIfAborted(options.signal);
    const method = "GET";
    const headers = {
      "User-Agent": DEFAULT_USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      ...options.headers
    };
    const requestHash = hash(`POWERSHELL\n${method}\n${url}\n${headerFingerprint(headers)}`);
    const cacheKey = requestHash;
    const useCache = options.cache ?? true;
    const cached = useCache ? this.db.getPageCache(cacheKey) : undefined;
    if (cached && isCacheFresh(cached.fetched_at, options.cacheTtlMs) && isCacheableTextStatus(cached.status_code)) {
      try {
        const text = await fs.readFile(cached.path, "utf8");
        if (!text.trim()) throw new Error("Empty cached response");
        return {
          requestedUrl: url,
          effectiveUrl: cached.effective_url ?? url,
          statusCode: cached.status_code ?? 200,
          contentType: cached.content_type ?? "text/html",
          text,
          fetchedAt: cached.fetched_at,
          fromCache: true
        };
      } catch {
        // Cache row is stale; fetch again and overwrite it.
      }
    }

    await fs.mkdir(this.cacheDir, { recursive: true });
    await this.acquireHostSlot(url);
    const cachePath = path.join(this.cacheDir, `${cacheKey}.html`);
    const timeoutSec = Math.max(5, Math.ceil((options.timeoutMs ?? 30000) / 1000));
    // Defense-in-depth: pass URL and cache path via environment variables instead of
    // string-interpolating them into the PowerShell script. Single-quoted PS strings do not
    // expand $(...) so the prior escape was already safe, but env vars eliminate the entire
    // class of "what if a future change uses double quotes" hazard.
    const command = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$url = $env:SCRAPER_PS_URL
$cachePath = $env:SCRAPER_PS_CACHE_PATH
$headers = @{
${powerShellHeaderLines(headers)}
}
$response = Invoke-WebRequest -Uri $url -MaximumRedirection 5 -UseBasicParsing -TimeoutSec ${timeoutSec} -Headers $headers
$content = [string]$response.Content
if ([string]::IsNullOrWhiteSpace($content)) {
  throw "Empty response body from $url"
}
[System.IO.File]::WriteAllText($cachePath, $content, [System.Text.Encoding]::UTF8)
if (-not (Test-Path -LiteralPath $cachePath) -or ((Get-Item -LiteralPath $cachePath).Length -lt 32)) {
  throw "Response body was not written to cache"
}
$effectiveUrl = if ($response.BaseResponse -and $response.BaseResponse.ResponseUri) { $response.BaseResponse.ResponseUri.AbsoluteUri } else { $url }
$contentType = if ($response.Headers['Content-Type']) { [string]$response.Headers['Content-Type'] } else { '' }
[pscustomobject]@{
  StatusCode = [int]$response.StatusCode
  EffectiveUrl = $effectiveUrl
  ContentType = $contentType
} | ConvertTo-Json -Compress
`;
    const encodedCommand = Buffer.from(command, "utf16le").toString("base64");
    let stdout: string;
    try {
      const result = await execFileAsync("powershell.exe", ["-NoProfile", "-EncodedCommand", encodedCommand], {
        timeout: (options.timeoutMs ?? 30000) + 5000,
        maxBuffer: 1024 * 1024,
        signal: options.signal,
        env: { ...process.env, SCRAPER_PS_URL: url, SCRAPER_PS_CACHE_PATH: cachePath }
      });
      stdout = result.stdout;
    } catch (error) {
      if (options.signal?.aborted) throw new Error("Cancelled by user.");
      const details = cleanPowerShellError(readExecErrorOutput(error));
      throw new Error(`PowerShell fetch failed for ${url}: ${details || "request failed"}`);
    }
    const metadata = JSON.parse(stdout.trim()) as { StatusCode: number; EffectiveUrl?: string; ContentType?: string };
    const text = await fs.readFile(cachePath, "utf8");
    if (!text.trim()) {
      throw new Error(`Empty response body from ${url}`);
    }
    const fetchedAt = new Date().toISOString();
    if (useCache && shouldCacheTextResponse(metadata.StatusCode, text)) {
      this.db.setPageCache({
        cache_key: cacheKey,
        method: "POWERSHELL_GET",
        url,
        request_hash: requestHash,
        path: cachePath,
        status_code: metadata.StatusCode,
        content_type: metadata.ContentType ?? "",
        effective_url: metadata.EffectiveUrl ?? url,
        fetched_at: fetchedAt
      });
    }
    return {
      requestedUrl: url,
      effectiveUrl: metadata.EffectiveUrl ?? url,
      statusCode: metadata.StatusCode,
      contentType: metadata.ContentType ?? "",
      text,
      fetchedAt,
      fromCache: false
    };
  }

  async fetchTextViaCurl(
    url: string,
    options: {
      headers?: Record<string, string>;
      timeoutMs?: number;
      cache?: boolean;
      cacheTtlMs?: number;
      signal?: AbortSignal;
    } = {},
    cause?: unknown
  ): Promise<FetchedText> {
    throwIfAborted(options.signal);
    const method = "CURL_GET";
    const headers = {
      "user-agent": DEFAULT_USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
      ...options.headers
    };
    const requestHash = hash(`CURL\nGET\n${url}\n${headerFingerprint(headers)}`);
    const cacheKey = requestHash;
    const useCache = options.cache ?? true;
    const cached = useCache ? this.db.getPageCache(cacheKey) : undefined;
    if (cached && isCacheFresh(cached.fetched_at, options.cacheTtlMs) && isCacheableTextStatus(cached.status_code)) {
      try {
        const text = await fs.readFile(cached.path, "utf8");
        if (!text.trim()) throw new Error("Empty cached response");
        return {
          requestedUrl: url,
          effectiveUrl: cached.effective_url ?? url,
          statusCode: cached.status_code ?? 200,
          contentType: cached.content_type ?? "text/html",
          text,
          fetchedAt: cached.fetched_at,
          fromCache: true
        };
      } catch {
        // Cache row is stale; fetch again and overwrite it.
      }
    }

    await fs.mkdir(this.cacheDir, { recursive: true });
    await this.acquireHostSlot(url);
    const cachePath = path.join(this.cacheDir, `${cacheKey}.html`);
    const curl = process.platform === "win32" ? "curl.exe" : "curl";
    const timeoutSec = Math.max(5, Math.ceil((options.timeoutMs ?? 30000) / 1000));
    const args = ["-L", "--fail", "--retry", "1", "--retry-delay", "1", "--max-time", String(timeoutSec)];
    if (process.platform === "win32") args.push("--ssl-no-revoke");
    for (const [name, value] of Object.entries(headers)) {
      if (/^user-agent$/i.test(name)) args.push("-A", value);
      else args.push("-H", `${name}: ${value}`);
    }
    args.push("-o", cachePath, url);
    try {
      await execFileAsync(curl, args, {
        timeout: (options.timeoutMs ?? 30000) + 5000,
        maxBuffer: 1024 * 1024,
        signal: options.signal
      });
      const text = await fs.readFile(cachePath, "utf8");
      if (!text.trim()) throw new Error(`Empty response body from ${url}`);
      const fetchedAt = new Date().toISOString();
      if (useCache && shouldCacheTextResponse(200, text)) {
        this.db.setPageCache({
          cache_key: cacheKey,
          method,
          url,
          request_hash: requestHash,
          path: cachePath,
          status_code: 200,
          content_type: "text/html",
          effective_url: url,
          fetched_at: fetchedAt
        });
      }
      return {
        requestedUrl: url,
        effectiveUrl: url,
        statusCode: 200,
        contentType: "text/html",
        text,
        fetchedAt,
        fromCache: false
      };
    } catch (error) {
      if (options.signal?.aborted) throw new Error("Cancelled by user.");
      const message = error instanceof Error ? error.message : "curl fetch failed";
      const original = cause instanceof Error ? cause.message : undefined;
      throw new Error(original ? `${original}; curl fallback failed: ${message}` : message);
    }
  }

  private async fetchTextWithRetry(
    url: string,
    options: {
      method: "GET" | "POST";
      body?: URLSearchParams | string;
      headers: Record<string, string>;
      timeoutMs: number;
      maxAttempts?: number;
      retryBackoffMs?: number;
      signal?: AbortSignal;
    }
  ): Promise<{ response: Response; text: string }> {
    let lastError: unknown;
    const maxAttempts = options.maxAttempts ?? 2;
    const retryBackoffMs = options.retryBackoffMs ?? 750;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      throwIfAborted(options.signal);
      const request = createRequestAbort(options.timeoutMs, options.signal);
      try {
        const response = await fetch(url, {
          method: options.method,
          body: options.body,
          headers: options.headers,
          redirect: "follow",
          signal: request.signal
        });
        const text = await response.text();
        this.recordHostThrottleSignal(url, response.status);
        if (isRetryableStatus(response.status) && attempt < maxAttempts) {
          await delay(retryDelayMs(response, retryBackoffMs, attempt), options.signal);
          continue;
        }
        return { response, text };
      } catch (error) {
        if (options.signal?.aborted) throw new Error("Cancelled by user.");
        lastError = error;
        if (attempt < maxAttempts) {
          await delay(retryBackoffMs * attempt, options.signal);
          continue;
        }
      } finally {
        request.cleanup();
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Fetch failed");
  }

  async downloadFile(url: string, targetDir: string, suggestedName?: string, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    await fs.mkdir(targetDir, { recursive: true });
    const finalName = sanitizeFileName(suggestedName || filenameFromUrl(url));
    let outputPath = path.join(targetDir, finalName);
    let index = 2;
    while (await exists(outputPath)) {
      const parsed = path.parse(finalName);
      outputPath = path.join(targetDir, `${parsed.name}-${index}${parsed.ext}`);
      index += 1;
    }

    try {
      await this.acquireHostSlot(url);
      const { response, buffer } = await this.fetchBufferWithRetry(url, {
        method: "GET",
        headers: {
          "user-agent": DEFAULT_USER_AGENT,
          accept: "*/*"
        },
        timeoutMs: 90000,
        // Over this size we don't buffer into memory; the catch below streams to disk via curl.
        maxBytes: MAX_IN_MEMORY_DOWNLOAD_BYTES,
        signal
      });
      if (!response.ok) {
        throw new Error(`Download failed with HTTP ${response.status}`);
      }
      await fs.writeFile(outputPath, buffer);
    } catch (error) {
      if (signal?.aborted) throw new Error("Cancelled by user.");
      await this.downloadFileViaCurl(url, outputPath, signal, error);
    }
    return outputPath;
  }

  async downloadImageAsPng(url: string | string[], outputPath: string, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const urls = [...new Set((Array.isArray(url) ? url : splitCandidateUrls(url)).map((item) => item.trim()).filter(Boolean))];
    let lastError: unknown;
    for (const candidateUrl of urls) {
      try {
        return await this.downloadOneImageAsPng(candidateUrl, outputPath, signal);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Image download failed for every candidate URL");
  }

  private async downloadOneImageAsPng(url: string, outputPath: string, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    let buffer: Buffer;
    try {
      await this.acquireHostSlot(url);
      const result = await this.fetchBufferWithRetry(url, {
        method: "GET",
        headers: {
          "user-agent": DEFAULT_USER_AGENT,
          accept: "image/avif,image/webp,image/png,image/jpeg,image/svg+xml,image/*,*/*;q=0.8"
        },
        timeoutMs: 20000,
        signal
      });
      if (!result.response.ok) throw new Error(`Image download failed with HTTP ${result.response.status}`);
      buffer = result.buffer;
    } catch (error) {
      if (signal?.aborted) throw new Error("Cancelled by user.");
      const temporaryPath = `${outputPath}.download`;
      await this.downloadFileViaCurl(url, temporaryPath, signal, error);
      buffer = await fs.readFile(temporaryPath);
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }

    await sharp(buffer, { animated: false }).png().toFile(outputPath);
    return outputPath;
  }

  private async downloadFileViaCurl(url: string, outputPath: string, signal?: AbortSignal, cause?: unknown): Promise<void> {
    const curl = process.platform === "win32" ? "curl.exe" : "curl";
    // On Windows, schannel often returns CRYPT_E_NO_REVOCATION_CHECK (0x80092012) when the OCSP
    // responder or CRL endpoint is unreachable (corp proxy, restricted firewall, slow DNS).
    // That error completely blocks legitimate downloads from cdn.productimages.abb.com,
    // assets.balluff.com, and other large CDNs. `--ssl-no-revoke` tells curl to skip the
    // revocation-status check (without weakening cert chain validation) which is the
    // documented workaround for this exact error code.
    const args = ["-L", "--fail", "--retry", "2", "--retry-delay", "2", "--max-time", "120", "-A", DEFAULT_USER_AGENT];
    if (process.platform === "win32") args.push("--ssl-no-revoke");
    args.push("-o", outputPath, url);
    try {
      await execFileAsync(curl, args, {
        timeout: 130000,
        maxBuffer: 1024 * 1024,
        signal
      });
      const stat = await fs.stat(outputPath);
      if (stat.size === 0) throw new Error("Downloaded file is empty");
    } catch (error) {
      await fs.rm(outputPath, { force: true }).catch(() => {});
      if (signal?.aborted) throw new Error("Cancelled by user.");
      const message = error instanceof Error ? error.message : "curl download failed";
      const original = cause instanceof Error ? cause.message : undefined;
      throw new Error(original ? `${original}; curl fallback failed: ${message}` : message);
    }
  }

  private async fetchBufferWithRetry(
    url: string,
    options: {
      method: "GET" | "POST";
      body?: URLSearchParams | string;
      headers: Record<string, string>;
      timeoutMs: number;
      signal?: AbortSignal;
      maxBytes?: number;
    }
  ): Promise<{ response: Response; buffer: Buffer }> {
    let lastError: unknown;
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      throwIfAborted(options.signal);
      const request = createRequestAbort(options.timeoutMs, options.signal);
      try {
        const response = await fetch(url, {
          method: options.method,
          body: options.body,
          headers: options.headers,
          redirect: "follow",
          signal: request.signal
        });
        // Guard against buffering an enormous file (e.g. a 200 MB catalog brochure) into memory.
        // If the server declares an over-limit size, bail before arrayBuffer() so the caller can
        // stream it to disk via the curl fallback instead. Non-retryable: retrying re-reads the
        // same too-large body.
        if (options.maxBytes) {
          const declared = Number(response.headers.get("content-length"));
          if (Number.isFinite(declared) && declared > options.maxBytes) {
            const tooLarge = new Error(`Response body ${declared} bytes exceeds max ${options.maxBytes} bytes for ${url}`);
            (tooLarge as { nonRetryable?: boolean }).nonRetryable = true;
            throw tooLarge;
          }
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        this.recordHostThrottleSignal(url, response.status);
        if (isRetryableStatus(response.status) && attempt < maxAttempts) {
          await delay(retryDelayMs(response, 750, attempt), options.signal);
          continue;
        }
        return { response, buffer };
      } catch (error) {
        if (options.signal?.aborted) throw new Error("Cancelled by user.");
        if ((error as { nonRetryable?: boolean } | undefined)?.nonRetryable) throw error;
        lastError = error;
        if (attempt < maxAttempts) {
          await delay(750 * attempt, options.signal);
          continue;
        }
      } finally {
        request.cleanup();
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Download failed");
  }

}

/**
 * Retry on transient server / rate-limit statuses. 429 (Too Many Requests) and 503 (Service
 * Unavailable) are explicitly included alongside 5xx and 408 so a polite backoff kicks in for
 * EVERY fetch, not just the connectors (ABB/Schneider) that special-case them by hand.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Backoff for a retryable response: honor a server-sent `Retry-After` (seconds or HTTP date)
 * when present, otherwise exponential backoff with jitter. Capped so a misbehaving header
 * can't stall a run for minutes.
 */
function retryDelayMs(response: Response, baseBackoffMs: number, attempt: number): number {
  const MAX_RETRY_DELAY_MS = 30000;
  const retryAfter = parseRetryAfterMs(response);
  if (retryAfter !== undefined) return Math.min(retryAfter, MAX_RETRY_DELAY_MS);
  const exponential = baseBackoffMs * attempt;
  const jitter = Math.floor(exponential * 0.25 * ((attempt * 2654435761) % 1000) / 1000);
  return Math.min(exponential + jitter, MAX_RETRY_DELAY_MS);
}

export function parseRetryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

function hash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function headerFingerprint(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), value] as const)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join("\n");
}

function powerShellHeaderLines(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([key, value]) => `  '${escapePowerShellString(key)}' = '${escapePowerShellString(value)}'`)
    .join("\n");
}

function escapePowerShellString(value: string): string {
  return value.replaceAll("'", "''");
}

function filenameFromResponse(response: Response, url: string): string {
  const disposition = response.headers.get("content-disposition");
  const fromHeader = disposition?.match(/filename="?([^";]+)"?/i)?.[1];
  if (fromHeader) return fromHeader;
  const parsed = new URL(url);
  const base = path.basename(parsed.pathname);
  return base || `${hash(url).slice(0, 12)}.bin`;
}

function filenameFromUrl(url: string): string {
  const parsed = new URL(url);
  const base = path.basename(parsed.pathname);
  return base || `${hash(url).slice(0, 12)}.bin`;
}

function sanitizeFileName(name: string): string {
  const clean = sanitize(name).trim();
  return clean || "download.bin";
}

function splitCandidateUrls(url: string): string[] {
  const values = url
    .split("||")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length ? [...new Set(values)] : [url];
}

function readExecErrorOutput(error: unknown): string {
  if (error && typeof error === "object") {
    const stderr = "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
    if (stderr.trim()) return stderr;
    const stdout = "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "") : "";
    if (stdout.trim()) return stdout;
  }
  return error instanceof Error ? error.message : String(error);
}

function cleanPowerShellError(value: string): string {
  const decoded = value
    .replace(/_x000D__x000A_/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
  const matches = [...decoded.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)]
    .map((match) => match[1].replace(/<[^>]+>/g, " ").trim())
    .filter(Boolean);
  const message = (matches.length ? matches.join(" ") : decoded.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  return message.slice(0, 500);
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Cancelled by user.");
}

function createRequestAbort(timeoutMs: number, externalSignal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  if (externalSignal?.aborted) abort();
  externalSignal?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abort);
    }
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isCacheFresh(fetchedAt: string, cacheTtlMs: number | undefined): boolean {
  const ttlMs = cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  if (ttlMs <= 0) return false;
  const fetchedTime = Date.parse(fetchedAt);
  if (!Number.isFinite(fetchedTime)) return false;
  return Date.now() - fetchedTime <= ttlMs;
}

function isCacheableTextStatus(statusCode: number | undefined): boolean {
  const status = statusCode ?? 200;
  return status >= 200 && status < 400;
}

function shouldCacheTextResponse(statusCode: number | undefined, text: string): boolean {
  return isCacheableTextStatus(statusCode) && text.trim().length > 0;
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timeout: NodeJS.Timeout;
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new Error("Cancelled by user."));
    };
    if (signal?.aborted) {
      reject(new Error("Cancelled by user."));
      return;
    }
    timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

// Above this declared content-length we refuse to buffer a download into memory (a single
// oversized catalog brochure × concurrent items could otherwise exhaust RAM). Such files are
// instead streamed straight to disk by the curl fallback in downloadFile().
const MAX_IN_MEMORY_DOWNLOAD_BYTES = 96 * 1024 * 1024;
