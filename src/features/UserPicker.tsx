import { useState, type FormEvent } from 'react'
import { findUsers, type PeerInfo } from '../lib/api'
import { Avatar, Icon } from '../ui/Icon'

/** Search for users (same rules as the chat search) and pick them with a button per result. */
export function UserPicker(props: {
  label: string
  exclude: string[] // user ids that must not be offered again
  actionLabel: string
  onPick: (p: PeerInfo) => void | Promise<void>
}) {
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
      setResults((await findUsers(q)).filter((p) => !props.exclude.includes(p.id)))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function pick(p: PeerInfo) {
    setError('')
    try {
      await props.onPick(p)
      setResults((cur) => cur?.filter((r) => r.id !== p.id) ?? null)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      <form className="field" onSubmit={search} role="search">
        <label className="lbl" htmlFor="pick-user">{props.label}</label>
        <div className="inwrap">
          <Icon name="search" className="lead" />
          <input
            id="pick-user"
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
          {busy && <span className="spin" aria-label="Searching" />}
        </div>
        {error ? (
          <span className="hint err" role="alert"><Icon name="warn" size="sm" />{error}</span>
        ) : (
          <span className="hint">Press Enter to search.</span>
        )}
      </form>
      {results && results.length === 0 && <p className="t-small muted" style={{ margin: 0 }}>No match.</p>}
      {results?.map((p) => (
        <div key={p.id} className="req" style={{ padding: '4px 0' }}>
          <Avatar name={p.username} small />
          <span className="who">@{p.username}</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void pick(p)}>{props.actionLabel}</button>
        </div>
      ))}
    </div>
  )
}
