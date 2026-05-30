import type { AgentSettings, PrinterInfo, JobType } from '@shared/types'
import type { AgentStatus, QueueJobView, QueueSnapshot, WebsiteListItem, WebsiteDetail } from '@shared/ipc'

const agent = window.agent

// Apply theme before first paint to avoid a flash.
;(() => {
  const stored = localStorage.getItem('tp-theme')
  const theme = stored || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
  document.documentElement.setAttribute('data-theme', theme)
})()

function setupTheme(): void {
  $('themeToggle').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light'
    document.documentElement.setAttribute('data-theme', next)
    localStorage.setItem('tp-theme', next)
  })
}

function setupNav(): void {
  const items = Array.from(document.querySelectorAll<HTMLButtonElement>('.nav-item'))
  const panels = Array.from(document.querySelectorAll<HTMLElement>('.panel'))
  for (const item of items) {
    item.addEventListener('click', () => {
      const section = item.dataset.section
      for (const i of items) i.classList.toggle('is-active', i === item)
      for (const p of panels) p.classList.toggle('is-active', p.dataset.panel === section)
      document.querySelector('.content')?.scrollTo({ top: 0 })
    })
  }
}

const DOC_TYPES: Array<{ key: string; label: string }> = [
  { key: 'receipt', label: 'Receipts' },
  { key: 'invoice', label: 'Invoices' },
  { key: 'statement', label: 'Statements' },
  { key: 'label', label: 'Labels' },
  { key: 'escpos', label: 'Thermal (ESC/POS)' },
  { key: 'raw', label: 'Raw / ZPL' },
]

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T

let settings: AgentSettings
let printers: PrinterInfo[] = []

async function init(): Promise<void> {
  setupTheme()
  setupNav()
  settings = await agent.getSettings()
  printers = await agent.listPrinters().catch(() => [])
  renderPrinters()
  bindControls()
  renderWebsitesList(await agent.getWebsites())
  agent.onWebsites(renderWebsitesList)
  renderQueue(await agent.getQueue())
  agent.onQueue(renderQueue)
  renderLogs(await agent.getLogs())
  agent.onLog(appendLogs)
  applyStatus(await agent.getStatus())
  agent.onStatus(applyStatus)
}

/* ---------- printers ---------- */

function renderPrinters(): void {
  fillSelect($('defaultPrinter') as HTMLSelectElement, settings.defaultPrinter, '(system default)')

  const container = $('printerMap')
  container.innerHTML = ''
  for (const dt of DOC_TYPES) {
    const row = document.createElement('div')
    row.className = 'map-row'
    const label = document.createElement('label')
    label.textContent = dt.label
    const select = document.createElement('select')
    select.id = `map-${dt.key}`
    fillSelect(select, settings.printerMap[dt.key] ?? '', 'Use default')
    select.addEventListener('change', savePrinterMap)
    row.append(label, select)
    container.append(row)
  }
}

function fillSelect(select: HTMLSelectElement, selected: string | null, emptyLabel: string): void {
  select.innerHTML = ''
  const none = new Option(emptyLabel, '')
  select.append(none)
  for (const p of printers) {
    select.append(new Option(p.displayName || p.name, p.name))
  }
  select.value = selected ?? ''
}

async function savePrinterMap(): Promise<void> {
  const map: Record<string, string> = {}
  for (const dt of DOC_TYPES) {
    const value = ($(`map-${dt.key}`) as HTMLSelectElement).value
    if (value) map[dt.key] = value
  }
  settings = await agent.setSettings({ printerMap: map })
  toast('Printer mapping saved')
}

/* ---------- controls ---------- */

