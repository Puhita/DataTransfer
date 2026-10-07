import { useCallback, useEffect, useState } from 'react'
import {
  addProjectMember,
  checkPeerKeyChange,
  markPeerVerified,
  removeProjectMember,
  type PeerInfo,
  type ProfileRow,
  type ProjectInfo,
} from '../lib/api'
import { Avatar, Icon } from '../ui/Icon'
import { ChatRoom } from './ChatRoom'
import { SecretsRoom } from './SecretsRoom'
import { UserPicker } from './UserPicker'

export function ProjectView(props: {
  me: ProfileRow
  project: ProjectInfo
  onBack: () => void
  onChanged: () => Promise<void>
  onDelete: () => void
}) {
  const { me, project } = props
  const isOwner = project.ownerId === me.id
  const [tab, setTab] = useState<'chat' | 'secrets'>('chat')
  const [showMembers, setShowMembers] = useState(false)
  const [changed, setChanged] = useState<PeerInfo[]>([])
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState('')

  const others = project.members.filter((m) => m.id !== me.id)

  // trust-on-first-use per member: warn when someone's keys differ from what we saw before
  const refreshKeys = useCallback(async () => {
    const res = await Promise.all(others.map(async (m) => ((await checkPeerKeyChange(m)) === 'changed' ? m : null)))
    setChanged(res.filter((m): m is PeerInfo => !!m))
  }, [others.map((m) => m.id + m.enc_public_key + m.sign_public_key).join('|')])

  useEffect(() => {
    void refreshKeys()
  }, [refreshKeys])

  async function trustChanged() {
    await Promise.all(changed.map(markPeerVerified))
    setChanged([])
  }

  async function run(fn: () => Promise<void>) {
    setError('')
    try {
      await fn()
      await props.onChanged()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const secrets = tab === 'secrets'
  const title = project.name

  return (
    <main className={'pane' + (secrets ? ' vault' : '')} data-space={secrets ? 'secrets' : undefined}>
      <header className="pane-head">
        <div className="top">
          <button className="iconbtn only-m" aria-label="Back to chats" onClick={props.onBack}>
            <Icon name="back" />
          </button>
          <span className="avatar"><Icon name="users" /></span>
          <div className="nm">
            <h1 className="t-h3" style={{ margin: 0 }}>{project.name}</h1>
            <div className="msub only-m">
              <Icon name="lock" size="sm" style={{ color: 'var(--accent)' }} />
              {project.members.length} members · encrypted
            </div>
          </div>
          <span className="pill only-d"><Icon name="lock" size="sm" />End-to-end encrypted</span>
          <button className="btn btn-secondary btn-sm only-d" onClick={() => setShowMembers(true)}>
            <Icon name="users" size="sm" />
            {project.members.length} members
          </button>
          <button className="iconbtn bordered only-m" aria-label="Members" onClick={() => setShowMembers(true)}>
            <Icon name="users" />
          </button>
        </div>
        <div className="tabbar" role="tablist">
          <button className="tab" role="tab" aria-selected={!secrets} onClick={() => setTab('chat')}>Chat</button>
          <button className="tab" role="tab" aria-selected={secrets} onClick={() => setTab('secrets')}>
            <Icon name="key" />
            Secrets
          </button>
        </div>
      </header>

      {changed.length > 0 && (
        <div style={{ padding: '16px 24px 0' }} className="banner-wrap">
          <div className="banner banner-warn" role="alert">
            <Icon name="warn" size="lg" />
            <div className="body">
              <b>Keys changed.</b> {changed.map((m) => '@' + m.username).join(', ')} {changed.length === 1 ? 'has' : 'have'} different
              encryption keys than before. Confirm with them before you trust the new keys.
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => void trustChanged()}>I verified, trust new keys</button>
          </div>
        </div>
      )}

      {secrets ? (
        <SecretsRoom key={project.secrets.id} me={me} members={project.members} room={project.secrets} title={title} group />
      ) : (
        <ChatRoom key={project.chat.id} me={me} members={project.members} room={project.chat} title={title} group />
      )}

      {showMembers && (
        <div className="scrim" style={{ position: 'fixed', inset: 0, zIndex: 20 }} onClick={() => setShowMembers(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="pm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div className="stack" style={{ gap: 6 }}>
                <h2 id="pm" className="t-h2" style={{ margin: 0 }}>{project.name}</h2>
                <p className="t-body muted" style={{ margin: 0 }}>
                  Everyone listed can read this project's chat and secrets, including everything shared before they joined.
                </p>
              </div>
              <button className="iconbtn" aria-label="Close" onClick={() => setShowMembers(false)}><Icon name="close" /></button>
            </div>

            <div className="stack" style={{ gap: 4 }}>
              <span className="t-label">Members · {project.members.length}</span>
              {project.members.map((m) => (
                <div key={m.id} className="req" style={{ padding: '6px 0' }}>
                  <Avatar name={m.username} small />
                  <span className="who">
                    @{m.username}
                    {m.id === me.id && <span className="muted"> · you</span>}
                    {m.id === project.ownerId && <span className="muted"> · owner</span>}
                  </span>
                  {isOwner && m.id !== me.id &&
                    (confirmRemove === m.id ? (
                      <>
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => run(async () => { await removeProjectMember(project, m); setConfirmRemove(null) })}
                        >
                          Remove
                        </button>
                        <button className="btn btn-secondary btn-sm" onClick={() => setConfirmRemove(null)}>Keep</button>
                      </>
                    ) : (
                      <button className="btn btn-secondary btn-sm" onClick={() => setConfirmRemove(m.id)}>Remove</button>
                    ))}
                </div>
              ))}
              {isOwner && confirmRemove && (
                <p className="t-small muted" style={{ margin: 0 }}>
                  New keys are created for the people who stay, so they can't read anything new. They may still have copies of what they already saw.
                </p>
              )}
            </div>

            {isOwner && (
              <UserPicker
                label="Add people"
                exclude={project.members.map((m) => m.id)}
                actionLabel="Add"
                onPick={async (p) => {
                  await addProjectMember(me, project, p)
                  await props.onChanged()
                }}
              />
            )}

            {error && (
              <div className="banner banner-err" role="alert"><Icon name="warn" /><div className="body">{error}</div></div>
            )}

            {isOwner && (
              <div className="danger">
                <div className="stack" style={{ gap: 4 }}>
                  <h3 className="t-body" style={{ margin: 0, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Icon name="trash" style={{ color: 'var(--err)' }} />
                    Delete project
                  </h3>
                  <p className="t-small" style={{ margin: 0 }}>
                    Removes the project, its chat and all its secrets for every member. This can't be undone.
                  </p>
                </div>
                <div className="cluster">
                  {confirmDelete ? (
                    <>
                      <button className="btn btn-danger" onClick={props.onDelete}>Yes, delete it</button>
                      <button className="btn btn-secondary" onClick={() => setConfirmDelete(false)}>Keep project</button>
                    </>
                  ) : (
                    <button className="btn btn-danger-outline" onClick={() => setConfirmDelete(true)}>
                      <Icon name="trash" />
                      Delete project
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  )
}
