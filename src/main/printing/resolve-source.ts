import { promises as fs } from 'node:fs'
import type { JobSource } from '@shared/types'
import type { LoadedSource } from './driver'

const DEFAULT_TIMEOUT = 20_000
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024

export interface LoadOptions {
  timeoutMs?: number
  maxBytes?: number
  /** When false, a `file` source is rejected. */
  allowFile?: boolean
}

/**
 * Turn a JobSource into in-memory bytes (or inline text).
 *  - text   -> kept as text
 *  - base64 -> decoded to a Buffer
 *  - file   -> read from a local path (gated by allowFile)
 *  - url    -> fetched (with timeout + size cap) into a Buffer
 */
export async function loadSource(source: JobSource, opts: LoadOptions = {}): Promise<LoadedSource> {
  if (source.text != null) return { text: source.text }
  if (source.base64 != null) {
    const buffer = Buffer.from(source.base64, 'base64')
    enforceSize(buffer.length, opts.maxBytes)
    return { buffer }
  }
  if (source.file != null) {
    if (opts.allowFile === false) throw new Error('printing from a local file path is disabled')
    const buffer = await fs.readFile(source.file)
    enforceSize(buffer.length, opts.maxBytes)
    return { buffer }
  }
  if (source.url != null) return { buffer: await fetchToBuffer(source.url, opts) }
  throw new Error('source has no url, base64, text, or file')
}

async function fetchToBuffer(url: string, opts: LoadOptions): Promise<Buffer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT)
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!res.ok) throw new Error(`fetch failed ${res.status} ${res.statusText}`)
    const buffer = Buffer.from(await res.arrayBuffer())
    enforceSize(buffer.length, opts.maxBytes)
    return buffer
  } finally {
    clearTimeout(timer)
  }
}

function enforceSize(n: number, max?: number): void {
  const limit = max ?? DEFAULT_MAX_BYTES
  if (n > limit) throw new Error(`payload too large: ${n} bytes (max ${limit})`)
}
