const { app, BrowserWindow, Menu, shell, dialog } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const rootDir = path.resolve(__dirname, "../..");
const dataDir = path.join(rootDir, "data");
const serverLogPath = path.join(dataDir, "desktop-server.log");

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
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);
}

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

  await waitForHealth(port, 30000);
}

function getServerRuntime() {
  const bundledNode = path.join(rootDir, "runtime", "node", "node.exe");
  if (fs.existsSync(bundledNode)) {
    return { command: bundledNode, args: [], env: {} };
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
