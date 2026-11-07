// Lab 7, експеримент: розбір бінарного знімка поза головним потоком.
// Головний потік передає ArrayBuffer (transfer, без копії), отримує назад готовий об'єкт (structured clone).
import { decodeSnapshot } from 'shared/net/binary.ts'
import type { Snapshot } from 'shared/net/protocol.ts'

export type DecodeResult = { ok: true; snap: Snapshot } | { ok: false; error: string }

addEventListener('message', (e: MessageEvent<unknown>) => {
  let result: DecodeResult
  try {
    result = { ok: true, snap: decodeSnapshot(e.data) }
  } catch (err) {
    result = { ok: false, error: String(err) }
  }
  postMessage(result)
})
