import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ChatInfo, ProfileRow, RoomInfo } from '../lib/api'
import { useRoom } from './useRoom'

export function ChatRoom(props: { me: ProfileRow; chat: ChatInfo; room: RoomInfo }) {
  const { items, error, loading, send } = useRoom(props.me, props.chat, props.room)
  const [text, setText] = useState('')
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [items.length])

  async function submit(e: FormEvent) {
    e.preventDefault()
    const t = text.trim()
    if (!t) return
    setText('')
    try {
      await send(t)
    } catch {
      setText(t)
    }
  }

  return (
    <>
      <div className="messages">
        {loading && <p className="muted">Decrypting…</p>}
        {items.map((m) => (
          <div key={m.id} className={'msg ' + (m.senderId === props.me.id ? 'mine' : 'theirs')}>
            {m.text === null ? <em className="err">⚠ could not verify or decrypt this message</em> : <span>{m.text}</span>}
            <time>{new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      {error && <p className="err pad">{error}</p>}
      <form className="composer" onSubmit={submit}>
        <input placeholder="Message (encrypted before it leaves this device)" value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} autoFocus />
        <button disabled={!text.trim()}>Send</button>
      </form>
    </>
  )
}
