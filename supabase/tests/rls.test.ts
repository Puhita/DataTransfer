import { readFileSync } from 'node:fs'
import { describe, expect, it, beforeAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { citext } from '@electric-sql/pglite/contrib/citext'

// Minimal stand-in for Supabase's auth schema so the real migration can be executed.
const STUB = `
create role anon nologin; create role authenticated nologin;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.sub', true), '')::uuid $$;
create publication supabase_realtime;
grant usage on schema public, auth to anon, authenticated;
-- Supabase grants everything on new public tables/functions to these roles by default
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
`

const A = '00000000-0000-0000-0000-00000000000a'
const B = '00000000-0000-0000-0000-00000000000b'
const C = '00000000-0000-0000-0000-00000000000c'

let db: PGlite

async function as<T>(uid: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role authenticated; select set_config('request.jwt.sub', '${uid ?? ''}', false)`)
  try {
    return await fn()
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.sub', '', false)`)
  }
}

const profile = (id: string, name: string, byEmail = true) =>
  db.query(
    `insert into profiles (id, username, discoverable_by_email, enc_public_key, sign_public_key, kdf_salt, kdf_opslimit, kdf_memlimit, wrapped_keys_passphrase, wrapped_keys_recovery)
     values ($1,$2,$3,'e','s','salt',2,8388608,'w1','w2')`,
    [id, name, byEmail],
  )

beforeAll(async () => {
  db = new PGlite({ extensions: { citext } })
  await db.exec(STUB)
  await db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'))
  await db.exec(readFileSync(new URL('../migrations/0002_push.sql', import.meta.url), 'utf8'))
  await db.exec(readFileSync(new URL('../migrations/0003_projects.sql', import.meta.url), 'utf8'))
  await db.exec(readFileSync(new URL('../migrations/0004_delete_secrets.sql', import.meta.url), 'utf8'))
  await db.exec(`insert into auth.users values ('${A}','alice@x.io'),('${B}','bob@x.io'),('${C}','carol@x.io')`)
  await as(A, () => profile(A, 'alice'))
  await as(B, () => profile(B, 'bob'))
  await as(C, () => profile(C, 'carol', false))
})

describe('discovery', () => {
  it('finds by username prefix and exact email, never by partial email', async () => {
    const short = await as(A, () => db.query(`select * from find_users('bo')`))
    expect(short.rows).toHaveLength(0)
    const r1 = await as(A, () => db.query<{ username: string }>(`select * from find_users('bob')`))
    expect(r1.rows.map((r) => r.username)).toEqual(['bob'])
    const r2 = await as(A, () => db.query<{ username: string }>(`select * from find_users('bob@x.io')`))
    expect(r2.rows.map((r) => r.username)).toEqual(['bob'])
    const r3 = await as(A, () => db.query(`select * from find_users('bob@x')`))
    expect(r3.rows).toHaveLength(0)
  })
  it('respects discoverable_by_email=false but still allows username', async () => {
    const r = await as(A, () => db.query(`select * from find_users('carol@x.io')`))
    expect(r.rows).toHaveLength(0)
    const r2 = await as(A, () => db.query(`select * from find_users('carol')`))
    expect(r2.rows).toHaveLength(1)
  })
  it('treats % and _ literally', async () => {
    const r = await as(A, () => db.query(`select * from find_users('%%%')`))
    expect(r.rows).toHaveLength(0)
  })
  it('hides non-contacts profiles from direct select', async () => {
    const r = await as(A, () => db.query(`select id from profiles`))
    expect(r.rows.map((x: any) => x.id)).toEqual([A])
  })
})

