import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, screen, shell, Tray } from "electron";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRepos, createUsageFetcher, defaultInstallPaths, findExecutable, openDb, QuotaPoller, type Db } from "@aolangai/core";
import { INVOKE_CHANNEL, NOTICE_CHANNEL, STATE_CHANNEL, type AppNotice, type AppState } from "../shared/api.js";
import { createApi, dispatch, type MainApi } from "./ipc.js";
import { cliPaths, cliRuntime } from "./runtime.js";
import { openAppOutcome, osascriptOutcome } from "./login.js";
import { startMaintenance } from "./maintenance.js";
import { createNoticeGate, trayQuotaLines, trayTitle } from "./notify.js";
import { createPick, recentLabel } from "./recent.js";
import { realExec, scanSessions } from "./sessions.js";
import { applyShellPath } from "./shell-path.js";
import { watchStore } from "./watch.js";
import { initialWindowState, MIN_SIZE, readWindowState, writeWindowState } from "./window-state.js";

const here = path.dirname(fileURLToPath(import.meta.url));
app.setPath("userData", path.join(app.getPath("appData"), "aolangai"));

const STORE_WATCH_MS = 1_000;
const SWEEP_MS = 30_000;
const SESSIONS_MS = 10_000;
/** The bot stack of the app icon, 18pt, 2x, alpha only (macOS template image): keeps the menu-bar item visible when the
 * title is empty. Made from build/tray.svg by scripts/icons.sh. */
const TRAY_ICON = "iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAABmJLR0QA/wD/AP+gvaeTAAACbklEQVRYhc2Xz0tVQRTHP/eZJOYife5CfBGKS81VqStJWkjbEFroJoggAqFFq/4Aaxf52uRCUNCFG4nUTQX2J7iQQNEQqQwKTSu1xcx4j/fNfW/u3PusLwzvvHPmnPneM7/OwH+GIIVvHXDOorvg4LsHfAGOU4x/Cm3AE93ahP6uHsSlfQJGgVxaMleBXRF4F+j0IGTalAzuM2XTwG2LbgjoA+44xGgFbhBmZwSY8OACwCKlX7ngEecWcKT9N0mYHNn5voXQPQ9CAG9EjNYkjrmIPCECvcJ/YRZFnM7oQOUgt+cRsCz+f9A6H8i4gS+hqiJ6sAHkgQfANaApxq9ZyI9R292GHVQ2i8CWD8Gb2jHpWVKpfUftqijGRZ+uqPEK8KMKZOQB2l6JkFxDL4EGLc8BBdRCC4AaISdpBWBWx6wHnluyZEUeONRMV4HzEXua+6YO+KhjHwKNwhaboUtCfgccpCAQxT7wVss5oKVcZ0OiVuh+Z0jG4JeQa2N7kcHVnxINQt4Hd0LXgXVgDeix2Hsr2G1oAga0fKD9T9BNuLjGLc5Lwr7oYZeLt1vrVoTupCZyzdBFITd62G3o0L+fgUdJCVUL71FX1IZR2O6ys8Ig8JpIpeBK6GeM7Gq3Yd6mdJ2yIvBHtxcedme4ZmiScPdse9gzJ+QyUCoiBv96l5XAECqpbTOGjFm2HDaEvgldoueIIwpC3nFxCFBvbVOz2MpNXwwS1lobVJgBs6iPgWfAGCprc6hds5aSzGWgn3AmnpLgBVODeqNXq6aewXMTDaPe2lkR2QQeupKJm88Atbjzyb/nFL6i6pwze2hmjr+4yvrEmYlA+QAAAABJRU5ErkJggg==";

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

const run = (cmd: string, args: string[], env: Record<string, string>) =>
  new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile(cmd, args, { env, timeout: 20_000 }, (err, stdout) => {
      const code = err && typeof (err as NodeJS.ErrnoException).code === "number" ? Number((err as NodeJS.ErrnoException).code) : err ? 1 : 0;
      resolve({ code, stdout: String(stdout) });
    });
  });

/** The `@aolangai/cli` workspace package, wherever node_modules put it. Development only: the packaged app has no such package. */
const cliDevRoot = () => path.dirname(createRequire(import.meta.url).resolve("@aolangai/cli/package.json"));

