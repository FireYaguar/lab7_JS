import { asSeq } from 'shared/brand.ts'
import type { InputMessage, ShipState, Snapshot } from 'shared/net/protocol.ts'
import { datan2 } from 'shared/sim/dmath.ts'
import type { Player } from './types.ts'

// Бот = звичайний Player без сокета. Він бачить лише знімки (як клієнт) і відповідає на кожен
// знімок InputMessage із наступним seq — далі той самий шлях, що й у людини: Match.pushInput,
// черга, кредити, applyInput. Жодних «чітів» через прямий доступ до World.

const TAU = Math.PI * 2

export function botInput(snap: Snapshot, shipId: Player['shipId'], seq: number): InputMessage {
  const me = snap.entities.find((e): e is ShipState => e.kind === 'ship' && e.id === shipId)
  const idle: InputMessage = {
    v: 1,
    type: 'input',
    seq: asSeq(seq),
    thrust: false,
    turn: 0,
    fire: false,
  }
  if (!me || me.respawnIn > 0) return idle
  let best: { x: number; y: number } | null = null
  let bestD = Infinity
  for (const e of snap.entities) {
    if (e.id === me.id || (e.kind !== 'ship' && e.kind !== 'asteroid')) continue
    const d = (e.x - me.x) ** 2 + (e.y - me.y) ** 2
    if (d < bestD) {
      bestD = d
      best = e
    }
  }
  if (!best) return { ...idle, thrust: true, turn: 1 }
  let diff = (datan2(best.y - me.y, best.x - me.x) - me.angle) % TAU
  if (diff > Math.PI) diff -= TAU
  if (diff < -Math.PI) diff += TAU
  const turn = diff > 0.08 ? 1 : diff < -0.08 ? -1 : 0
  return { ...idle, turn, thrust: bestD > 250 ** 2, fire: Math.abs(diff) < 0.3 }
}

export function createBot(id: string, name: string, push: (input: InputMessage) => void): Player {
  let seq = 0
  const bot: Player = {
    id,
    name,
    shipId: null,
    send: () => {},
    sendRaw: () => {},
    sendSnapshot: (snap) => push(botInput(snap, bot.shipId, ++seq)),
  }
  return bot
}
