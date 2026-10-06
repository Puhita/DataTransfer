import { getSodium } from './sodium'
import { fromB64, toB64, type Identity } from './keys'

export interface Envelope {
  ciphertext: string
  nonce: string
  signature: string
  keyVersion: number
}

export interface MessageContext {
  roomId: string
  senderId: string
  keyVersion: number
}

const adFor = (c: MessageContext) => `dt:msg:v1|${c.roomId}|${c.senderId}|${c.keyVersion}`

export async function newRoomKey(): Promise<Uint8Array> {
  const s = await getSodium()
  return s.crypto_aead_xchacha20poly1305_ietf_keygen()
}

/** Wrap a room key for one member so only their private key can open it. */
export async function wrapRoomKey(roomKey: Uint8Array, recipientEncPublic: string): Promise<string> {
  const s = await getSodium()
  return toB64(s.crypto_box_seal(roomKey, await fromB64(recipientEncPublic)))
}

export async function unwrapRoomKey(wrapped: string, me: Identity): Promise<Uint8Array> {
  const s = await getSodium()
  return s.crypto_box_seal_open(await fromB64(wrapped), me.encPublic, me.encPrivate)
}

/** Encrypt and sign. The signature covers ciphertext plus context so rows cannot be moved between rooms/senders. */
export async function encryptMessage(
  plaintext: string,
  roomKey: Uint8Array,
  ctx: MessageContext,
  me: Identity,
): Promise<Envelope> {
  const s = await getSodium()
  const ad = adFor(ctx)
  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, ad, null, nonce, roomKey)
  const signed = new Uint8Array([...s.from_string(ad), ...nonce, ...ct])
  const sig = s.crypto_sign_detached(signed, me.signPrivate)
  return {
    ciphertext: await toB64(ct),
    nonce: await toB64(nonce),
    signature: await toB64(sig),
    keyVersion: ctx.keyVersion,
  }
}

export class DecryptError extends Error {}

/** Verifies the sender's signature, then decrypts. Throws DecryptError on any failure. */
export async function decryptMessage(
  env: Pick<Envelope, 'ciphertext' | 'nonce' | 'signature'>,
  roomKey: Uint8Array,
  ctx: MessageContext,
  senderSignPublic: string,
): Promise<string> {
  const s = await getSodium()
  try {
    const ad = adFor(ctx)
    const nonce = await fromB64(env.nonce)
    const ct = await fromB64(env.ciphertext)
    const signed = new Uint8Array([...s.from_string(ad), ...nonce, ...ct])
    const ok = s.crypto_sign_verify_detached(await fromB64(env.signature), signed, await fromB64(senderSignPublic))
    if (!ok) throw new DecryptError('bad signature')
    return s.to_string(s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, ad, nonce, roomKey))
  } catch (e) {
    throw e instanceof DecryptError ? e : new DecryptError('cannot decrypt')
  }
}
