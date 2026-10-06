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

export async function getRoomKey(roomId: string, myId: string): Promise<Uint8Array> {
  const cached = keystore.roomKey(roomId)
  if (cached) return cached
  const me = keystore.identity
  if (!me) throw new Error('Locked')
  const { data, error } = await supabase
    .from('room_members')
    .select('wrapped_room_key')
    .eq('room_id', roomId)
    .eq('user_id', myId)
    .single()
  fail(error)
  const key = await unwrapRoomKey(data!.wrapped_room_key, me)
  keystore.setRoomKey(roomId, key)
  return key
}

export async function decodeRow(
  row: MessageRow,
  roomKey: Uint8Array,
  senderSignPublic: string | undefined,
): Promise<Decoded> {
  let text: string | null = null
  if (senderSignPublic) {
    try {
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
  const key = await getRoomKey(room.id, myId)
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

export async function acceptPeerKeyChange(peer: PeerInfo): Promise<void> {
  const fp = await keyFingerprint({ encPublic: peer.enc_public_key, signPublic: peer.sign_public_key })
  try {
    localStorage.setItem(`dt:fp:${peer.id}`, fp)
  } catch {
    /* storage unavailable: nothing to persist */
  }
}
