/**
 * Terminal Printer — universal browser/JS client SDK (UMD).
 *
 * Works three ways from a single file:
 *   • <script src="terminal-printer.js"></script>   → window.TerminalPrinter
 *   • const { TerminalPrinter } = require('terminal-printer')
 *   • import { TerminalPrinter } from 'terminal-printer.mjs'   (ESM wrapper)
 *
 * Dependency-free. Discovers the local Terminal Printer agent, auto-connects,
 * performs a one-time (auto-approved) pairing to obtain a per-site token, and
 * HMAC-signs every job so it prints silently — no browser print dialog.
 *
 * Quick start:
 *   <script src="terminal-printer.js"></script>
 *   <script>
 *     const tp = new TerminalPrinter()                 // auto-connects
 *     await tp.printPdf('https://my.app/receipt.pdf', { options: { paperSize: 'A5' } })
 *   </script>
 */
;(function (global, factory) {
  const mod = factory()
  if (typeof module === 'object' && module.exports) {
    module.exports = mod
    module.exports.TerminalPrinter = mod.TerminalPrinter
  } else {
    global.TerminalPrinter = mod.TerminalPrinter
    global.TerminalPrinterSDK = mod
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'

  const PROTOCOL_VERSION = 1
  const DEFAULT_PORTS = [9120, 9121, 9122]

  class TerminalPrinter {
    /**
     * @param {object} [options]
     * @param {boolean} [options.autoConnect=true] connect (and discover) immediately
     * @param {number[]} [options.ports]   ports to probe (default [9120,9121,9122])
     * @param {string}   [options.host]    loopback host (default '127.0.0.1')
     * @param {boolean}  [options.autoReconnect=true]
     * @param {string}   [options.storageKey] localStorage key for the pairing token
     * @param {string}   [options.siteName]  label for this site
     * @param {number}   [options.jobTimeoutMs=60000]
     */
    constructor(options) {
      options = options || {}
      this.host = options.host || '127.0.0.1'
      this.ports = options.ports || DEFAULT_PORTS
      this.autoReconnect = options.autoReconnect !== false
      this.storageKey = options.storageKey || 'terminal-printer:secret'
      this.siteName = options.siteName || (typeof document !== 'undefined' ? document.title : '')
      this.jobTimeoutMs = options.jobTimeoutMs || 60000

      this.port = null
      this.ws = null
      this.agentInfo = null
      this.connected = false
      this.paired = false

      this._secret = this._loadSecret()
      this._cryptoKey = null
      this._pending = new Map()
      this._pairWaiters = []
      this._printersWaiters = []
      this._listeners = new Map()
      this._connectPromise = null
      this._reconnectAttempt = 0
      this._stopped = false

      if (options.autoConnect !== false) {
        // Fire-and-forget; print() also connects lazily if this hasn't finished.
        this.connect().catch(() => undefined)
      }
    }

    /** True when connected AND paired (ready to print). */
    get available() {
      return this.connected && !!this._secret
    }

    /* ---------------- connection ---------------- */

    async connect() {
      if (this.connected) return
      if (this._connectPromise) return this._connectPromise
      this._stopped = false
      this._connectPromise = this._doConnect().finally(() => {
        this._connectPromise = null
      })
      return this._connectPromise
    }

    async _doConnect() {
      const port = await this._discover()
      if (!port) throw new Error('Terminal Printer agent not found on this machine')
      this.port = port
      await this._openSocket()
    }

    async _discover() {
      for (const port of this.ports) {
        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 700)
          const res = await fetch('http://' + this.host + ':' + port + '/health', { signal: controller.signal })
          clearTimeout(timer)
          if (res.ok) {
            this.agentInfo = await res.json()
            return port
          }
        } catch (e) {
          /* try next */
        }
      }
      return null
    }

    _openSocket() {
      return new Promise((resolve, reject) => {
        let settled = false
        const ws = new WebSocket('ws://' + this.host + ':' + this.port + '/ws')
        this.ws = ws
        ws.onopen = () => {
          this.connected = true
          this._reconnectAttempt = 0
          this._emit('open')
        }
        ws.onmessage = (e) => {
          let msg
          try {
            msg = JSON.parse(e.data)
          } catch (err) {
            return
          }
          if (msg.kind === 'hello') {
            this.agentInfo = { name: msg.name, version: msg.version, agentId: msg.agentId }
            this.paired = !!msg.paired
            if (!settled) {
              settled = true
              resolve()
            }
          }
          this._handle(msg)
        }
        ws.onerror = () => {
          this._emit('error', new Error('WebSocket error'))
          if (!settled) {
            settled = true
            reject(new Error('Could not connect to the Terminal Printer agent'))
          }
        }
        ws.onclose = () => {
          this.connected = false
          this.ws = null
          this._emit('close')
          this._failAllPending('connection closed')
          if (this.autoReconnect && !this._stopped) this._scheduleReconnect()
        }
      })
    }

    _scheduleReconnect() {
      this._reconnectAttempt++
      const delay = Math.min(15000, 500 * Math.pow(2, Math.min(this._reconnectAttempt, 5)))
      setTimeout(() => {
        if (this._stopped) return
        this.connect().catch(() => undefined)
      }, delay)
    }

    disconnect() {
      this._stopped = true
      if (this.ws) this.ws.close()
    }

    _handle(msg) {
      switch (msg.kind) {
        case 'paired':
          this.paired = true
          this._setSecret(msg.secret)
          for (const w of this._pairWaiters.splice(0)) w.resolve(msg.secret)
          break
        case 'pair_denied':
          for (const w of this._pairWaiters.splice(0)) w.reject(new Error('Pairing was denied (site blocked)'))
          break
        case 'pair_required':
          this.paired = false
          this._emit('pair_required')
          break
        case 'printers':
          for (const w of this._printersWaiters.splice(0)) w.resolve(msg.printers)
          break
        case 'ack':
          this._emit('status', { id: msg.id, status: msg.status })
          break
        case 'result': {
          this._emit('result', msg)
          const p = this._pending.get(msg.id)
          if (p) {
            this._pending.delete(msg.id)
            clearTimeout(p.timer)
            msg.status === 'printed' ? p.resolve(msg) : p.reject(new Error(msg.error || 'print failed'))
          }
          break
        }
        case 'error': {
          this._emit('error', new Error(msg.error))
          if (msg.id) {
            const p = this._pending.get(msg.id)
            if (p) {
              this._pending.delete(msg.id)
              clearTimeout(p.timer)
              p.reject(new Error(msg.error))
            }
          }
          break
        }
      }
    }

    /* ---------------- pairing ---------------- */

    pair() {
      if (!this.connected) return Promise.reject(new Error('not connected'))
      return new Promise((resolve, reject) => {
        this._pairWaiters.push({ resolve, reject })
        this._send({ kind: 'pair', name: this.siteName })
      })
    }

    async _ensurePaired() {
      if (this._secret) return
      await this.pair()
    }

    /* ---------------- printing ---------------- */

    listPrinters() {
      if (!this.connected) return Promise.reject(new Error('not connected'))
      return new Promise((resolve, reject) => {
        this._printersWaiters.push({ resolve, reject })
        this._send({ kind: 'printers' })
        setTimeout(() => reject(new Error('listPrinters timeout')), 5000)
      })
    }

    async print(job) {
      if (!this.connected) await this.connect()
      await this._ensurePaired()
      try {
        return await this._sendJob(job)
      } catch (err) {
        if (/signature|unpaired|not registered|not paired/i.test(err.message || '')) {
          this._setSecret(null)
          await this.pair()
          return this._sendJob(job)
        }
        throw err
      }
    }

    async _sendJob(job) {
      const full = Object.assign(
        { v: PROTOCOL_VERSION, id: 'tp-' + this._uuid(), ts: Date.now(), nonce: this._uuid() },
        job,
      )
      full.signature = await this._sign(full)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this._pending.delete(full.id)
          reject(new Error('print job timed out'))
        }, this.jobTimeoutMs)
        this._pending.set(full.id, { resolve, reject, timer })
        this._send({ kind: 'job', job: full })
      })
    }

    printUrl(url, opts) {
      opts = opts || {}
      return this.print(Object.assign({ type: opts.type || 'pdf', source: { url: url } }, opts))
    }
    printPdf(urlOrBase64, opts) {
      const source = /^https?:|^data:/.test(urlOrBase64) ? { url: urlOrBase64 } : { base64: urlOrBase64 }
      return this.print(Object.assign({ type: 'pdf', source: source }, opts || {}))
    }
    printHtml(html, opts) {
      return this.print(Object.assign({ type: 'html', source: { text: html } }, opts || {}))
    }
    printImage(urlOrBase64, opts) {
      const source = /^https?:|^data:/.test(urlOrBase64) ? { url: urlOrBase64 } : { base64: urlOrBase64 }
      return this.print(Object.assign({ type: 'image', source: source }, opts || {}))
    }
    printEscpos(textOrModel, opts) {
      const job = typeof textOrModel === 'string' ? { source: { text: textOrModel } } : { data: textOrModel, source: { text: '' } }
      return this.print(Object.assign({ type: 'escpos' }, job, opts || {}))
    }
    printZpl(zpl, opts) {
      return this.print(Object.assign({ type: 'raw', source: { text: zpl } }, opts || {}))
    }
    printWebsite(url, opts) {
      return this.print(Object.assign({ type: 'website', source: { url: url } }, opts || {}))
    }
    printToMany(printers, job) {
      return this.print(Object.assign({}, job, { printers: printers }))
    }

    /* ---------------- signing (Web Crypto) ---------------- */

    async _sign(job) {
      const key = await this._key()
      const rest = Object.assign({}, job)
      delete rest.signature
      const data = new TextEncoder().encode(stableStringify(rest))
      const sig = await crypto.subtle.sign('HMAC', key, data)
      return Array.prototype.map.call(new Uint8Array(sig), (b) => ('0' + b.toString(16)).slice(-2)).join('')
    }

    async _key() {
      if (this._cryptoKey) return this._cryptoKey
      const raw = new TextEncoder().encode(this._secret)
      this._cryptoKey = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      return this._cryptoKey
    }

    /* ---------------- events ---------------- */

    on(event, cb) {
      if (!this._listeners.has(event)) this._listeners.set(event, new Set())
      this._listeners.get(event).add(cb)
      return this
    }
    off(event, cb) {
      const set = this._listeners.get(event)
      if (set) set.delete(cb)
      return this
    }
    _emit(event, payload) {
      const set = this._listeners.get(event)
      if (set) set.forEach((cb) => { try { cb(payload) } catch (e) { /* ignore */ } })
    }

    /* ---------------- helpers ---------------- */

    _send(obj) {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj))
    }
    _failAllPending(reason) {
      this._pending.forEach((p) => {
        clearTimeout(p.timer)
        p.reject(new Error(reason))
      })
      this._pending.clear()
    }
    _loadSecret() {
      try {
        return typeof localStorage !== 'undefined' ? localStorage.getItem(this.storageKey) : null
      } catch (e) {
        return null
      }
    }
    _setSecret(secret) {
      this._secret = secret
      this._cryptoKey = null
      try {
        if (typeof localStorage !== 'undefined') {
          secret ? localStorage.setItem(this.storageKey, secret) : localStorage.removeItem(this.storageKey)
        }
      } catch (e) {
        /* private mode */
      }
    }
    _uuid() {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15)
        const v = c === 'x' ? r : (r & 0x3) | 0x8
        return v.toString(16)
      })
    }
  }

  function stableStringify(value) {
    return JSON.stringify(sortDeep(value))
  }
  function sortDeep(value) {
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(sortDeep)
    const out = {}
    Object.keys(value)
      .sort()
      .forEach((key) => {
        if (value[key] === undefined) return
        out[key] = sortDeep(value[key])
      })
    return out
  }

  return { TerminalPrinter: TerminalPrinter, stableStringify: stableStringify }
})
