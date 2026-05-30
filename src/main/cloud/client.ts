import WebSocket from 'ws'
import { app } from 'electron'
import { PROTOCOL_VERSION, CLOUD_BACKOFF_MAX_MS, CLOUD_HEARTBEAT_MS } from '@shared/constants'
import type { CloudSettings, JobOptions, JobType, PrintJob } from '@shared/types'
import type { PrintEngine } from '../printing'
import type { ConfigStore } from '../config/store'
import { scoped } from '../util/log'
import { Outbox, type OutboxItem } from './outbox'

const log = scoped('cloud')

export type CloudConnState = 'disabled' | 'connecting' | 'connected' | 'disconnected' | 'error'

export interface CloudState {
  state: CloudConnState
  detail?: string
}

/** Shape of the Laravel `print-job.queued` broadcast payload. */
interface CloudJobEvent {
  id: string
  document_type?: string
  format: JobType
  payload_url?: string | null
  payload?: string | null
  printer_name?: string | null
  copies?: number
  options?: JobOptions
  status_url?: string
  expires_at?: string
}

/**
 * Connects out to a Laravel Reverb server (Pusher protocol, implemented natively
 * over `ws`), subscribes to the terminal's private channel, prints pushed jobs,
 * and reports status back over REST. Robust in Electron's main process — no
 * browser globals required.
 */
export class CloudClient {
  private ws: WebSocket | null = null
  private socketId: string | null = null
  private stopped = true
  private attempt = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private state: CloudState = { state: 'disabled' }
  private readonly outbox = new Outbox()

  constructor(
    private readonly store: ConfigStore,
    private readonly engine: PrintEngine,
    private readonly onState: (s: CloudState) => void,
  ) {}

  get currentState(): CloudState {
    return this.state
  }

