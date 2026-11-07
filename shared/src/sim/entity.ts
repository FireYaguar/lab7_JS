import { asEntityId, asSeq, type EntityId, type Seq } from '../brand.ts'
import { dcos, dsin } from './dmath.ts'
import { Pool } from './pool.ts'
import { type Rng, range } from './random.ts'
import type { Effect, EntityKind } from './types.ts'
import { Vector2 } from './vector.ts'

// Компоненти (композиція з Lab 2) — звичайні дані.
export interface Homing {
  readonly targets: readonly EntityKind[]
  readonly turnRate: number
  readonly range: number
}
export interface PickupData {
  readonly effect: Effect
}

export interface EntityOptions<K extends EntityKind> {
  kind: K
  x?: number
  y?: number
  vx?: number
  vy?: number
  angle?: number
  radius?: number
  ttl?: number
}

// Базова сутність, узагальнена за kind: Entity<'bullet'> має kind типу 'bullet', а не просто string.
// Це робить AnyEntity (нижче) розрізнюваним об’єднанням: switch (e.kind) звужує тип.
export class Entity<K extends EntityKind = EntityKind> {
  static #nextId = 1
  #id: EntityId = asEntityId(Entity.#nextId++)

  readonly kind: K
  readonly pos: Vector2 // мутуються на місці (Vector2.*Self) — без нового вектора на кадр
  readonly vel: Vector2
  angle: number
  radius: number
  ttl: number // секунд до самознищення; Infinity — живе вічно
  alive = true // false → World прибере наприкінці кроку
  solid = true // бере участь у колізіях
  wraps = true // загортається по краях арени
  homing: Homing | null = null
  pickup: PickupData | null = null
  prevX: number
  prevY: number
  prevAngle: number

  constructor({
    kind,
    x = 0,
    y = 0,
    vx = 0,
    vy = 0,
    angle = 0,
    radius = 10,
    ttl = Infinity,
  }: EntityOptions<K>) {
    this.kind = kind
    this.pos = new Vector2(x, y)
    this.vel = new Vector2(vx, vy)
    this.angle = angle
    this.radius = radius
    this.ttl = ttl
    this.prevX = x
    this.prevY = y
    this.prevAngle = angle
  }

  get id(): EntityId {
    return this.#id
  }

  // Повторне використання з пулу: новий id (клієнти розрізняють сутності за id) і чистий стан.
  protected reuse(x: number, y: number, vx: number, vy: number, ttl: number): void {
    this.#id = asEntityId(Entity.#nextId++)
    this.pos.set(x, y)
    this.vel.set(vx, vy)
    this.ttl = ttl
    this.alive = true
    this.homing = null
    this.prevX = x
    this.prevY = y
  }

  // World кличе, коли прибирає мертву сутність. Пулові сутності повертаються в пул.
  release(): void {}

  savePrev(): void {
    this.prevX = this.pos.x
    this.prevY = this.pos.y
    this.prevAngle = this.angle
  }

  update(dt: number): void {
    this.pos.addScaledSelf(this.vel, dt)
    if (this.ttl !== Infinity) {
      this.ttl -= dt
      if (this.ttl <= 0) this.alive = false
    }
  }
}

interface BulletInit {
  x: number
  y: number
  vx: number
  vy: number
  ownerId: EntityId
}

export class Bullet extends Entity<'bullet'> {
  static readonly SPEED = 620
  static readonly DAMAGE = 25
  static readonly TTL = 1.1
  // Lab 7: кулі з пулу — Bullet.create замість new у гарячому шляху (Ship.fire)
  static readonly pool = new Pool<Bullet>(
    () => new Bullet({ x: 0, y: 0, vx: 0, vy: 0, ownerId: asEntityId(0) }),
  )
  ownerId: EntityId
  readonly damage = Bullet.DAMAGE
  seq: Seq = asSeq(0) // seq input-у, яким випущено (клієнт зіставляє зі своєю передбаченою кулею)

  constructor({ x, y, vx, vy, ownerId }: BulletInit) {
    super({ kind: 'bullet', x, y, vx, vy, radius: 3, ttl: Bullet.TTL })
    this.ownerId = ownerId
  }

  static create({ x, y, vx, vy, ownerId }: BulletInit): Bullet {
    const b = Bullet.pool.acquire()
    b.reuse(x, y, vx, vy, Bullet.TTL)
    b.ownerId = ownerId
    b.seq = asSeq(0)
    return b
  }

  override release(): void {
    Bullet.pool.release(this)
  }
}

export class Asteroid extends Entity<'asteroid'> {
  readonly spin: number
  readonly shapeSeed: number // форма «каменя» для рендеру

  constructor({ x, y, rng }: { x: number; y: number; rng: Rng }) {
    const speed = range(rng, 20, 70)
    const dir = range(rng, 0, Math.PI * 2)
    super({
      kind: 'asteroid',
      x,
      y,
      vx: dcos(dir) * speed,
      vy: dsin(dir) * speed,
      angle: dir,
      radius: range(rng, 20, 38),
    })
    this.spin = range(rng, -1, 1)
    this.shapeSeed = Math.floor(rng() * 1e9)
  }

  override update(dt: number): void {
    super.update(dt)
    this.angle += this.spin * dt
  }
}

export interface Particle {
  x: number
  y: number
  vx: number
  vy: number
}

// Вибух: багато короткоживучих частинок. Lab 7: частинки беруться з пулу і повертаються в release().
export class Explosion extends Entity<'explosion'> {
  static readonly particles = new Pool<Particle>(() => ({ x: 0, y: 0, vx: 0, vy: 0 }))
  readonly particles: Particle[] = []

  constructor({ x, y, rng, count = 18 }: { x: number; y: number; rng: Rng; count?: number }) {
    super({ kind: 'explosion', x, y, ttl: 0.8 })
    this.solid = false
    this.wraps = false
    for (let i = 0; i < count; i++) {
      const a = range(rng, 0, Math.PI * 2)
      const s = range(rng, 40, 220)
      const p = Explosion.particles.acquire()
      p.x = x
      p.y = y
      p.vx = dcos(a) * s
      p.vy = dsin(a) * s
      this.particles.push(p)
    }
  }

  override release(): void {
    for (const p of this.particles) Explosion.particles.release(p)
    this.particles.length = 0
  }

  override update(dt: number): void {
    super.update(dt)
    const ps = this.particles
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i]
      if (!p) continue
      p.x += p.vx * dt
      p.y += p.vy * dt
    }
  }
}

// Pickup — не клас (композиція, Lab 2): звичайний Entity<'pickup'>, у якого компонент pickup точно є.
export type PickupEntity = Entity<'pickup'> & { pickup: PickupData }