function bindControls(): void {
  $('refreshPrinters').addEventListener('click', async () => {
    printers = await agent.listPrinters().catch(() => [])
    renderPrinters()
    toast('Printers refreshed')
  })

  const defaultSel = $('defaultPrinter') as HTMLSelectElement
  defaultSel.addEventListener('change', async () => {
    settings = await agent.setSettings({ defaultPrinter: defaultSel.value || null })
    toast('Default printer saved')
  })

  const port = $('localPort') as HTMLInputElement
  port.value = String(settings.localPort)
  $('restartServer').addEventListener('click', async () => {
    const value = parseInt(port.value, 10)
    if (!value || value < 1 || value > 65535) return toast('Invalid port', 'error')
    settings = await agent.setSettings({ localPort: value })
    await agent.restartServer()
    toast('Server restarted')
  })
  $('toggleServer').addEventListener('click', async () => {
    const st = await agent.getStatus()
    if (st.serverRunning) {
      await agent.stopServer()
      toast('Server stopped')
    } else {
      await agent.restartServer()
      toast('Server started')
    }
  })

  // Cloud fields
  ;($('cloudEnabled') as HTMLInputElement).checked = settings.cloud.enabled
  setVal('baseUrl', settings.cloud.baseUrl)
  setVal('building', settings.cloud.building)
  setVal('terminal', settings.cloud.terminal)
  setVal('token', settings.cloud.token)
  setVal('reverbKey', settings.cloud.reverbKey)
  setVal('reverbHost', settings.cloud.reverbHost)
  setVal('reverbPort', settings.cloud.reverbPort != null ? String(settings.cloud.reverbPort) : '')
  ;($('reverbScheme') as HTMLSelectElement).value = settings.cloud.reverbScheme

  $('saveCloud').addEventListener('click', saveCloud)
  $('reconnectCloud').addEventListener('click', async () => {
    await agent.restartCloud()
    toast('Reconnecting…')
  })

  // Test print
  for (const btn of document.querySelectorAll<HTMLButtonElement>('#testButtons .btn')) {
    btn.addEventListener('click', async () => {
      const type = btn.dataset.test as JobType
      btn.disabled = true
      try {
        const result = await agent.testPrint(type)
        toast(
          result.status === 'printed' ? `Test ${type} printed` : `Test ${type} failed: ${result.error}`,
          result.status === 'printed' ? 'success' : 'error',
        )
      } catch (err) {
        toast(`Test ${type} failed: ${String(err)}`, 'error')
      } finally {
        btn.disabled = false
      }
    })
  }

  // General
  bindCheckbox('startOnLogin', settings.startOnLogin, (checked) => ({ startOnLogin: checked }))
  bindCheckbox('paused', settings.paused, (checked) => ({ paused: checked }))
  const logLevel = $('logLevel') as HTMLSelectElement
  logLevel.value = settings.logLevel
  logLevel.addEventListener('change', async () => {
    settings = await agent.setSettings({ logLevel: logLevel.value as AgentSettings['logLevel'] })
    toast('Log level saved')
  })

  // Queue settings
  bindNumber('maxConcurrent', settings.maxConcurrent)
  bindNumber('maxAttempts', settings.maxAttempts)
  bindNumber('retryBackoffMs', settings.retryBackoffMs)
  bindNumber('historyLimit', settings.historyLimit)
  bindCheckbox('persistQueue', settings.persistQueue, (c) => ({ persistQueue: c }))
  bindCheckbox('allowFileSource', settings.allowFileSource, (c) => ({ allowFileSource: c }))
  $('clearHistory').addEventListener('click', () => agent.clearQueueHistory())

  // Status + Logs
  $('recheck').addEventListener('click', async () => {
    applyStatus(await agent.getStatus())
    renderQueue(await agent.getQueue())
    toast('Re-checked')
  })
  $('openLogs').addEventListener('click', () => agent.openLogs())
  $('copyLogs').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('logView').textContent || '')
      toast('Logs copied')
    } catch {
      toast('Copy failed', 'error')
    }
  })
}

function bindNumber(id: keyof AgentSettings & string, initial: number): void {
  const el = $(id) as HTMLInputElement
  el.value = String(initial)
  el.addEventListener('change', async () => {
    const v = parseInt(el.value, 10)
    if (Number.isNaN(v)) return
    settings = await agent.setSettings({ [id]: v } as Partial<AgentSettings>)
    toast('Saved')
  })
}

