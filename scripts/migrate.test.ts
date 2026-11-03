import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { citext } from '@electric-sql/pglite/contrib/citext'
// @ts-expect-error plain .mjs without types
import { apply, plan } from './migrate-core.mjs'

const sql = (f: string) => readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8')

// Minimal stand-in for Supabase's auth schema. `confirmed_at` and `email` are GENERATED, like the real ones.
const stub = (extraUserCol = '') => `
create role anon nologin; create role authenticated nologin;
create schema auth;
create table auth.users (
  id uuid primary key, email text, encrypted_password text, raw_user_meta_data jsonb,
  email_confirmed_at timestamptz, confirmed_at timestamptz generated always as (email_confirmed_at) stored,
  created_at timestamptz default now() ${extraUserCol});
create table auth.identities (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null, provider_id text not null, identity_data jsonb not null,
  email text generated always as (lower(identity_data->>'email')) stored, unique (provider_id, provider));
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true), '')::uuid $$;
create publication supabase_realtime;
grant usage on schema public, auth to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
`

const A = '00000000-0000-0000-0000-00000000000a'
const B = '00000000-0000-0000-0000-00000000000b'
const CHAT = '00000000-0000-0000-0000-0000000000c1'
const ROOM = '00000000-0000-0000-0000-0000000000d1'
const MSG = '00000000-0000-0000-0000-0000000000e1'
const TS = '2026-10-05 14:02:03.123456+00' // microseconds on purpose

let old: PGlite
let target: PGlite

const profile = (id: string, name: string) =>
  `insert into profiles (id, username, enc_public_key, sign_public_key, kdf_salt, kdf_opslimit, kdf_memlimit, wrapped_keys_passphrase, wrapped_keys_recovery)
   values ('${id}','${name}','e-${name}','s-${name}','salt',2,8388608,'wp-${name}','wr-${name}')`

beforeAll(async () => {
  // OLD: only the first two migrations (no projects), like a project that never got the later ones
  old = new PGlite({ extensions: { citext } })
  await old.exec(stub())
  await old.exec(sql('0001_init.sql'))
  await old.exec(sql('0002_push.sql'))
  // NEW: full schema, and an extra auth column the old one lacks
  target = new PGlite({ extensions: { citext } })
  await target.exec(stub(', is_anonymous boolean not null default false'))
  for (const f of ['0001_init.sql', '0002_push.sql', '0003_projects.sql', '0004_delete_secrets.sql']) await target.exec(sql(f))

  await old.exec(`
    insert into auth.users (id, email, encrypted_password, raw_user_meta_data, email_confirmed_at) values
      ('${A}','alice@x.io','$2a$10$hashhashhashA','{"username":"alice"}','${TS}'),
      ('${B}','bob@x.io','$2a$10$hashhashhashB','{"username":"bob"}','${TS}');
    insert into auth.identities (user_id, provider, provider_id, identity_data) values
      ('${A}','email','${A}','{"email":"Alice@x.io","sub":"${A}"}');
    ${profile(A, 'alice')}; ${profile(B, 'bob')};
    insert into chats (id, created_by, peer_id, status) values ('${CHAT}','${A}','${B}','active');
    insert into rooms (id, chat_id, kind, key_version) values ('${ROOM}','${CHAT}','chat',1);
    insert into room_members (room_id, user_id, wrapped_room_key, key_version) values ('${ROOM}','${A}','wk-a',1),('${ROOM}','${B}','wk-b',1);
    insert into messages (id, room_id, sender_id, ciphertext, nonce, signature, key_version, created_at, expires_at, burn_after_read)
      values ('${MSG}','${ROOM}','${A}','ct''quote','nonce','sig',1,'${TS}','2030-01-01 00:00:00+00',true);
    insert into push_tokens (token, user_id) values ('tok-should-not-copy-aaaaaaaaaaaa','${A}');
  `)
})

describe('migrate', () => {
  it('dry run reports counts, warnings and no errors, and changes nothing', async () => {
    const r = await plan(old, target)
    expect(r.errors).toEqual([])
    expect(r.tables.find((t: { table: string }) => t.table === 'auth.users').oldRows).toBe(2)
    expect(r.warnings.join('\n')).toMatch(/public\.projects: not in the old database/)
    expect((await target.query('select count(*)::int as n from auth.users')).rows[0]).toEqual({ n: 0 })
  })

  it('copies everything with ids, ciphertext, hashes and microsecond timestamps intact', async () => {
    const r = await plan(old, target)
    const res = await apply(old, target, r)
    expect(res.find((x: { table: string }) => x.table === 'public.messages')).toMatchObject({ read: 1, inserted: 1 })

    const u = (await target.query(`select id::text, email, encrypted_password, raw_user_meta_data, to_char(confirmed_at at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') as c from auth.users order by email`)).rows as any[]
    expect(u.map((x) => x.id)).toEqual([A, B])
    expect(u[0].encrypted_password).toBe('$2a$10$hashhashhashA')
    expect(u[0].raw_user_meta_data).toEqual({ username: 'alice' })
    expect(u[0].c).toBe('2026-10-05 14:02:03.123456') // generated column recomputed, not copied

    const id = (await target.query(`select email from auth.identities`)).rows[0] as any
    expect(id.email).toBe('alice@x.io') // generated in the target

    const m = (await target.query(`select ciphertext, to_char(created_at at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') as c, to_char(expires_at at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') as e, burn_after_read as b, key_version from messages`)).rows[0] as any
    expect(m).toEqual({ ciphertext: "ct'quote", c: '2026-10-05 14:02:03.123456', e: '2030-01-01 00:00:00.000000', b: true, key_version: 1 })

    expect((await target.query(`select count(*)::int as n from room_members`)).rows[0]).toEqual({ n: 2 })
    expect((await target.query(`select username::text as u from profiles order by 1`)).rows.map((x: any) => x.u)).toEqual(['alice', 'bob'])
    expect((await target.query(`select count(*)::int as n from push_tokens`)).rows[0]).toEqual({ n: 0 }) // devices re-register
  })

  it('is safe to run again', async () => {
    const r = await plan(old, target)
    expect(r.alreadyThere).toBe(2)
    const res = await apply(old, target, r)
    expect(res.every((x: { inserted: number }) => x.inserted === 0)).toBe(true)
  })

  it('refuses when the same email already exists in the target under a different id', async () => {
    const fresh = new PGlite({ extensions: { citext } })
    await fresh.exec(stub(', is_anonymous boolean not null default false'))
    for (const f of ['0001_init.sql', '0002_push.sql', '0003_projects.sql', '0004_delete_secrets.sql']) await fresh.exec(sql(f))
    await fresh.exec(`insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000ff','ALICE@x.io')`)
    const r = await plan(old, fresh)
    expect(r.errors.join('\n')).toMatch(/alice@x\.io.*DIFFERENT ids/)
    await expect(apply(old, fresh, r)).rejects.toThrow(/Refusing to apply/)
    expect((await fresh.query('select count(*)::int as n from profiles')).rows[0]).toEqual({ n: 0 })
  })

  it('errors clearly when the target has no schema yet', async () => {
    const empty = new PGlite({ extensions: { citext } })
    await empty.exec(stub())
    const r = await plan(old, empty)
    expect(r.errors.join('\n')).toMatch(/missing in the NEW database/)
  })
})
