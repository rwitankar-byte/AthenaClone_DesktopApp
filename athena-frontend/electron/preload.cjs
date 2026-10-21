const { contextBridge, ipcRenderer } = require("electron");

const IPC_CHANNELS = Object.freeze({
  getAppInfo: "app:get-info",
  setFullscreen: "window:set-fullscreen",
});

// React sees only these methods; Node.js and raw ipcRenderer remain private here.
contextBridge.exposeInMainWorld("electronAPI", {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
  setFullscreen: (enabled) => {
    if (typeof enabled !== "boolean") {
      return Promise.reject(new TypeError("setFullscreen requires a boolean"));
    }

    return ipcRenderer.invoke(IPC_CHANNELS.setFullscreen, enabled);
  },
});