  async start(): Promise<void> {
    const cfg = this.store.get().cloud
    if (!cfg.enabled || !this.isConfigured(cfg)) {
      this.setState({ state: 'disabled' })
      return
    }
    this.stopped = false
    await this.outbox.load()
    this.connect(cfg)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.clearTimers()
    if (this.ws) {
      this.ws.removeAllListeners()
      try {
        this.ws.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
    this.socketId = null
    this.setState({ state: 'disabled' })
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  private isConfigured(cfg: CloudSettings): boolean {
    return !!(cfg.baseUrl && cfg.reverbKey && cfg.reverbHost && cfg.building && cfg.terminal && cfg.token)
  }

  private channelName(cfg: CloudSettings): string {
    return `private-printer.${cfg.building}.${cfg.terminal}`
  }

  private connect(cfg: CloudSettings): void {
    this.setState({ state: 'connecting' })
    const scheme = cfg.reverbScheme === 'https' ? 'wss' : 'ws'
    const port = cfg.reverbPort ?? (cfg.reverbScheme === 'https' ? 443 : 80)
    const url =
      `${scheme}://${cfg.reverbHost}:${port}/app/${cfg.reverbKey}` +
      `?protocol=7&client=terminal-printer&version=${app.getVersion()}`

    log.info(`connecting to ${cfg.reverbHost}:${port}`)
    const ws = new WebSocket(url)
    this.ws = ws

    ws.on('message', (raw) => this.onFrame(cfg, raw.toString()))
    ws.on('error', (err) => {
      log.error('socket error', String(err))
      this.setState({ state: 'error', detail: String(err) })
    })
    ws.on('close', () => {
      if (this.stopped) return
      this.setState({ state: 'disconnected' })
      this.scheduleReconnect(cfg)
    })
  }

  private onFrame(cfg: CloudSettings, text: string): void {
    let frame: { event?: string; data?: unknown; channel?: string }
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    const data = typeof frame.data === 'string' ? safeParse(frame.data) : frame.data

    switch (frame.event) {
      case 'pusher:connection_established': {
        this.attempt = 0
        this.socketId = (data as { socket_id?: string })?.socket_id ?? null
        log.info('connected, socket', this.socketId)
        this.setState({ state: 'connected' })
        void this.subscribe(cfg)
        this.startTimers(cfg)
        void this.register(cfg)
        void this.outbox.flush((item) => this.postRaw(item))
        break
      }
      case 'pusher:ping':
        this.sendFrame({ event: 'pusher:pong', data: {} })
        break
      case 'pusher:error':
        log.warn('pusher error', JSON.stringify(data))
        break
      case 'pusher_internal:subscription_succeeded':
        log.info('subscribed to', frame.channel)
        break
      case 'print-job.queued':
        void this.onJob(cfg, data as CloudJobEvent)
        break
      default:
        break
    }
  }

  private async subscribe(cfg: CloudSettings): Promise<void> {
    if (!this.socketId) return
    const channel = this.channelName(cfg)
    try {
      const res = await fetch(`${cfg.baseUrl}/broadcasting/auth`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${cfg.token}`,
        },
        body: JSON.stringify({ socket_id: this.socketId, channel_name: channel }),
      })
      if (!res.ok) throw new Error(`auth ${res.status}`)
      const auth = (await res.json()) as { auth: string }
      this.sendFrame({ event: 'pusher:subscribe', data: { auth: auth.auth, channel } })
    } catch (err) {
      log.error('channel auth failed', String(err))
      this.setState({ state: 'error', detail: 'channel auth failed' })
    }
  }

  private async onJob(cfg: CloudSettings, ev: CloudJobEvent): Promise<void> {
    if (!ev?.id) return
    log.info(`cloud job ${ev.id} (${ev.format})`)
    const job: PrintJob = {
      v: PROTOCOL_VERSION,
      id: ev.id,
      type: ev.format,
      source: ev.payload_url ? { url: ev.payload_url } : ev.payload ? { base64: ev.payload } : { text: '' },
      printer: ev.printer_name ? { name: ev.printer_name } : undefined,
      copies: ev.copies,
      options: ev.options,
      meta: { building: cfg.building ?? undefined, terminal: cfg.terminal ?? undefined, docType: ev.document_type },
    }

    const statusUrl = ev.status_url ? this.absolute(cfg, ev.status_url) : null
    if (statusUrl) await this.report(cfg, statusUrl, ev.id, { status: 'printing' })

    const result = await this.engine.enqueue(job, 'cloud')

    if (statusUrl) {
      await this.report(
        cfg,
        statusUrl,
        ev.id,
        result.status === 'printed' ? { status: 'done' } : { status: 'failed', error: result.error },
      )
    }
  }

  private async register(cfg: CloudSettings): Promise<void> {
    const printers = await this.engine.listPrinters().catch(() => [])
    const url = this.apiBase(cfg) + '/register'
    try {
      await this.apiPost(cfg, url, {
        platform: process.platform,
        app_version: app.getVersion(),
        printers: printers.map((p) => ({ name: p.name, is_default: p.isDefault })),
        capabilities: { formats: ['pdf', 'escpos', 'image', 'html', 'raw'] },
      })
      log.info('registered with server')
    } catch (err) {
      log.warn('register failed', String(err))
    }
  }

  private async heartbeat(cfg: CloudSettings): Promise<void> {
    try {
      await this.apiPost(cfg, this.apiBase(cfg) + '/heartbeat', {})
    } catch (err) {
      log.debug('heartbeat failed', String(err))
    }
  }

  private async report(
    cfg: CloudSettings,
    url: string,
    jobId: string,
    body: { status: string; error?: string },
  ): Promise<void> {
    const item: OutboxItem = {
      url,
      body,
      headers: { Authorization: `Bearer ${cfg.token}`, 'Idempotency-Key': `${jobId}:${body.status}` },
    }
    try {
      await this.postRaw(item)
    } catch (err) {
      log.warn(`status post failed for ${jobId}, queueing:`, String(err))
      await this.outbox.add(item)
    }
  }

  private async apiPost(cfg: CloudSettings, url: string, body: unknown): Promise<void> {
    await this.postRaw({ url, body, headers: { Authorization: `Bearer ${cfg.token}` } })
  }

  private async postRaw(item: OutboxItem): Promise<void> {
    const res = await fetch(item.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(item.headers ?? {}) },
      body: JSON.stringify(item.body),
    })
    if (!res.ok) throw new Error(`POST ${item.url} -> ${res.status}`)
  }

  private apiBase(cfg: CloudSettings): string {
    return `${cfg.baseUrl}/api/v1/buildings/${cfg.building}/printers`
  }

  private absolute(cfg: CloudSettings, pathOrUrl: string): string {
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl
    return new URL(pathOrUrl, cfg.baseUrl ?? undefined).toString()
  }

  private sendFrame(frame: { event: string; data: unknown; channel?: string }): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame))
    }
  }

  private startTimers(cfg: CloudSettings): void {
    this.clearTimers()
    this.pingTimer = setInterval(() => this.sendFrame({ event: 'pusher:ping', data: {} }), 60_000)
    this.heartbeatTimer = setInterval(() => void this.heartbeat(cfg), CLOUD_HEARTBEAT_MS)
  }

  private clearTimers(): void {
    for (const t of [this.pingTimer, this.heartbeatTimer, this.reconnectTimer]) {
      if (t) clearInterval(t as NodeJS.Timeout)
    }
    this.pingTimer = this.heartbeatTimer = this.reconnectTimer = null
  }

  private scheduleReconnect(cfg: CloudSettings): void {
    if (this.stopped) return
    this.attempt++
    const delay = Math.min(CLOUD_BACKOFF_MAX_MS, 1000 * 2 ** Math.min(this.attempt, 5))
    log.info(`reconnecting in ${delay}ms (attempt ${this.attempt})`)
    this.reconnectTimer = setTimeout(() => this.connect(cfg), delay)
  }

  private setState(s: CloudState): void {
    this.state = s
    this.onState(s)
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
