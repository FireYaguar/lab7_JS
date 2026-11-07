import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { asEntityId, asSeq, asTick } from '../src/brand.ts'
import {
  CodecError,
  decodeInput,
  decodeSnapshot,
  encodeInput,
  encodeSnapshot,
} from '../src/net/binary.ts'
import {
  ClientMessage,
  type EntityState,
  type InputMessage,
  type Snapshot,
} from '../src/net/protocol.ts'
import { createArena } from '../src/sim/arena.ts'
import { findCollisions, findCollisionsNaive } from '../src/sim/collision.ts'
import { Asteroid } from '../src/sim/entity.ts'
import { mulberry32 } from '../src/sim/random.ts'
import { Ship } from '../src/sim/ship.ts'
import { stepShip, World } from '../src/sim/world.ts'

// Property-based: замість кількох прикладів — інваріант, який fast-check перевіряє на сотнях
// випадкових входів і, якщо знайде контрприклад, звужує його (shrink) до найменшого.

const u32 = fc.nat({ max: 0xffffffff })
const turn = fc.constantFrom(-1 as const, 0 as const, 1 as const)
const coord = fc.double({ min: -5000, max: 5000, noNaN: true })
const angle = fc.double({ min: -Math.PI, max: Math.PI, noNaN: true })
const timer = fc.double({ min: 0, max: 600, noNaN: true })

const input = fc
  .record({ seq: u32, thrust: fc.boolean(), fire: fc.boolean(), turn })
  .map((r): InputMessage => ({ v: 1, type: 'input', ...r, seq: asSeq(r.seq) }))

const base = { id: u32.map(asEntityId), x: coord, y: coord }
const entity: fc.Arbitrary<EntityState> = fc.oneof(
  fc.record({
    ...base,
    kind: fc.constant('ship' as const),
    angle,
    vx: coord,
    vy: coord,
    hp: fc.integer({ min: 0, max: 255 }),
    solid: fc.boolean(),
    thrust: fc.boolean(),
    cooldown: fc.double({ min: 0, max: 60, noNaN: true }),
    shield: timer,
    rapid: timer,
    homingShots: timer,
    respawnIn: timer,
    score: u32,
  }),
  fc.record({
    ...base,
    kind: fc.constant('bullet' as const),
    homing: fc.boolean(),
    ownerId: u32.map(asEntityId),
    seq: u32.map(asSeq),
  }),
  fc.record({
    ...base,
    kind: fc.constant('asteroid' as const),
    angle,
    radius: fc.integer({ min: 0, max: 255 }),
    shape: fc.integer({ min: 0, max: 2 }),
    homing: fc.boolean(),
  }),
  fc.record({
    ...base,
    kind: fc.constant('pickup' as const),
    effect: fc.constantFrom('shield' as const, 'rapid' as const, 'homing' as const),
  }),
  fc.record({ ...base, kind: fc.constant('explosion' as const) }),
)
const snapshot = fc
  .record({
    tick: u32.map(asTick),
    ack: u32.map(asSeq),
    entities: fc.array(entity, { maxLength: 40 }),
  })
  .map((s): Snapshot => ({ type: 'snapshot', ...s }))

const SIZE: Record<EntityState['kind'], number> = {
  ship: 39,
  bullet: 22,
  asteroid: 18,
  pickup: 15,
  explosion: 14,
}
const f32 = (v: number): number => Math.fround(v)
const angleDiff = (a: number, b: number): number =>
  Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))

