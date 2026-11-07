import { asSeq, type EntityId, type Seq } from 'shared/brand.ts'
import { Bus } from 'shared/bus.ts'
import { decodeSnapshot } from 'shared/net/binary.ts'
import { codecs } from 'shared/net/codec.ts'
import { STEP, SUBSTEPS, TICK_MS } from 'shared/net/constants.ts'
import type {
  EntityState,
  InputMessage,
  RoomInfo,
  ShipState,
  Snapshot,
} from 'shared/net/protocol.ts'
import { reconcile as reconcileShip } from 'shared/net/reconcile.ts'
import { type Arena, createArena, lerpWrapped, wrap } from 'shared/sim/arena.ts'
import { type Bullet, Explosion } from 'shared/sim/entity.ts'
import { mulberry32 } from 'shared/sim/random.ts'
import { Ship } from 'shared/sim/ship.ts'
import { assertNever } from 'shared/sim/types.ts'
import { stepShip, type WorldEvents } from 'shared/sim/world.ts'
import { type Input, readControls } from '../input.ts'
import { lerpAngle, type RenderItem } from '../render/draw.ts'
import type { Connection } from './connection.ts'
import type { DecodeResult } from './decode.worker.ts'
import type { NetSettings } from './net-panel.ts'

// Мережева гра (Lab 5). Сервер авторитетний; клієнт:
//  • шле input з seq кожен тік (30/с), ніколи не координати;
//  • ПЕРЕДБАЧАЄ свій корабель тим самим stepShip, що й сервер;
//  • на знімку — ЗВІРКА: стан сервера + повторне програвання непідтверджених input, поправка згладжується ~100 мс;
//  • чужі сутності малює В МИНУЛОМУ — інтерполяція між двома знімками (interpDelay);
//  • свої кулі показує одразу (передбачені), серверні копії своїх куль ховає.

const SMOOTH_TAU = 0.033 // с: за 100 мс лишається ~5% поправки
const SNAP_LIMIT = 200 // px: більший стрибок (респаун, загортання) не згладжуємо, а ставимо одразу
const CHAOS = 25 // px/с випадкового шуму в передбаченні — експеримент «Math.random() в integrate»

interface Buffered {
  time: number
  map: Map<EntityId, EntityState>
}
interface NetStats {
  rtt: number
  snapshotAt: number
  snapshotsPerSec: number
  downBps: number
  upBps: number
  correction: number
  correctionMax: number
  corrections: [ms: number, px: number][] // за останні 3 с — для графіка
  inputLatency: number | null
  tick: number
  entities: number
}

export interface NetGame {
  readonly arena: Arena
  readonly bus: Bus<WorldEvents>
  readonly me: Ship
  readonly stats: NetStats
  readonly settings: NetSettings
  readonly pending: number
  readonly entityCount: number
  simulate(): void
  items(alpha: number): RenderItem[]
}

function wrappedDelta(d: number, size: number): number {
  if (d > size / 2) return d - size
  if (d < -size / 2) return d + size
  return d
}

// Lab 7: RenderItem-и не створюються щокадру — кожен kind має масив готових об'єктів,
// які на початку кадру «звільняються» (reset) і заповнюються заново.
type Item<K extends RenderItem['kind']> = Extract<RenderItem, { kind: K }>
class FrameSlots<T> {
  readonly #items: T[] = []
  #used = 0
  readonly #make: () => T
  constructor(make: () => T) {
    this.#make = make
  }
  next(): T {
    let it = this.#items[this.#used]
    if (!it) {
      it = this.#make()
      this.#items.push(it)
    }
    this.#used++
    return it
  }
  reset(): void {
    this.#used = 0
  }
}
const NO_LOOK = { solid: false, thrust: false, shield: 0, hp: 0 }
function createSlots() {
  return {
    ship: new FrameSlots<Item<'ship'>>(() => ({
      kind: 'ship',
      x: 0,
      y: 0,
      angle: 0,
      mine: false,
      look: NO_LOOK,
    })),
    asteroid: new FrameSlots<Item<'asteroid'>>(() => ({
      kind: 'asteroid',
      x: 0,
      y: 0,
      angle: 0,
      radius: 0,
      shape: 0,
      homing: false,
    })),
    bullet: new FrameSlots<Item<'bullet'>>(() => ({ kind: 'bullet', x: 0, y: 0, homing: false })),
    pickup: new FrameSlots<Item<'pickup'>>(() => ({
      kind: 'pickup',
      x: 0,
      y: 0,
      effect: 'shield',
    })),
    explosion: new FrameSlots<Item<'explosion'>>(() => ({
      kind: 'explosion',
      particles: [],
      ttl: 0,
    })),
  }
}
type Slots = ReturnType<typeof createSlots>
const SLOT_KINDS: readonly (keyof Slots)[] = ['ship', 'asteroid', 'bullet', 'pickup', 'explosion']

