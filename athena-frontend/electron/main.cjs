const { BrowserWindow, app } = require("electron");
const path = require("node:path");

function createWindow() {
  // Keep privileged Electron APIs in the main/preload processes, never in React.
  const window = new BrowserWindow({
    title: "Athena Exam",
    height: 500,
    width: 800,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.on("ready-to-show", () => window.show());

  window.webContents.on("will-navigate", (event, url) => {
    const allowed = app.isPackaged
      ? url.startsWith("file:")
      : url.startsWith("http://localhost:5173/");
    if (!allowed) event.preventDefault();
  });

  // Vite serves the renderer in development; packaged apps use the built files.
  if (app.isPackaged) {
    window.loadFile(path.join(__dirname, "../dist/index.html"));
  } else {
    window.loadURL("http://localhost:5173/");
  }

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

app.whenReady().then(() => {
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
