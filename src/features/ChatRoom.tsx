import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ChatInfo, ProfileRow, RoomInfo } from '../lib/api'
import { EmojiPicker } from './EmojiPicker'
import { useRoom } from './useRoom'

// a message made only of 1-3 emoji is shown large
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*\s*){1,3}$/u

export function ChatRoom(props: { me: ProfileRow; chat: ChatInfo; room: RoomInfo }) {
  const { items, error, loading, send, peerTyping, notifyTyping } = useRoom(props.me, props.chat, props.room)
  const [text, setText] = useState('')
  const bottom = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [items.length, peerTyping])

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

  function insertEmoji(emoji: string) {
    const el = input.current
    const start = el?.selectionStart ?? text.length
    const end = el?.selectionEnd ?? text.length
    setText(text.slice(0, start) + emoji + text.slice(end))
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(start + emoji.length, start + emoji.length)
    })
    notifyTyping()
  }

  return (
    <>
      <div className="messages">
        {loading && <p className="muted">Decrypting…</p>}
        {items.map((m) => (
          <div
            key={m.id}
            className={'msg ' + (m.senderId === props.me.id ? 'mine' : 'theirs') + (m.text && EMOJI_ONLY.test(m.text) ? ' big' : '')}
          >
            {m.text === null ? <em className="err">⚠ could not verify or decrypt this message</em> : <span>{m.text}</span>}
            <time>{new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
          </div>
        ))}
        {peerTyping && (
          <div className="typing" aria-live="polite">
            @{props.chat.peer.username} is typing<span className="dots"><i>.</i><i>.</i><i>.</i></span>
          </div>
        )}
        <div ref={bottom} />
      </div>
      {error && <p className="err pad">{error}</p>}
      <form className="composer" onSubmit={submit}>
        <EmojiPicker onPick={insertEmoji} />
        <input
          ref={input}
          placeholder="Message (encrypted before it leaves this device)"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            if (e.target.value) notifyTyping()
          }}
          maxLength={4000}
          autoFocus
        />
        <button disabled={!text.trim()}>Send</button>
      </form>
    </>
  )
}
