// End-to-end probe against a RUNNING agent (npx electron . --hidden).
// Verifies: WS hello+pairing, signed ESC/POS job -> network transport (to a
// local TCP sink), and the bad-signature / replay rejections.
//
// Requires the agent's config.json to contain a pairing for ORIGIN with SECRET
// (the verify step injects this). Run: node test/manual/probe.mjs
import net from 'node:net'
import crypto from 'node:crypto'
import WebSocket from 'ws'

const ORIGIN = 'http://localhost:9999'
let SECRET = null // obtained from the agent via auto-approve pairing
const WS_URL = 'ws://127.0.0.1:9120/ws'
const SINK_PORT = 9100

// --- canonicalization, must match src/shared/schema.ts exactly ---
function sortDeep(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sortDeep)
  const out = {}
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue
    out[key] = sortDeep(value[key])
  }
  return out
}
const stableStringify = (v) => JSON.stringify(sortDeep(v))
function sign(job, secret) {
  const { signature, ...rest } = job
  return crypto.createHmac('sha256', secret).update(stableStringify(rest)).digest('hex')
}

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

function makeEscposJob() {
  const job = {
    v: 1,
    id: 'probe-' + crypto.randomUUID(),
    type: 'escpos',
    source: { text: 'PROBE RECEIPT\nItem        1   5.00\nTOTAL           5.00' },
    printer: { transport: 'network', host: '127.0.0.1', port: SINK_PORT },
    options: { paperSize: '80mm', cut: true },
    ts: Date.now(),
    nonce: crypto.randomUUID(),
  }
  job.signature = sign(job, SECRET)
  return job
}

