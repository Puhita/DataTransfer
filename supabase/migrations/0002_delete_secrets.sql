-- Either member of a chat may delete entries in the Secrets room (shared secret, shared control).
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
