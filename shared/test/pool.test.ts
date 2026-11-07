import { asEntityId } from 'shared/brand.ts'
import type { Snapshot } from 'shared/net/protocol.ts'
import { describe, expect, it } from 'vitest'
import { createArena } from '../src/sim/arena.ts'
import { Bullet, Explosion } from '../src/sim/entity.ts'
import { Pool } from '../src/sim/pool.ts'
import { mulberry32 } from '../src/sim/random.ts'
import { Ship } from '../src/sim/ship.ts'
import { Vector2 } from '../src/sim/vector.ts'
import { World } from '../src/sim/world.ts'

describe('пули і вектори без алокацій (Lab 7)', () => {
  it('Pool: release → acquire повертає той самий об’єкт, нових не створює', () => {
    const pool = new Pool(() => ({ n: 0 }))
    const a = pool.acquire()
    pool.release(a)
    expect(pool.acquire()).toBe(a)
    expect(pool.created).toBe(1)
  })

  it('Bullet.create бере кулю з пулу, але з новим id і чистим станом', () => {
    const b1 = Bullet.create({ x: 1, y: 2, vx: 3, vy: 4, ownerId: asEntityId(7) })
    const id1 = b1.id
    b1.alive = false
    b1.release()
    const b2 = Bullet.create({ x: 5, y: 6, vx: 0, vy: 0, ownerId: asEntityId(8) })
    expect(b2).toBe(b1)
    expect(b2.id).not.toBe(id1)
    expect([b2.alive, b2.pos.x, b2.ttl, b2.ownerId, b2.homing]).toEqual([
      true,
      5,
      Bullet.TTL,
      8,
      null,
    ])
  })

  it('World повертає мертві кулі в пул: 300 кроків стрільби — створено лише кілька куль', () => {
    const world = new World(createArena(800, 600), 1, { asteroids: 0 })
    const ship = world.spawn(new Ship({ x: 400, y: 300 }))
    const before = Bullet.pool.created
    for (let i = 0; i < 300; i++) {
      world.applyInput(ship, { thrust: false, turn: 1, fire: true }, 1 / 60)
      world.stepOthers(1 / 60)
    }
    // кулдаун ≈ 0.25 с, TTL 1.1 с → одночасно живе ~5 куль; без пулу було б ~70 new
    expect(Bullet.pool.created - before).toBeLessThan(10)
  })

  it('частинки вибуху повертаються в пул і використовуються повторно', () => {
    const ex = new Explosion({ x: 0, y: 0, rng: mulberry32(1) })
    const first = ex.particles[0]
    ex.release()
    expect(ex.particles).toHaveLength(0)
    const again = new Explosion({ x: 9, y: 9, rng: mulberry32(2) })
    expect(again.particles).toContain(first)
    expect(first?.x).toBe(9)
  })

  it('*Self-методи Vector2 змінюють той самий об’єкт і дають той самий результат, що й чисті', () => {
    const v = new Vector2(3, 4)
    const pure = v.addScaled(new Vector2(1, 1), 2).scale(0.5).rotate(1)
    const same = v.addScaledSelf(new Vector2(1, 1), 2).scaleSelf(0.5).rotateSelf(1)
    expect(same).toBe(v)
    expect([same.x, same.y]).toEqual([pure.x, pure.y])
  })
})

describe('знімок: закодувати раз — розіслати всім (Lab 7)', () => {
  it('SnapshotEncoder кодує базовий знімок один раз, ack у кожного свій', async () => {
    const { SnapshotEncoder, codecs } = await import('../src/net/codec.ts')
    const { decodeSnapshot } = await import('../src/net/binary.ts')
    const { asSeq, asTick } = await import('../src/brand.ts')
    const base: Snapshot = { type: 'snapshot', tick: asTick(5), ack: asSeq(0), entities: [] }
    const enc = new SnapshotEncoder()
    const frames = [1, 2, 3].map((a) => enc.encode(codecs.binary, base, asSeq(a)))
    expect(enc.encodes).toBe(1)
    expect(frames.map((f) => decodeSnapshot(f).ack)).toEqual([1, 2, 3])
    expect(JSON.parse(String(enc.encode(codecs.json, base, asSeq(9)))).ack).toBe(9)
  })
})