/* ---------- queue ---------- */

function renderQueue(snap: QueueSnapshot): void {
  const badge = $('navQueueBadge')
  const live = snap.activeCount + snap.queuedCount
  badge.hidden = live === 0
  badge.textContent = String(live)
  const body = $('queueBody')
  const all = [...snap.active, ...snap.queued, ...snap.history]
  if (!all.length) {
    body.innerHTML = '<p class="muted">No jobs yet.</p>'
    return
  }
  body.innerHTML = ''
  const list = document.createElement('div')
  list.className = 'queue-list'
  for (const job of all) list.append(renderJobRow(job))
  body.append(list)
}

function renderJobRow(job: QueueJobView): HTMLElement {
  const row = document.createElement('div')
  row.className = 'queue-row'

  const main = document.createElement('div')
  main.className = 'queue-main'
  const attempts = job.attempts > 1 ? ` · try ${job.attempts}/${job.maxAttempts}` : ''
  main.innerHTML =
    `<span class="qtype">${escapeHtml(job.type)}</span> ` +
    `<span class="qprinter">${escapeHtml(job.printerName || '(default)')}</span>` +
    (job.origin ? ` <span class="muted">· ${escapeHtml(job.origin)}</span>` : '') +
    `<span class="muted">${attempts}</span>` +
    (job.error ? `<div class="qerror">${escapeHtml(job.error)}</div>` : '')

  const right = document.createElement('div')
  right.className = 'queue-right'
  const badge = document.createElement('span')
  badge.className = 'qstate q-' + job.state
  badge.textContent = job.state
  right.append(badge)

  if (job.state === 'queued') {
    right.append(makeBtn('Cancel', () => agent.cancelJob(job.id)))
  } else if (job.state === 'failed' || job.state === 'canceled') {
    right.append(makeBtn('Retry', () => agent.retryJob(job.id)))
  }
  row.append(main, right)
  return row
}

function makeBtn(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = 'btn ghost btn-xs'
  b.textContent = label
  b.addEventListener('click', onClick)
  return b
}

function bindCheckbox(id: string, initial: boolean, patch: (checked: boolean) => Partial<AgentSettings>): void {
  const el = $(id) as HTMLInputElement
  el.checked = initial
  el.addEventListener('change', async () => {
    settings = await agent.setSettings(patch(el.checked))
    toast('Saved')
  })
}

async function saveCloud(): Promise<void> {
  const patch = {
    enabled: ($('cloudEnabled') as HTMLInputElement).checked,
    baseUrl: getVal('baseUrl') || null,
    building: getVal('building') || null,
    terminal: getVal('terminal') || null,
    token: getVal('token') || null,
    reverbKey: getVal('reverbKey') || null,
    reverbHost: getVal('reverbHost') || null,
    reverbPort: getVal('reverbPort') ? parseInt(getVal('reverbPort'), 10) : null,
    reverbScheme: ($('reverbScheme') as HTMLSelectElement).value as 'http' | 'https',
  }
  settings = await agent.setCloud(patch)
  toast('Cloud settings saved', 'success')
}

/* ---------- websites ---------- */

let currentSites: WebsiteListItem[] = []
let selectedSite: string | null = null
let detailTab: 'files' | 'activity' = 'files'
let detailToken = 0 // guards against out-of-order async detail renders