function createWindow() {
  const stateFile = path.join(app.getPath("userData"), "window-state.json");
  const primary = screen.getPrimaryDisplay();
  const areas = [primary, ...screen.getAllDisplays().filter((d) => d.id !== primary.id)].map((d) => d.workArea);
  const { bounds, maximized } = initialWindowState(readWindowState(stateFile), areas);
  win = new BrowserWindow({
    ...bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    title: "aolangai",
    webPreferences: { preload: path.join(here, "../preload/index.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // The window never opens new windows or navigates away from the app page.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e, url) => {
    if (url !== win?.webContents.getURL()) e.preventDefault();
  });
  if (maximized) win.maximize();
  win.on("close", (e) => {
    if (win) writeWindowState(stateFile, { bounds: win.getNormalBounds(), maximized: win.isMaximized() });
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(path.join(here, "../renderer/index.html"));
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  win!.show();
  win!.focus();
}


async function main() {
  // Before anything looks for claude or node: started from Finder, the app only has the short PATH of a GUI app.
  await Promise.all([app.whenReady(), applyShellPath(process.env)]);
  const dbFile = process.env.AOLANGAI_DB ? path.resolve(process.env.AOLANGAI_DB) : path.join(app.getPath("userData"), "aolangai.db");
  let db: Db;
  let pollerDb: Db;
  try {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    db = openDb(dbFile);
    // The poller writes through its own connection so the store watcher (data_version) sees its commits.
    pollerDb = openDb(dbFile);
  } catch (e) {
    dialog.showErrorBox("aolangai could not start", e instanceof Error ? e.message : String(e));
    app.exit(1);
    return;
  }
  const repos = createRepos(db);

  const noticesFor = createNoticeGate(); // the first state only becomes the baseline
  const notify = (n: AppNotice) => {
    if (!Notification.isSupported()) return;
    const note = new Notification(n);
    note.on("click", showWindow);
    note.show();
  };
  // The menu: a line of quota per account (click shows the window), a separator if any, then the fixed entries.
  let menuLines: string[] | undefined;
  let lastState: AppState | undefined;
  const buildMenu = (lines: string[]) =>
    Menu.buildFromTemplate([
      ...lines.map((label) => ({ label, click: showWindow })),
      ...(lines.length > 0 ? [{ type: "separator" as const }] : []),
      { label: "Open aolangai", click: showWindow },
      { label: "Stop all", click: () => void api.stopAll().catch(() => {}) },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]);
  const refreshMenu = (state: AppState) => {
    lastState = state;
    if (!tray) return;
    const lines = trayQuotaLines(state, Date.now());
    if (menuLines && lines.length === menuLines.length && lines.every((l, i) => l === menuLines![i])) return;
    menuLines = lines;
    tray.setContextMenu(buildMenu(lines));
  };
  const onState = (state: AppState) => {
    for (const n of noticesFor(state)) notify(n);
    // The window first: a tray failure must not swallow a state (pushState has already recorded it as sent).
    if (win && !win.isDestroyed()) win.webContents.send(STATE_CHANNEL, state);
    try {
      tray?.setTitle(trayTitle(state));
      refreshMenu(state);
    } catch (e) {
      console.error("tray update failed", e);
    }
  };

  const api: MainApi = createApi({
    repos,
    dbPath: dbFile,
    userData: app.getPath("userData"),
    env: process.env,
    exec: run,
    which: findExecutable,
    runtime: cliRuntime({ packaged: app.isPackaged, execPath: process.execPath, node: findExecutable("node") }),
    packaged: app.isPackaged,
    loginItem: { get: () => app.getLoginItemSettings().openAtLogin, set: (on) => app.setLoginItemSettings({ openAtLogin: on }) },
    scanSessions: (accounts, excludePids) => scanSessions({ accounts, excludePids, selfPid: process.pid, uid: process.getuid?.(), exec: realExec, now: Date.now() }),
    spawn: (cmd, args, opts) => spawn(cmd, args, opts),
    openPath: (p) => shell.openPath(p),
    showItemInFolder: (p) => shell.showItemInFolder(p),
    openExternal: (url) => shell.openExternal(url),
    runOsascript: async (args) => osascriptOutcome(await run("osascript", args, process.env as Record<string, string>)),
    openApp: async (appPath) => openAppOutcome(await run("/usr/bin/open", ["-a", appPath], process.env as Record<string, string>)),
    pickFolder: async (defaultPath, recent) => {
      const parent = win && !win.isDestroyed() ? win : undefined;
      const showDialog = async () => {
        const options = { defaultPath, properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[], title: "Choose a working folder" };
        const { canceled, filePaths } = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
        return canceled ? undefined : filePaths[0];
      };
      if (recent.length === 0) return showDialog();
      const pick = createPick<string>();
      Menu.buildFromTemplate([
        ...recent.map((dir) => ({ label: recentLabel(dir, os.homedir()), click: () => pick.choose(dir) })),
        { type: "separator" as const },
        { label: "Choose another folder…", click: () => pick.choose(showDialog()) },
      ]).popup({ ...(parent ? { window: parent } : {}), callback: pick.closed });
      return pick.promise;
    },
    cli: cliPaths({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, devRoot: app.isPackaged ? "" : cliDevRoot() }),
    installPaths: defaultInstallPaths(),
    now: Date.now,
    emitState: onState,
    emitNotice: (n) => {
      notify(n);
      if (win && !win.isDestroyed()) win.webContents.send(NOTICE_CHANNEL, n);
    },
  });

  api.autoInstall(); // packaged app only: keeps the skill and the command in place and up to date
  ipcMain.handle(INVOKE_CHANNEL, (_e, req: unknown) => dispatch(api, req));

  const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON, "base64"), { scaleFactor: 2 });
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  menuLines = [];
  tray.setContextMenu(buildMenu([]));
  if (lastState) refreshMenu(lastState); // a state that arrived before the tray existed

  // First sweep, scan and state, then a sweep every 30 s and a scan every 10 s; an error is logged and retried, never thrown.
  const maintenance = startMaintenance(api, { intervalMs: SWEEP_MS, sessionsMs: SESSIONS_MS });
  createWindow();

  // Plan quota every minute; an empty app-owned folder as cwd, no prompt is ever sent. No claude, no poller.
  const claude = findExecutable("claude");
  const poller = claude
    ? new QuotaPoller(createRepos(pollerDb), createUsageFetcher({ claudePath: claude, cwd: path.join(app.getPath("userData"), "quota-probe") }))
    : undefined;
  poller?.start();
  const stopWatching = watchStore(db, STORE_WATCH_MS, maintenance.pushState);

  app.on("activate", showWindow);
  app.on("window-all-closed", () => {
    // stay alive in the menu bar
  });
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("will-quit", () => {
    poller?.stop();
    maintenance.stop();
    stopWatching();
    for (const d of [pollerDb, db]) {
      try {
        d.close();
      } catch {
        // exiting anyway
      }
    }
  });
}

// One instance per store: a second one would add a tray, a quota poller (double the probes) and a sweeper.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (app.isReady()) showWindow();
  });
  main().catch((e) => {
    dialog.showErrorBox("aolangai could not start", e instanceof Error ? e.message : String(e));
    app.exit(1);
  });
}
