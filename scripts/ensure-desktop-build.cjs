const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const distIndex = path.join(rootDir, "dist", "index.html");

if (!fs.existsSync(distIndex)) {
  console.log("Desktop build is missing. Building frontend...");
  const result = spawnSync("npm", ["run", "build:frontend"], {
    cwd: rootDir,
    shell: true,
    stdio: "inherit"
  });
  process.exit(result.status ?? 1);
}

console.log("Desktop build found.");
