/**
 * Runtime validation (zod) + canonicalization for the print job contract.
 *
 * `stableStringify` / `canonicalJob` are pure and must stay byte-for-byte
 * identical to the browser SDK's implementation so HMAC signatures match.
 */
import { z } from 'zod'
import { PROTOCOL_VERSION } from './constants'
import type { PrintJob } from './types'

export const jobSourceSchema = z
  .object({
    url: z.string().url().optional(),
    base64: z.string().optional(),
    text: z.string().optional(),
    file: z.string().max(4096).optional(),
  })
  .refine((s) => [s.url, s.base64, s.text, s.file].filter((v) => v != null).length === 1, {
    message: 'source must contain exactly one of url, base64, text, or file',
  })

export const jobPrinterSchema = z.object({
  name: z.string().max(256).optional(),
  transport: z.enum(['queue', 'network']).optional(),
  host: z.string().max(256).optional(),
  port: z.number().int().min(1).max(65535).optional(),
})

export const jobOptionsSchema = z.object({
  paperSize: z.string().max(32).optional(),
  orientation: z.enum(['portrait', 'landscape']).optional(),
  silent: z.boolean().optional(),
  duplex: z.boolean().optional(),
  scale: z.union([z.number(), z.enum(['noscale', 'shrink', 'fit'])]).optional(),
  monochrome: z.boolean().optional(),
  cut: z.boolean().optional(),
  openCashDrawer: z.boolean().optional(),
  characterSet: z.string().max(64).optional(),
  toPdfFirst: z.boolean().optional(),
  width: z.number().int().min(1).max(256).optional(),
})

export const jobMetaSchema = z.object({
  building: z.string().max(128).optional(),
  terminal: z.string().max(128).optional(),
  user: z.string().max(128).optional(),
  docType: z.string().max(64).optional(),
  docId: z.union([z.string().max(128), z.number()]).optional(),
  label: z.string().max(256).optional(),
})

export const printJobSchema = z.object({
  v: z.number().int(),
  id: z.string().min(1).max(128),
  type: z.enum(['pdf', 'escpos', 'image', 'html', 'raw', 'website']),
  source: jobSourceSchema,
  data: z.unknown().optional(),
  printer: jobPrinterSchema.optional(),
  printers: z.array(z.string().max(256)).max(32).optional(),
  copies: z.number().int().min(1).max(99).optional(),
  options: jobOptionsSchema.optional(),
  meta: jobMetaSchema.optional(),
  ts: z.number().int().optional(),
  nonce: z.string().max(128).optional(),
  signature: z.string().max(256).optional(),
})

export type ParsedJobResult =
  | { ok: true; job: PrintJob }
  | { ok: false; error: string }

export function parsePrintJob(input: unknown): ParsedJobResult {
  const res = printJobSchema.safeParse(input)
  if (!res.success) {
    const first = res.error.issues[0]
    const path = first?.path?.join('.') || '(root)'
    return { ok: false, error: `${path}: ${first?.message ?? 'invalid job'}` }
  }
  return { ok: true, job: res.data as PrintJob }
}

/**
 * Deterministic JSON: object keys sorted recursively, undefined dropped.
 * Arrays keep their order. Must match the browser SDK exactly.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sortDeep)
  const obj = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] === undefined) continue
    out[key] = sortDeep(obj[key])
  }
  return out
}

/** Canonical string that gets HMAC-signed: the job with `signature` removed. */
export function canonicalJob(job: PrintJob): string {
  const { signature: _sig, ...rest } = job
  return stableStringify(rest)
}

/** Convenience: build a well-formed job skeleton (used by tests/test prints). */
export function makeJob(partial: Partial<PrintJob> & Pick<PrintJob, 'type' | 'source'>): PrintJob {
  return {
    v: PROTOCOL_VERSION,
    id: partial.id ?? cryptoRandomId(),
    type: partial.type,
    source: partial.source,
    data: partial.data,
    printer: partial.printer,
    copies: partial.copies,
    options: partial.options,
    meta: partial.meta,
    ts: partial.ts,
    nonce: partial.nonce,
    signature: partial.signature,
  }
}

function cryptoRandomId(): string {
  // Works in both node (>=19) and the browser via the Web Crypto global.
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } }
  if (g.crypto?.randomUUID) return g.crypto.randomUUID()
  return 'job-' + Math.abs(hashString(String(Date.now()))).toString(36)
}

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}