describe('fast-check властивості', () => {
  it('1. input: decode(encode(m)) === m', () => {
    fc.assert(
      fc.property(input, (m) => {
        expect(decodeInput(encodeInput(m))).toEqual(m)
      }),
    )
  })

  it('2. знімок: decode(encode(s)) ≈ s з урахуванням округлення (f32, кут Int16, таймери)', () => {
    fc.assert(
      fc.property(snapshot, (s) => {
        const d = decodeSnapshot(encodeSnapshot(s))
        expect([d.tick, d.ack, d.entities.length]).toEqual([s.tick, s.ack, s.entities.length])
        s.entities.forEach((e, i) => {
          const r = d.entities[i]
          expect(r?.kind).toBe(e.kind)
          if (!r || r.kind !== e.kind) return
          expect([r.id, r.x, r.y]).toEqual([e.id, f32(e.x), f32(e.y)])
          if (e.kind === 'ship' && r.kind === 'ship') {
            expect(angleDiff(r.angle, e.angle)).toBeLessThanOrEqual(0.5e-4 + 1e-9) // 1/10000 рад / 2
            expect([r.vx, r.vy, r.hp, r.solid, r.thrust, r.score]).toEqual([
              f32(e.vx),
              f32(e.vy),
              e.hp,
              e.solid,
              e.thrust,
              e.score,
            ])
            expect(Math.abs(r.cooldown - e.cooldown)).toBeLessThanOrEqual(0.0005 + 1e-9)
          }
          if (e.kind === 'asteroid' && r.kind === 'asteroid') {
            expect(angleDiff(r.angle, e.angle)).toBeLessThanOrEqual(0.5e-4 + 1e-9)
            expect([r.radius, r.shape, r.homing]).toEqual([e.radius, e.shape, e.homing])
          }
          if (e.kind === 'bullet' && r.kind === 'bullet')
            expect([r.ownerId, r.seq, r.homing]).toEqual([e.ownerId, e.seq, e.homing])
          if (e.kind === 'pickup' && r.kind === 'pickup') expect(r.effect).toBe(e.effect)
        })
      }),
    )
  })

  it('3. довжина кадру = 12 + Σ розмір сутності за специфікацією; input — рівно 8 байт', () => {
    fc.assert(
      fc.property(
        snapshot,
        (s) =>
          encodeSnapshot(s).byteLength === 12 + s.entities.reduce((n, e) => n + SIZE[e.kind], 0),
      ),
    )
    fc.assert(fc.property(input, (m) => encodeInput(m).byteLength === 8))
  })

  it('4. сміття → лише CodecError, ніколи інший виняток', () => {
    const onlyCodecError = (fn: () => unknown): boolean => {
      try {
        fn()
        return true // інколи сміття випадково валідне — це теж ок
      } catch (err) {
        return err instanceof CodecError
      }
    }
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 200 }),
        (bytes) =>
          onlyCodecError(() => decodeSnapshot(bytes)) && onlyCodecError(() => decodeInput(bytes)),
      ),
    )
    // справжній кадр з випадково зміненим байтом / обрізаний
    fc.assert(
      fc.property(snapshot, fc.nat(), fc.nat({ max: 255 }), (s, at, value) => {
        const bytes = new Uint8Array(encodeSnapshot(s))
        if (bytes.length > 0) bytes[at % bytes.length] = value
        return (
          onlyCodecError(() => decodeSnapshot(bytes)) &&
          onlyCodecError(() => decodeSnapshot(bytes.subarray(0, at % (bytes.length + 1))))
        )
      }),
    )
  })

  it('5. корабель лишається в арені після 1000 випадкових кроків', () => {
    const arena = createArena(1600, 900)
    const command = fc.record({ thrust: fc.boolean(), turn, fire: fc.boolean() })
    fc.assert(
      fc.property(fc.array(command, { minLength: 1000, maxLength: 1000 }), (cmds) => {
        const ship = new Ship({ x: 800, y: 450 })
        for (const c of cmds) {
          stepShip(ship, c, 1 / 60, arena)
          if (
            !(
              ship.pos.x >= 0 &&
              ship.pos.x < arena.width &&
              ship.pos.y >= 0 &&
              ship.pos.y < arena.height
            )
          )
            return false
        }
        return true
      }),
      { numRuns: 50 },
    )
  })

  it('6. розбір повідомлення: правильне приймає, зіпсоване — відхиляє', () => {
    const join = fc.record({
      v: fc.constant(1),
      type: fc.constant('join'),
      room: fc.string({ minLength: 1, maxLength: 32 }).filter((s) => s.trim().length > 0),
      name: fc.string({ minLength: 1, maxLength: 16 }).filter((s) => s.trim().length > 0),
    })
    const raw = fc.oneof(
      input.map((m) => ({ ...m, seq: Number(m.seq) })),
      join,
    )
    fc.assert(fc.property(raw, (m) => ClientMessage.safeParse(m).success))
    const corrupt = fc.constantFrom<[string, unknown]>(
      ['v', 2],
      ['type', 'teleport'],
      ['seq', -1],
      ['seq', 1.5],
      ['turn', 7],
      ['thrust', 'yes'],
      ['room', ''],
      ['name', 'x'.repeat(17)],
    )
    fc.assert(
      fc.property(raw, corrupt, (m, [key, bad]) => {
        if (!(key in m) && key !== 'v' && key !== 'type') return true // поле не з цього типу повідомлення
        return !ClientMessage.safeParse({ ...m, [key]: bad }).success
      }),
    )
  })

  it('просторовий хеш знаходить ті самі пари в тому самому порядку, що й перевірка всіх пар', () => {
    const body = fc.record({
      x: fc.double({ min: 0, max: 799, noNaN: true }),
      y: fc.double({ min: 0, max: 599, noNaN: true }),
      r: fc.integer({ min: 3, max: 38 }),
    })
    fc.assert(
      fc.property(fc.array(body, { maxLength: 60 }), (bodies) => {
        const world = new World(createArena(800, 600), 1, { asteroids: 0 })
        const rng = mulberry32(7)
        for (const b of bodies) world.spawn(new Asteroid({ x: b.x, y: b.y, rng })).radius = b.r
        const ids = (it: Iterable<[{ id: number }, { id: number }]>) =>
          [...it].map(([a, b]) => `${a.id}:${b.id}`)
        expect(ids(findCollisions(world))).toEqual(ids(findCollisionsNaive(world)))
      }),
      { numRuns: 100 },
    )
  })
})
