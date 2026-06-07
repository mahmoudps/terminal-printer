import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app, shell, dialog, Notification } from 'electron'
import { LOCAL_PORTS, PROTOCOL_VERSION } from '@shared/constants'
import { IPC, type AgentStatus } from '@shared/ipc'
import { initLogging, scoped, logEmitter } from './util/log'
import { ConfigStore } from './config/store'
import { PrintEngine } from './printing'
import { schedulePersist, loadQueue, flushQueuePersist } from './printing/persist'
import { runTestPrint } from './printing/test-content'
import { runDoctor } from './diagnostics/doctor'
import { SpoolListener } from './spool/listener'
import { installVirtualPrinter, removeVirtualPrinter, isVirtualPrinterInstalled } from './spool/register'
import { WebsiteRegistry } from './websites/registry'
import { NonceCache } from './security/nonce'
import { LocalServer } from './server'
import { CloudClient } from './cloud/client'
import { createTray, refreshTray } from './app/tray'
import { openSettingsWindow, getSettingsWindow } from './app/windows'
import { registerIpc, applyLoginItem } from './ipc/handlers'
import type { AppContext } from './context'

const log = scoped('main')

let ctx: AppContext
let serverError: string | null = null
let serverStoppedByUser = false // user pressed Stop (distinct from a bind error)

function notify(body: string): void {
  try {
    if (Notification.isSupported()) new Notification({ title: 'Terminal Printer', body }).show()
  } catch {
    /* notifications are best-effort */
  }
}

/** Persist a captured virtual-printer job to userData/captured/. */
async function saveCapture(data: Buffer): Promise<void> {
  try {
    const dir = join(app.getPath('userData'), 'captured')
    await fs.mkdir(dir, { recursive: true })
    const file = join(dir, `print-${randomUUID()}.prn`)
    await fs.writeFile(file, data)
    log.info(`virtual printer: saved capture ${file} (${data.length} bytes)`)
  } catch (err) {
    log.error('virtual printer: save capture failed:', String(err))
  }
}

function portList(preferred: number): number[] {
  const list = [preferred, preferred + 1, preferred + 2]
  for (const p of LOCAL_PORTS) if (!list.includes(p)) list.push(p)
  return list
}

function getStatus(store: ConfigStore, server: LocalServer, cloud: CloudClient): AgentStatus {
  const s = store.get()
  return {
    version: app.getVersion(),
    agentId: s.agentId,
    serverPort: server.port,
    serverRunning: server.running,
    serverError: serverError ?? undefined,
    serverStopped: serverStoppedByUser,
    cloud: cloud.currentState,
    paused: s.paused,
  }
}

