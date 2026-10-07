// Supabase Edge Function (Deno). Triggered by a Database Webhook on INSERT into public.messages.
// Sends a push to the OTHER member(s) of the room. The push never contains message text.
//
// Secrets (supabase secrets set ...): WEBHOOK_SECRET, FIREBASE_SERVICE_ACCOUNT (the service-account JSON).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
// Deploy with --no-verify-jwt: the webhook authenticates with the x-webhook-secret header instead.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { buildFcmMessage, isDeadToken, secretsMatch, signServiceAccountJwt, type RoomKind, type ServiceAccount } from './logic.ts'

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

async function accessToken(sa: ServiceAccount): Promise<string> {
  const jwt = await signServiceAccountJwt(sa, Math.floor(Date.now() / 1000))
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  })
  if (!res.ok) throw new Error(`google token exchange failed: ${res.status}`)
  return (await res.json()).access_token as string
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('WEBHOOK_SECRET') ?? ''
  if (!secretsMatch(req.headers.get('x-webhook-secret') ?? '', secret)) return new Response('forbidden', { status: 403 })

  const payload = await req.json().catch(() => null)
  const row = payload?.type === 'INSERT' ? payload.record : null
  if (!row?.room_id || !row?.sender_id) return new Response('ignored', { status: 200 })

  const { data: room } = await db.from('rooms').select('kind, chat_id, project_id').eq('id', row.room_id).single()
  const { data: sender } = await db.from('profiles').select('username').eq('id', row.sender_id).single()
  const { data: members } = await db.from('room_members').select('user_id').eq('room_id', row.room_id).neq('user_id', row.sender_id)
  if (!room || !sender || !members?.length) return new Response('no recipients', { status: 200 })

  const { data: tokens } = await db.from('push_tokens').select('token').in('user_id', members.map((m) => m.user_id))
  if (!tokens?.length) return new Response('no devices', { status: 200 })

  const sa = JSON.parse(Deno.env.get('FIREBASE_SERVICE_ACCOUNT')!) as ServiceAccount
  const bearer = await accessToken(sa)
  const url = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`

  let sent = 0
  await Promise.all(
    tokens.map(async ({ token }) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(buildFcmMessage(token, sender.username, room.kind as RoomKind, room.chat_id ?? room.project_id)),
      })
      if (res.ok) return void sent++
      if (isDeadToken(res.status, await res.text())) await db.from('push_tokens').delete().eq('token', token)
    }),
  )
  return new Response(JSON.stringify({ sent }), { headers: { 'Content-Type': 'application/json' } })
})
