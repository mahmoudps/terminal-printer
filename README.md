# Terminal Printer

[![release](https://github.com/mahmoudps/terminal-printer/actions/workflows/release.yml/badge.svg)](https://github.com/mahmoudps/terminal-printer/actions/workflows/release.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A cross-platform **silent print agent** (Electron + TypeScript) for **Windows,
macOS, and Linux**. It receives print jobs over a loopback **WebSocket/HTTP**
server (or an optional cloud relay) and prints them directly to OS printers — no
browser print dialog.

Transport- and app-agnostic: any web page or service that speaks the simple JSON
protocol can print. A ready-made, dependency-free, **universal browser SDK** lives
in [`client/`](client/) — works via `<script>`, ESM, or CommonJS, and auto-connects.

**Download:** grab the installer for your OS from the
[Releases](https://github.com/mahmoudps/terminal-printer/releases) page.

## Capabilities

| Format | How it prints |
| --- | --- |
| `pdf` | Silent via [pdf-to-printer] (bundled SumatraPDF), exact A4/A5 sizing |
| `escpos` | Thermal receipts via [node-thermal-printer] → TCP 9100, or RAW spool (Windows `winspool` / CUPS `lp` on macOS·Linux) — cut, drawer kick, Arabic codepage |
| `image` | PNG/JPG wrapped to paper size and printed silently |
| `html` | Rendered in a hidden window, printed silently (native RTL Arabic) |
| `website` | A live web page URL rendered in a hidden window, printed silently |
| `raw` | ZPL/EPL/raw bytes → RAW spool or TCP |

Input sources per job: `url`, `base64`, inline `text`, or a local `file` path.

- **Two paths:** browser → `ws://127.0.0.1:9120` (local, offline) **or** server → Reverb → agent (remote/server-initiated).
- **Desktop direct printing:** tray → *Print a file…* sends any PDF/image straight to a printer, no browser involved.
- **Observable queue:** bounded parallelism (different printers print at once, each printer stays serial), per-printer isolation, automatic retry, cancel, and persistence across restarts — live in the **Queues** tab. Fan a job out to several printers with `printers: [...]`.
- **Multi-website:** every site that connects is **auto-approved** and isolated with its **own token**; the **Websites** tab lists all sites with the **files** each printed and its **activity log**, and lets you block/revoke/regenerate. Loopback-only bind, HMAC-signed jobs, replay protection.
- **No native build step:** RAW printing uses a PowerShell `winspool` P/Invoke on Windows and CUPS `lp` on macOS/Linux, so `npm install` needs no native build tools.

## Develop

```bash
npm install
npm run dev        # electron-vite dev with HMR
npm run typecheck
npm test           # vitest unit tests
```

## Build installers

```bash
npm run dist:win     # Windows  → dist/Terminal Printer Setup x.y.z.exe (NSIS, per-user)
npm run dist:mac     # macOS    → dist/*.dmg + *.zip   (run on macOS)
npm run dist:linux   # Linux    → dist/*.AppImage + *.deb  (run on Linux)
npm run dist         # current OS
```

Each platform builds on its own OS. The CI workflow
([`.github/workflows/release.yml`](.github/workflows/release.yml)) builds
**Windows + macOS + Linux** on GitHub's runners and publishes them to a Release —
run it from the **Actions** tab or with `gh workflow run release.yml`.

## Configuration

Settings live in `%APPDATA%/Terminal Printer/config.json` and are edited from the
tray → **Open Settings** window: default printer, per-document-type printer map,
local port, cloud relay (server URL, building/terminal, printer token, Reverb
keys), allowed sites, start-on-login, and the **queue** (max parallel jobs,
attempts per job, retry delay, history size, persist-across-restart, allow local
file source).

The settings window also has a live **Status** panel (server + cloud, with
*Re-check*) and a **Logs** panel (live tail, copy, open-file). On startup the
agent runs **to the tray on login** (when enabled), warns if you launch a second
copy, and surfaces a clear error — tray + Windows notification — if the local
server can't bind a port.

## Queue

Every job flows through an observable queue, shown live in Settings → **Queues**:

- **Parallel:** up to `maxConcurrent` jobs print at once across printers; each
  printer prints one job at a time (thermal/USB safety).
- **Isolation:** a job's failure never blocks other printers' lanes; each job is
  tracked by its source origin.
- **Retry / cancel:** failed jobs retry up to `maxAttempts` with a backoff;
  queued jobs can be canceled and finished jobs retried from the UI.
- **Persistence:** queued jobs are saved to `queue.json` and replayed on the next
  launch (payloads over 1 MB are skipped).
- **Fan-out:** a job with `printers: ["A","B"]` prints to all of them in parallel.

## Protocol (local WebSocket on `/ws`)

Client → agent: `{kind:'pair'|'job'|'printers'|'ping', ...}`
Agent → client: `{kind:'hello'|'paired'|'pair_required'|'ack'|'result'|'printers'|'error'|'pong', ...}`

A **job** must be signed once an origin is paired:

```jsonc
{
  "v": 1, "id": "uuid", "type": "pdf|escpos|image|html|raw|website",
  "source": { "url": "https://…" },   // or { "base64": … } / { "text": … } / { "file": "C:\\path.pdf" }
  "printer": { "name": "EPSON-TM", "transport": "queue|network", "host": "…", "port": 9100 },
  "printers": ["EPSON-TM", "Office"],  // optional fan-out — print to several at once
  "copies": 1,
  "options": { "paperSize": "A5", "scale": "noscale", "cut": true, "openCashDrawer": true },
  "meta": { "docType": "receipt", "docId": 42 },
  "ts": 1748600000000, "nonce": "uuid",
  "signature": "hmac-sha256-hex over the canonical job (sorted keys, minus signature)"
}
```

The HTTP endpoint mirrors this: `GET /health`, `GET /printers`, `POST /print`.

## Manual end-to-end test

1. `npm run dev` (or run the installed app). A tray icon appears.
2. Serve the test page so it has a real Origin:
   `cd test/manual && python -m http.server 9999`, open `http://localhost:9999/test-page.html`.
3. **Connect** → **Pair** → approve the dialog in the tray → **Print HTML receipt**.
4. For thermal/label tests, map the `Thermal (ESC/POS)` / `Raw` document types to the
   right printer in Settings first.

An automated protocol/pipeline probe (no GUI clicks) lives in
`test/manual/probe.mjs` — it injects a pairing into `config.json`, then drives a
signed ESC/POS job to a local TCP sink and checks the security rejections.

## Browser client SDK

[`client/terminal-printer.js`](client/terminal-printer.js) is a ~9 KB,
dependency-free library that discovers the agent, handles pairing + HMAC signing,
and prints from any web page:

```js
import { TerminalPrinter } from './terminal-printer.js'
const tp = new TerminalPrinter()
await tp.printPdf('https://my.app/receipt.pdf', { options: { paperSize: 'A5' } })
```

See [`client/README.md`](client/README.md) and [`client/demo.html`](client/demo.html).

## Cloud relay (optional)

Beyond the local path, the agent can connect **out** to a WebSocket server and
print jobs pushed to it remotely — useful for printing to a terminal from a
back-end or another machine. It speaks the **Pusher/Reverb protocol** (implemented
natively over `ws`), so it works with any [Laravel Reverb](https://reverb.laravel.com)
or Pusher-compatible server you run:

- authenticates a private channel `printer.{building}.{terminal}` with a bearer token,
- prints `print-job.queued` events (fetching the document from a signed URL),
- POSTs status back to the server.

Configure it under Settings → Cloud relay (server URL, channel ids, token, Reverb
key/host). It's off by default — the local path needs no server at all.

[pdf-to-printer]: https://www.npmjs.com/package/pdf-to-printer
[node-thermal-printer]: https://www.npmjs.com/package/node-thermal-printer
