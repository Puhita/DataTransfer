import { useEffect, useState, type FormEvent } from 'react'
import { burnMessage, type ChatInfo, type Decoded, type ProfileRow, type RoomInfo } from '../lib/api'
import { useRoom } from './useRoom'

interface SecretPayload {
  name: string
  value: string
  notes?: string
}

const EXPIRY: { label: string; hours: number | null }[] = [
  { label: 'Never expires', hours: null },
  { label: '1 hour', hours: 1 },
  { label: '24 hours', hours: 24 },
  { label: '7 days', hours: 168 },
]

const CLIPBOARD_CLEAR_MS = 30_000

function parse(text: string | null): SecretPayload | null {
  if (text === null) return null
  try {
    const j = JSON.parse(text) as SecretPayload
    return typeof j.name === 'string' && typeof j.value === 'string' ? j : null
  } catch {
    return null
  }
}

export function SecretsRoom(props: { me: ProfileRow; chat: ChatInfo; room: RoomInfo }) {
  const { items, error, loading, send, setItems } = useRoom(props.me, props.chat, props.room)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [notes, setNotes] = useState('')
  const [expiry, setExpiry] = useState<number | null>(null)
  const [burn, setBurn] = useState(false)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now())
  // values the user revealed locally; kept even if the server copy is burned
  const [kept, setKept] = useState<Map<string, Decoded>>(new Map())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const payload: SecretPayload = { name: name.trim(), value, notes: notes.trim() || undefined }
      await send(JSON.stringify(payload), {
        expiresAt: expiry ? new Date(Date.now() + expiry * 3600_000).toISOString() : null,
        burn,
      })
      setName('')
      setValue('')
      setNotes('')
      setBurn(false)
    } catch {
      /* error surfaced by hook */
    } finally {
      setBusy(false)
    }
  }

  const visible = [...items, ...[...kept.values()].filter((k) => !items.some((i) => i.id === k.id))].filter(
    (m) => !m.expiresAt || new Date(m.expiresAt).getTime() > now,
  )

  return (
    <>
      <div className="messages">
        <p className="muted small">
          Secrets are encrypted on your device with a key only you and @{props.chat.peer.username} hold. Values stay masked until you reveal them.
        </p>
        {loading && <p className="muted">Decrypting…</p>}
        {visible.map((m) => (
          <SecretItem
            key={m.id}
            m={m}
            mine={m.senderId === props.me.id}
            peer={props.chat.peer.username}
            onReveal={async () => {
              if (m.burn && m.senderId !== props.me.id) {
                setKept((k) => new Map(k).set(m.id, m))
                await burnMessage(m.id)
                setItems((cur) => cur.filter((x) => x.id !== m.id))
              }
            }}
          />
        ))}
        {!loading && visible.length === 0 && <p className="muted">No secrets shared yet.</p>}
      </div>
      {error && <p className="err pad">{error}</p>}
      <form className="secretform" onSubmit={submit}>
        <input placeholder="Name, e.g. STRIPE_API_KEY" required value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        <textarea placeholder="Value (or paste a whole .env block)" required rows={3} value={value} onChange={(e) => setValue(e.target.value)} maxLength={50000} spellCheck={false} autoComplete="off" />
        <input placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        <div className="row">
          <select value={expiry ?? ''} onChange={(e) => setExpiry(e.target.value ? Number(e.target.value) : null)}>
            {EXPIRY.map((x) => (
              <option key={x.label} value={x.hours ?? ''}>
                {x.label}
              </option>
            ))}
          </select>
          <label className="check">
            <input type="checkbox" checked={burn} onChange={(e) => setBurn(e.target.checked)} /> Delete after they reveal it
          </label>
          <span className="spacer" />
          <button disabled={busy || !name.trim() || !value}>Send secret</button>
        </div>
      </form>
    </>
  )
}

function SecretItem(props: { m: Decoded; mine: boolean; peer: string; onReveal: () => Promise<void> }) {
  const { m } = props
  const [shown, setShown] = useState(false)
  const [copied, setCopied] = useState(false)
  const p = parse(m.text)

  if (!p)
    return (
      <div className="secret">
        <em className="err">⚠ could not verify or decrypt this entry</em>
      </div>
    )

  async function reveal() {
    const next = !shown
    setShown(next)
    if (next) await props.onReveal().catch(() => {})
  }

  async function copy() {
    if (!shown) await props.onReveal().catch(() => {})
    try {
      await navigator.clipboard.writeText(p!.value)
      setCopied(true)
      setTimeout(() => {
        navigator.clipboard.writeText('').catch(() => {})
        setCopied(false)
      }, CLIPBOARD_CLEAR_MS)
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <div className="secret">
      <div className="row">
        <b>{p.name}</b>
        <span className="muted small">
          {props.mine ? 'you' : '@' + props.peer} · {new Date(m.createdAt).toLocaleString()}
        </span>
        <span className="spacer" />
        {m.expiresAt && <span className="tag">expires {new Date(m.expiresAt).toLocaleString()}</span>}
        {m.burn && <span className="tag warnTag">{props.mine ? 'burns after they reveal' : 'deleted from server on reveal'}</span>}
      </div>
      <pre className="value">{shown ? p.value : '•'.repeat(Math.min(24, Math.max(8, p.value.length)))}</pre>
      {p.notes && <p className="muted small">{p.notes}</p>}
      <div className="row">
        <button className="ghost small" onClick={reveal}>
          {shown ? 'Hide' : 'Reveal'}
        </button>
        <button className="ghost small" onClick={copy}>
          {copied ? 'Copied (clears in 30s)' : 'Copy'}
        </button>
      </div>
    </div>
  )
}
