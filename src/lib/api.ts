import {
  newRoomKey,
  wrapRoomKey,
  unwrapRoomKey,
  encryptMessage,
  decryptMessage,
  keyFingerprint,
  type StoredKeys,
  type KeyBundle,
} from '../crypto'
import { supabase } from './supabase'
import { keystore } from './keystore'

export interface ProfileRow {
  id: string
  username: string
  discoverable_by_email: boolean
  enc_public_key: string
  sign_public_key: string
  kdf_salt: string
  kdf_opslimit: number
  kdf_memlimit: number
  wrapped_keys_passphrase: string
  wrapped_keys_recovery: string
}

export interface PeerInfo {
  id: string
  username: string
  enc_public_key: string
  sign_public_key: string
}

export interface RoomInfo {
  id: string
  kind: 'chat' | 'secrets'
  key_version: number
}

export interface ChatInfo {
  id: string
  status: 'pending' | 'active'
  incoming: boolean // true if someone else started it and I must accept
  peer: PeerInfo
  chat: RoomInfo
  secrets: RoomInfo
}

export interface Decoded {
  id: string
  senderId: string
  createdAt: string
  expiresAt: string | null
  burn: boolean
  text: string | null // null = failed verification/decryption
}

export interface MessageRow {
  id: string
  room_id: string
  sender_id: string
  ciphertext: string
  nonce: string
  signature: string
  key_version: number
  expires_at: string | null
  burn_after_read: boolean
  created_at: string
}

const fail = (e: { message: string } | null) => {
  if (e) throw new Error(e.message)
}

export const storedKeys = (p: ProfileRow): StoredKeys => ({
  encPublic: p.enc_public_key,
  signPublic: p.sign_public_key,
  kdf: { salt: p.kdf_salt, opslimit: p.kdf_opslimit, memlimit: p.kdf_memlimit },
  wrappedByPassphrase: p.wrapped_keys_passphrase,
  wrappedByRecovery: p.wrapped_keys_recovery,
})

export async function getMyProfile(uid: string): Promise<ProfileRow | null> {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', uid).maybeSingle()
  fail(error)
  return data as ProfileRow | null
}

export async function createProfile(uid: string, username: string, b: KeyBundle): Promise<void> {
  const { error } = await supabase.from('profiles').insert({
    id: uid,
    username,
    enc_public_key: b.encPublic,
    sign_public_key: b.signPublic,
    kdf_salt: b.kdf.salt,
    kdf_opslimit: b.kdf.opslimit,
    kdf_memlimit: b.kdf.memlimit,
    wrapped_keys_passphrase: b.wrappedByPassphrase,
    wrapped_keys_recovery: b.wrappedByRecovery,
  })
  if (error) {
    if (error.code === '23505') throw new Error('That username is taken.')
    if (error.code === '23514') throw new Error('Username must be 3-24 letters, digits or underscore.')
    throw new Error(error.message)
  }
}

export async function setDiscoverable(uid: string, v: boolean): Promise<void> {
  const { error } = await supabase.from('profiles').update({ discoverable_by_email: v }).eq('id', uid)
  fail(error)
}

export async function updatePassphraseWrap(
  uid: string,
  w: { kdf: { salt: string; opslimit: number; memlimit: number }; wrappedByPassphrase: string },
): Promise<void> {
  const { error } = await supabase
    .from('profiles')
    .update({
      kdf_salt: w.kdf.salt,
      kdf_opslimit: w.kdf.opslimit,
      kdf_memlimit: w.kdf.memlimit,
      wrapped_keys_passphrase: w.wrappedByPassphrase,
    })
    .eq('id', uid)
  fail(error)
}

export async function findUsers(q: string): Promise<PeerInfo[]> {
  const { data, error } = await supabase.rpc('find_users', { p_query: q })
  fail(error)
  return (data ?? []) as PeerInfo[]
}

export async function startChat(me: ProfileRow, peer: PeerInfo): Promise<string> {
  const chatKey = await newRoomKey()
  const secKey = await newRoomKey()
  const { data, error } = await supabase.rpc('create_chat', {
    p_peer: peer.id,
    p_chat_key_me: await wrapRoomKey(chatKey, me.enc_public_key),
    p_chat_key_peer: await wrapRoomKey(chatKey, peer.enc_public_key),
    p_secrets_key_me: await wrapRoomKey(secKey, me.enc_public_key),
    p_secrets_key_peer: await wrapRoomKey(secKey, peer.enc_public_key),
  })
  fail(error)
  return data as string
}

export const acceptChat = async (id: string) => fail((await supabase.rpc('accept_chat', { p_chat: id })).error)
export const deleteChat = async (id: string) => fail((await supabase.rpc('delete_chat', { p_chat: id })).error)
export async function deleteMessage(id: string): Promise<void> {
  const { data, error } = await supabase.from('messages').delete().eq('id', id).select('id')
  fail(error)
  if (!data?.length) throw new Error('Not allowed, or already deleted.')
}
export const burnMessage = async (id: string) => fail((await supabase.rpc('burn_message', { p_msg: id })).error)

