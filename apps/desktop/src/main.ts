import { app, BrowserWindow, dialog, session } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { updater } from "./updater";

let serverProcess: ChildProcess | undefined;
let mainWindow: BrowserWindow | undefined;

const isPackaged = app.isPackaged;
const projectRoot = join(__dirname, "..", "..");
const webDist = isPackaged
  ? join(process.resourcesPath, "web-dist")
  : join(projectRoot, "web", "dist");
const serverRuntime = isPackaged
  ? join(process.resourcesPath, "server-runtime")
  : join(projectRoot, "server");
const serverDist = join(serverRuntime, "dist");

function waitForServerUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/Elenchi server listening at (https?:\/\/[^\s]+)/);
      if (match) {
        resolve(match[1]);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      reject(
        new Error(
          `Elenchi server exited before startup (code ${code ?? "unknown"}).\n${output.trim()}`,
        ),
      );
    });
  });
}

async function startBundledServer(): Promise<string> {
  const cliPath = join(serverDist, "cli.js");
  if (!existsSync(cliPath)) {
    throw new Error(`Server build not found: ${cliPath}. Run pnpm build:desktop first.`);
  }
  if (!existsSync(webDist)) {
    throw new Error(`Web build not found: ${webDist}. Run pnpm build:desktop first.`);
  }

  serverProcess = spawn(process.execPath, [cliPath], {
    cwd: serverDist,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      ELENCHI_DATA_DIR: join(app.getPath("userData"), "data"),
      ELENCHI_HOST: "127.0.0.1",
      ELENCHI_PORT: "0",
      ELENCHI_WEB_DIST: webDist,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProcess.stderr?.on("data", (chunk: Buffer) => {
    // eslint-disable-next-line no-console
    console.error(`[elenchi-server] ${chunk.toString().trimEnd()}`);
  });
  return waitForServerUrl(serverProcess);
}

async function createWindow(): Promise<void> {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  const serverUrl = process.env.ELENCHI_DESKTOP_URL ?? (await startBundledServer());
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 720,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, "preload.js"),
    },
  });
  await mainWindow.loadURL(process.env.ELENCHI_DESKTOP_URL ?? `${serverUrl}/`);
  updater.initialize(isPackaged);
}

app.whenReady().then(createWindow).catch((error: unknown) => {
  dialog.showErrorBox("Elenchi 启动失败", error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  serverProcess?.kill();
  serverProcess = undefined;
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