describe('chat lifecycle + message access', () => {
  let chat: string
  let chatRoom: string
  let secretsRoom: string

  it('creates a pending chat with two rooms; peer can then read profile', async () => {
    const r = await as(A, () => db.query<{ create_chat: string }>(`select create_chat('${B}','a1','b1','a2','b2')`))
    chat = r.rows[0].create_chat
    const rooms = await as(A, () => db.query<{ id: string; kind: string }>(`select id, kind from rooms where chat_id='${chat}'`))
    chatRoom = rooms.rows.find((x) => x.kind === 'chat')!.id
    secretsRoom = rooms.rows.find((x) => x.kind === 'secrets')!.id
    expect(rooms.rows).toHaveLength(2)
    const peer = await as(B, () => db.query(`select id from profiles where id='${A}'`))
    expect(peer.rows).toHaveLength(1)
  })

  it('blocks duplicate chats and self chats', async () => {
    await expect(as(B, () => db.query(`select create_chat('${A}','x','x','x','x')`))).rejects.toThrow(/already exists/)
    await expect(as(A, () => db.query(`select create_chat('${A}','x','x','x','x')`))).rejects.toThrow()
  })

  it('cannot send while pending', async () => {
    await expect(
      as(A, () => db.query(`insert into messages (room_id, sender_id, ciphertext, nonce, signature) values ('${chatRoom}','${A}','c','n','s')`)),
    ).rejects.toThrow(/row-level security/)
  })

  it('only the peer can accept', async () => {
    await expect(as(A, () => db.query(`select accept_chat('${chat}')`))).rejects.toThrow()
    await as(B, () => db.query(`select accept_chat('${chat}')`))
  })

  it('members send/read, outsiders see nothing, impersonation blocked', async () => {
    await as(A, () => db.query(`insert into messages (room_id, sender_id, ciphertext, nonce, signature) values ('${chatRoom}','${A}','c','n','s')`))
    const bob = await as(B, () => db.query(`select * from messages`))
    expect(bob.rows).toHaveLength(1)
    const carol = await as(C, () => db.query(`select * from messages`))
    expect(carol.rows).toHaveLength(0)
    await expect(
      as(B, () => db.query(`insert into messages (room_id, sender_id, ciphertext, nonce, signature) values ('${chatRoom}','${A}','c','n','s')`)),
    ).rejects.toThrow(/row-level security/)
    await expect(
      as(C, () => db.query(`insert into messages (room_id, sender_id, ciphertext, nonce, signature) values ('${chatRoom}','${C}','c','n','s')`)),
    ).rejects.toThrow(/row-level security/)
    const keys = await as(C, () => db.query(`select * from room_members`))
    expect(keys.rows).toHaveLength(0)
  })

  it('expired secrets are invisible; burn-after-read only by recipient', async () => {
    await as(A, () => db.query(`insert into messages (room_id, sender_id, ciphertext, nonce, signature, expires_at) values ('${secretsRoom}','${A}','c','n','s', now() - interval '1 minute')`))
    const seen = await as(B, () => db.query(`select * from messages where room_id='${secretsRoom}'`))
    expect(seen.rows).toHaveLength(0)

    const ins = await as(A, () => db.query<{ id: string }>(`insert into messages (room_id, sender_id, ciphertext, nonce, signature, burn_after_read) values ('${secretsRoom}','${A}','c','n','s', true) returning id`))
    const id = ins.rows[0].id
    await as(A, () => db.query(`select burn_message('${id}')`)) // sender cannot burn via RPC
    expect((await as(B, () => db.query(`select 1 from messages where id='${id}'`))).rows).toHaveLength(1)
    await as(B, () => db.query(`select burn_message('${id}')`))
    expect((await as(B, () => db.query(`select 1 from messages where id='${id}'`))).rows).toHaveLength(0)
  })

  it('either member can delete secrets, only the sender can delete chat messages, outsiders neither', async () => {
    const ins = (room: string) => as(A, () => db.query<{ id: string }>(`insert into messages (room_id, sender_id, ciphertext, nonce, signature) values ('${room}','${A}','c','n','s') returning id`))
    const sec = (await ins(secretsRoom)).rows[0].id
    const msg = (await ins(chatRoom)).rows[0].id
    const del = (uid: string, id: string) => as(uid, () => db.query(`delete from messages where id='${id}' returning id`))
    expect((await del(C, sec)).rows).toHaveLength(0)
    expect((await del(B, msg)).rows).toHaveLength(0)
    expect((await del(B, sec)).rows).toHaveLength(1)
    expect((await del(A, msg)).rows).toHaveLength(1)
  })

  it('profiles keys are immutable but discoverability can be toggled', async () => {
    await expect(as(A, () => db.query(`update profiles set enc_public_key='evil' where id='${A}'`))).rejects.toThrow(/permission denied/)
    await as(A, () => db.query(`update profiles set discoverable_by_email=false where id='${A}'`))
  })

  it('outsider cannot delete a chat; party can', async () => {
    await as(C, () => db.query(`select delete_chat('${chat}')`))
    expect((await as(A, () => db.query(`select 1 from chats where id='${chat}'`))).rows).toHaveLength(1)
    await as(B, () => db.query(`select delete_chat('${chat}')`))
    expect((await as(A, () => db.query(`select 1 from messages`))).rows).toHaveLength(0)
  })
})

