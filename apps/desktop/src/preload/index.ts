import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { INVOKE_CHANNEL, NOTICE_CHANNEL, STATE_CHANNEL, type AolangaiBridge, type AppNotice, type AppState } from "../shared/api.js";

const bridge: AolangaiBridge = {
  invoke: (method, ...args) => ipcRenderer.invoke(INVOKE_CHANNEL, { method, args }) as never,
  onState(cb) {
    const listener = (_e: IpcRendererEvent, state: AppState) => cb(state);
    ipcRenderer.on(STATE_CHANNEL, listener);
    return () => void ipcRenderer.removeListener(STATE_CHANNEL, listener);
  },
  onNotice(cb) {
    const listener = (_e: IpcRendererEvent, notice: AppNotice) => cb(notice);
    ipcRenderer.on(NOTICE_CHANNEL, listener);
    return () => void ipcRenderer.removeListener(NOTICE_CHANNEL, listener);
  },
};

contextBridge.exposeInMainWorld("aolangai", bridge);
