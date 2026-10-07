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