async function main() {
  // 1. TCP sink that captures ESC/POS bytes.
  let received = Buffer.alloc(0)
  const sink = net.createServer((sock) => sock.on('data', (d) => (received = Buffer.concat([received, d]))))
  await new Promise((r) => sink.listen(SINK_PORT, '127.0.0.1', r))

  const ws = new WebSocket(WS_URL, { origin: ORIGIN })
  const inbox = [] // unconsumed messages
  const waiters = [] // pending next() calls: { predicate, resolve, timer }
  function pump() {
    for (let wi = 0; wi < waiters.length; wi++) {
      const w = waiters[wi]
      const mi = inbox.findIndex(w.predicate)
      if (mi >= 0) {
        const [msg] = inbox.splice(mi, 1)
        waiters.splice(wi, 1)
        clearTimeout(w.timer)
        w.resolve(msg)
        return pump()
      }
    }
  }
  const deliver = (msg) => {
    inbox.push(msg)
    pump()
  }
  const next = (predicate, timeoutMs = 8000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waiters.findIndex((w) => w.timer === timer)
        if (i >= 0) waiters.splice(i, 1)
        reject(new Error('timeout waiting for message'))
      }, timeoutMs)
      waiters.push({ predicate, resolve, timer })
      pump()
    })

  ws.on('message', (raw) => deliver(JSON.parse(raw.toString())))
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })

  // 2. hello + auto-approve pairing (agent issues a per-site token, no prompt)
  const hello = await next((m) => m.kind === 'hello')
  record('ws hello received', hello.kind === 'hello')
  ws.send(JSON.stringify({ kind: 'pair' }))
  const paired = await next((m) => m.kind === 'paired' || m.kind === 'pair_denied')
  record('auto-approved + token issued (no prompt)', paired.kind === 'paired' && !!paired.secret, paired.kind)
  SECRET = paired.secret

  // 3. signed escpos job prints and reaches the TCP sink
  const job = makeEscposJob()
  ws.send(JSON.stringify({ kind: 'job', job }))
  const ack = await next((m) => m.kind === 'ack' && m.id === job.id)
  record('job acknowledged (queued)', ack.status === 'queued')
  const result = await next((m) => m.kind === 'result' && m.id === job.id, 15000)
  record('job result = printed', result.status === 'printed', result.error || '')
  await new Promise((r) => setTimeout(r, 200))
  record('ESC/POS bytes reached TCP sink', received.length > 0, `${received.length} bytes`)
  // ESC/POS init sequence starts with ESC @ (0x1b 0x40)
  record('payload looks like ESC/POS (ESC @)', received.includes(Buffer.from([0x1b, 0x40])))

  // 3b. raw queue transport exercises the PowerShell winspool P/Invoke helper.
  //     Spooling to a non-existent queue should compile the C# and fail at OpenPrinter.
  const rawJob = {
    v: 1,
    id: 'raw-' + crypto.randomUUID(),
    type: 'raw',
    source: { text: '^XA^FO50,50^FDTEST^FS^XZ' },
    printer: { transport: 'queue', name: '__TP_NoSuchPrinter__' },
    ts: Date.now(),
    nonce: crypto.randomUUID(),
  }
  rawJob.signature = sign(rawJob, SECRET)
  ws.send(JSON.stringify({ kind: 'job', job: rawJob }))
  const rawRes = await next((m) => m.kind === 'result' && m.id === rawJob.id, 25000)
  record(
    'raw-spool helper ran (winspool P/Invoke compiled + executed)',
    rawRes.status === 'failed' && /openprinter|printer/i.test(rawRes.error || ''),
    rawRes.error || rawRes.status,
  )

  // 4. bad signature is rejected
  const bad = makeEscposJob()
  bad.signature = 'deadbeef'
  bad.id = 'bad-' + crypto.randomUUID()
  ws.send(JSON.stringify({ kind: 'job', job: bad }))
  const badRes = await next((m) => m.kind === 'error' && m.id === bad.id)
  record('bad signature rejected', /signature/i.test(badRes.error), badRes.error)

  // 5. replayed nonce is rejected (reuse the first job's nonce+sig as-is)
  ws.send(JSON.stringify({ kind: 'job', job }))
  const replay = await next((m) => (m.kind === 'error' || m.kind === 'result') && m.id === job.id, 8000)
  record('replayed nonce rejected', replay.kind === 'error' && /replay|nonce/i.test(replay.error || ''), replay.error || replay.status)

  // 6. parallel printing across several printers (different network sinks)
  const ports = [9101, 9102, 9103]
  const got = {}
  const sinks = []
  for (const p of ports) {
    got[p] = 0
    const s = net.createServer((sock) => sock.on('data', (d) => (got[p] += d.length)))
    await new Promise((r) => s.listen(p, '127.0.0.1', r))
    sinks.push(s)
  }
  const escposToPort = (port) => {
    const j = {
      v: 1,
      id: 'par-' + crypto.randomUUID(),
      type: 'escpos',
      source: { text: 'PARALLEL ' + port },
      printer: { transport: 'network', host: '127.0.0.1', port },
      options: { paperSize: '80mm', cut: true },
      ts: Date.now(),
      nonce: crypto.randomUUID(),
    }
    j.signature = sign(j, SECRET)
    return j
  }
  const parJobs = ports.map(escposToPort)
  parJobs.forEach((j) => ws.send(JSON.stringify({ kind: 'job', job: j })))
  const parResults = await Promise.all(parJobs.map((j) => next((m) => m.kind === 'result' && m.id === j.id, 20000)))
  record('parallel jobs all printed', parResults.every((r) => r.status === 'printed'))
  await new Promise((r) => setTimeout(r, 250))
  record('every printer received its bytes', ports.every((p) => got[p] > 0), JSON.stringify(got))
  for (const s of sinks) s.close()

  // 7. a job to a dead printer fails after its retries
  const deadJob = {
    v: 1,
    id: 'dead-' + crypto.randomUUID(),
    type: 'escpos',
    source: { text: 'X' },
    printer: { transport: 'network', host: '127.0.0.1', port: 9199 }, // nothing listening
    options: { paperSize: '80mm' },
    ts: Date.now(),
    nonce: crypto.randomUUID(),
  }
  deadJob.signature = sign(deadJob, SECRET)
  ws.send(JSON.stringify({ kind: 'job', job: deadJob }))
  const deadRes = await next((m) => m.kind === 'result' && m.id === deadJob.id, 30000)
  record('job to a dead printer fails after retries', deadRes.status === 'failed', deadRes.error || '')

  ws.close()
  sink.close()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => {
  console.error('probe error:', err)
  process.exit(2)
})
