import { datan2, dcos, dlength, dsin } from './dmath.ts'

// 2D-вектор. Звичайні методи (add, scale, …) чисті — повертають НОВИЙ вектор.
// Lab 7: профайлер показав алокацію вектора на кожен крок кожної сутності (Entity.update),
// тому для гарячого циклу є методи *Self, що змінюють вектор на місці й повертають this.
// pos/vel сутностей — readonly-посилання, які мутуються лише ними.

export class Vector2 {
  x: number
  y: number

  constructor(x = 0, y = 0) {
    this.x = x
    this.y = y
  }

  static fromAngle(angle: number, length = 1): Vector2 {
    return new Vector2(dcos(angle) * length, dsin(angle) * length)
  }

  add(v: Vector2): Vector2 {
    return new Vector2(this.x + v.x, this.y + v.y)
  }

  sub(v: Vector2): Vector2 {
    return new Vector2(this.x - v.x, this.y - v.y)
  }

  scale(k: number): Vector2 {
    return new Vector2(this.x * k, this.y * k)
  }

  // this + v·k (рух: pos + vel·dt) — та сама арифметика, що addScaledInPlace у Lab 2–5
  addScaled(v: Vector2, k: number): Vector2 {
    return new Vector2(this.x + v.x * k, this.y + v.y * k)
  }

  set(x: number, y: number): this {
    this.x = x
    this.y = y
    return this
  }

  addScaledSelf(v: Vector2, k: number): this {
    this.x += v.x * k
    this.y += v.y * k
    return this
  }

  scaleSelf(k: number): this {
    this.x *= k
    this.y *= k
    return this
  }

  rotateSelf(angle: number): this {
    const c = dcos(angle)
    const s = dsin(angle)
    return this.set(this.x * c - this.y * s, this.x * s + this.y * c)
  }

  dot(v: Vector2): number {
    return this.x * v.x + this.y * v.y
  }

  length(): number {
    return dlength(this.x, this.y)
  }

  normalize(): Vector2 {
    const len = this.length()
    return len === 0 ? new Vector2() : new Vector2(this.x / len, this.y / len)
  }

  rotate(angle: number): Vector2 {
    const c = dcos(angle)
    const s = dsin(angle)
    return new Vector2(this.x * c - this.y * s, this.x * s + this.y * c)
  }

  angle(): number {
    return datan2(this.y, this.x)
  }
}
