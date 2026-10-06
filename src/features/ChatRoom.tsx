import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { ChatInfo, Decoded, ProfileRow, RoomInfo } from '../lib/api'
import { Icon } from '../ui/Icon'
import { useRoom } from './useRoom'

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

export function ChatRoom(props: { me: ProfileRow; chat: ChatInfo; room: RoomInfo }) {
  const { items, error, loading, send } = useRoom(props.me, props.chat, props.room)
  const [text, setText] = useState('')
  const bottom = useRef<HTMLDivElement>(null)
  const peer = props.chat.peer.username

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [items.length, loading])

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
          <p>This message couldn't be verified as sent by {mine ? 'you' : '@' + peer}, so it isn't shown.</p>
          <span className="meta" style={{ color: 'var(--muted)' }}>{time(m.createdAt)}</span>
        </div>
      ) : (
        <div key={m.id} className={'msg ' + (mine ? 'mine' : 'theirs')}>
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
            No messages yet. Say hi to @{peer}. Everything here is encrypted on your device first.
          </p>
        )}
        {rows}
        <div ref={bottom} />
      </div>
      {error && (
        <div style={{ padding: '0 24px 8px' }}>
          <div className="banner banner-err" role="alert"><Icon name="warn" /><div className="body">{error}</div></div>
        </div>
      )}
      <form className="composer" onSubmit={submit}>
        <textarea
          className="input"
          rows={1}
          placeholder={`Message @${peer}`}
          aria-label="Message"
          maxLength={4000}
          value={text}
          onChange={(e) => setText(e.target.value)}
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
