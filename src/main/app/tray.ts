import { Menu, Tray } from 'electron'
import type { JobType } from '@shared/types'
import { scoped } from '../util/log'
import type { AppContext } from '../context'
import { dotIcon } from './icon'

const log = scoped('tray')

const COLORS = {
  connected: '#22c55e', // cloud connected
  local: '#9ca3af', // local-only (grey)
  error: '#ef4444', // error (red)
}

const TEST_FORMATS: JobType[] = ['pdf', 'escpos', 'image', 'html', 'raw']

let tray: Tray | null = null

export function createTray(ctx: AppContext): Tray {
  tray = new Tray(dotIcon(COLORS.local))
  tray.setToolTip('Terminal Printer')
  tray.on('double-click', () => ctx.openSettings())
  rebuild(ctx)
  return tray
}

export function refreshTray(ctx: AppContext): void {
  if (!tray) return
  const s = ctx.store.get()
  const cloudState = ctx.cloud.currentState.state
  const hasServerError = !!ctx.getStatus().serverError
  const color = hasServerError
    ? COLORS.error
    : s.cloud.enabled && cloudState === 'connected'
      ? COLORS.connected
      : cloudState === 'error'
        ? COLORS.error
        : COLORS.local
  tray.setImage(dotIcon(color))
  rebuild(ctx)
}

function rebuild(ctx: AppContext): void {
  if (!tray) return
  const s = ctx.store.get()
  const cloud = ctx.cloud.currentState
  const q = ctx.engine.queueCounts()
  const serverError = ctx.getStatus().serverError
  const statusLine = serverError
    ? 'Server: NOT STARTED — open Settings'
    : `Local :${ctx.server.port || '—'}   •   Cloud: ${s.cloud.enabled ? cloud.state : 'off'}`
  const queueLine = `Queue: ${q.active} active / ${q.queued} queued`

  const menu = Menu.buildFromTemplate([
    { label: statusLine, enabled: false },
    { label: queueLine, enabled: false },
    { type: 'separator' },
    { label: 'Open Settings…', click: () => ctx.openSettings() },
    { label: 'Print a file…', click: () => void ctx.printFile() },
    {
      label: 'Test Print',
      submenu: TEST_FORMATS.map((type) => ({
        label: type.toUpperCase(),
        click: () => {
          ctx
            .testPrint(type)
            .then((r) => log.info(`test ${type}: ${r.status}${r.error ? ' — ' + r.error : ''}`))
            .catch((e) => log.error(`test ${type} failed`, String(e)))
        },
      })),
    },
    {
      label: s.paused ? 'Resume printing' : 'Pause printing',
      click: () => {
        void ctx.store.update({ paused: !s.paused }).then(() => {
          ctx.refreshTray()
          ctx.broadcastStatus()
        })
      },
    },
    { type: 'separator' },
    {
      label: 'Start on login',
      type: 'checkbox',
      checked: s.startOnLogin,
      click: (item) => {
        void ctx.setStartOnLogin(item.checked)
        void ctx.store.update({ startOnLogin: item.checked })
      },
    },
    { label: 'Open logs folder', click: () => ctx.openLogs() },
    { type: 'separator' },
    { label: 'Quit Terminal Printer', click: () => ctx.quit() },
  ])
  tray.setContextMenu(menu)
}
