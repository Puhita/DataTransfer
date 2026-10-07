import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { onOpenChat, startPush } from '../lib/push'
import {
  acceptChat,
  deleteChat,
  findUsers,
  deleteProject,
  listChats,
  listProjects,
  startChat,
  type ChatInfo,
  type PeerInfo,
  type ProjectInfo,
  type ProfileRow,
} from '../lib/api'
import { Avatar, Icon } from '../ui/Icon'
import { ChatView } from './ChatView'
import { NewProject } from './NewProject'
import { ProjectView } from './ProjectView'
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
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [showNewProject, setShowNewProject] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    try {
      const [c, p] = await Promise.all([listChats(me.id), listProjects()])
      setChats(c)
      setProjects(p)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [me.id])

  useEffect(() => {
    void reload()
    const ch = supabase
      .channel(`chats:${me.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chats' }, () => void reload())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, () => void reload())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'project_members' }, () => void reload())
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms' }, () => void reload())
      .subscribe()
    return () => void supabase.removeChannel(ch)
  }, [me.id, reload])

  // push notifications (Android app only): register this device, and open the chat when a notification is tapped
  useEffect(() => {
    void startPush()
    return onOpenChat(setSelected)
  }, [])

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
  const currentProject = projects.find((p) => p.id === selected) ?? null
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
    <div className="app" data-view={current || currentProject ? 'room' : 'list'}>
      <aside className="sidebar" aria-label="Chats">
        <div className="sb-head">
          <Avatar name={me.username} />
          <div className="flex1">
            <div style={{ fontWeight: 700, lineHeight: '20px' }}>@{me.username}</div>
            <div className="t-small muted">You</div>
          </div>
          <button className="iconbtn bordered" aria-label="Settings" onClick={() => setShowSettings(true)}>
            <Icon name="sliders" />
          </button>
          <button className="iconbtn bordered" aria-label="Lock now" onClick={props.onLock}>
            <Icon name="lock" />
          </button>
        </div>

        <FindUser
          me={me}
          onStarted={async (id) => {
            await reload()
            setSelected(id)
          }}
        />

        {error && (
          <div style={{ padding: '12px 16px 0' }}>
            <div className="banner banner-err" role="alert">
              <Icon name="warn" />
              <div className="body">{error}</div>
            </div>
          </div>
        )}

        {incoming.length > 0 && (
          <>
            <div className="sb-section">
              <span className="t-label">Requests</span>
              <span className="badge" aria-label={`${incoming.length} requests`}>{incoming.length}</span>
            </div>
            <div className="sb-list">
              {incoming.map((c) => (
                <div key={c.id} className="req">
                  <Avatar name={c.peer.username} small />
                  <span className="who">@{c.peer.username}</span>
                  <button className="btn btn-primary btn-sm" onClick={() => act(() => acceptChat(c.id))}>Accept</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => act(() => deleteChat(c.id))}>Decline</button>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="sb-section">
          <span className="t-label">Projects</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowNewProject(true)}>
            <Icon name="plus" size="sm" />
            New
          </button>
        </div>
        <div className="sb-list">
          {projects.length === 0 && <p className="t-small muted" style={{ margin: 0, padding: '4px 10px' }}>No projects yet. Create one to share a chat and secrets with a team.</p>}
          {projects.map((p) => (
            <button key={p.id} className="row" aria-current={p.id === selected ? 'true' : undefined} onClick={() => setSelected(p.id)}>
              <span className="avatar"><Icon name="users" /></span>
              <span className="grow">
                <div className="name">{p.name}</div>
                <div className="sub"><Icon name="lock" size="sm" />{p.members.length} members</div>
              </span>
              <Icon name="chevron" className="muted only-m" />
            </button>
          ))}
        </div>

        <div className="sb-section"><span className="t-label">Chats</span></div>
        <div className="sb-list">
          {rest.length === 0 && <p className="t-small muted" style={{ margin: 0, padding: '4px 10px' }}>No chats yet. Search for someone above.</p>}
          {rest.map((c) => (
            <button
              key={c.id}
              className={'row' + (c.status === 'pending' ? ' waiting' : '')}
              aria-current={c.id === selected ? 'true' : undefined}
              onClick={() => setSelected(c.id)}
            >
              <Avatar name={c.peer.username} />
              <span className="grow">
                <div className="name">@{c.peer.username}</div>
                <div className="sub">
                  {c.status === 'pending' ? (
                    <><Icon name="clock" size="sm" />Waiting for them to accept</>
                  ) : (
                    <><Icon name="lock" size="sm" />Chat and Secrets</>
                  )}
                </div>
              </span>
              <Icon name="chevron" className="muted only-m" />
            </button>
          ))}
        </div>

        <div className="lockstate">
          <Icon name="unlock" />
          Unlocked · locks after 15 min idle
        </div>
      </aside>

      {currentProject ? (
        <ProjectView
          key={currentProject.id}
          me={me}
          project={currentProject}
          onBack={() => setSelected(null)}
          onChanged={reload}
          onDelete={() => act(async () => { await deleteProject(currentProject.id); setSelected(null) })}
        />
      ) : current && current.status === 'active' ? (
        <ChatView
          key={current.id}
          me={me}
          chat={current}
          onBack={() => setSelected(null)}
          onDelete={() => act(async () => { await deleteChat(current.id); setSelected(null) })}
        />
      ) : (
        <main className="pane">
          <button className="btn btn-ghost only-m" style={{ alignSelf: 'flex-start', margin: 8 }} onClick={() => setSelected(null)}>
            <Icon name="back" />
            Chats
          </button>
          <div style={{ margin: 'auto', padding: 24, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            {current ? (
              <>
                <div className="round"><Icon name="clock" size="xl" /></div>
                <h2 className="t-h3" style={{ margin: 0 }}>Waiting for @{current.peer.username}</h2>
                <p className="t-body muted" style={{ margin: 0, maxWidth: 360 }}>
                  They need to accept your request before you can chat or share secrets.
                </p>
                <button className="btn btn-secondary" onClick={() => act(async () => { await deleteChat(current.id); setSelected(null) })}>
                  Cancel request
                </button>
              </>
            ) : (
              <>
                <div className="round"><Icon name="lock" size="xl" /></div>
                <p className="t-body muted" style={{ margin: 0 }}>Select a chat, or find someone to start one.</p>
              </>
            )}
          </div>
        </main>
      )}

      {showNewProject && (
        <NewProject
          me={me}
          onClose={() => setShowNewProject(false)}
          onCreated={async (id) => {
            setShowNewProject(false)
            await reload()
            setSelected(id)
          }}
        />
      )}

      {showSettings && (
        <Settings me={me} onClose={() => setShowSettings(false)} onProfile={props.onProfile} onLogout={props.onLogout} />
      )}
    </div>
  )
}

function FindUser(props: { me: ProfileRow; onStarted: (chatId: string) => void }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<PeerInfo[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function search(e: FormEvent) {
    e.preventDefault()
    if (q.trim().length < 3) return setError('Type at least 3 characters.')
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
    <div style={{ padding: '0 16px' }}>
      <form className="field" onSubmit={search} role="search">
        <label className="lbl sr-only" htmlFor="find">Find user</label>
        <div className="inwrap">
          <Icon name="search" className="lead" />
          <input
            id="find"
            className="input has-lead"
            placeholder="Username or exact email"
            enterKeyHint="search"
            autoComplete="off"
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              if (!e.target.value) setResults(null)
            }}
          />
          {busy ? (
            <span className="spin" aria-label="Searching" />
          ) : (
            q && (
              <button type="button" className="iconbtn" aria-label="Clear" onClick={() => { setQ(''); setResults(null); setError('') }}>
                <Icon name="close" />
              </button>
            )
          )}
        </div>
        {error ? (
          <span className="hint err" role="alert"><Icon name="warn" size="sm" />{error}</span>
        ) : (
          <span className="hint">Press Enter. Search by username, or by someone's exact email address.</span>
        )}
      </form>
      {results && (
        <div style={{ paddingTop: 8 }}>
          <span className="t-label">Result</span>
          {results.length === 0 && (
            <p className="t-small muted" style={{ margin: '6px 0 0' }}>
              No match. Email search needs the full address, and the person must allow it.
            </p>
          )}
          <div className="stack" style={{ gap: 2, marginTop: 4 }}>
            {results.map((p) => (
              <div key={p.id} className="req" style={{ padding: '8px 0' }}>
                <Avatar name={p.username} />
                <span className="who">@{p.username}</span>
                <button className="btn btn-primary btn-sm" onClick={() => start(p)}>Send request</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
