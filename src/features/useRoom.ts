import { useCallback, useEffect, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import {
  decodeRow,
  fetchRoomMessages,
  sendEncrypted,
  type Decoded,
  type MessageRow,
  type PeerInfo,
  type ProfileRow,
  type RoomInfo,
} from '../lib/api'

/** Loads, decrypts and live-updates one room. Plaintext exists only in this hook's state. */
export function useRoom(me: ProfileRow, members: PeerInfo[], room: RoomInfo) {
  const [items, setItems] = useState<Decoded[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const seen = useRef(new Set<string>())
  const channel = useRef<RealtimeChannel | null>(null)
  const lastTypingSent = useRef(0)
  const typingTimers = useRef(new Map<string, number>())
  const [typing, setTyping] = useState<string[]>([]) // user ids currently typing

  // depend on the signing keys themselves, not the array identity, so list reloads don't refetch the room
  const keyMap = members.map((m) => m.id + ':' + m.sign_public_key).join('|')
  const signKeyOf = useCallback(
    (senderId: string) => {
      if (senderId === me.id) return me.sign_public_key
      const hit = keyMap.split('|').find((e) => e.startsWith(senderId + ':'))
      return hit?.slice(senderId.length + 1)
    },
    [me.id, me.sign_public_key, keyMap],
  )

  const stopTyping = useCallback((uid: string) => {
    window.clearTimeout(typingTimers.current.get(uid))
    typingTimers.current.delete(uid)
    setTyping((cur) => (cur.includes(uid) ? cur.filter((x) => x !== uid) : cur))
  }, [])

  const add = useCallback(
    async (row: MessageRow) => {
      if (seen.current.has(row.id)) return
      seen.current.add(row.id)
      const d = await decodeRow(row, me.id, signKeyOf(row.sender_id))
      stopTyping(row.sender_id)
      setItems((cur) => [...cur, d])
    },
    [me.id, signKeyOf, stopTyping],
  )

  useEffect(() => {
    let alive = true
    seen.current = new Set()
    setItems([])
    setLoading(true)
    ;(async () => {
      try {
        const rows = await fetchRoomMessages(room.id)
        const decoded = await Promise.all(rows.map((r) => decodeRow(r, me.id, signKeyOf(r.sender_id))))
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
      .on('broadcast', { event: 'typing' }, (p) => {
        // payload carries only the sender's user id, never content; only known members count
        const uid = (p.payload as { u?: string } | undefined)?.u
        if (!uid || uid === me.id || !signKeyOf(uid)) return
        setTyping((cur) => (cur.includes(uid) ? cur : [...cur, uid]))
        window.clearTimeout(typingTimers.current.get(uid))
        typingTimers.current.set(uid, window.setTimeout(() => stopTyping(uid), 4000))
      })
      .subscribe()
    channel.current = ch
    const timers = typingTimers.current
    return () => {
      alive = false
      timers.forEach((t) => window.clearTimeout(t))
      timers.clear()
      setTyping([])
      channel.current = null
      void supabase.removeChannel(ch)
    }
  }, [room.id, me.id, signKeyOf, add, stopTyping])

  /** Tell the others we are typing (throttled to once per 2s). */
  const notifyTyping = useCallback(() => {
    const now = Date.now()
    if (now - lastTypingSent.current < 2000) return
    lastTypingSent.current = now
    void channel.current?.send({ type: 'broadcast', event: 'typing', payload: { u: me.id } })
  }, [me.id])

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

  return { items, error, loading, send, setItems, typing, notifyTyping }
}
