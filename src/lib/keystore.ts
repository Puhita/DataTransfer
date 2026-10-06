import type { Identity } from '../crypto'

/** Decrypted key material lives here, in memory only. Reloading the page clears it. */
let identity: Identity | null = null
const roomKeys = new Map<string, Uint8Array>()

export const keystore = {
  get identity() {
    return identity
  },
  set identity(v: Identity | null) {
    identity = v
  },
  roomKey: (roomId: string) => roomKeys.get(roomId),
  setRoomKey: (roomId: string, k: Uint8Array) => void roomKeys.set(roomId, k),
  clear() {
    identity = null
    roomKeys.clear()
  },
}
