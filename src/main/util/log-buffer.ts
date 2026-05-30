import { EventEmitter } from 'node:events'
import { LOG_BUFFER_SIZE } from '@shared/constants'

/**
 * In-memory ring buffer of recent log lines + a stream, feeding the in-GUI Logs
 * panel. Kept free of any electron-log / electron import so it is unit-testable.
 */
const buffer: string[] = []
export const logEmitter = new EventEmitter()

export function getLogBuffer(): string[] {
  return buffer.slice()
}

export function pushLogLine(line: string): void {
  buffer.push(line)
  if (buffer.length > LOG_BUFFER_SIZE) buffer.shift()
  logEmitter.emit('line', line)
}

/** Format an electron-log message object into a single display line. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function formatLog(message: any): string {
  const d: Date = message?.date instanceof Date ? message.date : new Date()
  const time = d.toTimeString().slice(0, 8) // HH:MM:SS
  const level = String(message?.level ?? 'info').toUpperCase().padEnd(5)
  const text = (message?.data ?? [])
    .map((x: unknown) => (typeof x === 'string' ? x : safeStringify(x)))
    .join(' ')
  return `${time} ${level} ${text}`
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
