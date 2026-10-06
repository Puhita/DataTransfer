import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import {
  acceptChat,
  deleteChat,
  findUsers,
  listChats,
  startChat,
  type ChatInfo,
  type PeerInfo,
  type ProfileRow,
} from '../lib/api'
import { ChatView } from './ChatView'
import { Settings } from './Settings'

const IDLE_LOCK_MS = 15 * 60 * 1000

export function Main(props: {
  session: Session
  profile: ProfileRow
  onProfile: (p: ProfileRow) => void
  onLock: () => void
  onLogout: () => void
}) {
  const me = props.profile
  const [chats, setChats] = useState<ChatInfo[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [error, setError] = useState('')
  const [navOpen, setNavOpen] = useState(true)

  const reload = useCallback(async () => {
    try {
      setChats(await listChats(me.id))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [me.id])

  useEffect(() => {
    void reload()
    const ch = supabase
      .channel(`chats:${me.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chats' }, () => void reload())
      .subscribe()
    return () => void supabase.removeChannel(ch)
  }, [me.id, reload])

  // auto-lock after inactivity
  const timer = useRef<number>(0)
  useEffect(() => {
    const bump = () => {
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(props.onLock, IDLE_LOCK_MS)
    }
    const evs = ['mousemove', 'keydown', 'click', 'touchstart'] as const
    evs.forEach((e) => window.addEventListener(e, bump))
    bump()
    return () => {
      window.clearTimeout(timer.current)
      evs.forEach((e) => window.removeEventListener(e, bump))
    }
  }, [props.onLock])

  const current = chats.find((c) => c.id === selected) ?? null
  const incoming = chats.filter((c) => c.incoming)
  const rest = chats.filter((c) => !c.incoming)

  async function act(fn: () => Promise<void>) {
    setError('')
    try {
      await fn()
      await reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="app">
      <aside className={navOpen ? 'side open' : 'side'}>
        <header>
          <b>@{me.username}</b>
          <span className="spacer" />
          <button className="ghost" title="Settings" onClick={() => setShowSettings(true)}>
            ⚙
          </button>
          <button className="ghost" title="Lock" onClick={props.onLock}>
            🔒
          </button>
        </header>

        <NewChat
          me={me}
          onStarted={async (id) => {
            await reload()
            setSelected(id)
            setNavOpen(false)
          }}
        />

        {error && <p className="err pad">{error}</p>}

        {incoming.length > 0 && (
          <section>
            <h3>Requests</h3>
            {incoming.map((c) => (
              <div key={c.id} className="request">
                <span>@{c.peer.username}</span>
                <button onClick={() => act(() => acceptChat(c.id))}>Accept</button>
                <button className="ghost" onClick={() => act(() => deleteChat(c.id))}>
                  Decline
                </button>
              </div>
            ))}
          </section>
        )}

        <section>
          <h3>Chats</h3>
          {rest.length === 0 && <p className="muted pad">No chats yet. Search for someone above.</p>}
          {rest.map((c) => (
            <div
              key={c.id}
              className={'chatitem' + (c.id === selected ? ' active' : '')}
              onClick={() => {
                setSelected(c.id)
                setNavOpen(false)
              }}
            >
              @{c.peer.username}
              {c.status === 'pending' && <em> · waiting</em>}
            </div>
          ))}
        </section>
      </aside>

      <main className="pane">
        <button className="ghost back" onClick={() => setNavOpen(true)}>
          ← Chats
        </button>
        {current && current.status === 'active' ? (
          <ChatView key={current.id} me={me} chat={current} onDelete={() => act(async () => { await deleteChat(current.id); setSelected(null); setNavOpen(true) })} />
        ) : current ? (
          <div className="empty">
            Waiting for @{current.peer.username} to accept.{' '}
            <button className="ghost" onClick={() => act(async () => { await deleteChat(current.id); setSelected(null) })}>
              Cancel request
            </button>
          </div>
        ) : (
          <div className="empty">Select or start a chat.</div>
        )}
      </main>

      {showSettings && (
        <Settings me={me} onClose={() => setShowSettings(false)} onProfile={props.onProfile} onLogout={props.onLogout} />
      )}
    </div>
  )
}

function NewChat(props: { me: ProfileRow; onStarted: (chatId: string) => void }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<PeerInfo[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function search(e: FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      setResults(await findUsers(q))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function start(p: PeerInfo) {
    setError('')
    try {
      const id = await startChat(props.me, p)
      setResults(null)
      setQ('')
      props.onStarted(id)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <form className="search" onSubmit={search}>
      <input placeholder="Find by username or exact email" value={q} onChange={(e) => setQ(e.target.value)} />
      <button disabled={busy || q.trim().length < 3}>Find</button>
      {error && <p className="err">{error}</p>}
      {results && results.length === 0 && <p className="muted small">No match. Email search needs the full address and the person must allow it.</p>}
      {results?.map((p) => (
        <div key={p.id} className="request">
          <span>@{p.username}</span>
          <button type="button" onClick={() => start(p)}>
            Start chat
          </button>
        </div>
      ))}
    </form>
  )
}
