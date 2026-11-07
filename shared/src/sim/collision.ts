import type { EntityId } from '../brand.ts'
import { applyPickup } from './components.ts'
import type { Ship } from './ship.ts'
import type { AnyEntity, World } from './world.ts'

// Система колізій окремо від World: спочатку знаходимо пари, потім застосовуємо правила.
//
// Lab 7: замість перевірки всіх пар O(n²) — просторовий хеш (spatial hash). Профіль сервера на 256
// клієнтах показав, що після «закодуй знімок один раз» колізії стали ~40 % тіку. Кожна сутність лежить
// у клітинці за своїм центром; кандидати — лише з 3×3 сусідніх клітинок. CELL ≥ найбільшої суми радіусів
// (астероїд 38 + астероїд 38 = 76), тож жодна пара, що торкається, не пропускається.
// Порядок пар той самий, що в O(n²) (i < j за порядком обходу світу) — хеш детермінізму не змінився.
// Масиви й Map перевикористовуються між кроками: у гарячому циклі нічого не алокується, крім самих пар.

export const CELL = 80
const cells = new Map<number, number[]>() // ключ клітинки → індекси в list
const list: AnyEntity[] = []
const near: number[] = []
const byIndex = (a: number, b: number): number => a - b

function cellKey(cx: number, cy: number): number {
  return (cx & 0xffff) | ((cy & 0xffff) << 16)
}

export function* findCollisions(world: World): Generator<[AnyEntity, AnyEntity]> {
  list.length = 0
  for (const e of world) if (e.solid && e.alive) list.push(e)
  for (const bucket of cells.values()) bucket.length = 0
  for (let i = 0; i < list.length; i++) {
    const e = list[i]
    if (!e) continue
    const key = cellKey(Math.floor(e.pos.x / CELL), Math.floor(e.pos.y / CELL))
    let bucket = cells.get(key)
    if (!bucket) {
      bucket = []
      cells.set(key, bucket)
    }
    bucket.push(i)
  }
  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    if (!a) continue
    const cx = Math.floor(a.pos.x / CELL)
    const cy = Math.floor(a.pos.y / CELL)
    near.length = 0
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = cells.get(cellKey(cx + dx, cy + dy))
        if (bucket) for (const j of bucket) if (j > i) near.push(j)
      }
    }
    near.sort(byIndex)
    for (const j of near) {
      const b = list[j]
      if (!b) continue
      const dx = a.pos.x - b.pos.x
      const dy = a.pos.y - b.pos.y
      const r = a.radius + b.radius
      if (dx * dx + dy * dy <= r * r) yield [a, b]
    }
  }
}

// Еталон для тестів: перевірка всіх пар (як було до Lab 7)
export function* findCollisionsNaive(world: World): Generator<[AnyEntity, AnyEntity]> {
  const all: AnyEntity[] = []
  for (const e of world) if (e.solid && e.alive) all.push(e)
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i]
      const b = all[j]
      if (!a || !b) continue
      const dx = a.pos.x - b.pos.x
      const dy = a.pos.y - b.pos.y
      const r = a.radius + b.radius
      if (dx * dx + dy * dy <= r * r) yield [a, b]
    }
  }
}

const SCORE = { asteroid: 10, ship: 100 }
const RAM_DAMAGE = 30

function credit(world: World, ownerId: EntityId, points: number): void {
  const owner = world.get(ownerId)
  // TS: world.get повертає будь-яку сутність, а score є лише в корабля
  if (owner?.kind !== 'ship') return
  owner.score += points
  world.emit('scored', { shipId: ownerId, points, total: owner.score })
}

function damage(world: World, ship: Ship, amount: number, sourceId: EntityId): boolean {
  const killed = ship.takeDamage(amount)
  world.emit('hit', { targetId: ship.id, sourceId, damage: amount, blocked: ship.shield > 0 })
  if (killed) world.explode(ship.pos.x, ship.pos.y, 'ship')
  return killed
}

// Пари впорядковано за kind (asteroid < bullet < pickup < ship), тож кожну комбінацію перевіряємо в одному порядку.
// Перевірки a.kind / b.kind звужують типи: всередині if a — Asteroid, b — Bullet тощо.
export function resolveCollisions(world: World, pairs: Iterable<[AnyEntity, AnyEntity]>): void {
  for (const [p, q] of pairs) {
    const [a, b] = p.kind <= q.kind ? [p, q] : [q, p]
    if (!a.alive || !b.alive || !a.solid || !b.solid) continue // уже знищено в цьому кроці

    if (a.kind === 'asteroid' && b.kind === 'bullet') {
      a.alive = false
      b.alive = false
      world.explode(a.pos.x, a.pos.y, 'asteroid')
      credit(world, b.ownerId, SCORE.asteroid)
    } else if (a.kind === 'bullet' && b.kind === 'ship') {
      if (a.ownerId === b.id) continue // своя куля не б’є
      a.alive = false
      if (damage(world, b, a.damage, a.ownerId)) credit(world, a.ownerId, SCORE.ship)
    } else if (a.kind === 'asteroid' && b.kind === 'ship') {
      a.alive = false
      world.explode(a.pos.x, a.pos.y, 'asteroid')
      damage(world, b, RAM_DAMAGE, a.id)
    } else if (a.kind === 'pickup' && b.kind === 'ship') {
      a.alive = false
      applyPickup(b, a.pickup.effect)
      world.emit('picked', { shipId: b.id, effect: a.pickup.effect })
    }
    // інші пари (asteroid:asteroid, bullet:bullet, bullet:pickup…) — ігноруємо
  }
}
