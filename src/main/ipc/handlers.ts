import { app, ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { JobType } from '@shared/types'
import { initLogging, getLogBuffer } from '../util/log'
import { runTestPrint } from '../printing/test-content'
import type { AppContext } from '../context'

export function registerIpc(ctx: AppContext): void {
  ipcMain.handle(IPC.getSettings, () => ctx.store.get())

  ipcMain.handle(IPC.setSettings, async (_e, patch) => {
    const before = ctx.store.get()
    const after = await ctx.store.update(patch ?? {})
    if (patch?.localPort != null && patch.localPort !== before.localPort) await ctx.restartServer()
    if (patch?.startOnLogin != null && patch.startOnLogin !== before.startOnLogin) {
      await ctx.setStartOnLogin(after.startOnLogin)
    }
    if (patch?.logLevel) initLogging(after.logLevel)
    ctx.engine.kick() // apply maxConcurrent / queue setting changes immediately
    ctx.refreshTray()
    ctx.broadcastStatus()
    return after
  })

  ipcMain.handle(IPC.setCloud, async (_e, patch) => {
    const after = await ctx.store.setCloud(patch ?? {})
    await ctx.cloud.restart()
    ctx.refreshTray()
    ctx.broadcastStatus()
    return after
  })

  ipcMain.handle(IPC.listPrinters, () => ctx.engine.listPrinters())

  ipcMain.handle(IPC.testPrint, (_e, type: JobType) => runTestPrint(ctx.engine, type))

  ipcMain.handle(IPC.getWebsites, () => ctx.registry.list())
  ipcMain.handle(IPC.getWebsiteDetail, (_e, origin: string) => ctx.registry.detail(origin))
  ipcMain.handle(IPC.revokeWebsite, (_e, origin: string) => ctx.registry.remove(origin))
  ipcMain.handle(IPC.blockWebsite, (_e, origin: string, blocked: boolean) => ctx.registry.setBlocked(origin, blocked))
  ipcMain.handle(IPC.renameWebsite, (_e, origin: string, name: string) => ctx.registry.rename(origin, name))
  ipcMain.handle(IPC.regenerateToken, (_e, origin: string) => ctx.registry.regenerateToken(origin))

  ipcMain.handle(IPC.getStatus, () => ctx.getStatus())
  ipcMain.handle(IPC.restartCloud, () => ctx.cloud.restart())
  ipcMain.handle(IPC.restartServer, () => ctx.restartServer())

  ipcMain.handle(IPC.getQueue, () => ctx.engine.snapshot())
  ipcMain.handle(IPC.cancelJob, (_e, id: string) => ctx.engine.cancel(id))
  ipcMain.handle(IPC.retryJob, (_e, id: string) => ctx.engine.retry(id))
  ipcMain.handle(IPC.clearQueueHistory, () => ctx.engine.clearHistory())

  ipcMain.handle(IPC.getLogs, () => getLogBuffer())
  ipcMain.handle(IPC.openLogs, () => ctx.openLogs())
}

/** Apply the OS "start at login" setting (Windows/macOS). */
export function applyLoginItem(open: boolean): void {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin: open, args: ['--hidden'] })
  }
}