describe('push tokens', () => {
  const T1 = 'token-aaaaaaaaaaaaaaaaaaaaaaaa'

  it('registers a token and moves it when another account logs in on the same device', async () => {
    await as(A, () => db.query(`select register_push_token('${T1}')`))
    expect((await db.query<{ user_id: string }>(`select user_id from push_tokens where token='${T1}'`)).rows[0].user_id).toBe(A)
    await as(B, () => db.query(`select register_push_token('${T1}')`))
    expect((await db.query<{ user_id: string }>(`select user_id from push_tokens where token='${T1}'`)).rows[0].user_id).toBe(B)
  })

  it('hides the table from clients and rejects bad tokens', async () => {
    // a token exists (owned by B) but RLS has no policy, so no client can read any token, even its owner
    expect((await as(A, () => db.query(`select * from push_tokens`))).rows).toHaveLength(0)
    expect((await as(B, () => db.query(`select * from push_tokens`))).rows).toHaveLength(0)
    await expect(as(A, () => db.query(`select register_push_token('short')`))).rejects.toThrow(/bad token/)
  })

  it('only the owner can unregister', async () => {
    await as(A, () => db.query(`select unregister_push_token('${T1}')`)) // A does not own it now
    expect((await db.query(`select 1 from push_tokens where token='${T1}'`)).rows).toHaveLength(1)
    await as(B, () => db.query(`select unregister_push_token('${T1}')`))
    expect((await db.query(`select 1 from push_tokens where token='${T1}'`)).rows).toHaveLength(0)
  })
})

