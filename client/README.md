# Terminal Printer — browser client SDK

A dependency-free library for printing silently from a web page through the
Terminal Printer desktop agent. ~9 KB, no build step.

## Install

One file, three ways — no build step. It **auto-connects** and **auto-pairs** by default.

**Plain `<script>` (drops into any HTML page):**

```html
<script src="terminal-printer.js"></script>
<script>
  const tp = new TerminalPrinter()                  // discovers + connects + pairs automatically
  await tp.printPdf('https://my.app/receipt.pdf', { options: { paperSize: 'A5' } })
</script>
```

**ES module:**

```js
import { TerminalPrinter } from './terminal-printer.mjs'
const tp = new TerminalPrinter()
await tp.printPdf(url)
```

**CommonJS / bundlers:**

```js
const { TerminalPrinter } = require('terminal-printer')
```

The first time a site connects it is **auto-approved** and issued its own token (no
prompt); the token is stored in `localStorage` and printing is silent thereafter.
Every site — with the files it printed, its activity, and its token — is listed in
the agent's **Websites** tab, where you can block or revoke any of them.

> `ws://127.0.0.1` is a *potentially trustworthy* origin, so this works from an
> **HTTPS** page with no mixed-content error in Chrome/Edge/Firefox.

## API

### `new TerminalPrinter(options?)`

| option | default | meaning |
| --- | --- | --- |
| `autoConnect` | `true` | discover + connect immediately on construction |
| `ports` | `[9120,9121,9122]` | ports to probe for the agent |
| `host` | `'127.0.0.1'` | loopback host |
| `autoReconnect` | `true` | reconnect if the socket drops |
| `storageKey` | `'terminal-printer:secret'` | localStorage key for the pairing secret |
| `siteName` | `document.title` | label shown in the approval dialog |
| `jobTimeoutMs` | `60000` | per-job timeout |

### Methods

- `connect(): Promise<void>` — discover + open the socket.
- `pair(): Promise<string>` — request pairing (dialog for a new site; silent if already paired).
- `listPrinters(): Promise<PrinterInfo[]>`
- `print(job): Promise<JobResult>` — auto-connects and auto-pairs; retries once if the secret is stale.
- `printUrl(url, opts)`, `printPdf(urlOrBase64, opts)`, `printHtml(html, opts)`, `printImage(urlOrBase64, opts)`, `printEscpos(textOrModel, opts)`, `printZpl(zpl, opts)`, `printWebsite(url, opts)` — sugar.
- `printToMany(printers, job)` — fan a job out to several printers in parallel.
- `disconnect()`

### Properties

- `available` — `true` when connected **and** paired (ready to print).
- `connected`, `paired`, `agentInfo` (`{ name, version, agentId }`).

### Events

`tp.on(event, cb)` / `tp.off(event, cb)` — `open`, `close`, `status`, `result`,
`pair_required`, `error`.

## Job shape

```js
await tp.print({
  type: 'pdf',                       // 'pdf' | 'escpos' | 'image' | 'html' | 'raw' | 'website'
  source: { url: 'https://…' },      // or { base64 } or { text } ({ file } is API/CLI only — browsers can't read paths)
  printer: { name: 'EPSON-TM' },     // optional; omit for the agent's mapped/default printer
  printers: ['EPSON-TM', 'Office'],  // optional fan-out: print to several at once
  copies: 1,
  options: { paperSize: 'A5', scale: 'noscale', cut: true, openCashDrawer: true },
  meta: { docType: 'receipt', docId: 42 },
})
```

The SDK adds `id`, `ts`, `nonce`, and an HMAC `signature` automatically. Jobs flow
through the agent's queue: different printers print in parallel, each printer one
job at a time, with automatic retry — watch it live in the agent's **Queues** tab.

## Examples

```js
// HTML receipt (Arabic RTL is shaped natively)
await tp.printHtml('<html dir="rtl" lang="ar"><body><h2>إيصال</h2></body></html>', { options: { paperSize: 'A5' } })

// Thermal text receipt with a cut
await tp.printEscpos('STORE\nTotal 12.00\n', { options: { paperSize: '80mm', cut: true } })

// Structured thermal receipt
await tp.printEscpos({ lines: [
  { text: 'STORE', align: 'center', bold: true, size: 2 },
  { text: 'Total: 12.00', align: 'right' },
], qr: 'https://my.app/r/42' }, { options: { openCashDrawer: true } })

// ZPL label to a label printer
await tp.printZpl('^XA^FO50,50^ADN,36,20^FDHELLO^FS^XZ', { printer: { name: 'Zebra' } })

// Render a live web page and print it
await tp.printWebsite('https://example.com/invoice/42', { options: { paperSize: 'A4' } })

// Fan-out: same receipt to two printers at once
await tp.printToMany(['Counter', 'Kitchen'], { type: 'escpos', source: { text: 'ORDER #42\n' } })

// Graceful fallback when no agent is installed
try {
  await tp.printPdf(url)
} catch (e) {
  window.open(url)               // or window.print()
}
```

See `demo.html` for a full working page.
