// Lab 7: навантаження. N клієнтів без браузера (ws) в одній кімнаті; кожен декодує знімки і шле input,
// як людина (логіка бота з src/bot.ts → бінарний INPUT). Міряємо тривалість тіку сервера (p50/p99).
//   SNAPSHOT_ENCODE=per-client node scripts/load.ts before  → docs/lab07/load-before.json
//   node scripts/load.ts after --prof  → + CPU-профіль сервера для найбільшого N у /tmp/server-prof
// Клієнт шле input за власним таймером 30 Гц (як браузер), рішення — за останнім знімком.
import { writeFileSync } from 'node:fs'
import { decodeSnapshot, encodeInput } from 'shared/net/binary.ts'
import { WebSocket } from 'ws'
import { z } from 'zod'
import { botInput } from '../src/bot.ts'
import { startServer } from './_server.ts'

const label = process.argv[2] ?? 'run'
const prof = process.argv.includes('--prof')
const COUNTS = (process.env.COUNTS ?? '8,32,64,128,256').split(',').map(Number) // 256 — щоб знайти, де крок перевалює за 33 мс
const WARMUP_MS = 3000
const MEASURE_MS = 10_000 // = вікно статистики Match (300 тіків)
const pct = z.object({ p50: z.number(), p99: z.number() })
const StatsResponse = z.object({
  matches: z.array(z.object({ entities: z.number(), tickMs: pct, lateMs: pct })),
})

interface Row {
  clients: number
  entities: number
  tickP50: number
  tickP99: number
  lateP99: number
  downKBps: number // сумарно до всіх клієнтів
  kicked: number // відключені сервером (rate limit) — мають бути 0
}

async function run(n: number): Promise<Row> {
  const server = await startServer(3200 + n, {
    MAX_PLAYERS_PER_ROOM: '512',
    NODE_ENV: 'production',
    SNAPSHOT_ENCODE: process.env.SNAPSHOT_ENCODE ?? 'shared',
    ...(prof && n === Math.max(...COUNTS)
      ? { NODE_OPTIONS: '--cpu-prof --cpu-prof-dir=/tmp/server-prof' }
      : {}),
  })
  let bytes = 0
  const sockets: WebSocket[] = []
  for (let i = 0; i < n; i++) {
    const ws = new WebSocket(`${server.base.replace('http', 'ws')}/ws`)
    let shipId: Parameters<typeof botInput>[1] = null
    let seq = 0
    ws.on('open', () =>
      ws.send(JSON.stringify({ v: 1, type: 'join', room: 'classic', name: `load${i}` })),
    )
    ws.on('message', (data: Buffer, isBinary) => {
      bytes += data.length
      if (!isBinary) {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'match') shipId = msg.shipId
        return
      }
      const snap = decodeSnapshot(data.buffer.slice(data.byteOffset, data.byteOffset + data.length))
      ws.send(encodeInput(botInput(snap, shipId, ++seq)))
    })
    sockets.push(ws)
    // входимо пачками по 16 кожні 100 мс: «шторм» із сотень join (кожен — broadcast усім) не є кроком гри
    if (i % 16 === 15) await new Promise((r) => setTimeout(r, 100))
  }
  await new Promise((r) => setTimeout(r, WARMUP_MS))
  bytes = 0
  await new Promise((r) => setTimeout(r, MEASURE_MS))
  const { matches } = StatsResponse.parse(
    await fetch(`${server.base}/api/stats`).then((r) => r.json()),
  )
  const m = matches[0]
  if (!m) throw new Error('match not running')
  const kicked = sockets.filter((ws) => ws.readyState !== WebSocket.OPEN).length
  for (const ws of sockets) ws.close()
  await server.stop()
  return {
    clients: n,
    entities: m.entities,
    tickP50: m.tickMs.p50,
    tickP99: m.tickMs.p99,
    lateP99: m.lateMs.p99,
    downKBps: Math.round(bytes / 1024 / (MEASURE_MS / 1000)),
    kicked,
  }
}

const rows: Row[] = []
for (const n of COUNTS) {
  const row = await run(n)
  rows.push(row)
  console.log(row)
}
const over = rows.find((r) => r.tickP99 > 1000 / 30)
console.log(
  over ? `крок > 33 мс (p99) починаючи з ${over.clients} клієнтів` : 'крок ≤ 33 мс на всіх N',
)
writeFileSync(
  new URL(`../../docs/lab07/load-${label}.json`, import.meta.url),
  `${JSON.stringify(rows, null, 2)}\n`,
)
