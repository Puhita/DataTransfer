import { getSodium } from './sodium'

/** Long-term identity of a user. Private halves never leave the browser unwrapped. */
export interface Identity {
  encPublic: Uint8Array
  encPrivate: Uint8Array
  signPublic: Uint8Array
  signPrivate: Uint8Array
}

export interface KdfParams {
  salt: string // base64
  opslimit: number
  memlimit: number
}

/** What we upload to the server: public keys plus two wrapped copies of the private keys. */
export interface KeyBundle {
  encPublic: string
  signPublic: string
  kdf: KdfParams
  wrappedByPassphrase: string
  wrappedByRecovery: string
}

export const DEFAULT_OPSLIMIT = 3
export const DEFAULT_MEMLIMIT = 128 * 1024 * 1024

const b64 = async (u: Uint8Array) => {
  const s = await getSodium()
  return s.to_base64(u, s.base64_variants.ORIGINAL)
}
const unb64 = async (t: string) => {
  const s = await getSodium()
  return s.from_base64(t, s.base64_variants.ORIGINAL)
}
export const toB64 = b64
export const fromB64 = unb64

async function aeadSeal(key: Uint8Array, plain: Uint8Array, ad: string): Promise<string> {
  const s = await getSodium()
  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(plain, ad, null, nonce, key)
  const out = new Uint8Array(nonce.length + ct.length)
  out.set(nonce)
  out.set(ct, nonce.length)
  return b64(out)
}

async function aeadOpen(key: Uint8Array, blob: string, ad: string): Promise<Uint8Array> {
  const s = await getSodium()
  const raw = await unb64(blob)
  const n = s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
  return s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, raw.slice(n), ad, raw.slice(0, n), key)
}

export async function generateIdentity(): Promise<Identity> {
  const s = await getSodium()
  const enc = s.crypto_box_keypair()
  const sig = s.crypto_sign_keypair()
  return {
    encPublic: enc.publicKey,
    encPrivate: enc.privateKey,
    signPublic: sig.publicKey,
    signPrivate: sig.privateKey,
  }
}

export async function deriveKeyFromPassphrase(passphrase: string, p: KdfParams): Promise<Uint8Array> {
  const s = await getSodium()
  return s.crypto_pwhash(
    s.crypto_secretbox_KEYBYTES,
    passphrase,
    await unb64(p.salt),
    p.opslimit,
    p.memlimit,
    s.crypto_pwhash_ALG_ARGON2ID13,
  )
}

export async function newKdfParams(opslimit = DEFAULT_OPSLIMIT, memlimit = DEFAULT_MEMLIMIT): Promise<KdfParams> {
  const s = await getSodium()
  return { salt: await b64(s.randombytes_buf(s.crypto_pwhash_SALTBYTES)), opslimit, memlimit }
}

const PRIV_AD = 'dt:identity:v1'

async function packPrivate(id: Identity): Promise<Uint8Array> {
  const s = await getSodium()
  return s.from_string(JSON.stringify({ e: await b64(id.encPrivate), s: await b64(id.signPrivate) }))
}

async function unpackPrivate(raw: Uint8Array, pub: { encPublic: Uint8Array; signPublic: Uint8Array }): Promise<Identity> {
  const s = await getSodium()
  const j = JSON.parse(s.to_string(raw)) as { e: string; s: string }
  return {
    encPublic: pub.encPublic,
    signPublic: pub.signPublic,
    encPrivate: await unb64(j.e),
    signPrivate: await unb64(j.s),
  }
}

/** Create a fresh identity and everything the server needs to store. Returns the one-time recovery key. */
export async function createKeyBundle(
  passphrase: string,
  kdfOverride?: { opslimit: number; memlimit: number },
): Promise<{ identity: Identity; bundle: KeyBundle; recoveryKey: string }> {
  const s = await getSodium()
  const identity = await generateIdentity()
  const kdf = await newKdfParams(kdfOverride?.opslimit, kdfOverride?.memlimit)
  const passKey = await deriveKeyFromPassphrase(passphrase, kdf)
  const recoveryRaw = s.randombytes_buf(32)
  const packed = await packPrivate(identity)
  const bundle: KeyBundle = {
    encPublic: await b64(identity.encPublic),
    signPublic: await b64(identity.signPublic),
    kdf,
    wrappedByPassphrase: await aeadSeal(passKey, packed, PRIV_AD),
    wrappedByRecovery: await aeadSeal(recoveryRaw, packed, PRIV_AD),
  }
  return { identity, bundle, recoveryKey: formatRecoveryKey(await b64(recoveryRaw)) }
}

export interface StoredKeys {
  encPublic: string
  signPublic: string
  kdf: KdfParams
  wrappedByPassphrase: string
  wrappedByRecovery: string
}

async function openWith(key: Uint8Array, blob: string, stored: StoredKeys): Promise<Identity> {
  const raw = await aeadOpen(key, blob, PRIV_AD)
  return unpackPrivate(raw, { encPublic: await unb64(stored.encPublic), signPublic: await unb64(stored.signPublic) })
}

/** Throws if the passphrase is wrong. */
export async function unlockWithPassphrase(passphrase: string, stored: StoredKeys): Promise<Identity> {
  const key = await deriveKeyFromPassphrase(passphrase, stored.kdf)
  return openWith(key, stored.wrappedByPassphrase, stored)
}

export async function unlockWithRecoveryKey(recoveryKey: string, stored: StoredKeys): Promise<Identity> {
  const key = await unb64(parseRecoveryKey(recoveryKey))
  return openWith(key, stored.wrappedByRecovery, stored)
}

/** Re-wrap the private keys under a new passphrase (fresh salt). Recovery wrap is unchanged. */
export async function rewrapWithPassphrase(
  identity: Identity,
  newPassphrase: string,
  kdfOverride?: { opslimit: number; memlimit: number },
): Promise<{ kdf: KdfParams; wrappedByPassphrase: string }> {
  const kdf = await newKdfParams(kdfOverride?.opslimit, kdfOverride?.memlimit)
  const key = await deriveKeyFromPassphrase(newPassphrase, kdf)
  return { kdf, wrappedByPassphrase: await aeadSeal(key, await packPrivate(identity), PRIV_AD) }
}

export function formatRecoveryKey(base64: string): string {
  return base64.replace(/=+$/, '').replace(/(.{6})/g, '$1-').replace(/-$/, '')
}

export function parseRecoveryKey(text: string): string {
  const clean = text.replace(/[\s-]/g, '')
  return clean + '='.repeat((4 - (clean.length % 4)) % 4)
}
