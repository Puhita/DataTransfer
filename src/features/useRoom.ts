import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import {
  decodeRow,
  fetchRoomMessages,
  getRoomKey,
  sendEncrypted,
  type ChatInfo,
  type Decoded,
  type MessageRow,
  type ProfileRow,
  type RoomInfo,
} from '../lib/api'

/** Loads, decrypts and live-updates one room. Plaintext exists only in this hook's state. */
export function useRoom(me: ProfileRow, chat: ChatInfo, room: RoomInfo) {
  const [items, setItems] = useState<Decoded[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const seen = useRef(new Set<string>())

  const signKeyOf = useCallback(
    (senderId: string) => (senderId === me.id ? me.sign_public_key : senderId === chat.peer.id ? chat.peer.sign_public_key : undefined),
    [me.id, me.sign_public_key, chat.peer.id, chat.peer.sign_public_key],
  )

  const add = useCallback(
    async (row: MessageRow) => {
      if (seen.current.has(row.id)) return
      seen.current.add(row.id)
      const key = await getRoomKey(room.id, me.id)
      const d = await decodeRow(row, key, signKeyOf(row.sender_id))
      setItems((cur) => [...cur, d])
    },
    [room.id, me.id, signKeyOf],
  )

  useEffect(() => {
    let alive = true
    seen.current = new Set()
    setItems([])
    setLoading(true)
    ;(async () => {
      try {
        const rows = await fetchRoomMessages(room.id)
        const key = await getRoomKey(room.id, me.id)
        const decoded = await Promise.all(rows.map((r) => decodeRow(r, key, signKeyOf(r.sender_id))))
        if (!alive) return
        rows.forEach((r) => seen.current.add(r.id))
        setItems(decoded)
      } catch (e) {
        if (alive) setError((e as Error).message)
      } finally {
        if (alive) setLoading(false)
      }
    })()

    const ch = supabase
      .channel(`room:${room.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `room_id=eq.${room.id}` }, (p) =>
        void add(p.new as MessageRow).catch((e) => setError((e as Error).message)),
      )
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, (p) => {
        const id = (p.old as { id?: string }).id
        if (id) setItems((cur) => cur.filter((m) => m.id !== id))
      })
      .subscribe()
    return () => {
      alive = false
      void supabase.removeChannel(ch)
    }
  }, [room.id, me.id, signKeyOf, add])

  const send = useCallback(
    async (plaintext: string, opts?: { expiresAt?: string | null; burn?: boolean }) => {
      setError('')
      try {
        await add(await sendEncrypted(room, me.id, plaintext, opts))
      } catch (e) {
        setError((e as Error).message)
        throw e
      }
    },
    [room, me.id, add],
  )

  return { items, error, loading, send, setItems }
}
