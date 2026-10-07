import { describe, expect, it } from 'vitest'
import {
  createKeyBundle,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
  rewrapWithPassphrase,
  generateIdentity,
  newRoomKey,
  wrapRoomKey,
  unwrapRoomKey,
  encryptMessage,
  decryptMessage,
  safetyNumber,
  toB64,
  type StoredKeys,
} from './index'

const FAST = { opslimit: 2, memlimit: 8 * 1024 * 1024 }

describe('key bundle', () => {
  it('unlocks with passphrase and recovery key, rejects wrong passphrase', async () => {
    const { identity, bundle, recoveryKey } = await createKeyBundle('correct horse', FAST)
    const stored: StoredKeys = bundle
    const a = await unlockWithPassphrase('correct horse', stored)
    expect(await toB64(a.encPrivate)).toBe(await toB64(identity.encPrivate))
    const b = await unlockWithRecoveryKey(recoveryKey, stored)
    expect(await toB64(b.signPrivate)).toBe(await toB64(identity.signPrivate))
    await expect(unlockWithPassphrase('wrong', stored)).rejects.toThrow()
  })

  it('never contains private keys in the uploaded bundle in the clear', async () => {
    const { identity, bundle } = await createKeyBundle('pw-pw-pw-pw', FAST)
    const blob = JSON.stringify(bundle)
    expect(blob.includes(await toB64(identity.encPrivate))).toBe(false)
    expect(blob.includes(await toB64(identity.signPrivate))).toBe(false)
  })

  it('rewraps under a new passphrase', async () => {
    const { identity, bundle } = await createKeyBundle('old-passphrase', FAST)
    const rw = await rewrapWithPassphrase(identity, 'new-passphrase', FAST)
    const stored: StoredKeys = { ...bundle, ...rw }
    await unlockWithPassphrase('new-passphrase', stored)
    await expect(unlockWithPassphrase('old-passphrase', stored)).rejects.toThrow()
  })
})

describe('messages', () => {
  it('round-trips between two users', async () => {
    const alice = await generateIdentity()
    const bob = await generateIdentity()
    const key = await newRoomKey()
    const forBob = await wrapRoomKey(key, await toB64(bob.encPublic))
    const bobKey = await unwrapRoomKey(forBob, bob)
    const ctx = { roomId: 'r1', senderId: 'alice', keyVersion: 1 }
    const env = await encryptMessage('API_KEY=sk-123', key, ctx, alice)
    expect(env.ciphertext).not.toContain('sk-123')
    const out = await decryptMessage(env, bobKey, ctx, await toB64(alice.signPublic))
    expect(out).toBe('API_KEY=sk-123')
  })

  it('rejects a third party, tampering, wrong room, wrong sender, forged signature', async () => {
    const alice = await generateIdentity()
    const mallory = await generateIdentity()
    const key = await newRoomKey()
    const ctx = { roomId: 'r1', senderId: 'alice', keyVersion: 1 }
    const env = await encryptMessage('secret', key, ctx, alice)
    const alicePub = await toB64(alice.signPublic)

    await expect(unwrapRoomKey(await wrapRoomKey(key, await toB64(alice.encPublic)), mallory)).rejects.toThrow()
    await expect(decryptMessage(env, await newRoomKey(), ctx, alicePub)).rejects.toThrow()
    await expect(decryptMessage({ ...env, ciphertext: env.ciphertext.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')) }, key, ctx, alicePub)).rejects.toThrow()
    await expect(decryptMessage(env, key, { ...ctx, roomId: 'r2' }, alicePub)).rejects.toThrow()
    await expect(decryptMessage(env, key, { ...ctx, senderId: 'mallory' }, alicePub)).rejects.toThrow()
    await expect(decryptMessage(env, key, ctx, await toB64(mallory.signPublic))).rejects.toThrow()
  })

  it('uses a fresh nonce each time', async () => {
    const a = await generateIdentity()
    const key = await newRoomKey()
    const ctx = { roomId: 'r', senderId: 'a', keyVersion: 1 }
    const e1 = await encryptMessage('same', key, ctx, a)
    const e2 = await encryptMessage('same', key, ctx, a)
    expect(e1.nonce).not.toBe(e2.nonce)
    expect(e1.ciphertext).not.toBe(e2.ciphertext)
  })
})

describe('safety number', () => {
  it('is symmetric and changes when a key changes', async () => {
    const a = await generateIdentity()
    const b = await generateIdentity()
    const c = await generateIdentity()
    const pk = async (i: typeof a) => ({ encPublic: await toB64(i.encPublic), signPublic: await toB64(i.signPublic) })
    const ab = await safetyNumber(await pk(a), await pk(b))
    expect(ab).toBe(await safetyNumber(await pk(b), await pk(a)))
    expect(ab).not.toBe(await safetyNumber(await pk(a), await pk(c)))
    expect(ab).toMatch(/^(\d{5} ){5}\d{5}$/)
  })
})

describe('project key sharing and rotation', () => {
  it('shares old keys with a new member, and a rotated key excludes a removed member', async () => {
    const [owner, bob, carol] = await Promise.all([generateIdentity(), generateIdentity(), generateIdentity()])
    const ctx = (v: number) => ({ roomId: 'room-1', senderId: 'owner', keyVersion: v })

    // v1 is wrapped for the owner and bob; a message is sent
    const k1 = await newRoomKey()
    const m1 = await encryptMessage('before carol', k1, ctx(1), owner)

    // owner adds carol: re-wraps v1 for her, so she reads history
    const carolV1 = await unwrapRoomKey(await wrapRoomKey(k1, await toB64(carol.encPublic)), carol)
    expect(await decryptMessage(m1, carolV1, ctx(1), await toB64(owner.signPublic))).toBe('before carol')

    // owner removes carol: v2 is wrapped for owner and bob only
    const k2 = await newRoomKey()
    const bobV2 = await unwrapRoomKey(await wrapRoomKey(k2, await toB64(bob.encPublic)), bob)
    const m2 = await encryptMessage('after carol', k2, ctx(2), owner)
    expect(await decryptMessage(m2, bobV2, ctx(2), await toB64(owner.signPublic))).toBe('after carol')
    // carol only has v1, which cannot open v2 messages
    await expect(decryptMessage(m2, carolV1, ctx(2), await toB64(owner.signPublic))).rejects.toThrow()
    // and she cannot unwrap a key that was wrapped for someone else
    await expect(unwrapRoomKey(await wrapRoomKey(k2, await toB64(bob.encPublic)), carol)).rejects.toThrow()
  })
})
