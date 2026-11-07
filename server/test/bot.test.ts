import { asEntityId, asSeq, asTick } from 'shared/brand.ts'
import { InputMessage, type ShipState, type Snapshot } from 'shared/net/protocol.ts'
import { describe, expect, it } from 'vitest'
import { botInput } from '../src/bot.ts'

const ship = (id: number, x: number, y: number, angle = 0): ShipState => ({
  id: asEntityId(id),
  kind: 'ship',
  x,
  y,
  angle,
  vx: 0,
  vy: 0,
  hp: 100,
  solid: true,
  thrust: false,
  cooldown: 0,
  shield: 0,
  rapid: 0,
  homingShots: 0,
  respawnIn: 0,
  score: 0,
})
const snap = (...entities: ShipState[]): Snapshot => ({
  type: 'snapshot',
  tick: asTick(1),
  ack: asSeq(0),
  entities,
})

describe('бот шле той самий input, що й людина', () => {
  it('результат проходить ту саму Zod-схему InputMessage, що й повідомлення клієнта', () => {
    const input = botInput(snap(ship(1, 0, 0), ship(2, 500, 0)), asEntityId(1), 7)
    expect(InputMessage.safeParse(input).success).toBe(true)
    expect(input.seq).toBe(7)
  })

  it('повертає до цілі, стріляє, коли ціль попереду; далеку ціль доганяє газом', () => {
    const ahead = botInput(snap(ship(1, 0, 0, 0), ship(2, 500, 0)), asEntityId(1), 1)
    expect(ahead).toMatchObject({ turn: 0, fire: true, thrust: true })
    const below = botInput(snap(ship(1, 0, 0, 0), ship(2, 0, 100)), asEntityId(1), 2)
    expect(below).toMatchObject({ turn: 1, fire: false, thrust: false })
  })
})
