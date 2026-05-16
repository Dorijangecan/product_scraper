import fs from "node:fs";
import path from "node:path";

export interface AppPaths {
  rootDir: string;
  dataDir: string;
  cacheDir: string;
  outputDir: string;
  dbPath: string;
}

export function createAppPaths(rootDir = process.cwd()): AppPaths {
  const dataDir = path.join(rootDir, "data");
  const cacheDir = path.join(dataDir, "cache");
  const outputDir = path.join(rootDir, "outputs");
  for (const dir of [dataDir, cacheDir, outputDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return {
    rootDir,
    dataDir,
    cacheDir,
    outputDir,
    dbPath: path.join(dataDir, "scraper.db")
  };
}
