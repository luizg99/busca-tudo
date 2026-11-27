import { contextBridge, ipcRenderer } from 'electron';

// O token nunca chega ao renderer: as chamadas passam pelo processo principal.
contextBridge.exposeInMainWorld('buscaTudo', {
  api: (method: string, path: string, body?: unknown) => ipcRenderer.invoke('api', method, path, body),
  status: () => ipcRenderer.invoke('status'),
  version: () => ipcRenderer.invoke('app-version'),
  startService: () => ipcRenderer.invoke('start-service'),
  startupGet: () => ipcRenderer.invoke('startup-get'),
  startupSet: (enabled: boolean) => ipcRenderer.invoke('startup-set', enabled),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
});
