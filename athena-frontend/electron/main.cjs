const { BrowserWindow, app, ipcMain } = require("electron");
const path = require("node:path");
const { saveSnapshot } = require("./snapshot.cjs");

const IPC_CHANNELS = Object.freeze({
  getAppInfo: "app:get-info",
  setFullscreen: "window:set-fullscreen",
  saveSnapshot: "proctoring:save-snapshot",
  getWindowState: "window:get-state",
  windowStateChanged: "window:state-changed",
});

let mainWindow = null;
let ipcHandlersRegistered = false;

function assertTrustedSender(event) {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error("Untrusted renderer IPC sender");
  }
}

function registerIpcHandlers() {
  if (ipcHandlersRegistered) return;

  // IPC handlers stay in the main process; the renderer receives only these results.
  ipcMain.handle(IPC_CHANNELS.getAppInfo, (event, ...args) => {
    assertTrustedSender(event);
    if (args.length !== 0) throw new TypeError("getAppInfo accepts no arguments");

    return {
      name: "Athena Exam",
      version: app.getVersion(),
      platform: process.platform,
    };
  });

  ipcMain.handle(IPC_CHANNELS.setFullscreen, (event, enabled) => {
    assertTrustedSender(event);
    if (typeof enabled !== "boolean") {
      throw new TypeError("setFullscreen requires a boolean");
    }

    // Native fullscreen can transition asynchronously, especially on macOS;
    // the window events below are the authoritative state updates.
    mainWindow.setFullScreen(enabled);
    return mainWindow.isFullScreen();
  });

  ipcMain.handle(IPC_CHANNELS.getWindowState, (event, ...args) => {
    assertTrustedSender(event);
    if (args.length !== 0) throw new TypeError("getWindowState accepts no arguments");

    return {
      fullscreen: mainWindow.isFullScreen(),
      focused: mainWindow.isFocused(),
    };
  });

  ipcMain.handle(IPC_CHANNELS.saveSnapshot, async (event, payload) => {
    assertTrustedSender(event);
    await saveSnapshot(app, payload);
    return { saved: true };
  });

  ipcHandlersRegistered = true;
}

function sendWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Fullscreen is a window state, not kiosk mode; focus changes are signals only.
  mainWindow.webContents.send(IPC_CHANNELS.windowStateChanged, {
    fullscreen: mainWindow.isFullScreen(),
    focused: mainWindow.isFocused(),
  });
}

function isAllowedNavigation(url) {
  try {
    const parsedUrl = new URL(url);
    return app.isPackaged
      ? parsedUrl.protocol === "file:"
      : parsedUrl.protocol === "http:" &&
          parsedUrl.hostname === "localhost" &&
          parsedUrl.port === "5173";
  } catch {
    return false;
  }
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return mainWindow;
  }

  // Keep privileged Electron APIs in the main/preload processes, never in React.
  mainWindow = new BrowserWindow({
    title: "Athena Exam",
    height: 500,
    width: 800,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.on("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.on("enter-full-screen", sendWindowState);
  mainWindow.on("leave-full-screen", sendWindowState);
  mainWindow.on("focus", sendWindowState);
  mainWindow.on("blur", sendWindowState);

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });

  // Vite serves the renderer in development; packaged apps use the built files.
  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  } else {
    mainWindow.loadURL("http://localhost:5173/");
  }

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  return mainWindow;
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  // macOS apps stay open after their last window closes and recreate it on activate.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Windows and Linux conventionally exit when the final window is closed.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
