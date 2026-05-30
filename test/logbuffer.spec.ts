import { describe, it, expect } from 'vitest'
import { LOG_BUFFER_SIZE } from '@shared/constants'
import { pushLogLine, getLogBuffer, logEmitter, formatLog } from '../src/main/util/log-buffer'

describe('formatLog', () => {
  it('formats time, level, and message', () => {
    const date = new Date(2026, 0, 1, 13, 5, 9)
    const line = formatLog({ date, level: 'info', data: ['[scope]', 'hello', 42] })
    expect(line).toContain('13:05:09')
    expect(line).toContain('INFO')
    expect(line).toContain('[scope] hello 42')
  })

  it('does not throw on missing fields', () => {
    expect(() => formatLog({})).not.toThrow()
  })
})

describe('log ring buffer', () => {
  it('caps at LOG_BUFFER_SIZE and keeps the newest line', () => {
    for (let i = 0; i < LOG_BUFFER_SIZE + 25; i++) pushLogLine('line ' + i)
    const buf = getLogBuffer()
    expect(buf.length).toBe(LOG_BUFFER_SIZE)
    expect(buf[buf.length - 1]).toBe('line ' + (LOG_BUFFER_SIZE + 24))
  })

  it('emits each pushed line', () => {
    const seen: string[] = []
    const handler = (l: string) => seen.push(l)
    logEmitter.on('line', handler)
    pushLogLine('emitted-1')
    logEmitter.off('line', handler)
    expect(seen).toContain('emitted-1')
  })
})
