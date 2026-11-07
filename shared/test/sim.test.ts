import { describe, expect, it } from 'vitest'
import { asEntityId, asSeq } from '../src/brand.ts'
import { Bus } from '../src/bus.ts'
import { reconcile } from '../src/net/reconcile.ts'
import { createArena, lerpWrapped, wrap } from '../src/sim/arena.ts'
import { findCollisions, resolveCollisions } from '../src/sim/collision.ts'
import { createPickup } from '../src/sim/components.ts'
import { Asteroid, Bullet } from '../src/sim/entity.ts'
import { mulberry32, pick, range } from '../src/sim/random.ts'
import { SHIP, Ship } from '../src/sim/ship.ts'
import type { Command } from '../src/sim/types.ts'
import { Vector2 } from '../src/sim/vector.ts'
import { stepShip, World } from '../src/sim/world.ts'

const arena = createArena(1600, 900)
const IDLE: Command = { thrust: false, turn: 0, fire: false }

describe('Vector2', () => {
  it('методи чисті: аргументи й this не змінюються', () => {
    const a = new Vector2(1, 2)
    const b = new Vector2(3, 4)
    expect(a.add(b)).toEqual(new Vector2(4, 6))
    expect(a.sub(b)).toEqual(new Vector2(-2, -2))
    expect(a.scale(2)).toEqual(new Vector2(2, 4))
    expect(a.addScaled(b, 0.5)).toEqual(new Vector2(2.5, 4))
    expect(a).toEqual(new Vector2(1, 2))
    expect(b).toEqual(new Vector2(3, 4))
  })
  it('length, dot, normalize (і нульовий вектор)', () => {
    expect(new Vector2(3, 4).length()).toBe(5)
    expect(new Vector2(1, 2).dot(new Vector2(3, 4))).toBe(11)
    expect(new Vector2(3, 4).normalize().length()).toBeCloseTo(1, 15)
    expect(new Vector2().normalize()).toEqual(new Vector2(0, 0))
  })
  it('rotate на 90° і angle / fromAngle — взаємно обернені', () => {
    const r = new Vector2(1, 0).rotate(Math.PI / 2)
    expect(r.x).toBeCloseTo(0, 12)
    expect(r.y).toBeCloseTo(1, 12)
    const v = Vector2.fromAngle(0.7, 3)
    expect(v.angle()).toBeCloseTo(0.7, 12)
    expect(v.length()).toBeCloseTo(3, 12)
  })
})

describe('корабель: integrate (Ship.control + update)', () => {
  it('газ розганяє вздовж носа', () => {
    const s = new Ship({ x: 100, y: 100, angle: 0 })
    for (let i = 0; i < 30; i++) stepShip(s, { thrust: true, turn: 0, fire: false }, 1 / 60, arena)
    expect(s.vel.x).toBeGreaterThan(0)
    expect(Math.abs(s.vel.y)).toBeLessThan(1e-9)
    expect(s.pos.x).toBeGreaterThan(100)
  })
  it('без газу тертя гальмує, швидкість обмежена maxSpeed', () => {
    const s = new Ship({ angle: 0 })
    for (let i = 0; i < 600; i++) stepShip(s, { thrust: true, turn: 0, fire: false }, 1 / 60, arena)
    expect(s.vel.length()).toBeLessThanOrEqual(SHIP.maxSpeed + 1e-9)
    const fast = s.vel.length()
    for (let i = 0; i < 60; i++) stepShip(s, IDLE, 1 / 60, arena)
    expect(s.vel.length()).toBeLessThan(fast * 0.7)
  })
  it('кут завжди в (−π, π]', () => {
    const s = new Ship({ angle: 0 })
    for (let i = 0; i < 1000; i++) {
      stepShip(s, { thrust: false, turn: 1, fire: false }, 1 / 60, arena)
      expect(s.angle).toBeGreaterThan(-Math.PI)
      expect(s.angle).toBeLessThanOrEqual(Math.PI)
    }
  })
  it('постріл: куля з носа з успадкованою швидкістю, далі кулдаун', () => {
    const s = new Ship({ x: 500, y: 500, angle: 0 })
    const b = stepShip(s, { seq: asSeq(7), thrust: false, turn: 0, fire: true }, 1 / 60, arena)
    expect(b).not.toBeNull()
    expect(b?.pos.x).toBeGreaterThan(500)
    expect(b?.seq).toBe(7)
    expect(stepShip(s, { thrust: false, turn: 0, fire: true }, 1 / 60, arena)).toBeNull()
  })
  it('шкода: щит блокує, нуль hp → знищено, respawn відновлює', () => {
    const s = new Ship()
    s.shield = 1
    expect(s.takeDamage(500)).toBe(false)
    expect(s.hp).toBe(100)
    s.shield = 0
    expect(s.takeDamage(60)).toBe(false)
    expect(s.takeDamage(60)).toBe(true)
    expect(s.solid).toBe(false)
    s.respawn(10, 20)
    expect([s.hp, s.solid, s.pos.x, s.pos.y]).toEqual([100, true, 10, 20])
  })
})

