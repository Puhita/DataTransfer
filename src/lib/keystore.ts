import type { Identity } from '../crypto'

/** Decrypted key material lives here, in memory only. Reloading the page clears it. */
let identity: Identity | null = null
const roomKeys = new Map<string, Uint8Array>()
const k = (roomId: string, version: number) => `${roomId}:${version}`

export const keystore = {
  get identity() {
    return identity
  },
  set identity(v: Identity | null) {
    identity = v
  },
  roomKey: (roomId: string, version: number) => roomKeys.get(k(roomId, version)),
  setRoomKey: (roomId: string, version: number, key: Uint8Array) => void roomKeys.set(k(roomId, version), key),
  clear() {
    identity = null
    roomKeys.clear()
  },
}
