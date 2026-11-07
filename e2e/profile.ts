// Lab 7: 30 с гри з 8 ботами в headless Chromium через CDP.
// Міряє: інтервал і роботу кадру (p50/p95/p99), паузи GC (trace), хто алокує (sampling heap profiler),
// CPU-профіль для flame chart. Результат → docs/lab07/profile-<label>.json (+ .cpuprofile для flame.py).
//
//   npx vite build -w client --minify false --outDir dist-profile   (імена функцій для звіту)
//   PLAYWRIGHT_BROWSERS_PATH=… node e2e/profile.ts before 30
import { writeFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { startServer } from '../server/scripts/_server.ts'

const label = process.argv[2] ?? 'run'
const seconds = Number(process.argv[3] ?? 30)
const extra = process.argv[4] ?? '' // напр. 'worker=1' — експеримент з Web Worker
const out = new URL(`../docs/lab07/profile-${label}`, import.meta.url).pathname

const server = await startServer(3107, {
  CLIENT_DIST: '../client/dist-profile',
  NODE_ENV: 'production',
  MAX_PLAYERS_PER_ROOM: '16',
})
const browser = await chromium.launch({
  args: ['--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
})
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  // Кадр = усі rAF-колбеки з однаковим timestamp: інтервал між кадрами і сумарна JS-робота
  await page.addInitScript(() => {
    const raf = window.requestAnimationFrame.bind(window)
    const rec: FrameRecorder = { interval: [], work: [], on: false }
    let lastT = 0
    window.__frames = rec
    window.requestAnimationFrame = (cb) =>
      raf((t) => {
        const s = performance.now()
        cb(t)
        if (!rec.on) return
        const w = performance.now() - s
        if (t !== lastT) {
          if (lastT) rec.interval.push(t - lastT)
          rec.work.push(w)
          lastT = t
        } else rec.work[rec.work.length - 1] = (rec.work.at(-1) ?? 0) + w
      })
  })
  await page.goto(`${server.base}/?room=classic&name=profiler${extra ? `&${extra}` : ''}`)
  await page.waitForFunction(() => 'netGame' in window || '__net' in window)
  const bots = await fetch(`${server.base}/api/rooms/classic/bots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ count: 8 }),
  }).then((r) => r.json())
  console.log('bots', bots)
  await page.waitForTimeout(3000) // прогрів (JIT, асети)

  const cdp = await page.context().newCDPSession(page)
  const trace: { name: string; ph: string; dur?: number; ts: number; pid: number }[] = []
  cdp.on('Tracing.dataCollected', (e) => {
    for (const v of e.value) {
      // у типах CDP значення — string, насправді ts/dur/pid — числа
      const { name, ph, dur } = v
      if (name && ph)
        trace.push({
          name,
          ph,
          ts: Number(v.ts),
          pid: Number(v.pid),
          ...(dur === undefined ? {} : { dur: Number(dur) }),
        })
    }
  })
  const traceDone = new Promise<void>((r) => cdp.once('Tracing.tracingComplete', () => r()))
  await cdp.send('Tracing.start', {
    categories: 'devtools.timeline,v8,disabled-by-default-v8.gc',
    transferMode: 'ReportEvents',
  })
  await cdp.send('HeapProfiler.startSampling', {
    samplingInterval: 8192,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  })
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 250 })
  await cdp.send('Profiler.start')
  await page.evaluate(() => {
    window.__frames.on = true
  })

  await page.waitForTimeout(seconds * 1000)

  const frames = await page.evaluate(() => {
    const f = window.__frames
    f.on = false
    return { interval: f.interval, work: f.work }
  })
  const { profile: cpu } = await cdp.send('Profiler.stop')
  const { profile: heap } = await cdp.send('HeapProfiler.stopSampling')
  await cdp.send('Tracing.end')
  await traceDone

  const pct = (xs: number[], p: number): number => {
    const s = [...xs].sort((a, b) => a - b)
    return Number((s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0).toFixed(2))
  }
  const stat = (xs: number[]) => ({
    n: xs.length,
    p50: pct(xs, 0.5),
    p95: pct(xs, 0.95),
    p99: pct(xs, 0.99),
    max: pct(xs, 1),
  })

  // паузи GC на головному потоці рендерера
  const gcs = trace.filter(
    (e) => (e.name === 'MinorGC' || e.name === 'MajorGC') && e.ph === 'X' && e.dur !== undefined,
  )
  const gc = (name: string) => {
    const ds = gcs.filter((e) => e.name === name).map((e) => (e.dur ?? 0) / 1000)
    return {
      count: ds.length,
      totalMs: Number(ds.reduce((a, b) => a + b, 0).toFixed(1)),
      ...stat(ds),
    }
  }

  // хто алокує: сума selfSize за функцією (включно з уже зібраними GC об'єктами)
  type HeapNode = (typeof heap)['head']
  const by = new Map<string, number>()
  let total = 0
  const walk = (n: HeapNode): void => {
    const f = n.callFrame
    const key = `${f.functionName || '(anonymous)'} ${f.url.split('/').pop() ?? ''}:${f.lineNumber + 1}`
    by.set(key, (by.get(key) ?? 0) + n.selfSize)
    total += n.selfSize
    for (const c of n.children) walk(c)
  }
  walk(heap.head)
  const allocators = [...by]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([fn, bytes]) => ({
      fn,
      MB: Number((bytes / 2 ** 20).toFixed(1)),
      share: Number(((bytes / total) * 100).toFixed(1)),
    }))

  // зайнятість головного потоку: частка часу CPU-профілю не в (idle)
  const idleIds = new Set(
    cpu.nodes.filter((n) => n.callFrame.functionName === '(idle)').map((n) => n.id),
  )
  let busy = 0
  let all = 0
  cpu.samples?.forEach((id, i) => {
    const dt = cpu.timeDeltas?.[i] ?? 0
    all += dt
    if (!idleIds.has(id)) busy += dt
  })

  const result = {
    label,
    seconds,
    bots: bots.added,
    frameIntervalMs: stat(frames.interval),
    frameWorkMs: stat(frames.work),
    mainThreadBusyPct: Number(((busy / all) * 100).toFixed(1)),
    allocMBperSec: Number((total / 2 ** 20 / seconds).toFixed(1)),
    gc: { minor: gc('MinorGC'), major: gc('MajorGC') },
    allocators,
  }
  await writeFile(`${out}.json`, `${JSON.stringify(result, null, 2)}\n`)
  await writeFile(`/tmp/profile-${label}.cpuprofile`, JSON.stringify(cpu))
  console.log(JSON.stringify(result, null, 2))
} finally {
  await browser.close()
  await server.stop()
}
