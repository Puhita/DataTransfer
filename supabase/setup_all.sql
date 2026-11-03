-- ===== supabase/migrations/0001_init.sql =====
-- DataTransfer schema. The server only ever stores ciphertext, public keys and
-- wrapped (encrypted) private keys. Run in the Supabase SQL editor or `supabase db push`.

create extension if not exists citext;

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id                     uuid primary key references auth.users (id) on delete cascade,
  username               citext not null unique
                           check (username ~ '^[A-Za-z0-9_]{3,24}$'),
  discoverable_by_email  boolean not null default true,
  enc_public_key         text not null,
  sign_public_key        text not null,
  kdf_salt               text not null,
  kdf_opslimit           int  not null check (kdf_opslimit >= 2),
  kdf_memlimit           int  not null check (kdf_memlimit >= 8388608),
  wrapped_keys_passphrase text not null,
  wrapped_keys_recovery   text not null,
  created_at             timestamptz not null default now()
);

-- ------------------------------------------------------------ chats / rooms
create table public.chats (
  id          uuid primary key default gen_random_uuid(),
  created_by  uuid not null references public.profiles (id) on delete cascade,
  peer_id     uuid not null references public.profiles (id) on delete cascade,
  status      text not null default 'pending' check (status in ('pending', 'active')),
  created_at  timestamptz not null default now(),
  check (created_by <> peer_id)
);
-- one chat per unordered pair
create unique index chats_pair_unique
  on public.chats (least(created_by, peer_id), greatest(created_by, peer_id));

create table public.rooms (
  id          uuid primary key default gen_random_uuid(),
  chat_id     uuid not null references public.chats (id) on delete cascade,
  kind        text not null check (kind in ('chat', 'secrets')),
  key_version int  not null default 1,
  unique (chat_id, kind)
);

create table public.room_members (
  room_id          uuid not null references public.rooms (id) on delete cascade,
  user_id          uuid not null references public.profiles (id) on delete cascade,
  wrapped_room_key text not null,
  key_version      int  not null default 1,
  primary key (room_id, user_id)
);
create index room_members_user_idx on public.room_members (user_id);

-- ------------------------------------------------------------------ messages
-- Used for both chat messages and secret entries; room.kind decides which.
create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  room_id         uuid not null references public.rooms (id) on delete cascade,
  sender_id       uuid not null references public.profiles (id) on delete cascade,
  ciphertext      text not null check (length(ciphertext) <= 100000),
  nonce           text not null,
  signature       text not null,
  key_version     int  not null default 1,
  expires_at      timestamptz,
  burn_after_read boolean not null default false,
  created_at      timestamptz not null default now()
);
create index messages_room_created_idx on public.messages (room_id, created_at);

-- ------------------------------------------------------------------- helpers
create or replace function public.is_room_member(p_room uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.room_members m where m.room_id = p_room and m.user_id = auth.uid());
$$;

create or replace function public.room_is_active(p_room uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.rooms r join public.chats c on c.id = r.chat_id
    where r.id = p_room and c.status = 'active');
$$;

create or replace function public.shares_chat_with(p_other uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.chats c
    where (c.created_by = auth.uid() and c.peer_id = p_other)
       or (c.peer_id = auth.uid() and c.created_by = p_other));
$$;

create or replace function public.is_chat_party(p_chat uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.chats c
    where c.id = p_chat and auth.uid() in (c.created_by, c.peer_id));
$$;

-- ----------------------------------------------------------------------- RLS
alter table public.profiles     enable row level security;
alter table public.chats        enable row level security;
alter table public.rooms        enable row level security;
alter table public.room_members enable row level security;
alter table public.messages     enable row level security;

-- profiles: own row, or someone you have a chat with
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.shares_chat_with(id));
create policy profiles_insert on public.profiles for insert to authenticated
  with check (id = auth.uid());
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- chats/rooms/members: read-only for parties; writes go through RPCs below
create policy chats_select on public.chats for select to authenticated
  using (auth.uid() in (created_by, peer_id));
create policy rooms_select on public.rooms for select to authenticated
  using (public.is_chat_party(chat_id));
create policy members_select on public.room_members for select to authenticated
  using (user_id = auth.uid());