describe('колізії', () => {
  it('findCollisions: дотик і перетин — так, проміжок — ні', () => {
    const w = new World(arena, 1, { asteroids: 0 })
    const a = w.spawn(new Ship({ x: 100, y: 100 }))
    const b = w.spawn(new Ship({ x: 128, y: 100 })) // 14 + 14 = 28 — рівно дотик
    const c = w.spawn(new Ship({ x: 300, y: 100 }))
    const pairs = [...findCollisions(w)].map(([p, q]) => [p.id, q.id])
    expect(pairs).toEqual([[a.id, b.id]])
    expect(pairs.flat()).not.toContain(c.id)
  })
  it('куля + астероїд: обидва знищені, власнику +10', () => {
    const w = new World(arena, 1, { asteroids: 0 })
    const s = w.spawn(new Ship({ x: 1000, y: 800 }))
    const ast = w.spawn(new Asteroid({ x: 300, y: 300, rng: mulberry32(1) }))
    const bul = w.spawn(new Bullet({ x: 300, y: 300, vx: 0, vy: 0, ownerId: s.id }))
    resolveCollisions(w, findCollisions(w))
    expect([ast.alive, bul.alive, s.score]).toEqual([false, false, 10])
  })
  it('своя куля власника не б’є; чужа — б’є', () => {
    const w = new World(arena, 1, { asteroids: 0 })
    const s = w.spawn(new Ship({ x: 300, y: 300 }))
    const own = w.spawn(new Bullet({ x: 300, y: 300, vx: 0, vy: 0, ownerId: s.id }))
    resolveCollisions(w, findCollisions(w))
    expect([own.alive, s.hp]).toEqual([true, 100])
    w.spawn(new Bullet({ x: 300, y: 300, vx: 0, vy: 0, ownerId: asEntityId(999999) }))
    resolveCollisions(w, findCollisions(w))
    expect(s.hp).toBe(100 - Bullet.DAMAGE)
  })
  it('таран астероїда і pickup', () => {
    const w = new World(arena, 1, { asteroids: 0 })
    const s = w.spawn(new Ship({ x: 300, y: 300 }))
    w.spawn(new Asteroid({ x: 300, y: 300, rng: mulberry32(2) }))
    w.spawn(createPickup({ x: 300, y: 300, effect: 'rapid' }))
    const picked: string[] = []
    w.events.on('picked', (p) => picked.push(p.effect))
    resolveCollisions(w, findCollisions(w))
    expect(s.hp).toBe(70)
    expect(picked).toEqual(['rapid'])
    expect(s.rapid).toBeGreaterThan(0)
  })
  it('швидка куля не пролітає крізь корабель при кроці 1/60 (620 px/с → 10 px/крок < 17 px)', () => {
    const w = new World(arena, 1, { asteroids: 0 })
    const target = w.spawn(new Ship({ x: 600, y: 300 }))
    w.spawn(new Bullet({ x: 500, y: 300, vx: Bullet.SPEED, vy: 0, ownerId: asEntityId(424242) }))
    for (let i = 0; i < 30; i++) w.stepOthers(1 / 60)
    expect(target.hp).toBe(100 - Bullet.DAMAGE)
  })
})

