import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Input, readControls } from '../src/input.ts'
import { createLoop } from '../src/loop.ts'
import { lerpAngle } from '../src/render/draw.ts'

describe('ігровий цикл (фейкові таймери + requestAnimationFrame)', () => {
  // у node немає rAF — підставляємо його через setTimeout (~60 Гц), а час крутять фейкові таймери
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 1000 / 60),
    )
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('фіксований крок: за 1 с — рівно 60 кроків симуляції, незалежно від частоти кадрів', () => {
    let steps = 0
    let frames = 0
    const loop = createLoop({ step: 1 / 60, simulate: () => steps++, render: () => frames++ })
    loop.start()
    vi.advanceTimersByTime(1000)
    loop.stop()
    expect(steps).toBeGreaterThanOrEqual(59)
    expect(steps).toBeLessThanOrEqual(60)
    expect(frames).toBeGreaterThan(0)
  })

  it('alpha в [0, 1) і clamp 0.25 с: після «завислого» кадру не більше 15 кроків', () => {
    // кадри подаємо вручну: зависання на 2 с — це просто великий стрибок timestamp
    const queue: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => queue.push(cb))
    const alphas: number[] = []
    let steps = 0
    const loop = createLoop({
      step: 1 / 60,
      simulate: () => steps++,
      render: (a) => alphas.push(a),
    })
    loop.start()
    for (const t of [1000, 1016, 1033, 3033]) {
      const before = steps
      queue.shift()?.(t)
      if (t === 3033) expect(steps - before).toBe(15)
    }
    loop.stop()
    expect(alphas.every((a) => a >= 0 && a < 1)).toBe(true)
  })

  it('stop() зупиняє цикл', () => {
    let frames = 0
    const loop = createLoop({ simulate: () => {}, render: () => frames++ })
    loop.start()
    vi.advanceTimersByTime(100)
    loop.stop()
    const n = frames
    vi.advanceTimersByTime(500)
    expect(frames).toBe(n)
  })
})

describe('керування і рендер', () => {
  const keys = (...down: string[]): Input => ({
    isDown: (c) => down.includes(c),
    justPressed: () => false,
    consume: () => {},
    dispose: () => {},
  })

  it('readControls: ліво+право = 0, лише право = 1, Space = fire', () => {
    expect(readControls(keys('KeyA', 'KeyD')).turn).toBe(0)
    expect(readControls(keys('ArrowRight')).turn).toBe(1)
    expect(readControls(keys('KeyA')).turn).toBe(-1)
    expect(readControls(keys('Space', 'KeyW'))).toEqual({ thrust: true, turn: 0, fire: true })
  })

  it('lerpAngle іде коротким шляхом через ±π', () => {
    const mid = lerpAngle(Math.PI - 0.1, -Math.PI + 0.1, 0.5)
    expect(Math.abs(Math.abs(mid) - Math.PI)).toBeLessThan(1e-9)
  })
})
