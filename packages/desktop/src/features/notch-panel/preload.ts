import { contextBridge, ipcRenderer } from "electron";

// Sandboxed and tsc-compiled like the main preload: load nothing but "electron" at runtime.

contextBridge.exposeInMainWorld("paseoNotch", {
  onUpdate: (handler: (message: unknown) => void) => {
    ipcRenderer.on("paseo:notch:update", (_event, message: unknown) => handler(message));
  },
  action: (action: unknown) => ipcRenderer.send("paseo:notch:action", action),
  setInteractive: (interactive: boolean) =>
    ipcRenderer.send("paseo:notch:interactive", interactive === true),
});
