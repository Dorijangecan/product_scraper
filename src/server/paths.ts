import fs from "node:fs";
import path from "node:path";

export interface AppPaths {
  rootDir: string;
  dataDir: string;
  cacheDir: string;
  outputDir: string;
  customerUploadsDir: string;
  dbPath: string;
}

export function createAppPaths(rootDir = process.cwd()): AppPaths {
  const dataDir = path.join(rootDir, "data");
  const cacheDir = path.join(dataDir, "cache");
  const outputDir = path.join(rootDir, "outputs");
  const customerUploadsDir = path.join(dataDir, "customer-uploads");
  for (const dir of [dataDir, cacheDir, outputDir, customerUploadsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return {
    rootDir,
    dataDir,
    cacheDir,
    outputDir,
    customerUploadsDir,
    dbPath: path.join(dataDir, "scraper.db")
  };
}
