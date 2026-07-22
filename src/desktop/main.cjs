const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "../..");
const dataDir = path.join(rootDir, "data");
const serverLogPath = path.join(dataDir, "desktop-server.log");
const desktopSettingsPath = path.join(dataDir, "desktop-settings.json");
const serverStartupTimeoutMs = 300000;

let serverProcess;
let mainWindow;

app.setName("Product Scraper");
app.commandLine.appendSwitch("disable-http-cache");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  console.log("Electron ready.");
  Menu.setApplicationMenu(null);
  const port = await findFreePort(3001);
  console.log(`Starting local server on port ${port}...`);
  await startServer(port);
  console.log("Local server ready. Opening window...");
  createWindow(port);
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Product Scraper failed to start: ${message}`);
  appendLog(`Product Scraper failed to start: ${message}\n`);
  dialog.showErrorBox("Product Scraper failed to start", message);
  app.quit();
});

app.on("before-quit", () => {
  stopServer();
});

app.on("window-all-closed", () => {
  app.quit();
});

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: "Product Scraper",
    backgroundColor: "#f7f5ef",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs")
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);
}

ipcMain.handle("desktop:open-files", async (_event, options = {}) => {
  const kind = normalizePickerKind(options.kind);
  const lastDirs = readDesktopLastDirs();
  const defaultPath = lastDirs[kind] && fs.existsSync(lastDirs[kind]) ? lastDirs[kind] : undefined;
  const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
    title: typeof options.title === "string" ? options.title : undefined,
    defaultPath,
    properties: options.multiple ? ["openFile", "multiSelections"] : ["openFile"],
    filters: normalizeDialogFilters(options.filters)
  });
  if (result.canceled) return [];

  const selectedPaths = result.filePaths;
  rememberLastDir(kind, selectedPaths[selectedPaths.length - 1]);
  return Promise.all(selectedPaths.map(readDialogFile));
});

ipcMain.handle("desktop:remember-file-folder", (_event, options = {}) => {
  const filePath = typeof options.filePath === "string" ? options.filePath : "";
  if (!filePath) return false;
  rememberLastDir(normalizePickerKind(options.kind), filePath);
  return true;
});

async function startServer(port) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(serverLogPath, `\n[${new Date().toISOString()}] Starting desktop server on ${port}\n`);

  const runtime = getServerRuntime();
  const bundledPlaywright = path.join(rootDir, "runtime", "ms-playwright");
  const playwrightEnv = fs.existsSync(bundledPlaywright) ? { PLAYWRIGHT_BROWSERS_PATH: bundledPlaywright } : {};
  appendLog(`Using server runtime: ${runtime.command} ${runtime.args.join(" ")}\n`);
  serverProcess = spawn(runtime.command, [...runtime.args, "--import", "tsx", "src/server/index.ts"], {
    cwd: rootDir,
    env: {
      ...process.env,
      ...runtime.env,
      ...playwrightEnv,
      PORT: String(port),
      PRODUCT_SCRAPER_DESKTOP: "1"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  serverProcess.stdout.on("data", (chunk) => appendLog(chunk));
  serverProcess.stderr.on("data", (chunk) => appendLog(chunk));
  serverProcess.on("error", (error) => {
    appendLog(`Desktop server spawn failed: ${error.message}\n`);
  });
  serverProcess.on("exit", (code, signal) => {
    appendLog(`Desktop server exited with code=${code ?? ""} signal=${signal ?? ""}\n`);
  });

  await waitForHealth(port, serverStartupTimeoutMs);
}

/**
 * Verifies a candidate runtime can actually load the native addons the server needs. better-sqlite3
 * lazy-loads its compiled `.node` on the first `new Database()` — a plain `require()` succeeds even on
 * an ABI-mismatched runtime, so we must instantiate a DB to detect a NODE_MODULE_VERSION mismatch.
 */
function runtimeCanLoadNativeAddons(command, args, env) {
  try {
    const check = spawnSync(command, [...args, "-e", "new (require('better-sqlite3'))(':memory:').close()"], {
      cwd: rootDir,
      env: { ...process.env, ...env },
      timeout: 20000,
      stdio: "ignore"
    });
    return check.status === 0;
  } catch {
    return false;
  }
}

function getServerRuntime() {
  // The desktop server loads native modules (better-sqlite3) that are ABI-bound to a specific Node
  // version. A stale bundled runtime — or an Electron whose Node ABI differs from the one node_modules
  // was built against — otherwise crashes startup with a NODE_MODULE_VERSION mismatch. So instead of
  // blindly taking the first available runtime, probe candidates in preference order and use the first
  // that can actually open the database. This makes startup robust no matter how the app is launched
  // (npm, bundled portable node, or Electron-as-node) or which Node version node_modules was built for.
  const candidates = [];
  const pushNode = (command, label, env = {}) => {
    if (command && !candidates.some((c) => c.command === command) && (env.ELECTRON_RUN_AS_NODE || fs.existsSync(command))) {
      candidates.push({ command, args: [], env, label });
    }
  };
  // 1. The Node that launched npm (set only for `npm run desktop`) — usually the freshly-installed one.
  pushNode(process.env.npm_node_execpath, "npm node");
  // 2. A system Node install (covers double-click / packaged launches where npm_node_execpath is unset,
  //    and where the bundled runtime's ABI no longer matches a rebuilt node_modules).
  for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], "C:\\Program Files"]) {
    if (base) pushNode(path.join(base, "nodejs", "node.exe"), "system node");
  }
  try {
    const resolved = spawnSync(process.platform === "win32" ? "where" : "which", ["node"], { encoding: "utf8" });
    const first = (resolved.stdout || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first) pushNode(first, "PATH node");
  } catch {
    /* PATH lookup unavailable — rely on the other candidates. */
  }
  // 3. Bundled portable runtimes shipped with the app (for machines without Node installed).
  pushNode(path.join(rootDir, ".runtime", "node", "node.exe"), ".runtime node");
  pushNode(path.join(rootDir, "runtime", "node", "node.exe"), "portable node");
  // 4. Electron itself as a Node runtime — last resort.
  pushNode(process.execPath, "electron-as-node", { ELECTRON_RUN_AS_NODE: "1" });

  for (const candidate of candidates) {
    if (runtimeCanLoadNativeAddons(candidate.command, candidate.args, candidate.env)) {
      appendLog(`Selected server runtime (${candidate.label}): ${candidate.command}\n`);
      return { command: candidate.command, args: candidate.args, env: candidate.env };
    }
    appendLog(`Skipping server runtime (${candidate.label}) — cannot load native modules (ABI mismatch?): ${candidate.command}\n`);
  }

  // No candidate could open the DB (e.g. better-sqlite3 was built for a Node version not present here).
  // Fall back to the first candidate so behavior is no worse than before, with an actionable log line —
  // the fix is `npm rebuild better-sqlite3` under the runtime the app launches with.
  const fallback = candidates[0];
  appendLog(
    `WARNING: no runtime could load better-sqlite3 (native ABI mismatch). Falling back to ${fallback.command}. ` +
      `Run 'npm rebuild better-sqlite3' with that Node version to fix.\n`
  );
  return { command: fallback.command, args: fallback.args, env: fallback.env };
}

function normalizePickerKind(value) {
  return value === "customerDocuments" ? "customerDocuments" : "catalogInput";
}

function readDesktopLastDirs() {
  try {
    const parsed = JSON.parse(fs.readFileSync(desktopSettingsPath, "utf8"));
    const lastDirs = parsed && typeof parsed === "object" ? parsed.lastDirs : undefined;
    return lastDirs && typeof lastDirs === "object" ? lastDirs : {};
  } catch {
    return {};
  }
}

function writeDesktopLastDirs(lastDirs) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(desktopSettingsPath, JSON.stringify({ lastDirs }, null, 2));
}

function rememberLastDir(kind, filePath) {
  if (!filePath) return;
  const dir = path.dirname(filePath);
  if (!dir || !fs.existsSync(dir)) return;
  const lastDirs = readDesktopLastDirs();
  lastDirs[kind] = dir;
  writeDesktopLastDirs(lastDirs);
}

function normalizeDialogFilters(filters) {
  if (!Array.isArray(filters)) return undefined;
  return filters
    .map((filter) => ({
      name: typeof filter.name === "string" ? filter.name : "Files",
      extensions: Array.isArray(filter.extensions)
        ? filter.extensions
            .map((extension) => String(extension).replace(/^\./, "").trim())
            .filter(Boolean)
        : []
    }))
    .filter((filter) => filter.extensions.length > 0);
}

async function readDialogFile(filePath) {
  const data = await fs.promises.readFile(filePath);
  return {
    name: path.basename(filePath),
    type: mimeTypeForFile(filePath),
    data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  };
}

function mimeTypeForFile(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".csv":
      return "text/csv";
    case ".tsv":
      return "text/tab-separated-values";
    case ".txt":
      return "text/plain";
    case ".pdf":
      return "application/pdf";
    case ".doc":
      return "application/msword";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    default:
      return "application/octet-stream";
  }
}

function stopServer() {
  if (!serverProcess || serverProcess.killed) return;
  serverProcess.kill();
  serverProcess = undefined;
}

function appendLog(chunk) {
  fs.appendFile(serverLogPath, String(chunk), () => {});
}

function waitForHealth(port, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve();
          return;
        }
        retry();
      });
      req.on("error", retry);
      req.setTimeout(1500, () => {
        req.destroy();
        retry();
      });
    };

    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Product Scraper server did not start on port ${port}. See ${serverLogPath}`));
        return;
      }
      setTimeout(tick, 400);
    };

    tick();
  });
}

function findFreePort(preferredPort) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => {
      server.close(() => findFreePort(0).then(resolve));
    });
    server.listen(preferredPort, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : preferredPort;
      server.close(() => resolve(port));
    });
  });
}