// Запис знімка (дві точки в часі) → RenderItem. switch за kind: новий тип сутності без рендеру → помилка tsc.
function stateItem(
  a: EntityState,
  b: EntityState,
  t: number,
  arena: Arena,
  mine: boolean,
  slots: Slots,
): RenderItem | null {
  const x = lerpWrapped(a.x, b.x, t, arena.width)
  const y = lerpWrapped(a.y, b.y, t, arena.height)
  switch (b.kind) {
    case 'ship': {
      const it = slots.ship.next()
      it.x = x
      it.y = y
      it.angle = a.kind === 'ship' ? lerpAngle(a.angle, b.angle, t) : b.angle
      it.mine = mine
      it.look = b
      return it
    }
    case 'asteroid': {
      const it = slots.asteroid.next()
      it.x = x
      it.y = y
      it.angle = a.kind === 'asteroid' ? lerpAngle(a.angle, b.angle, t) : b.angle
      it.radius = b.radius
      it.shape = b.shape
      it.homing = b.homing
      return it
    }
    case 'bullet': {
      const it = slots.bullet.next()
      it.x = x
      it.y = y
      it.homing = b.homing
      return it
    }
    case 'pickup': {
      const it = slots.pickup.next()
      it.x = x
      it.y = y
      it.effect = b.effect
      return it
    }
    case 'explosion':
      return null // частинки — клієнтська косметика (Explosion нижче)
    default:
      return assertNever(b)
  }
}

