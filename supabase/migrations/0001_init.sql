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