async function bootstrap(): Promise<void> {
  const store = new ConfigStore()
  await store.load()
  initLogging(store.get().logLevel)
  log.info(`Terminal Printer v${app.getVersion()} starting`)

  const engine = new PrintEngine(() => store.get(), schedulePersist)
  const registry = new WebsiteRegistry()
  await registry.load()
  const nonces = new NonceCache()
  const server = new LocalServer({ engine, registry, nonces, store, getDiagnostics: () => ctx.runDiagnostics() })
  engine.onJobDone = (origin, job) => registry.recordJob(origin, job)

  // Virtual printer: capture desktop print jobs over loopback and route them.
  const spool = new SpoolListener((data) => {
    const vp = store.get().virtualPrinter
    if (vp.route === 'save') {
      void saveCapture(data)
      return
    }
    void engine.enqueue(
      {
        v: PROTOCOL_VERSION,
        id: `vp-${randomUUID()}`,
        type: 'raw',
        source: { base64: data.toString('base64') },
        meta: { label: 'Virtual printer job' },
      },
      'virtual',
    )
  })

  const sendToSettings = (channel: string, payload: unknown): void => {
    const w = getSettingsWindow()
    if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send(channel, payload)
  }
  const broadcastStatus = (): void => {
    sendToSettings(IPC.statusEvent, getStatus(store, server, cloud))
  }
  const broadcastQueue = (): void => {
    sendToSettings(IPC.queueEvent, engine.snapshot())
  }
  const broadcastWebsites = (): void => {
    sendToSettings(IPC.websiteEvent, registry.list())
  }

  let sitesTimer: NodeJS.Timeout | null = null
  registry.on('update', () => {
    if (sitesTimer) return
    sitesTimer = setTimeout(() => {
      sitesTimer = null
      broadcastWebsites()
    }, 200)
  })

  // Coalesce queue-change bursts before touching the UI + tray.
  let queueTimer: NodeJS.Timeout | null = null
  engine.queue.on('update', () => {
    if (queueTimer) return
    queueTimer = setTimeout(() => {
      queueTimer = null
      broadcastQueue()
      if (ctx) refreshTray(ctx)
    }, 150)
  })

  // Stream log lines to the settings window (batched).
  let logBatch: string[] = []
  let logTimer: NodeJS.Timeout | null = null
  logEmitter.on('line', (line: string) => {
    logBatch.push(line)
    if (logTimer) return
    logTimer = setTimeout(() => {
      logTimer = null
      const batch = logBatch
      logBatch = []
      sendToSettings(IPC.logEvent, batch)
    }, 200)
  })

  const cloud = new CloudClient(store, engine, () => {
    if (ctx) {
      refreshTray(ctx)
      broadcastStatus()
    }
  })

  ctx = {
    store,
    engine,
    server,
    cloud,
    registry,
    restartServer: async () => {
      serverStoppedByUser = false // the user wants it running
      try {
        await server.start(portList(store.get().localPort))
        serverError = null
      } catch (err) {
        serverError = String(err)
      }
      refreshTray(ctx)
      broadcastStatus()
    },
    stopServer: async () => {
      await server.stop()
      serverStoppedByUser = true
      serverError = null
      log.info('local server stopped by user')
      refreshTray(ctx)
      broadcastStatus()
    },
    broadcastStatus,
    getStatus: () => getStatus(store, server, cloud),
    refreshTray: () => refreshTray(ctx),
    openSettings: () => openSettingsWindow(),
    openLogs: () => {
      void shell.openPath(app.getPath('logs'))
    },
    printFile: async () => {
      const result = await dialog.showOpenDialog({
        title: 'Print a file directly',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Printable', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp'] },
          { name: 'PDF', extensions: ['pdf'] },
          { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
        ],
      })
      if (result.canceled) return
      for (const file of result.filePaths) {
        try {
          const ext = (file.split('.').pop() || '').toLowerCase()
          const res = await engine.enqueue(
            {
              v: PROTOCOL_VERSION,
              id: `file-${randomUUID()}`,
              type: ext === 'pdf' ? 'pdf' : 'image',
              source: { file },
              meta: { label: file },
            },
            'desktop',
          )
          log.info(`print file "${file}": ${res.status}${res.error ? ' — ' + res.error : ''}`)
        } catch (err) {
          log.error(`print file failed: ${String(err)}`)
        }
      }
    },
    testPrint: (type) => runTestPrint(engine, type),
    runDiagnostics: () => {
      const counts = engine.queueCounts()
      const s = store.get()
      return runDoctor({
        version: app.getVersion(),
        serverRunning: server.running,
        serverPort: server.port,
        serverError: serverError ?? undefined,
        serverStopped: serverStoppedByUser,
        defaultPrinter: s.defaultPrinter,
        cloudEnabled: s.cloud.enabled,
        cloudState: cloud.currentState.state,
        queued: counts.queued,
        active: counts.active,
        listPrinters: () => engine.listPrinters(),
      })
    },
    getHealth: () => engine.getStats(),
    applyVirtualPrinter: async () => {
      const vp = store.get().virtualPrinter
      try {
        if (vp.enabled) await spool.start(vp.listenPort)
        else await spool.stop()
      } catch (err) {
        log.error('virtual printer spool toggle failed:', String(err))
      }
      broadcastStatus()
    },
    installVirtualPrinter: async () => {
      const result = await installVirtualPrinter(store.get().virtualPrinter.listenPort)
      if (result.ok && !store.get().virtualPrinter.enabled) {
        await store.update({ virtualPrinter: { ...store.get().virtualPrinter, enabled: true } })
      }
      if (store.get().virtualPrinter.enabled && !spool.running) {
        await spool.start(store.get().virtualPrinter.listenPort).catch(() => undefined)
      }
      broadcastStatus()
      return result
    },
    removeVirtualPrinter: () => removeVirtualPrinter(store.get().virtualPrinter.listenPort),
    getVirtualPrinterStatus: async () => {
      const vp = store.get().virtualPrinter
      return {
        enabled: vp.enabled,
        running: spool.running,
        listenPort: spool.boundPort || vp.listenPort,
        route: vp.route,
        installed: await isVirtualPrinterInstalled(),
        platform: process.platform,
      }
    },
    setStartOnLogin: async (open) => {
      applyLoginItem(open)
      await store.update({ startOnLogin: open })
    },
    quit: () => {
      isQuitting = true
      app.quit()
    },
  }

  registerIpc(ctx)
  createTray(ctx)
  applyLoginItem(store.get().startOnLogin)

  try {
    const port = await server.start(portList(store.get().localPort))
    serverError = null
    log.info(`local server ready on ${port}`)
  } catch (err) {
    serverError = String(err)
    log.error('failed to start local server:', serverError)
    notify('The local print server could not start (is the port already in use?). Open Settings to retry.')
  }

  await cloud.start()
  await ctx.applyVirtualPrinter() // start the spool listener if the virtual printer is enabled
  refreshTray(ctx)
  broadcastStatus()

  // Replay jobs that were still queued when we last shut down.
  const saved = await loadQueue()
  if (saved.length) {
    log.info(`restoring ${saved.length} queued job(s) from last session`)
    engine.restoreQueue(saved)
  }

  // Unless launched at login (--hidden), surface the settings window.
  if (!process.argv.includes('--hidden')) openSettingsWindow()
}

let isQuitting = false
let cleanupStarted = false

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // A tray agent should survive a stray async error, not die silently. Log and
  // keep running; the real error sources are fixed at the source.
  process.on('uncaughtException', (err) => log.error('uncaughtException:', err))
  process.on('unhandledRejection', (reason) => log.error('unhandledRejection:', String(reason)))

  app.on('second-instance', () => {
    openSettingsWindow()
    notify('Terminal Printer is already running.')
  })

  app.whenReady().then(bootstrap).catch((err) => {
    log.error('bootstrap failed:', err)
  })

  // Tray app: keep running when all windows are closed.
  app.on('window-all-closed', () => {
    /* stay alive in the tray */
  })

  // Flush debounced state (queued jobs, website registry) before exiting so a
  // quit that closely follows activity doesn't drop the last few writes.
  app.on('before-quit', (e) => {
    isQuitting = true
    if (cleanupStarted) return
    cleanupStarted = true
    e.preventDefault()
    void (async () => {
      try {
        await Promise.allSettled([
          ctx?.registry.flush(),
          flushQueuePersist(),
          ctx?.cloud.stop(),
          ctx?.server.stop(),
        ])
      } catch {
        /* best effort — exit regardless */
      }
      app.exit(0)
    })()
  })
}