function renderWebsitesList(sites: WebsiteListItem[]): void {
  currentSites = sites
  const online = sites.filter((s) => s.online).length
  const badge = $('navSitesBadge')
  badge.hidden = online === 0
  badge.textContent = String(online)

  const container = $('sitesList')
  if (!sites.length) {
    container.innerHTML = '<p class="muted">No websites yet.</p>'
    selectedSite = null
    $('siteDetail').hidden = true
    return
  }
  container.innerHTML = ''
  for (const s of sites) {
    const row = document.createElement('div')
    row.className = 'site-row' + (s.blocked ? ' blocked' : '') + (s.origin === selectedSite ? ' selected' : '')
    row.innerHTML =
      `<span class="site-led ${s.online ? 'online' : ''}"></span>` +
      `<div class="site-info"><div class="site-name">${escapeHtml(s.name)}</div><div class="site-origin">${escapeHtml(s.origin)}</div></div>` +
      `<div class="site-meta">${s.jobCount} jobs<small>${timeAgo(s.lastSeenAt)}</small></div>`
    row.addEventListener('click', () => openSite(s.origin))
    container.append(row)
  }

  if (selectedSite && sites.some((s) => s.origin === selectedSite)) void renderDetail(selectedSite)
  else {
    selectedSite = null
    $('siteDetail').hidden = true
  }
}

function openSite(origin: string): void {
  selectedSite = origin
  renderWebsitesList(currentSites)
}

async function renderDetail(origin: string): Promise<void> {
  const myToken = ++detailToken
  const d = await agent.getWebsiteDetail(origin)
  // A newer render or a selection change superseded this fetch — bail before
  // touching the DOM so a busy site's pushes don't flicker / reset the tab.
  if (myToken !== detailToken || selectedSite !== origin) return
  const panel = $('siteDetail')
  if (!d) {
    panel.hidden = true
    return
  }
  panel.hidden = false
  panel.innerHTML = ''

  const head = document.createElement('div')
  head.className = 'detail-head'
  head.innerHTML = `<h2>${escapeHtml(d.name)}${d.blocked ? ' · blocked' : ''}</h2>`
  const actions = document.createElement('div')
  actions.className = 'btn-row'
  actions.append(
    makeBtn(d.blocked ? 'Unblock' : 'Block', async () => {
      await agent.blockWebsite(origin, !d.blocked)
      toast(d.blocked ? 'Unblocked' : 'Blocked')
    }),
    makeBtn('Revoke', async () => {
      await agent.revokeWebsite(origin)
      selectedSite = null
      panel.hidden = true
      toast('Website revoked')
    }),
  )
  head.append(actions)

  const originLine = document.createElement('div')
  originLine.className = 'site-origin'
  originLine.textContent = d.origin

  const tokenRow = document.createElement('div')
  tokenRow.className = 'token-row'
  const tokenBox = document.createElement('div')
  tokenBox.className = 'token-box'
  tokenBox.textContent = d.token
  tokenRow.append(
    tokenBox,
    makeBtn('Copy', async () => {
      try {
        await navigator.clipboard.writeText(d.token)
        toast('Token copied')
      } catch {
        toast('Copy failed', 'error')
      }
    }),
    makeBtn('Regenerate', async () => {
      await agent.regenerateToken(origin)
      toast('Token regenerated')
    }),
  )

  const tabs = document.createElement('div')
  tabs.className = 'tabs'
  const mkTab = (label: string, tab: 'files' | 'activity') => {
    const b = document.createElement('button')
    b.className = 'tab' + (detailTab === tab ? ' is-active' : '')
    b.textContent = label
    b.addEventListener('click', () => {
      detailTab = tab
      void renderDetail(origin)
    })
    return b
  }
  tabs.append(mkTab(`Files (${d.jobs.length})`, 'files'), mkTab('Activity', 'activity'))

  panel.append(head, originLine, tokenRow, tabs, detailTab === 'files' ? renderFiles(d) : renderActivity(d))
}

function renderFiles(d: WebsiteDetail): HTMLElement {
  if (!d.jobs.length) {
    const p = document.createElement('p')
    p.className = 'muted'
    p.textContent = 'No files printed yet.'
    return p
  }
  const table = document.createElement('table')
  table.className = 'files-table'
  table.innerHTML = '<thead><tr><th>Type</th><th>Document</th><th>Printer</th><th>Status</th><th>When</th></tr></thead>'
  const tbody = document.createElement('tbody')
  for (const j of d.jobs) {
    const tr = document.createElement('tr')
    const color = j.status === 'printed' ? 'var(--green)' : 'var(--rose)'
    tr.innerHTML =
      `<td>${escapeHtml(j.type)}</td><td>${escapeHtml(j.label || '—')}</td>` +
      `<td>${escapeHtml(j.printer || '—')}</td>` +
      `<td style="color:${color}">${j.status}</td><td>${timeAgo(j.at)}</td>`
    tbody.append(tr)
  }
  table.append(tbody)
  return table
}

