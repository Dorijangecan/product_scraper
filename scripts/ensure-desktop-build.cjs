const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const distIndex = path.join(rootDir, "dist", "index.html");
const watchedDirs = [
  path.join(rootDir, "src", "client"),
  path.join(rootDir, "src", "shared"),
  path.join(rootDir, "index.html"),
  path.join(rootDir, "vite.config.ts")
];

function newestMtime(target) {
  try {
    const stat = fs.statSync(target);
    if (stat.isFile()) return stat.mtimeMs;
    if (stat.isDirectory()) {
      let max = stat.mtimeMs;
      for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        const child = path.join(target, entry.name);
        const childMax = newestMtime(child);
        if (childMax > max) max = childMax;
      }
      return max;
    }
  } catch {
    return 0;
  }
  return 0;
}

function isBuildStale() {
  if (!fs.existsSync(distIndex)) return true;
  const distMtime = fs.statSync(distIndex).mtimeMs;
  for (const target of watchedDirs) {
    if (newestMtime(target) > distMtime) return true;
  }
  return false;
}

if (isBuildStale()) {
  console.log("Desktop build is missing or stale (client/shared changed since last build). Rebuilding frontend...");
  const result = spawnSync("npm", ["run", "build:frontend"], {
    cwd: rootDir,
    shell: true,
    stdio: "inherit"
  });
  process.exit(result.status ?? 1);
}

console.log("Desktop build is up to date.");