describe('World', () => {
  it('спавн під час кроку відкладається, despawn прибирає наприкінці', () => {
    const w = new World(arena, 3, { asteroids: 0 })
    const s = w.spawn(new Ship({ x: 100, y: 100, angle: 0 }))
    w.step(1 / 60, new Map([[s.id, { thrust: false, turn: 0, fire: true }]]))
    expect([...w.ofKind('bullet')]).toHaveLength(1)
    w.despawn(s.id)
    expect(w.get(s.id)).toBeDefined() // ще є — лише позначка
    w.step(1 / 60)
    expect(w.get(s.id)).toBeUndefined()
  })
  it('ofKind звужує тип і фільтрує', () => {
    const w = new World(arena, 3, { asteroids: 0 })
    w.spawn(new Ship())
    w.spawnAsteroid()
    w.spawnAsteroid()
    expect([...w.ofKind('asteroid')].every((a) => a.shapeSeed >= 0)).toBe(true)
    expect([...w.ofKind('asteroid')]).toHaveLength(2)
  })
  it('детермінізм кроку: два світи з одним seed і input — однакові позиції', () => {
    const run = (): number[] => {
      const w = new World(arena, 99, { asteroids: 4 })
      const s = w.spawn(new Ship({ x: 800, y: 450 }))
      for (let i = 0; i < 4; i++) w.spawnAsteroid()
      for (let i = 0; i < 300; i++)
        w.step(1 / 60, new Map([[s.id, { thrust: i % 3 === 0, turn: 1, fire: i % 9 === 0 }]]))
      return [...w].flatMap((e) => [e.pos.x, e.pos.y, e.vel.x, e.vel.y])
    }
    expect(run()).toEqual(run())
  })
})

describe('звірка з сервером (чиста функція)', () => {
  const cmds = Array.from({ length: 12 }, (_, i) => ({
    seq: asSeq(i + 1),
    thrust: true,
    turn: i % 4 === 0 ? (1 as const) : (0 as const),
    fire: false,
  }))
  const serverAfter = (n: number): Ship => {
    const s = new Ship({ x: 400, y: 400 })
    for (const c of cmds.slice(0, n)) stepShip(s, c, 1 / 60, arena)
    return s
  }
  const sync = (s: Ship) => ({ ...s, x: s.pos.x, y: s.pos.y, vx: s.vel.x, vy: s.vel.y, hp: s.hp })
  const replay1 = (ship: Ship) => (c: Command) => {
    stepShip(ship, c, 1 / 60, arena)
  }

  it('стан сервера + переграні непідтверджені = той самий стан, що після всіх input', () => {
    const client = new Ship({ x: 0, y: 0 })
    const rest = reconcile(client, sync(serverAfter(5)), asSeq(5), cmds, arena, replay1(client))
    expect(rest.map((c) => c.seq)).toEqual([6, 7, 8, 9, 10, 11, 12])
    const truth = serverAfter(12)
    expect([client.pos.x, client.pos.y]).toEqual([truth.pos.x, truth.pos.y])
  })
  it('ack усіх → нічого не переграється', () => {
    const client = new Ship()
    expect(
      reconcile(client, sync(serverAfter(12)), asSeq(12), cmds, arena, replay1(client)),
    ).toEqual([])
  })
  it('клієнт помилявся → звірка виправляє (поправка ≠ 0)', () => {
    const client = new Ship({ x: 999, y: 999 })
    reconcile(client, sync(serverAfter(3)), asSeq(3), cmds, arena, replay1(client))
    expect(client.pos.x).toBe(serverAfter(12).pos.x)
  })
})

describe('дрібниці: арена, PRNG, шина', () => {
  it('wrap і lerpWrapped', () => {
    expect(wrap(new Vector2(-1, 905), arena)).toEqual(new Vector2(1599, 5))
    expect(lerpWrapped(10, 20, 0.5, 1600)).toBe(15)
    expect(lerpWrapped(1590, 5, 0.5, 1600)).toBe(5) // стрибок через край — без «протягування»
  })
  it('range у межах, pick з порожнього — помилка', () => {
    const rng = mulberry32(5)
    for (let i = 0; i < 100; i++) {
      const v = range(rng, 2, 3)
      expect(v).toBeGreaterThanOrEqual(2)
      expect(v).toBeLessThan(3)
    }
    expect(() => pick(rng, [])).toThrow(RangeError)
  })
  it('Bus.once → проміс з payload', async () => {
    const bus = new Bus<{ ready: number }>()
    const p = bus.once('ready')
    bus.emit('ready', 42)
    await expect(p).resolves.toBe(42)
  })
})