function renderActivity(d: WebsiteDetail): HTMLElement {
  if (!d.events.length) {
    const p = document.createElement('p')
    p.className = 'muted'
    p.textContent = 'No activity yet.'
    return p
  }
  const list = document.createElement('div')
  list.className = 'events-list'
  for (const e of d.events) {
    const line = document.createElement('div')
    line.className = 'event-line'
    line.innerHTML = `<time>${new Date(e.at).toLocaleTimeString()}</time><span class="${e.kind === 'error' ? 'ev-err' : ''}">${escapeHtml(e.message)}</span>`
    list.append(line)
  }
  return list
}

function timeAgo(ts: number): string {
  if (!ts) return ''
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return Math.floor(s / 60) + 'm ago'
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'
  return new Date(ts).toLocaleDateString()
}

/* ---------- status ---------- */

function applyStatus(status: AgentStatus): void {
  $('ver').textContent = `v${status.version}`
  const cloud = status.cloud.state
  const dot = $('statusDot')
  dot.className = 'dot'
  if (status.serverError || cloud === 'error') dot.classList.add('error')
  else if (status.serverRunning && cloud === 'connected') dot.classList.add('connected')

  $('statusText').textContent = status.serverError
    ? 'Server not started'
    : status.serverStopped
      ? 'Server stopped'
      : status.serverRunning
        ? `Listening on 127.0.0.1:${status.serverPort}`
        : 'Server not running'
  $('wsUrl').textContent = `ws://127.0.0.1:${status.serverPort || '—'}/ws`
  ;($('toggleServer') as HTMLButtonElement).textContent = status.serverRunning ? 'Stop' : 'Start'

  const pill = $('cloudPill')
  pill.textContent = cloud
  pill.className = 'pill ' + (['connected', 'connecting', 'error'].includes(cloud) ? cloud : '')

  // Status card rows
  const srv = $('srvStatus')
  if (status.serverError) {
    srv.textContent = '✗ not started — ' + status.serverError
    srv.className = 'bad'
  } else if (status.serverStopped) {
    srv.textContent = '■ stopped'
    srv.className = 'muted'
  } else if (status.serverRunning) {
    srv.textContent = `✓ 127.0.0.1:${status.serverPort}`
    srv.className = 'ok'
  } else {
    srv.textContent = 'not running'
    srv.className = 'muted'
  }
  const cl = $('cloudStatus')
  cl.textContent = status.cloud.detail ? `${cloud} (${status.cloud.detail})` : cloud
  cl.className = cloud === 'connected' ? 'ok' : cloud === 'error' ? 'bad' : 'muted'

  $('navNetworkDot').hidden = !status.serverError
}

/* ---------- logs ---------- */

const LOG_MAX = 600
function renderLogs(lines: string[]): void {
  const v = $('logView')
  v.textContent = lines.join('\n')
  v.scrollTop = v.scrollHeight
}
function appendLogs(lines: string[]): void {
  const v = $('logView')
  const existing = v.textContent ? v.textContent.split('\n') : []
  v.textContent = existing.concat(lines).slice(-LOG_MAX).join('\n')
  v.scrollTop = v.scrollHeight
}

/* ---------- helpers ---------- */

function getVal(id: string): string {
  return ($(id) as HTMLInputElement).value.trim()
}
function setVal(id: string, value: string | null): void {
  ;($(id) as HTMLInputElement).value = value ?? ''
}

let toastTimer: number | undefined
function toast(message: string, type: '' | 'success' | 'error' = ''): void {
  const el = $('toast')
  el.textContent = message
  el.className = 'toast show ' + type
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (el.className = 'toast ' + type), 2600)
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

void init()