export async function listChats(myId: string): Promise<ChatInfo[]> {
  const { data: chats, error } = await supabase.from('chats').select('*').order('created_at', { ascending: false })
  fail(error)
  if (!chats?.length) return []
  const ids = chats.map((c) => c.id)
  const peerIds = chats.map((c) => (c.created_by === myId ? c.peer_id : c.created_by))
  const [rooms, peers] = await Promise.all([
    supabase.from('rooms').select('id, chat_id, kind, key_version').in('chat_id', ids),
    supabase.from('profiles').select('id, username, enc_public_key, sign_public_key').in('id', peerIds),
  ])
  fail(rooms.error)
  fail(peers.error)
  const out: ChatInfo[] = []
  for (const c of chats) {
    const peerId = c.created_by === myId ? c.peer_id : c.created_by
    const peer = peers.data?.find((p) => p.id === peerId)
    const r = rooms.data?.filter((x) => x.chat_id === c.id) ?? []
    const chat = r.find((x) => x.kind === 'chat')
    const secrets = r.find((x) => x.kind === 'secrets')
    if (!peer || !chat || !secrets) continue
    out.push({ id: c.id, status: c.status, incoming: c.peer_id === myId && c.status === 'pending', peer, chat, secrets })
  }
  return out
}

export async function getRoomKey(roomId: string, myId: string, version: number): Promise<Uint8Array> {
  const cached = keystore.roomKey(roomId, version)
  if (cached) return cached
  const me = keystore.identity
  if (!me) throw new Error('Locked')
  const { data, error } = await supabase
    .from('room_members')
    .select('wrapped_room_key')
    .eq('room_id', roomId)
    .eq('user_id', myId)
    .eq('key_version', version)
    .single()
  fail(error)
  const key = await unwrapRoomKey(data!.wrapped_room_key, me)
  keystore.setRoomKey(roomId, version, key)
  return key
}

/** Every key version I hold for a room, unwrapped (used to share history with a new member). */
async function allRoomKeys(roomId: string, myId: string): Promise<{ version: number; key: Uint8Array }[]> {
  const me = keystore.identity
  if (!me) throw new Error('Locked')
  const { data, error } = await supabase
    .from('room_members')
    .select('wrapped_room_key, key_version')
    .eq('room_id', roomId)
    .eq('user_id', myId)
  fail(error)
  return Promise.all(
    (data ?? []).map(async (r) => {
      const key = await unwrapRoomKey(r.wrapped_room_key, me)
      keystore.setRoomKey(roomId, r.key_version, key)
      return { version: r.key_version as number, key }
    }),
  )
}

export async function decodeRow(
  row: MessageRow,
  myId: string,
  senderSignPublic: string | undefined,
): Promise<Decoded> {
  let text: string | null = null
  if (senderSignPublic) {
    try {
      const roomKey = await getRoomKey(row.room_id, myId, row.key_version)
      text = await decryptMessage(
        row,
        roomKey,
        { roomId: row.room_id, senderId: row.sender_id, keyVersion: row.key_version },
        senderSignPublic,
      )
    } catch {
      text = null
    }
  }
  return {
    id: row.id,
    senderId: row.sender_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    burn: row.burn_after_read,
    text,
  }
}

export async function fetchRoomMessages(roomId: string): Promise<MessageRow[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('room_id', roomId)
    .order('created_at', { ascending: false })
    .limit(200)
  fail(error)
  return ((data ?? []) as MessageRow[]).reverse()
}

export async function sendEncrypted(
  room: RoomInfo,
  myId: string,
  plaintext: string,
  opts: { expiresAt?: string | null; burn?: boolean } = {},
): Promise<MessageRow> {
  const me = keystore.identity
  if (!me) throw new Error('Locked')
  const key = await getRoomKey(room.id, myId, room.key_version)
  const env = await encryptMessage(plaintext, key, { roomId: room.id, senderId: myId, keyVersion: room.key_version }, me)
  const { data, error } = await supabase
    .from('messages')
    .insert({
      room_id: room.id,
      sender_id: myId,
      ciphertext: env.ciphertext,
      nonce: env.nonce,
      signature: env.signature,
      key_version: env.keyVersion,
      expires_at: opts.expiresAt ?? null,
      burn_after_read: opts.burn ?? false,
    })
    .select()
    .single()
  fail(error)
  return data as MessageRow
}

/** Trust-on-first-use: remember a peer's key fingerprint and report if it later changes. */
export async function checkPeerKeyChange(peer: PeerInfo): Promise<'new' | 'same' | 'changed'> {
  const fp = await keyFingerprint({ encPublic: peer.enc_public_key, signPublic: peer.sign_public_key })
  try {
    const k = `dt:fp:${peer.id}`
    const old = localStorage.getItem(k)
    if (!old) {
      localStorage.setItem(k, fp)
      return 'new'
    }
    return old === fp ? 'same' : 'changed'
  } catch {
    return 'same'
  }
}

