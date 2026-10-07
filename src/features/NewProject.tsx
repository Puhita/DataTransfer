import { useState, type FormEvent } from 'react'
import { createProject, type PeerInfo, type ProfileRow } from '../lib/api'
import { Avatar, Icon } from '../ui/Icon'
import { UserPicker } from './UserPicker'

export function NewProject(props: { me: ProfileRow; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('')
  const [members, setMembers] = useState<PeerInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      props.onCreated(await createProject(props.me, name.trim(), members))
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="scrim" style={{ position: 'fixed', inset: 0, zIndex: 20 }} onClick={props.onClose}>
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="np" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="stack" style={{ gap: 6 }}>
            <h2 id="np" className="t-h2" style={{ margin: 0 }}>New project</h2>
            <p className="t-body muted" style={{ margin: 0 }}>
              A project has its own chat and secrets, shared with everyone you add. You can add or remove people later.
            </p>
          </div>
          <button type="button" className="iconbtn" aria-label="Close" onClick={props.onClose}><Icon name="close" /></button>
        </div>

        <div className="field">
          <label className="lbl" htmlFor="pname">Project name</label>
          <input id="pname" className="input" required maxLength={60} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div className="stack" style={{ gap: 8 }}>
          <span className="t-label">Members</span>
          <div className="req" style={{ padding: '4px 0' }}>
            <Avatar name={props.me.username} small />
            <span className="who">@{props.me.username} <span className="muted">· you, owner</span></span>
          </div>
          {members.map((m) => (
            <div key={m.id} className="req" style={{ padding: '4px 0' }}>
              <Avatar name={m.username} small />
              <span className="who">@{m.username}</span>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMembers((cur) => cur.filter((x) => x.id !== m.id))}>Remove</button>
            </div>
          ))}
          <UserPicker
            label="Add people"
            exclude={[props.me.id, ...members.map((m) => m.id)]}
            actionLabel="Add"
            onPick={(p) => setMembers((cur) => [...cur, p])}
          />
        </div>

        {error && (
          <div className="banner banner-err" role="alert"><Icon name="warn" /><div className="body">{error}</div></div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn btn-secondary" onClick={props.onClose}>Cancel</button>
          <button className={'btn btn-primary' + (busy ? ' is-loading' : '')} disabled={busy || !name.trim()}>
            Create project
          </button>
        </div>
      </form>
    </div>
  )
}
