// Пул об'єктів (Lab 7): кулі й частинки народжуються і вмирають десятками за секунду —
// замість new + GC беремо готовий об'єкт із вільного списку і повертаємо його туди після смерті.
export class Pool<T> {
  readonly #free: T[] = []
  created = 0 // скільки об'єктів пул створив за весь час (для тестів і звіту)

  readonly make: () => T
  readonly max: number

  constructor(make: () => T, max = 4096) {
    this.make = make
    this.max = max
  }

  acquire(): T {
    const x = this.#free.pop()
    if (x !== undefined) return x
    this.created++
    return this.make()
  }

  release(x: T): void {
    if (this.#free.length < this.max) this.#free.push(x)
  }

  get free(): number {
    return this.#free.length
  }
}
