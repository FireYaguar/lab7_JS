import { asSeq } from 'shared/brand.ts'
import type { InputMessage, Snapshot } from 'shared/net/protocol.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Match } from '../src/match.ts'
import type { Player } from '../src/types.ts'

const arena = { width: 1600, height: 900, asteroids: 0, seed: 1 }
const input = (seq: number, thrust = true): InputMessage => ({
  v: 1,
  type: 'input',
  seq: asSeq(seq),
  thrust,
  turn: 0,
  fire: false,
})

function player(id: string, snaps: Snapshot[]): Player {
  return {
    id,
    name: id,
    shipId: null,
    send: () => {},
    sendRaw: () => {},
    sendSnapshot: (s, ack) => snaps.push({ ...s, ack }),
  }
}

describe('Match (фейкові таймери: тік без реального очікування)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('30 тіків за секунду, кожен — знімок з ack останнього обробленого input', () => {
    const m = new Match(arena)
    const snaps: Snapshot[] = []
    m.addPlayer(player('p1', snaps))
    m.start()
    m.pushInput('p1', input(1))
    vi.advanceTimersByTime(1000)
    m.stop()
    expect(snaps.length).toBeGreaterThanOrEqual(29)
    expect(snaps.length).toBeLessThanOrEqual(31)
    expect(snaps.at(-1)?.ack).toBe(1)
  })

  it('черга впорядковує input за seq і відкидає дублі та застарілі', () => {
    const m = new Match(arena)
    const snaps: Snapshot[] = []
    m.addPlayer(player('p1', snaps))
    for (const s of [3, 1, 2, 2, 1]) m.pushInput('p1', input(s))
    m.start()
    vi.advanceTimersByTime(200)
    m.pushInput('p1', input(2)) // уже підтверджений
    vi.advanceTimersByTime(200)
    m.stop()
    // перший тік: стартовий кредит + 1 → обробили seq 1 і 2; далі 3; повторний 2 нічого не змінив
    const acks = [...new Set(snaps.map((s) => s.ack))]
    expect(acks).toEqual([2, 3])
    expect(snaps.map((s) => s.ack)).toEqual([...snaps.map((s) => s.ack)].sort((a, b) => a - b))
  })

  it('speedhack: 100 input за раз не дають більше 1 input на тік (кредити)', () => {
    const m = new Match(arena)
    const snaps: Snapshot[] = []
    m.addPlayer(player('p1', snaps))
    m.start()
    vi.advanceTimersByTime(34) // 1 тік, кредит використано на порожню чергу ні на що
    for (let s = 1; s <= 100; s++) m.pushInput('p1', input(s))
    vi.advanceTimersByTime(TICKS(10))
    m.stop()
    // за 10 тіків — не більше 10 + запас кредитів (4) input, а черга обрізана до 16
    expect(snaps.at(-1)?.ack ?? 0).toBeLessThanOrEqual(100)
    const processed = snaps.at(-1)?.ack ?? 0
    const firstAck = snaps.find((s) => s.ack > 0)?.ack ?? 0
    expect(processed - firstAck).toBeLessThanOrEqual(10 + 4)
  })
})

const TICKS = (n: number): number => Math.ceil((n * 1000) / 30)
