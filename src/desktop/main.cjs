const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const rootDir = path.resolve(__dirname, "../..");
const dataDir = path.join(rootDir, "data");
const serverLogPath = path.join(dataDir, "desktop-server.log");
const desktopSettingsPath = path.join(dataDir, "desktop-settings.json");
const serverStartupTimeoutMs = 120000;

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

function getServerRuntime() {
  // When launched through npm, prefer the same Node executable that installed
  // node_modules. Native packages such as better-sqlite3 are ABI-bound to that
  // Node version; using the bundled fallback runtime first can make desktop
  // startup fail with NODE_MODULE_VERSION mismatches.
  if (process.env.npm_node_execpath && fs.existsSync(process.env.npm_node_execpath)) {
    return { command: process.env.npm_node_execpath, args: [], env: {} };
  }

  const projectNode = path.join(rootDir, ".runtime", "node", "node.exe");
  if (fs.existsSync(projectNode)) {
    return { command: projectNode, args: [], env: {} };
  }

  const portableNode = path.join(rootDir, "runtime", "node", "node.exe");
  if (fs.existsSync(portableNode)) {
    return { command: portableNode, args: [], env: {} };
  }

  if (process.env.npm_node_execpath) {
    return { command: process.env.npm_node_execpath, args: [], env: {} };
  }

  // Portable builds are launched through Electron directly. Electron can run as
  // a Node runtime when this flag is set, so users do not need Node/npm installed.
  return {
    command: process.execPath,
    args: [],
    env: { ELECTRON_RUN_AS_NODE: "1" }
  };
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
