// Типи для page.evaluate: глобали, які додає клієнт (client/src/globals.d.ts) і e2e/profile.ts
import type { NetGame } from '../client/src/net/netgame.ts'

declare global {
  interface FrameRecorder {
    interval: number[]
    work: number[]
    on: boolean
  }
  interface Window {
    __frames: FrameRecorder
    __net?: NetGame
  }
}
