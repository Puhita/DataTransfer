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
export function buildFcmMessage(token: string, senderUsername: string, kind: RoomKind, chatId: string, projectName?: string) {
  return {
    message: {
      token,
      notification: {
        title: projectName ? `@${senderUsername} · ${projectName}` : `@${senderUsername}`,
        body: kind === 'secrets' ? 'Added a new secret' : 'New message',
      },
      data: { chatId, kind },
      android: {
        priority: 'HIGH',
        notification: { channel_id: 'messages', tag: `chat-${chatId}` },
      },
    },
  }
}

/** Only delete a token when FCM says THIS token is dead. A bare 404 or 400 also happens when the service account
 *  belongs to a different Firebase project than the app, and deleting tokens then silently breaks every device. */
export const isDeadToken = (_status: number, body: string): boolean =>
  body.includes('UNREGISTERED') || body.includes('is not a valid FCM registration token')

/** Short, secret-free reason for the logs: FCM error status/message, e.g. "SENDER_ID_MISMATCH". */
export function fcmFailure(status: number, body: string): string {
  try {
    const e = JSON.parse(body).error
    const code = e?.details?.find((d: { errorCode?: string }) => d.errorCode)?.errorCode
    return `${status} ${code ?? e?.status ?? ''} ${e?.message ?? ''}`.trim()
  } catch {
    return `${status} ${body.slice(0, 120)}`
  }
}

/** Constant-time comparison for the shared webhook secret. */
export function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}
