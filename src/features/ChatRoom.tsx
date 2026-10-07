import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { Decoded, PeerInfo, ProfileRow, RoomInfo } from '../lib/api'
import { Icon } from '../ui/Icon'
import { EmojiPicker } from './EmojiPicker'
import { useRoom } from './useRoom'

// a message made only of 1-3 emoji is shown large
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier})*\s*){1,3}$/u

const dayLabel = (iso: string) => {
  const d = new Date(iso)
  const today = new Date()
  const yest = new Date()
  yest.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yest.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** `title` is what the room is called in copy: '@bob' for a 1:1 chat, the project name for a group. */
export function ChatRoom(props: { me: ProfileRow; members: PeerInfo[]; room: RoomInfo; title: string; group?: boolean }) {
  const { items, error, loading, send, typing, notifyTyping } = useRoom(props.me, props.members, props.room)
  const [text, setText] = useState('')
  const bottom = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const title = props.title
  const nameOf = (id: string) => '@' + (props.members.find((m) => m.id === id)?.username ?? 'unknown')

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [items.length, loading, typing.length])

  async function submit(e?: FormEvent) {
    e?.preventDefault()
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

  const typingLabel =
    typing.length === 0
      ? ''
      : typing.length === 1
        ? `${nameOf(typing[0])} is typing`
        : typing.length === 2
          ? `${nameOf(typing[0])} and ${nameOf(typing[1])} are typing`
          : 'Several people are typing'

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  let lastDay = ''
  const rows = items.map((m: Decoded) => {
    const day = dayLabel(m.createdAt)
    const sep = day !== lastDay ? <span className="daysep" key={'d' + m.id}>{day}</span> : null
    lastDay = day
    const mine = m.senderId === props.me.id
    return [
      sep,
      m.text === null ? (
        <div className="msg fail" role="alert" key={m.id}>
          <div className="ttl"><Icon name="warn" />Signature check failed</div>
          <p>This message couldn't be verified as sent by {mine ? 'you' : nameOf(m.senderId)}, so it isn't shown.</p>
          <span className="meta" style={{ color: 'var(--muted)' }}>{time(m.createdAt)}</span>
        </div>
      ) : (
        <div key={m.id} className={'msg ' + (mine ? 'mine' : 'theirs') + (EMOJI_ONLY.test(m.text) ? ' big' : '')}>
          {props.group && !mine && <span className="sender">{nameOf(m.senderId)}</span>}
          {m.text}
          <span className="meta">{time(m.createdAt)}</span>
        </div>
      ),
    ]
  })

  return (
    <>
      <div className="msgs" aria-live="polite">
        {loading && (
          <div className="msg theirs loading" aria-busy="true">
            <div className="state"><span className="spin" />Decrypting…</div>
            <span className="skel" style={{ width: '100%' }} />
            <span className="skel" style={{ width: '58%' }} />
          </div>
        )}
        {!loading && items.length === 0 && (
          <p className="t-body muted" style={{ margin: 'auto', textAlign: 'center' }}>
            No messages yet. Say hi to {title}. Everything here is encrypted on your device first.
          </p>
        )}
        {rows}
        {typingLabel && (
          <div className="typing" role="status">
            {typingLabel}<span className="dots"><i>.</i><i>.</i><i>.</i></span>
          </div>
        )}
        <div ref={bottom} />
      </div>
      {error && (
        <div style={{ padding: '0 24px 8px' }}>
          <div className="banner banner-err" role="alert"><Icon name="warn" /><div className="body">{error}</div></div>
        </div>
      )}
      <form className="composer" onSubmit={submit}>
        <EmojiPicker onPick={insertEmoji} />
        <textarea
          ref={input}
          className="input"
          rows={1}
          placeholder={`Message ${title}`}
          aria-label="Message"
          maxLength={4000}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            if (e.target.value) notifyTyping()
          }}
          onKeyDown={onKey}
        />
        <button className="btn btn-primary" disabled={!text.trim()} aria-label="Send">
          <Icon name="send" />
          <span className="only-d">Send</span>
        </button>
      </form>
    </>
  )
}
