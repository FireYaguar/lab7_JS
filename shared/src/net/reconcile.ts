import type { Seq } from '../brand.ts'
import type { Arena } from '../sim/arena.ts'
import type { Ship, ShipSync } from '../sim/ship.ts'
import type { Command } from '../sim/types.ts'
import { stepShip } from '../sim/world.ts'
import { STEP, SUBSTEPS } from './constants.ts'

// Звірка (Lab 5) як чиста функція — без мережі й DOM, тому її легко тестувати:
// 1) поставити корабель у стан сервера (після input #ack); 2) викинути підтверджені input;
// 3) переграти решту тим самим stepShip. Повертає непідтверджені input.
export function reconcile<C extends Command & { readonly seq: Seq }>(
  ship: Ship,
  server: ShipSync,
  ack: Seq,
  pending: readonly C[],
  arena: Arena,
  replay: (cmd: C) => void = (cmd) => {
    for (let s = 0; s < SUBSTEPS; s++) stepShip(ship, cmd, STEP, arena)
  },
): C[] {
  ship.syncFrom(server)
  const rest = pending.filter((cmd) => cmd.seq > ack)
  for (const cmd of rest) replay(cmd)
  return rest
}