describe('projects', () => {
  let project: string
  let chatRoom: string
  let secretsRoom: string
  const msg = (room: string, sender: string, v = 1) =>
    `insert into messages (room_id, sender_id, ciphertext, nonce, signature, key_version) values ('${room}','${sender}','c','n','s',${v})`
  const members = (...ids: string[]) =>
    JSON.stringify(ids.map((u) => ({ user_id: u, chat_key: `c-${u}`, secrets_key: `s-${u}` })))

  it('creates a project with two rooms; members read it, outsiders do not', async () => {
    const r = await as(A, () =>
      db.query<{ create_project: string }>(`select create_project('Apollo', '${members(A, B)}'::jsonb)`),
    )
    project = r.rows[0].create_project
    const rooms = await as(A, () => db.query<{ id: string; kind: string }>(`select id, kind from rooms where project_id='${project}'`))
    expect(rooms.rows).toHaveLength(2)
    chatRoom = rooms.rows.find((x) => x.kind === 'chat')!.id
    secretsRoom = rooms.rows.find((x) => x.kind === 'secrets')!.id
    expect((await as(B, () => db.query(`select 1 from projects where id='${project}'`))).rows).toHaveLength(1)
    expect((await as(C, () => db.query(`select 1 from projects where id='${project}'`))).rows).toHaveLength(0)
    expect((await as(C, () => db.query(`select 1 from rooms where project_id='${project}'`))).rows).toHaveLength(0)
    // co-members can read each other's profile (for signature keys); outsiders cannot
    expect((await as(B, () => db.query(`select 1 from profiles where id='${A}'`))).rows).toHaveLength(1)
    expect((await as(C, () => db.query(`select 1 from profiles where id='${A}'`))).rows).toHaveLength(0)
  })

  it('rejects bad input: owner missing, unknown user, empty name', async () => {
    await expect(as(A, () => db.query(`select create_project('x', '${members(B)}'::jsonb)`))).rejects.toThrow(/owner must be a member/)
    await expect(
      as(A, () => db.query(`select create_project('x', '${members(A, '00000000-0000-0000-0000-0000000000ff')}'::jsonb)`)),
    ).rejects.toThrow(/unknown user/)
    await expect(as(A, () => db.query(`select create_project('  ', '${members(A)}'::jsonb)`))).rejects.toThrow(/bad project name/)
  })

  it('members send and read; outsiders cannot', async () => {
    await as(A, () => db.query(msg(chatRoom, A)))
    await as(B, () => db.query(msg(secretsRoom, B)))
    expect((await as(B, () => db.query(`select 1 from messages where room_id='${chatRoom}'`))).rows).toHaveLength(1)
    expect((await as(C, () => db.query(`select 1 from messages`))).rows).toHaveLength(0)
    await expect(as(C, () => db.query(msg(chatRoom, C)))).rejects.toThrow(/row-level security/)
  })

  it('only the owner can add members, and the key set must be complete', async () => {
    const keys = (user: string, versions: number[]) =>
      JSON.stringify(versions.flatMap((v) => [chatRoom, secretsRoom].map((room_id) => ({ room_id, key_version: v, wrapped: `w-${user}-${v}` }))))
    await expect(as(B, () => db.query(`select add_project_member('${project}','${C}','${keys(C, [1])}'::jsonb)`))).rejects.toThrow(/only the owner/)
    await expect(as(A, () => db.query(`select add_project_member('${project}','${C}','[]'::jsonb)`))).rejects.toThrow(/incomplete key set/)
    await expect(as(A, () => db.query(`select add_project_member('${project}','${B}','${keys(B, [1])}'::jsonb)`))).rejects.toThrow(/already a member/)
    await as(A, () => db.query(`select add_project_member('${project}','${C}','${keys(C, [1])}'::jsonb)`))
    // the new member reads history and holds a key for version 1
    expect((await as(C, () => db.query(`select 1 from messages where room_id='${chatRoom}'`))).rows).toHaveLength(1)
    expect((await as(C, () => db.query(`select 1 from room_members where key_version=1`))).rows).toHaveLength(2)
  })

  it('removing a member rotates keys: they lose access, others keep history and get the new version', async () => {
    const newKeys = (users: string[]) =>
      JSON.stringify(users.flatMap((user_id) => [chatRoom, secretsRoom].map((room_id) => ({ user_id, room_id, wrapped: `w2-${user_id}` }))))
    await expect(as(B, () => db.query(`select remove_project_member('${project}','${C}','${newKeys([A, B])}'::jsonb)`))).rejects.toThrow(/only the owner/)
    await expect(as(A, () => db.query(`select remove_project_member('${project}','${A}','${newKeys([B, C])}'::jsonb)`))).rejects.toThrow(/cannot be removed/)
    // wrong remaining set (forgot B) is rejected and nothing changes
    await expect(as(A, () => db.query(`select remove_project_member('${project}','${C}','${newKeys([A])}'::jsonb)`))).rejects.toThrow(/member list changed/)
    expect((await as(C, () => db.query(`select 1 from projects where id='${project}'`))).rows).toHaveLength(1)
    expect((await as(A, () => db.query<{ key_version: number }>(`select key_version from rooms where project_id='${project}'`))).rows.every((r) => r.key_version === 1)).toBe(true)

    await as(A, () => db.query(`select remove_project_member('${project}','${C}','${newKeys([A, B])}'::jsonb)`))
    expect((await as(C, () => db.query(`select 1 from projects`))).rows).toHaveLength(0)
    expect((await as(C, () => db.query(`select 1 from messages`))).rows).toHaveLength(0)
    expect((await as(C, () => db.query(`select 1 from room_members`))).rows).toHaveLength(0)
    const rooms = await as(A, () => db.query<{ key_version: number }>(`select key_version from rooms where project_id='${project}'`))
    expect(rooms.rows.every((r) => r.key_version === 2)).toBe(true)
    // remaining members hold versions 1 and 2 per room; history stays readable
    expect((await as(B, () => db.query(`select 1 from room_members where user_id='${B}'`))).rows).toHaveLength(4)
    expect((await as(B, () => db.query(`select 1 from messages where room_id='${chatRoom}'`))).rows).toHaveLength(1)
  })

  it('writes must use the current key version', async () => {
    await expect(as(A, () => db.query(msg(chatRoom, A, 1)))).rejects.toThrow(/row-level security/)
    await as(A, () => db.query(msg(chatRoom, A, 2)))
    await expect(as(C, () => db.query(msg(chatRoom, C, 2)))).rejects.toThrow(/row-level security/)
  })

  it('only the owner can delete the project; everything cascades', async () => {
    await as(B, () => db.query(`select delete_project('${project}')`))
    expect((await as(A, () => db.query(`select 1 from projects where id='${project}'`))).rows).toHaveLength(1)
    await as(A, () => db.query(`select delete_project('${project}')`))
    expect((await as(A, () => db.query(`select 1 from rooms where project_id='${project}'`))).rows).toHaveLength(0)
    expect((await as(A, () => db.query(`select 1 from messages`))).rows).toHaveLength(0)
  })
})
