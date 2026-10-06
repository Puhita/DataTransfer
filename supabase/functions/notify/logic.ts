// Pure helpers for the notify Edge Function (kept separate so they can be unit tested).

export interface ServiceAccount {
  client_email: string
  private_key: string
  project_id: string
}

const enc = new TextEncoder()

const b64url = (data: Uint8Array | string): string => {
  const bytes = typeof data === 'string' ? enc.encode(data) : data
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const pemToDer = (pem: string): ArrayBuffer => {
  const body = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')
  const bin = atob(body)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

/** Signed RS256 JWT that Google accepts in exchange for an OAuth access token. */
export async function signServiceAccountJwt(sa: ServiceAccount, nowSec: number): Promise<string> {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  )
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${header}.${claims}`)))
  return `${header}.${claims}.${b64url(sig)}`
}

export type RoomKind = 'chat' | 'secrets'

/** What the notification shows. Deliberately contains no message content, only who and what kind. */
export function buildFcmMessage(token: string, senderUsername: string, kind: RoomKind, chatId: string) {
  return {
    message: {
      token,
      notification: {
        title: `@${senderUsername}`,
        body: kind === 'secrets' ? 'Shared a new secret' : 'New message',
      },
      data: { chatId, kind },
      android: {
        priority: 'HIGH',
        notification: { channel_id: 'messages', tag: `chat-${chatId}` },
      },
    },
  }
}

/** FCM answers 404 UNREGISTERED / 400 INVALID_ARGUMENT for dead tokens, which we should delete. */
export const isDeadToken = (status: number, body: string): boolean =>
  status === 404 || (status === 400 && body.includes('INVALID_ARGUMENT')) || body.includes('UNREGISTERED')

/** Constant-time comparison for the shared webhook secret. */
export function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}