export function createNetGame({
  conn,
  room,
  name,
  input,
  settings,
}: {
  conn: Connection
  room: RoomInfo
  name: string
  input: Input
  settings: NetSettings
}): NetGame {
  const arena = createArena(room.arena.width, room.arena.height)
  const codec = codecs[settings.codec]
  const bus = new Bus<WorldEvents>() // ті самі події, що в локальному режимі: звук і HUD не знають про мережу

  const me = new Ship({ name }) // передбачений свій корабель (локальний id ≠ серверний)
  me.solid = false // до першого знімка не малюємо
  let shipId: EntityId | null = null // id корабля на сервері
  let seq = 0
  const pending: InputMessage[] = [] // input, які сервер ще не підтвердив
  const prev = { x: 0, y: 0, angle: 0 } // стан перед останнім тіком — для інтерполяції рендеру
  const smooth = { x: 0, y: 0 } // візуальна поправка, що згасає до 0
  const myBullets = new Map<Seq, { bullet: Bullet; seen: boolean }>()
  const explosions = new Map<EntityId, Explosion>() // косметика клієнта
  const buffer: Buffered[] = [] // останні знімки
  let latest: Snapshot | null = null
  let clockOffset: number | null = null // серверний час − performance.now()
  let lastFrame = performance.now()

  const stats: NetStats = {
    rtt: 0,
    snapshotAt: 0,
    snapshotsPerSec: 0,
    downBps: 0,
    upBps: 0,
    correction: 0,
    correctionMax: 0,
    corrections: [],
    inputLatency: null,
    tick: 0,
    entities: 0,
  }

  // ---------- мережа ----------
  conn.on('match', (m) => {
    shipId = m.shipId
  })
  conn.on('pong', (m) => {
    stats.rtt = performance.now() - m.t
  })
  if (settings.worker) {
    // Lab 7: експеримент із Web Worker (висновок — у README; за замовчуванням вимкнено)
    const worker = new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module' })
    worker.addEventListener('message', (e: MessageEvent<DecodeResult>) => {
      if (e.data.ok) onSnapshot(e.data.snap)
      else console.warn('[net] битий знімок', e.data.error)
    })
    conn.on('binary', (data) => worker.postMessage(data, [data]))
  } else
    conn.on('binary', (data) => {
      try {
        onSnapshot(decodeSnapshot(data))
      } catch (err: unknown) {
        console.warn('[net] битий знімок', err) // декодер — валідатор: краще пропустити кадр, ніж упасти
      }
    })
  conn.on('snapshot', (snap) => onSnapshot(snap)) // ?codec=json — уже пройшов схему в Connection
  conn.on('open', () => {
    pending.length = 0 // новий сокет — новий корабель на сервері
    latest = null
    buffer.length = 0
    conn.send({ type: 'netsim', lag: settings.lag, jitter: settings.jitter, drop: settings.drop })
  })

  let snapsThisSecond = 0
  let lastIn = 0
  let lastOut = 0
  setInterval(() => conn.send({ type: 'ping', t: performance.now() }), 500)
  setInterval(() => {
    stats.snapshotsPerSec = snapsThisSecond
    snapsThisSecond = 0
    stats.downBps = conn.bytesIn - lastIn
    stats.upBps = conn.bytesOut - lastOut
    lastIn = conn.bytesIn
    lastOut = conn.bytesOut
  }, 1000)

  function predict(cmd: InputMessage): Bullet | null {
    const bullet = stepShip(me, cmd, STEP, arena)
    if (settings.chaos && me.solid) {
      // НАВМИСНО недетерміновано: клієнт рахує не так, як сервер → поправки ростуть
      me.vel.set(me.vel.x + (Math.random() - 0.5) * CHAOS, me.vel.y + (Math.random() - 0.5) * CHAOS)
    }
    return bullet
  }

  function reconcile(own: ShipState, ack: Seq): void {
    const old = {
      x: me.pos.x,
      y: me.pos.y,
      hp: me.hp,
      score: me.score,
      shield: me.shield,
      rapid: me.rapid,
      homing: me.homingShots,
      solid: me.solid,
    }
    // стан сервера → викинути підтверджене → переграти решту (чиста функція з shared/, покрита тестами)
    const replay = (cmd: InputMessage): void => {
      if (settings.prediction && settings.reconcile) for (let s = 0; s < SUBSTEPS; s++) predict(cmd)
    }
    const rest = reconcileShip(me, own, ack, pending, arena, replay)
    pending.length = 0
    pending.push(...rest)
    if (!settings.prediction) return

    const dx = wrappedDelta(me.pos.x - old.x, arena.width)
    const dy = wrappedDelta(me.pos.y - old.y, arena.height)
    const dist = Math.hypot(dx, dy)
    if (old.solid && me.solid && dist < SNAP_LIMIT) {
      // візуально нічого не стрибає: зсув переносимо в smooth, який згасне за ~100 мс
      smooth.x -= dx
      smooth.y -= dy
      prev.x += dx
      prev.y += dy
    } else {
      smooth.x = 0
      smooth.y = 0
      prev.x = me.pos.x
      prev.y = me.pos.y
      prev.angle = me.angle
    }
    if (old.solid && me.solid) {
      stats.correction = dist
      stats.corrections.push([performance.now(), dist])
    }

    // події для звуку й HUD — з різниці станів
    if (me.hp < old.hp)
      bus.emit('hit', { targetId: me.id, sourceId: me.id, damage: old.hp - me.hp, blocked: false })
    if (me.score > old.score)
      bus.emit('scored', { shipId: me.id, points: me.score - old.score, total: me.score })
    if (me.shield > old.shield + 1 && old.solid && me.solid)
      bus.emit('picked', { shipId: me.id, effect: 'shield' })
    if (me.rapid > old.rapid + 1) bus.emit('picked', { shipId: me.id, effect: 'rapid' })
    if (me.homingShots > old.homing + 1) bus.emit('picked', { shipId: me.id, effect: 'homing' })
  }

  function onSnapshot(snap: Snapshot): void {
    if (latest && snap.tick <= latest.tick) return // розкид затримки переставив порядок — старе ігноруємо
    latest = snap
    snapsThisSecond += 1
    stats.snapshotAt = performance.now()
    stats.tick = snap.tick
    stats.entities = snap.entities.length

    const time = snap.tick * TICK_MS
    const sample = time - performance.now()
    // орієнтуємось на НАЙШВИДШУ доставку; якщо затримка зросла — повільно підлаштовуємось
    clockOffset =
      clockOffset === null ? sample : Math.max(sample, clockOffset + (sample - clockOffset) * 0.02)
    const map = new Map<EntityId, EntityState>()
    for (const e of snap.entities) map.set(e.id, e)
    buffer.push({ time, map })
    while (buffer.length > 60) buffer.shift()

    const own = shipId !== null ? map.get(shipId) : undefined
    if (own?.kind === 'ship') reconcile(own, snap.ack)

    // свої передбачені кулі ↔ серверні (за seq input-у)
    const onServer = new Set<Seq>()
    for (const e of snap.entities)
      if (e.kind === 'bullet' && e.ownerId === shipId) onServer.add(e.seq)
    for (const [s, rec] of myBullets) {
      if (onServer.has(s)) rec.seen = true
      else if (rec.seen || s <= snap.ack) {
        myBullets.delete(s) // сервер її знищив (влучання) або не випустив
        rec.bullet.release()
      }
    }
  }

  // ---------- тік клієнта (30/с) ----------
  let turnWas = 0
  let latencyProbe: { t0: number; angle: number | null } | null = null // затримка input → екран (поворот)

  function simulate(): void {
    const cmd: InputMessage = { v: 1, type: 'input', ...readControls(input), seq: asSeq(++seq) }
    input.consume()
    conn.sendRaw(codec.encodeInput(cmd))
    pending.push(cmd)
    if (pending.length > 120) pending.shift()

    // поворот, а не газ: кутової інерції немає, тож кут змінюється ЛИШЕ від input
    if (cmd.turn !== 0 && turnWas === 0 && shipId !== null)
      latencyProbe = { t0: performance.now(), angle: null }
    turnWas = cmd.turn

    prev.x = me.pos.x
    prev.y = me.pos.y
    prev.angle = me.angle
    if (settings.prediction && shipId !== null) {
      for (let s = 0; s < SUBSTEPS; s++) {
        const bullet = predict(cmd)
        if (bullet) {
          myBullets.set(cmd.seq, { bullet, seen: false })
          bus.emit('fired', { shipId: me.id, x: bullet.pos.x, y: bullet.pos.y })
        }
      }
    }
    for (const [s, rec] of myBullets) {
      const b = rec.bullet
      b.savePrev()
      for (let i = 0; i < SUBSTEPS; i++) {
        b.update(STEP)
        wrap(b.pos, arena)
      }
      if (!b.alive) {
        myBullets.delete(s)
        b.release()
      }
    }
  }

  // ---------- рендер ----------
  function interpolated(): { a: Buffered; b: Buffered; t: number } | null {
    const first = buffer[0]
    if (!first || clockOffset === null) return null
    const renderTime = performance.now() + clockOffset - settings.interpDelay
    let a = first
    let b = first
    for (let i = buffer.length - 1; i >= 0; i--) {
      const cur = buffer[i]
      if (cur && cur.time <= renderTime) {
        a = cur
        b = buffer[i + 1] ?? cur // новішого ще немає — тримаємо останній (без екстраполяції)
        break
      }
    }
    const t =
      b.time > a.time ? Math.min(1, Math.max(0, (renderTime - a.time) / (b.time - a.time))) : 0
    return { a, b, t }
  }

  const list: RenderItem[] = []
  const slots = createSlots()
  function items(alpha: number): RenderItem[] {
    const now = performance.now()
    const dt = (now - lastFrame) / 1000
    lastFrame = now
    const k = Math.exp(-dt / SMOOTH_TAU)
    smooth.x *= k
    smooth.y *= k

    list.length = 0
    for (const k of SLOT_KINDS) slots[k].reset()
    const pair = interpolated()
    if (pair) {
      for (const e of pair.b.map.values()) {
        const mineShip = e.id === shipId
        if (settings.prediction && (mineShip || (e.kind === 'bullet' && e.ownerId === shipId)))
          continue
        if (e.kind === 'explosion') {
          if (!explosions.has(e.id)) {
            explosions.set(e.id, new Explosion({ x: e.x, y: e.y, rng: mulberry32(e.id) }))
            bus.emit('exploded', { x: e.x, y: e.y })
          }
          continue
        }
        const ea = pair.a.map.get(e.id)
        if (!ea) continue // з’явилась лише в новішому знімку — почекаємо, поки буде пара
        const item = stateItem(ea, e, pair.t, arena, mineShip, slots)
        if (item) list.push(item)
      }
    }
    for (const [id, ex] of explosions) {
      ex.update(dt)
      if (!ex.alive) {
        explosions.delete(id)
        ex.release() // частинки — назад у пул
      } else {
        const it = slots.explosion.next()
        it.particles = ex.particles
        it.ttl = ex.ttl
        list.push(it)
      }
    }
    let mine: Item<'ship'> | null = null
    if (settings.prediction) {
      for (const { bullet } of myBullets.values()) {
        const it = slots.bullet.next()
        it.x = lerpWrapped(bullet.prevX, bullet.pos.x, alpha, arena.width)
        it.y = lerpWrapped(bullet.prevY, bullet.pos.y, alpha, arena.height)
        it.homing = bullet.homing !== null
        list.push(it)
      }
      if (me.solid) {
        mine = slots.ship.next()
        mine.x = lerpWrapped(prev.x, me.pos.x, alpha, arena.width) + smooth.x
        mine.y = lerpWrapped(prev.y, me.pos.y, alpha, arena.height) + smooth.y
        mine.angle = lerpAngle(prev.angle, me.angle, alpha)
        mine.mine = true
        mine.look = me
        list.push(mine)
      }
    } else {
      for (const item of list) if (item.kind === 'ship' && item.mine) mine = item
    }

    if (latencyProbe && mine) {
      if (latencyProbe.angle === null) latencyProbe.angle = mine.angle
      else if (Math.abs(mine.angle - latencyProbe.angle) > 0.001) {
        stats.inputLatency = now - latencyProbe.t0
        latencyProbe = null
      }
    }
    while ((stats.corrections[0]?.[0] ?? now) < now - 3000) stats.corrections.shift()
    stats.correctionMax = stats.corrections.reduce((m, c) => Math.max(m, c[1]), 0)
    return list
  }

  return {
    arena,
    bus,
    me,
    stats,
    settings,
    get pending() {
      return pending.length
    },
    get entityCount() {
      return stats.entities
    },
    simulate,
    items,
  }
}
