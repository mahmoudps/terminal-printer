import log from 'electron-log/main'
import { formatLog, pushLogLine } from './log-buffer'

/** Minimal logger surface used throughout the agent. electron-log satisfies it. */
export interface Logger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  debug(...args: unknown[]): void
}

// Re-export so the rest of the app keeps importing from './util/log'.
export { logEmitter, getLogBuffer } from './log-buffer'

let initialized = false

export function initLogging(level: string = 'info'): void {
  if (!initialized) {
    log.initialize()
    // Custom transport: mirror every log entry into the GUI ring buffer.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gui: any = (message: any) => {
      try {
        pushLogLine(formatLog(message))
      } catch {
        /* never let logging throw */
      }
    }
    gui.level = level
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(log.transports as any).gui = gui
    initialized = true
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(log.transports as any).gui.level = level
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log.transports.file.level = level as any
  log.transports.console.level = 'debug'
}

/** Return a child logger tagged with a scope label. */
export function scoped(scope: string): Logger {
  return {
    info: (...a) => log.info(`[${scope}]`, ...a),
    warn: (...a) => log.warn(`[${scope}]`, ...a),
    error: (...a) => log.error(`[${scope}]`, ...a),
    debug: (...a) => log.debug(`[${scope}]`, ...a),
  }
}

export default log as unknown as Logger
