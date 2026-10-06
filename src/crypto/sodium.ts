import _sodium from 'libsodium-wrappers-sumo'

export type Sodium = typeof _sodium

let ready: Promise<Sodium> | null = null

/** Resolves once libsodium's wasm is initialised. */
export function getSodium(): Promise<Sodium> {
  if (!ready) ready = _sodium.ready.then(() => _sodium)
  return ready
}
