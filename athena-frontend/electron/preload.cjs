const { contextBridge, ipcRenderer } = require("electron");

const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const IPC_CHANNELS = Object.freeze({
  getAppInfo: "app:get-info",
  setFullscreen: "window:set-fullscreen",
  saveSnapshot: "proctoring:save-snapshot",
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
  saveSnapshot: (payload) => {
    if (!(payload instanceof ArrayBuffer)) {
      return Promise.reject(new TypeError("Snapshot payload must be an ArrayBuffer"));
    }
    if (payload.byteLength === 0 || payload.byteLength > MAX_SNAPSHOT_BYTES) {
      return Promise.reject(new RangeError("Snapshot payload exceeds the size limit"));
    }

    return ipcRenderer.invoke(IPC_CHANNELS.saveSnapshot, payload);
  },
});
