const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const electronExe = path.join(rootDir, "node_modules", "electron", "dist", "electron.exe");
const electronCli = process.platform === "win32"
  ? electronExe
  : path.join(rootDir, "node_modules", ".bin", "electron");
const mainScript = path.join(rootDir, "src", "desktop", "main.cjs");

const build = spawnSync(process.execPath, [path.join(rootDir, "scripts", "ensure-desktop-build.cjs")], {
  cwd: rootDir,
  stdio: "inherit"
});
if (build.status !== 0) process.exit(build.status ?? 1);

if (!fs.existsSync(electronCli)) {
  console.error(`Electron nije pronadjen: ${electronCli}`);
  console.error("Pokreni npm install pa probaj ponovo.");
  process.exit(1);
}

console.log("Starting Electron...");
const app = spawnSync(electronCli, [mainScript], {
  cwd: rootDir,
  env: process.env,
  stdio: "inherit",
  windowsHide: false
});

if (app.error) {
  console.error(`Electron se nije mogao pokrenuti: ${app.error.message}`);
  process.exit(1);
}

process.exit(app.status ?? 0);