-- messages: members read; members of an ACTIVE chat write as themselves; sender deletes own
create policy messages_select on public.messages for select to authenticated
  using (public.is_room_member(room_id) and (expires_at is null or expires_at > now()));
create policy messages_insert on public.messages for insert to authenticated
  with check (sender_id = auth.uid() and public.is_room_member(room_id) and public.room_is_active(room_id));
create policy messages_delete on public.messages for delete to authenticated
  using (sender_id = auth.uid());

-- Profiles may only change non-key columns after creation. Keys are immutable
-- except for passphrase rewrap (kdf_* and wrapped_keys_passphrase).
revoke update on public.profiles from authenticated;
grant update (discoverable_by_email, kdf_salt, kdf_opslimit, kdf_memlimit, wrapped_keys_passphrase)
  on public.profiles to authenticated;

-- --------------------------------------------------------------------- RPCs
create table public.lookup_log (
  user_id uuid not null,
  at      timestamptz not null default now()
);
create index lookup_log_idx on public.lookup_log (user_id, at);
alter table public.lookup_log enable row level security; -- no policies: RPC-only

-- Find users by username prefix or EXACT email (only if they allow it).
create or replace function public.find_users(p_query text)
returns table (id uuid, username citext, enc_public_key text, sign_public_key text)
language plpgsql security definer set search_path = public, auth as $$
declare
  q text := btrim(p_query);
  recent int;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if length(q) < 3 or length(q) > 254 then return; end if;

  delete from public.lookup_log where at < now() - interval '1 hour';
  select count(*) into recent from public.lookup_log
    where user_id = auth.uid() and at > now() - interval '1 minute';
  if recent >= 30 then raise exception 'rate limit: slow down'; end if;
  insert into public.lookup_log (user_id) values (auth.uid());

  return query
    select p.id, p.username, p.enc_public_key, p.sign_public_key
    from public.profiles p
    where p.id <> auth.uid()
      and (
        p.username::text ilike replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%'
        or (
          position('@' in q) > 1 and p.discoverable_by_email
          and exists (select 1 from auth.users u where u.id = p.id and lower(u.email) = lower(q))
        )
      )
    order by (lower(p.username::text) = lower(q)) desc, p.username
    limit 10;
end $$;

