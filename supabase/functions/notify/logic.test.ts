import { describe, expect, it } from 'vitest'
import { buildFcmMessage, isDeadToken, secretsMatch, signServiceAccountJwt } from './logic.ts'

const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

describe('service account JWT', () => {
  it('is a valid RS256 JWT with the FCM scope', async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )
    const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----\n`
    const jwt = await signServiceAccountJwt({ client_email: 'bot@proj.iam.gserviceaccount.com', private_key: pem, project_id: 'proj' }, 1_000_000)

    const [h, c, s] = jwt.split('.')
    expect(JSON.parse(new TextDecoder().decode(fromB64url(h)))).toEqual({ alg: 'RS256', typ: 'JWT' })
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(c)))
    expect(claims).toMatchObject({
      iss: 'bot@proj.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_000_000,
      exp: 1_003_600,
    })
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pair.publicKey, fromB64url(s), new TextEncoder().encode(`${h}.${c}`))
    expect(ok).toBe(true)
  })
})

describe('notification payload', () => {
  it('says who and what kind, never content', () => {
    const chat = buildFcmMessage('tok', 'dev_tomas', 'chat', 'chat-1').message
    expect(chat.notification).toEqual({ title: '@dev_tomas', body: 'New message' })
    expect(chat.data).toEqual({ chatId: 'chat-1', kind: 'chat' })
    const sec = buildFcmMessage('tok', 'dev_tomas', 'secrets', 'chat-1').message
    expect(sec.notification.body).toBe('Shared a new secret')
    expect(JSON.stringify(sec)).not.toMatch(/ciphertext|nonce|signature/)
  })
})

describe('helpers', () => {
  it('detects dead tokens', () => {
    expect(isDeadToken(404, '{}')).toBe(true)
    expect(isDeadToken(400, '{"status":"INVALID_ARGUMENT"}')).toBe(true)
    expect(isDeadToken(200, '')).toBe(false)
    expect(isDeadToken(500, 'internal')).toBe(false)
  })
  it('compares secrets strictly and rejects empty', () => {
    expect(secretsMatch('abc123', 'abc123')).toBe(true)
    expect(secretsMatch('abc123', 'abc124')).toBe(false)
    expect(secretsMatch('abc', 'abcd')).toBe(false)
    expect(secretsMatch('', '')).toBe(false)
  })
})
