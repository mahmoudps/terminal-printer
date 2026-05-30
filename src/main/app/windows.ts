import { BrowserWindow } from 'electron'
import { join } from 'node:path'

let settingsWin: BrowserWindow | null = null

export function openSettingsWindow(): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show()
    settingsWin.focus()
    return
  }

  settingsWin = new BrowserWindow({
    width: 820,
    height: 760,
    minWidth: 640,
    minHeight: 560,
    show: false,
    title: 'Terminal Printer',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  settingsWin.removeMenu()

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void settingsWin.loadURL(devUrl)
  } else {
    void settingsWin.loadFile(join(__dirname, '../renderer/index.html'))
  }

  settingsWin.once('ready-to-show', () => settingsWin?.show())
  settingsWin.on('closed', () => {
    settingsWin = null
  })
}

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWin && !settingsWin.isDestroyed() ? settingsWin : null
}