-- Create a pending chat with its two rooms. The creator wraps both room keys for both parties.
create or replace function public.create_chat(
  p_peer uuid,
  p_chat_key_me text, p_chat_key_peer text,
  p_secrets_key_me text, p_secrets_key_peer text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  v_chat uuid;
  r_chat uuid;
  r_sec uuid;
begin
  if me is null then raise exception 'not authenticated'; end if;
  if p_peer = me then raise exception 'cannot chat with yourself'; end if;
  if not exists (select 1 from public.profiles where id = p_peer) then
    raise exception 'unknown user';
  end if;
  if exists (select 1 from public.chats c
      where (c.created_by = me and c.peer_id = p_peer) or (c.created_by = p_peer and c.peer_id = me)) then
    raise exception 'chat already exists';
  end if;

  insert into public.chats (created_by, peer_id) values (me, p_peer) returning id into v_chat;
  insert into public.rooms (chat_id, kind) values (v_chat, 'chat')    returning id into r_chat;
  insert into public.rooms (chat_id, kind) values (v_chat, 'secrets') returning id into r_sec;
  insert into public.room_members (room_id, user_id, wrapped_room_key) values
    (r_chat, me, p_chat_key_me), (r_chat, p_peer, p_chat_key_peer),
    (r_sec,  me, p_secrets_key_me), (r_sec, p_peer, p_secrets_key_peer);
  return v_chat;
end $$;

create or replace function public.accept_chat(p_chat uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.chats set status = 'active'
    where id = p_chat and peer_id = auth.uid() and status = 'pending';
  if not found then raise exception 'no pending request'; end if;
end $$;

-- Either party may decline / delete; everything cascades.
create or replace function public.delete_chat(p_chat uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.chats where id = p_chat and auth.uid() in (created_by, peer_id);
end $$;

-- Recipient reveals a burn-after-read secret -> it is deleted.
create or replace function public.burn_message(p_msg uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.messages m
   where m.id = p_msg and m.burn_after_read
     and m.sender_id <> auth.uid() and public.is_room_member(m.room_id);
end $$;

revoke all on function public.find_users(text) from public, anon;
revoke all on function public.create_chat(uuid, text, text, text, text) from public, anon;
revoke all on function public.accept_chat(uuid) from public, anon;
revoke all on function public.delete_chat(uuid) from public, anon;
revoke all on function public.burn_message(uuid) from public, anon;
grant execute on function public.find_users(text) to authenticated;
grant execute on function public.create_chat(uuid, text, text, text, text) to authenticated;
grant execute on function public.accept_chat(uuid) to authenticated;
grant execute on function public.delete_chat(uuid) to authenticated;
grant execute on function public.burn_message(uuid) to authenticated;

-- Realtime (RLS applies to postgres_changes)
alter publication supabase_realtime add table public.messages, public.chats;
alter table public.messages replica identity full;

-- ===== supabase/migrations/0002_push.sql =====
-- Push notification device tokens. Payloads never contain message content (the server cannot read it);
-- the Edge Function `notify` only says "<sender> · New message/secret".

create table public.push_tokens (
  token      text primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  platform   text not null default 'android' check (platform in ('android', 'ios', 'web')),
  updated_at timestamptz not null default now()
);
create index push_tokens_user_idx on public.push_tokens (user_id);
alter table public.push_tokens enable row level security; -- no policies: RPC / service role only

-- A device token belongs to whoever is logged in on it right now (it moves on account switch).
create or replace function public.register_push_token(p_token text, p_platform text default 'android')
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if length(p_token) < 20 or length(p_token) > 4096 then raise exception 'bad token'; end if;
  insert into public.push_tokens (token, user_id, platform) values (p_token, auth.uid(), p_platform)
  on conflict (token) do update set user_id = auth.uid(), platform = excluded.platform, updated_at = now();
end $$;

create or replace function public.unregister_push_token(p_token text)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.push_tokens where token = p_token and user_id = auth.uid();
end $$;

revoke all on function public.register_push_token(text, text) from public, anon;
revoke all on function public.unregister_push_token(text) from public, anon;
grant execute on function public.register_push_token(text, text) to authenticated;
grant execute on function public.unregister_push_token(text) to authenticated;

-- ===== supabase/migrations/0003_projects.sql =====
-- Projects: named groups with a Chat room and a Secrets room shared by several members.
-- Room keys are wrapped per member per key version. Removing a member rotates both room keys;
-- old versions stay wrapped for remaining members so history stays readable.

-- ---------------------------------------------------------------- tables
create table public.projects (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(btrim(name)) between 1 and 60),
  owner_id   uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.project_members (
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  primary key (project_id, user_id)
);
create index project_members_user_idx on public.project_members (user_id);

-- rooms belong to either a 1:1 chat or a project
alter table public.rooms alter column chat_id drop not null;
alter table public.rooms add column project_id uuid references public.projects (id) on delete cascade;
alter table public.rooms add constraint rooms_owner_check check ((chat_id is null) <> (project_id is null));
create unique index rooms_project_kind_unique on public.rooms (project_id, kind) where project_id is not null;

-- one wrapped key per member per key version
alter table public.room_members drop constraint room_members_pkey;
alter table public.room_members add primary key (room_id, user_id, key_version);

-- ---------------------------------------------------------------- helpers
create or replace function public.is_project_member(p_project uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.project_members m where m.project_id = p_project and m.user_id = auth.uid());
$$;

create or replace function public.is_project_owner(p_project uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.projects p where p.id = p_project and p.owner_id = auth.uid());
$$;

create or replace function public.room_key_version(p_room uuid)
returns int language sql stable security definer set search_path = public as $$
  select key_version from public.rooms where id = p_room;
$$;

-- project rooms are always active; chat rooms only once the chat is accepted
create or replace function public.room_is_active(p_room uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.rooms r left join public.chats c on c.id = r.chat_id
    where r.id = p_room and (r.project_id is not null or c.status = 'active'));
$$;

-- profiles are visible to chat peers and to people sharing a project
create or replace function public.shares_chat_with(p_other uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.chats c
    where (c.created_by = auth.uid() and c.peer_id = p_other)
       or (c.peer_id = auth.uid() and c.created_by = p_other))
  or exists (
    select 1 from public.project_members a join public.project_members b on a.project_id = b.project_id
    where a.user_id = auth.uid() and b.user_id = p_other);
$$;

-- ---------------------------------------------------------------- RLS
alter table public.projects        enable row level security;
alter table public.project_members enable row level security;

create policy projects_select on public.projects for select to authenticated
  using (public.is_project_member(id));
create policy project_members_select on public.project_members for select to authenticated
  using (public.is_project_member(project_id));

drop policy rooms_select on public.rooms;
create policy rooms_select on public.rooms for select to authenticated
  using ((chat_id is not null and public.is_chat_party(chat_id))
      or (project_id is not null and public.is_project_member(project_id)));

-- room_members select stays "own rows only"; writes only via RPCs

-- writes must use the room's current key version (blocks stale writes after a rotation)
drop policy messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
  with check (sender_id = auth.uid() and public.is_room_member(room_id) and public.room_is_active(room_id)
              and key_version = public.room_key_version(room_id));

-- ---------------------------------------------------------------- RPCs
-- p_members: [{user_id, chat_key, secrets_key}] including the caller (the owner)
create or replace function public.create_project(p_name text, p_members jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  v_project uuid;
  r_chat uuid;
  r_sec uuid;
  n int;
begin
  if me is null then raise exception 'not authenticated'; end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 60 then raise exception 'bad project name'; end if;
  if jsonb_typeof(p_members) is distinct from 'array' then raise exception 'bad members'; end if;

  select count(*) into n from jsonb_to_recordset(p_members) as x(user_id uuid, chat_key text, secrets_key text);
  if n < 1 or n > 50 then raise exception 'a project needs 1 to 50 members'; end if;
  if (select count(distinct x.user_id) from jsonb_to_recordset(p_members) as x(user_id uuid, chat_key text, secrets_key text)) <> n then
    raise exception 'duplicate member';
  end if;
  if not exists (select 1 from jsonb_to_recordset(p_members) as x(user_id uuid, chat_key text, secrets_key text) where x.user_id = me) then
    raise exception 'owner must be a member';
  end if;
  if exists (select 1 from jsonb_to_recordset(p_members) as x(user_id uuid, chat_key text, secrets_key text)
             where x.user_id is null or x.chat_key is null or x.secrets_key is null) then
    raise exception 'missing key';
  end if;
  if exists (select 1 from jsonb_to_recordset(p_members) as x(user_id uuid, chat_key text, secrets_key text)
             where x.user_id not in (select id from public.profiles)) then
    raise exception 'unknown user';
  end if;

  insert into public.projects (name, owner_id) values (btrim(p_name), me) returning id into v_project;
  insert into public.project_members (project_id, user_id)
    select v_project, x.user_id from jsonb_to_recordset(p_members) as x(user_id uuid, chat_key text, secrets_key text);
  insert into public.rooms (project_id, kind) values (v_project, 'chat')    returning id into r_chat;
  insert into public.rooms (project_id, kind) values (v_project, 'secrets') returning id into r_sec;
  insert into public.room_members (room_id, user_id, wrapped_room_key, key_version)
    select r_chat, x.user_id, x.chat_key, 1 from jsonb_to_recordset(p_members) as x(user_id uuid, chat_key text, secrets_key text)
    union all
    select r_sec, x.user_id, x.secrets_key, 1 from jsonb_to_recordset(p_members) as x(user_id uuid, chat_key text, secrets_key text);
  return v_project;
end $$;

-- p_keys: [{room_id, key_version, wrapped}] covering EVERY existing key version of both rooms
create or replace function public.add_project_member(p_project uuid, p_user uuid, p_keys jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  expected int;
  provided int;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not public.is_project_owner(p_project) then raise exception 'only the owner can add members'; end if;
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'unknown user'; end if;
  if exists (select 1 from public.project_members where project_id = p_project and user_id = p_user) then
    raise exception 'already a member';
  end if;
  if (select count(*) from public.project_members where project_id = p_project) >= 50 then
    raise exception 'project is full';
  end if;
  if jsonb_typeof(p_keys) is distinct from 'array' then raise exception 'bad keys'; end if;

  select coalesce(sum(key_version), 0) into expected from public.rooms where project_id = p_project;
  select count(*) into provided from (
    select distinct k.room_id, k.key_version
    from jsonb_to_recordset(p_keys) as k(room_id uuid, key_version int, wrapped text)
    join public.rooms r on r.id = k.room_id and r.project_id = p_project
    where k.key_version between 1 and r.key_version and k.wrapped is not null
  ) s;
  if provided <> expected or jsonb_array_length(p_keys) <> expected then raise exception 'incomplete key set'; end if;

  insert into public.project_members (project_id, user_id) values (p_project, p_user);
  insert into public.room_members (room_id, user_id, wrapped_room_key, key_version)
    select k.room_id, p_user, k.wrapped, k.key_version
    from jsonb_to_recordset(p_keys) as k(room_id uuid, key_version int, wrapped text);
end $$;

-- p_new_keys: [{user_id, room_id, wrapped}] one per REMAINING member per room, wrapping the new room keys.
-- The new key version is chosen by the server (current + 1).
create or replace function public.remove_project_member(p_project uuid, p_user uuid, p_new_keys jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  remaining int;
  provided int;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not public.is_project_owner(p_project) then raise exception 'only the owner can remove members'; end if;
  if p_user = auth.uid() then raise exception 'the owner cannot be removed'; end if;
  if not exists (select 1 from public.project_members where project_id = p_project and user_id = p_user) then
    raise exception 'not a member';
  end if;
  if jsonb_typeof(p_new_keys) is distinct from 'array' then raise exception 'bad keys'; end if;

  delete from public.room_members
    where user_id = p_user and room_id in (select id from public.rooms where project_id = p_project);
  delete from public.project_members where project_id = p_project and user_id = p_user;
  update public.rooms set key_version = key_version + 1 where project_id = p_project;

  select count(*) into remaining from public.project_members where project_id = p_project;
  select count(*) into provided from (
    select distinct k.user_id, k.room_id
    from jsonb_to_recordset(p_new_keys) as k(user_id uuid, room_id uuid, wrapped text)
    join public.project_members pm on pm.project_id = p_project and pm.user_id = k.user_id
    join public.rooms r on r.id = k.room_id and r.project_id = p_project
    where k.wrapped is not null
  ) s;
  if provided <> remaining * 2 or jsonb_array_length(p_new_keys) <> remaining * 2 then
    raise exception 'member list changed, retry';
  end if;

  insert into public.room_members (room_id, user_id, wrapped_room_key, key_version)
    select k.room_id, k.user_id, k.wrapped, r.key_version
    from jsonb_to_recordset(p_new_keys) as k(user_id uuid, room_id uuid, wrapped text)
    join public.rooms r on r.id = k.room_id;
end $$;

create or replace function public.delete_project(p_project uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.projects where id = p_project and owner_id = auth.uid();
end $$;

revoke all on function public.create_project(text, jsonb) from public, anon;
revoke all on function public.add_project_member(uuid, uuid, jsonb) from public, anon;
revoke all on function public.remove_project_member(uuid, uuid, jsonb) from public, anon;
revoke all on function public.delete_project(uuid) from public, anon;
grant execute on function public.create_project(text, jsonb) to authenticated;
grant execute on function public.add_project_member(uuid, uuid, jsonb) to authenticated;
grant execute on function public.remove_project_member(uuid, uuid, jsonb) to authenticated;
grant execute on function public.delete_project(uuid) to authenticated;

-- Realtime (RLS applies). rooms: so members pick up key-version changes.
alter publication supabase_realtime add table public.projects, public.project_members, public.rooms;

-- ===== supabase/migrations/0004_delete_secrets.sql =====
-- Any member of a chat or project may delete entries in the Secrets room (shared secret, shared control).
-- Chat messages can still only be deleted by their sender.
create or replace function public.is_secrets_room_member(p_room uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.rooms r
    join public.room_members m on m.room_id = r.id
    where r.id = p_room and r.kind = 'secrets' and m.user_id = auth.uid());
$$;

drop policy messages_delete on public.messages;
create policy messages_delete on public.messages for delete to authenticated
  using (sender_id = auth.uid() or public.is_secrets_room_member(room_id));

