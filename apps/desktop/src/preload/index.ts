import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const tracker = {
  login: (email: string, password: string) =>
    ipcRenderer.invoke('tracker:login', { email, password }),

  restoreSession: () => ipcRenderer.invoke('tracker:restore-session'),

  logout: () => ipcRenderer.invoke('tracker:logout'),

  getToday: () => ipcRenderer.invoke('tracker:get-today'),

  start: () => ipcRenderer.invoke('tracker:start'),

  stop: () => ipcRenderer.invoke('tracker:stop'),

  onTimerUpdated: (callback: (timer: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, timer: unknown): void => callback(timer)
    ipcRenderer.on('tracker:timer-updated', listener)
    return () => ipcRenderer.removeListener('tracker:timer-updated', listener)
  },

  onConnectionChanged: (callback: (online: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, online: boolean): void => callback(online)
    ipcRenderer.on('tracker:connection-changed', listener)
    return () => ipcRenderer.removeListener('tracker:connection-changed', listener)
  },

  onSessionExpired: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('tracker:session-expired', listener)
    return () => ipcRenderer.removeListener('tracker:session-expired', listener)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('tracker', tracker)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore Defined in index.d.ts
  window.electron = electronAPI

  // @ts-ignore Defined in index.d.ts
  window.tracker = tracker
}
