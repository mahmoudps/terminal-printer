import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type AgentBridge, type AgentStatus, type QueueSnapshot, type WebsiteListItem } from '@shared/ipc'

const bridge: AgentBridge = {
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (patch) => ipcRenderer.invoke(IPC.setSettings, patch),
  setCloud: (patch) => ipcRenderer.invoke(IPC.setCloud, patch),
  listPrinters: () => ipcRenderer.invoke(IPC.listPrinters),
  testPrint: (type) => ipcRenderer.invoke(IPC.testPrint, type),
  getWebsites: () => ipcRenderer.invoke(IPC.getWebsites),
  getWebsiteDetail: (origin) => ipcRenderer.invoke(IPC.getWebsiteDetail, origin),
  revokeWebsite: (origin) => ipcRenderer.invoke(IPC.revokeWebsite, origin),
  blockWebsite: (origin, blocked) => ipcRenderer.invoke(IPC.blockWebsite, origin, blocked),
  renameWebsite: (origin, name) => ipcRenderer.invoke(IPC.renameWebsite, origin, name),
  regenerateToken: (origin) => ipcRenderer.invoke(IPC.regenerateToken, origin),
  getStatus: () => ipcRenderer.invoke(IPC.getStatus),
  restartCloud: () => ipcRenderer.invoke(IPC.restartCloud),
  restartServer: () => ipcRenderer.invoke(IPC.restartServer),
  getQueue: () => ipcRenderer.invoke(IPC.getQueue),
  cancelJob: (id: string) => ipcRenderer.invoke(IPC.cancelJob, id),
  retryJob: (id: string) => ipcRenderer.invoke(IPC.retryJob, id),
  clearQueueHistory: () => ipcRenderer.invoke(IPC.clearQueueHistory),
  getLogs: () => ipcRenderer.invoke(IPC.getLogs),
  openLogs: () => ipcRenderer.invoke(IPC.openLogs),
  onStatus: (cb: (status: AgentStatus) => void) => {
    const handler = (_e: unknown, status: AgentStatus) => cb(status)
    ipcRenderer.on(IPC.statusEvent, handler)
    return () => ipcRenderer.removeListener(IPC.statusEvent, handler)
  },
  onQueue: (cb: (snapshot: QueueSnapshot) => void) => {
    const handler = (_e: unknown, snapshot: QueueSnapshot) => cb(snapshot)
    ipcRenderer.on(IPC.queueEvent, handler)
    return () => ipcRenderer.removeListener(IPC.queueEvent, handler)
  },
  onLog: (cb: (lines: string[]) => void) => {
    const handler = (_e: unknown, lines: string[]) => cb(lines)
    ipcRenderer.on(IPC.logEvent, handler)
    return () => ipcRenderer.removeListener(IPC.logEvent, handler)
  },
  onWebsites: (cb: (sites: WebsiteListItem[]) => void) => {
    const handler = (_e: unknown, sites: WebsiteListItem[]) => cb(sites)
    ipcRenderer.on(IPC.websiteEvent, handler)
    return () => ipcRenderer.removeListener(IPC.websiteEvent, handler)
  },
}

contextBridge.exposeInMainWorld('agent', bridge)
