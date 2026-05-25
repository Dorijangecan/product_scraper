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
  constructor(
    private readonly db: ScraperDb,
    private readonly cacheDir: string
  ) {}

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

    const { response, text } = await this.fetchTextWithRetry(url, {
      method,
      body: options.body,
      headers: {
        ...headers
      },
      timeoutMs: options.timeoutMs ?? 30000,
      maxAttempts: options.maxAttempts,
      retryBackoffMs: options.retryBackoffMs,
      signal: options.signal
    });
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
    const cachePath = path.join(this.cacheDir, `${cacheKey}.html`);
    const timeoutSec = Math.max(5, Math.ceil((options.timeoutMs ?? 30000) / 1000));
    const command = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$headers = @{
${powerShellHeaderLines(headers)}
}
$response = Invoke-WebRequest -Uri '${url.replaceAll("'", "''")}' -MaximumRedirection 5 -UseBasicParsing -TimeoutSec ${timeoutSec} -Headers $headers
$content = [string]$response.Content
if ([string]::IsNullOrWhiteSpace($content)) {
  throw "Empty response body from ${url.replaceAll("'", "''")}"
}
[System.IO.File]::WriteAllText('${cachePath.replaceAll("'", "''")}', $content, [System.Text.Encoding]::UTF8)
if (-not (Test-Path -LiteralPath '${cachePath.replaceAll("'", "''")}') -or ((Get-Item -LiteralPath '${cachePath.replaceAll("'", "''")}').Length -lt 32)) {
  throw "Response body was not written to cache"
}
$effectiveUrl = if ($response.BaseResponse -and $response.BaseResponse.ResponseUri) { $response.BaseResponse.ResponseUri.AbsoluteUri } else { '${url.replaceAll("'", "''")}' }
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
        signal: options.signal
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
        if (response.status >= 500 && attempt < maxAttempts) {
          await delay(retryBackoffMs * attempt, options.signal);
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
      const { response, buffer } = await this.fetchBufferWithRetry(url, {
        method: "GET",
        headers: {
          "user-agent": DEFAULT_USER_AGENT,
          accept: "*/*"
        },
        timeoutMs: 90000,
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
    try {
      await execFileAsync(
        curl,
        ["-L", "--fail", "--retry", "2", "--retry-delay", "2", "--max-time", "120", "-A", DEFAULT_USER_AGENT, "-o", outputPath, url],
        {
          timeout: 130000,
          maxBuffer: 1024 * 1024,
          signal
        }
      );
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
        const buffer = Buffer.from(await response.arrayBuffer());
        if (response.status >= 500 && attempt < maxAttempts) {
          await delay(750 * attempt, options.signal);
          continue;
        }
        return { response, buffer };
      } catch (error) {
        if (options.signal?.aborted) throw new Error("Cancelled by user.");
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

  private async fetchWithRetry(
    url: string,
    options: {
      method: "GET" | "POST";
      body?: URLSearchParams | string;
      headers: Record<string, string>;
      timeoutMs: number;
      signal?: AbortSignal;
    }
  ): Promise<Response> {
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
        if (response.status >= 500 && attempt < maxAttempts) {
          await delay(750 * attempt, options.signal);
          continue;
        }
        return response;
      } catch (error) {
        if (options.signal?.aborted) throw new Error("Cancelled by user.");
        lastError = error;
        if (attempt < maxAttempts) {
          await delay(750 * attempt, options.signal);
          continue;
        }
      } finally {
        request.cleanup();
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Fetch failed");
  }
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