/** User confirmed the safety number out-of-band (or accepted new keys after doing so). */
export async function markPeerVerified(peer: PeerInfo): Promise<void> {
  const fp = await keyFingerprint({ encPublic: peer.enc_public_key, signPublic: peer.sign_public_key })
  try {
    localStorage.setItem(`dt:fp:${peer.id}`, fp)
    localStorage.setItem(`dt:verified:${peer.id}`, fp)
  } catch {
    /* storage unavailable: nothing to persist */
  }
}

/** Verified only while the stored verified fingerprint still matches the peer's current keys. */
export async function isPeerVerified(peer: PeerInfo): Promise<boolean> {
  const fp = await keyFingerprint({ encPublic: peer.enc_public_key, signPublic: peer.sign_public_key })
  try {
    return localStorage.getItem(`dt:verified:${peer.id}`) === fp
  } catch {
    return false
  }
}

// ------------------------------------------------------------------ projects

export interface ProjectInfo {
  id: string
  name: string
  ownerId: string
  members: PeerInfo[] // everyone in the project, including me
  chat: RoomInfo
  secrets: RoomInfo
}

export async function listProjects(): Promise<ProjectInfo[]> {
  const { data: projects, error } = await supabase.from('projects').select('*').order('created_at', { ascending: false })
  fail(error)
  if (!projects?.length) return []
  const ids = projects.map((p) => p.id)
  const [pm, rooms] = await Promise.all([
    supabase.from('project_members').select('project_id, user_id').in('project_id', ids),
    supabase.from('rooms').select('id, project_id, kind, key_version').in('project_id', ids),
  ])
  fail(pm.error)
  fail(rooms.error)
  const userIds = [...new Set((pm.data ?? []).map((m) => m.user_id))]
  const profiles = await supabase.from('profiles').select('id, username, enc_public_key, sign_public_key').in('id', userIds)
  fail(profiles.error)
  const out: ProjectInfo[] = []
  for (const p of projects) {
    const r = rooms.data?.filter((x) => x.project_id === p.id) ?? []
    const chat = r.find((x) => x.kind === 'chat')
    const secrets = r.find((x) => x.kind === 'secrets')
    if (!chat || !secrets) continue
    const members = (pm.data ?? [])
      .filter((m) => m.project_id === p.id)
      .map((m) => profiles.data?.find((u) => u.id === m.user_id))
      .filter((u): u is PeerInfo => !!u)
      .sort((a, b) => a.username.localeCompare(b.username))
    out.push({ id: p.id, name: p.name, ownerId: p.owner_id, members, chat, secrets })
  }
  return out
}

/** Create a project; fresh room keys are wrapped for each member (always including me, the owner). */
export async function createProject(me: ProfileRow, name: string, others: PeerInfo[]): Promise<string> {
  const chatKey = await newRoomKey()
  const secKey = await newRoomKey()
  const everyone = [{ id: me.id, enc_public_key: me.enc_public_key }, ...others.filter((o) => o.id !== me.id)]
  const p_members = await Promise.all(
    everyone.map(async (m) => ({
      user_id: m.id,
      chat_key: await wrapRoomKey(chatKey, m.enc_public_key),
      secrets_key: await wrapRoomKey(secKey, m.enc_public_key),
    })),
  )
  const { data, error } = await supabase.rpc('create_project', { p_name: name, p_members })
  fail(error)
  return data as string
}

/** Owner adds someone: re-wrap every key version I hold for them, so they can read history. */
export async function addProjectMember(me: ProfileRow, project: ProjectInfo, user: PeerInfo): Promise<void> {
  const p_keys: { room_id: string; key_version: number; wrapped: string }[] = []
  for (const room of [project.chat, project.secrets]) {
    for (const { version, key } of await allRoomKeys(room.id, me.id)) {
      p_keys.push({ room_id: room.id, key_version: version, wrapped: await wrapRoomKey(key, user.enc_public_key) })
    }
  }
  fail((await supabase.rpc('add_project_member', { p_project: project.id, p_user: user.id, p_keys })).error)
}

/** Owner removes someone: new room keys (next version) wrapped only for the people who stay. */
export async function removeProjectMember(project: ProjectInfo, user: PeerInfo): Promise<void> {
  const remaining = project.members.filter((m) => m.id !== user.id)
  const chatKey = await newRoomKey()
  const secKey = await newRoomKey()
  const p_new_keys: { user_id: string; room_id: string; wrapped: string }[] = []
  for (const m of remaining) {
    p_new_keys.push({ user_id: m.id, room_id: project.chat.id, wrapped: await wrapRoomKey(chatKey, m.enc_public_key) })
    p_new_keys.push({ user_id: m.id, room_id: project.secrets.id, wrapped: await wrapRoomKey(secKey, m.enc_public_key) })
  }
  fail((await supabase.rpc('remove_project_member', { p_project: project.id, p_user: user.id, p_new_keys })).error)
}

export const deleteProject = async (id: string) => fail((await supabase.rpc('delete_project', { p_project: id })).error)
