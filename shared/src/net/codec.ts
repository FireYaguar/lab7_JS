import type { Seq } from '../brand.ts'
import { encodeInput, encodeSnapshot, withAck } from './binary.ts'
import type { InputMessage, Snapshot } from './protocol.ts'

// Один інтерфейс, дві реалізації: бінарний (за замовчуванням) і JSON (текстові кадри, ?codec=json).
// Декодування не тут: бінарні кадри розбирає decodeInput/decodeSnapshot, JSON — схеми Zod.
export interface Codec {
  readonly name: CodecName
  encodeInput(input: InputMessage): ArrayBuffer | string
  encodeSnapshot(snapshot: Snapshot): ArrayBuffer | string
}
export type CodecName = 'binary' | 'json'

export const codecs: Record<CodecName, Codec> = {
  binary: { name: 'binary', encodeInput, encodeSnapshot },
  json: {
    name: 'json',
    encodeInput: (input) => JSON.stringify(input),
    encodeSnapshot: (snapshot) => JSON.stringify(snapshot),
  },
}

// Lab 7: «закодуй один раз — розішли всім». Кеш на останній базовий знімок (тік кімнати):
// перший клієнт тіку платить encodeSnapshot, решта — лише копію буфера з іншим ack.
export class SnapshotEncoder {
  #base: Snapshot | null = null
  #encoded: ArrayBuffer | null = null
  encodes = 0

  encode(codec: Codec, base: Snapshot, ack: Seq): ArrayBuffer | string {
    if (codec.name === 'json') return codec.encodeSnapshot({ ...base, ack }) // налагоджувальний кодек
    if (base !== this.#base || !this.#encoded) {
      this.#base = base
      this.#encoded = encodeSnapshot(base)
      this.encodes++
    }
    return withAck(this.#encoded, ack)
  }
}
