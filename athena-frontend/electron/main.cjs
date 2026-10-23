const { BrowserWindow, app, ipcMain, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const {
  completeTimerState,
  createTimerState,
  getRemainingMs,
  isExpired,
} = require("./exam-timer.cjs");
const { saveSnapshot } = require("./snapshot.cjs");

const IPC_CHANNELS = Object.freeze({
  getAppInfo: "app:get-info",
  setFullscreen: "window:set-fullscreen",
  saveSnapshot: "proctoring:save-snapshot",
  getWindowState: "window:get-state",
  windowStateChanged: "window:state-changed",
  startExamTimer: "exam:start-timer",
  getExamTimer: "exam:get-timer",
  finishExam: "exam:finish",
  examStateChanged: "exam:state-changed",
});

let mainWindow = null;
let ipcHandlersRegistered = false;
let examTimerState = null;
let examTimerTimeout = null;

function examTimerFilePath() {
  return path.join(app.getPath("userData"), "exam-timer-state.json");
}

function persistExamTimer() {
  const filePath = examTimerFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(examTimerState), "utf8");
}

function clearExamTimerTimeout() {
  if (examTimerTimeout) clearTimeout(examTimerTimeout);
  examTimerTimeout = null;
}

function rendererExamTimerState() {
  return {
    ...examTimerState,
    remainingMs: getRemainingMs(examTimerState),
  };
}

function sendExamTimerState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(
    IPC_CHANNELS.examStateChanged,
    rendererExamTimerState(),
  );
}

function completeExam(reason) {
  if (!examTimerState || examTimerState.status !== "active") {
    return examTimerState;
  }

  examTimerState = completeTimerState(examTimerState, reason);
  clearExamTimerTimeout();
  persistExamTimer();
  sendExamTimerState();
  return examTimerState;
}

function scheduleExamTimer() {
  clearExamTimerTimeout();
  if (!examTimerState || examTimerState.status !== "active") return;

  const remainingMs = getRemainingMs(examTimerState);
  if (remainingMs === 0) {
    completeExam("time-expired");
    return;
  }

  // The deadline is authoritative; this timeout only wakes the main process
  // so expiry is persisted and broadcast even if the renderer is refreshed.
  examTimerTimeout = setTimeout(() => completeExam("time-expired"), remainingMs);
}

function loadExamTimer() {
  try {
    const stored = JSON.parse(fs.readFileSync(examTimerFilePath(), "utf8"));
    if (!stored || (stored.status !== "active" && stored.status !== "submitted")) {
      throw new Error("Invalid exam timer state");
    }
    examTimerState = stored;
  } catch {
    examTimerState = {
      status: "idle",
      startedAt: null,
      deadlineAt: null,
      durationMs: null,
      completedAt: null,
      completionReason: null,
      rulesAccepted: false,
    };
  }

  if (isExpired(examTimerState)) completeExam("time-expired");
  else scheduleExamTimer();
}

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

  ipcMain.handle(IPC_CHANNELS.startExamTimer, (event, ...args) => {
    assertTrustedSender(event);
    if (args.length !== 0) throw new TypeError("startExamTimer accepts no arguments");
    if (examTimerState.status === "active") return rendererExamTimerState();
    if (examTimerState.status === "submitted") {
      throw new Error("This exam has already been completed");
    }

    // The renderer cannot choose a deadline or duration; main owns both.
    examTimerState = createTimerState();
    persistExamTimer();
    scheduleExamTimer();
    sendExamTimerState();
    return rendererExamTimerState();
  });

  ipcMain.handle(IPC_CHANNELS.getExamTimer, (event, ...args) => {
    assertTrustedSender(event);
    if (args.length !== 0) throw new TypeError("getExamTimer accepts no arguments");
    return rendererExamTimerState();
  });

  ipcMain.handle(IPC_CHANNELS.finishExam, (event, reason, ...args) => {
    assertTrustedSender(event);
    if (args.length !== 0) throw new TypeError("finishExam accepts one argument");
    if (!["manual", "cancelled", "time-expired"].includes(reason)) {
      throw new TypeError("Invalid exam completion reason");
    }
    if (reason === "time-expired" && !isExpired(examTimerState)) {
      throw new Error("The exam deadline has not been reached");
    }
    // Once the deadline has passed, expiry wins over a concurrent manual action.
    completeExam(isExpired(examTimerState) ? "time-expired" : reason);
    return rendererExamTimerState();
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

function configurePermissions() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = permission === "media" && isAllowedNavigation(webContents.getURL());
    callback(allowed);
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return permission === "media" && isAllowedNavigation(webContents.getURL());
  });
}

app.whenReady().then(() => {
  loadExamTimer();
  registerIpcHandlers();
  configurePermissions();
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
