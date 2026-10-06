import { getSodium } from './sodium'
import { fromB64 } from './keys'

export interface PublicKeys {
  encPublic: string
  signPublic: string
}

/** 30-digit safety number, identical on both sides regardless of who computes it. */
export async function safetyNumber(a: PublicKeys, b: PublicKeys): Promise<string> {
  const s = await getSodium()
  const parts = await Promise.all(
    [a, b].map(async (k) => {
      const raw = new Uint8Array([...(await fromB64(k.encPublic)), ...(await fromB64(k.signPublic))])
      return s.to_hex(s.crypto_generichash(32, raw, null))
    }),
  )
  parts.sort()
  const digest = s.crypto_generichash(30, s.from_string(parts.join(":")), null)
  const groups: string[] = []
  for (let i = 0; i < 30; i += 5) {
    let n = 0n
    for (let j = 0; j < 5; j++) n = (n << 8n) | BigInt(digest[i + j])
    groups.push((n % 100000n).toString().padStart(5, '0'))
  }
  // 6 groups of 5 digits = 30 digits
  return groups.join(' ')
}

/** Short stable fingerprint of one user's public keys, used to detect key changes. */
export async function keyFingerprint(k: PublicKeys): Promise<string> {
  const s = await getSodium()
  const raw = new Uint8Array([...(await fromB64(k.encPublic)), ...(await fromB64(k.signPublic))])
  return s.to_hex(s.crypto_generichash(16, raw, null))
}
