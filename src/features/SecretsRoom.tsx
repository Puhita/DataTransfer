import { useEffect, useRef, useState, type FormEvent } from 'react'
import { burnMessage, type ChatInfo, type Decoded, type ProfileRow, type RoomInfo } from '../lib/api'
import { Icon } from '../ui/Icon'
import { useRoom } from './useRoom'

interface SecretPayload {
  name: string
  value: string
  notes?: string
}

const EXPIRY: { label: string; hours: number | null }[] = [
  { label: 'Never expires', hours: null },
  { label: 'In 1 hour', hours: 1 },
  { label: 'In 24 hours', hours: 24 },
  { label: 'In 7 days', hours: 168 },
  { label: 'In 30 days', hours: 720 },
]

const CLIPBOARD_CLEAR_S = 30
const MASK = '•'.repeat(16) // fixed length so the mask never hints at the value's size

function parse(text: string | null): SecretPayload | null {
  if (text === null) return null
  try {
    const j = JSON.parse(text) as SecretPayload
    return typeof j.name === 'string' && typeof j.value === 'string' ? j : null
  } catch {
    return null
  }
}

const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })

export function SecretsRoom(props: { me: ProfileRow; chat: ChatInfo; room: RoomInfo }) {
  const { items, error, loading, send, setItems } = useRoom(props.me, props.chat, props.room)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [notes, setNotes] = useState('')
  const [expiry, setExpiry] = useState<number | null>(null)
  const [burn, setBurn] = useState(false)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now())
  // values the user revealed locally; kept even after the server copy is burned
  const [kept, setKept] = useState<Map<string, Decoded>>(new Map())
  const peer = props.chat.peer.username

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
    <div className="scroll-body">
      <div className="secrets-wrap">
        <div className="stack" style={{ gap: 4 }}>
          <h2 className="t-h2" style={{ margin: 0 }}>Secrets with @{peer}</h2>
          <p className="t-body muted" style={{ margin: 0 }}>Only the two of you can open these. Values stay masked until you reveal them.</p>
        </div>

        {loading && (
          <div className="scard" aria-busy="true">
            <div className="cluster"><span className="spin" /><span className="t-small muted" style={{ fontWeight: 600 }}>Decrypting…</span></div>
            <span className="skel" style={{ width: '40%' }} />
            <span className="skel" style={{ width: '100%', height: 44 }} />
          </div>
        )}

        {!loading && visible.length === 0 && (
          <div className="empty">
            <div className="round"><Icon name="key" size="xl" /></div>
            <h2 className="t-h3" style={{ margin: 0 }}>No secrets yet</h2>
            <p className="t-body muted" style={{ margin: 0, maxWidth: 440 }}>
              Share an API key or .env value with @{peer}. It's encrypted on your device and stays masked until they reveal it.
            </p>
          </div>
        )}

        {visible.map((m) => (
          <SecretItem
            key={m.id}
            m={m}
            mine={m.senderId === props.me.id}
            peer={peer}
            onReveal={async () => {
              if (m.burn && m.senderId !== props.me.id) {
                setKept((k) => new Map(k).set(m.id, m))
                await burnMessage(m.id)
                setItems((cur) => cur.filter((x) => x.id !== m.id))
              }
            }}
          />
        ))}

        {error && (
          <div className="banner banner-err" role="alert"><Icon name="warn" /><div className="body">{error}</div></div>
        )}

        <form className="compose" onSubmit={submit} style={{ marginTop: 12 }}>
          <div className="stack" style={{ gap: 4 }}>
            <h2 className="t-h3" style={{ margin: 0 }}>Send a secret</h2>
            <span className="hint"><Icon name="lock" size="sm" />Encrypted on this device. Only @{peer} can read it.</span>
          </div>
          <div className="field">
            <label className="lbl" htmlFor="n1">Name</label>
            <input id="n1" className="input mono" placeholder="STRIPE_TEST_KEY" required maxLength={120} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label className="lbl" htmlFor="n2">Value</label>
            <textarea id="n2" className="input mono" rows={4} placeholder="Paste a value or a whole .env block" required maxLength={50000} spellCheck={false} autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
          </div>
          <div className="field">
            <label className="lbl" htmlFor="n3">Notes <span className="opt">· optional</span></label>
            <textarea id="n3" className="input" rows={2} placeholder="Where it's used, when to rotate" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <div className="compose-grid">
            <div className="field">
              <label className="lbl" htmlFor="n4">Expiry</label>
              <div className="selectwrap">
                <select id="n4" className="input" value={expiry ?? ''} onChange={(e) => setExpiry(e.target.value ? Number(e.target.value) : null)}>
                  {EXPIRY.map((x) => <option key={x.label} value={x.hours ?? ''}>{x.label}</option>)}
                </select>
                <Icon name="down" />
              </div>
            </div>
            <div className="field">
              <span className="lbl">Burn after reveal</span>
              <label className="switch">
                <input type="checkbox" role="switch" checked={burn} onChange={(e) => setBurn(e.target.checked)} />
                <span className="track"><span className="thumb"><Icon name="check" /></span></span>
                <span className="txt">
                  <b>{burn ? 'On' : 'Off'}</b>
                  <span>{burn ? "Deleted from the server the first time it's revealed." : "Turn on to delete it from the server the first time it's revealed."}</span>
                </span>
              </label>
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className={'btn btn-primary' + (busy ? ' is-loading' : '')} type="submit" disabled={busy || !name.trim() || !value}>
              <Icon name="lock" />
              Send secret
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function SecretItem(props: { m: Decoded; mine: boolean; peer: string; onReveal: () => Promise<void> }) {
  const { m } = props
  const [shown, setShown] = useState(false)
  const [left, setLeft] = useState(0) // seconds until the clipboard is cleared; 0 = not copied
  const [err, setErr] = useState('')
  const timer = useRef<number>(0)
  const p = parse(m.text)

  const pending = useRef(false) // clipboard holds this secret and has not been cleared yet

  useEffect(
    () => () => {
      window.clearInterval(timer.current)
      if (pending.current) navigator.clipboard.writeText('').catch(() => {})
    },
    [],
  )

  if (!p)
    return (
      <article className="scard">
        <div className="banner banner-err" role="alert"><Icon name="warn" /><div className="body">This entry couldn't be verified or decrypted, so it isn't shown.</div></div>
      </article>
    )

  const burnOnReveal = m.burn && !props.mine
  const canCopy = shown || !burnOnReveal

  async function toggle() {
    setErr('')
    if (!shown) {
      try {
        await props.onReveal()
      } catch (e) {
        return setErr((e as Error).message)
      }
    }
    setShown(!shown)
  }

  async function copy() {
    setErr('')
    try {
      if (!shown) await props.onReveal()
      await navigator.clipboard.writeText(p!.value)
    } catch {
      return setErr('The browser blocked clipboard access.')
    }
    window.clearInterval(timer.current)
    pending.current = true
    let s = CLIPBOARD_CLEAR_S
    setLeft(s)
    timer.current = window.setInterval(() => {
      s -= 1
      setLeft(s)
      if (s <= 0) {
        window.clearInterval(timer.current)
        pending.current = false
        navigator.clipboard.writeText('').catch(() => {})
      }
    }, 1000)
  }

  return (
    <article className="scard">
      <div className="scard-head">
        <div>
          <h3 className="sname" style={{ margin: 0 }}>{p.name}</h3>
          <div className="smeta">from {props.mine ? 'you' : '@' + props.peer} · {when(m.createdAt)}</div>
        </div>
      </div>
      {(m.expiresAt || m.burn) && (
        <div className="tags">
          {m.expiresAt && <span className="tag tag-warn"><Icon name="clock" size="sm" />expires {when(m.expiresAt)}</span>}
          {m.burn && (
            <span className="tag tag-burn">
              <Icon name="flame" size="sm" />
              {props.mine ? 'deleted from server when they reveal it' : 'deleted from server on reveal'}
            </span>
          )}
        </div>
      )}
      <div className={'slab ' + (shown ? 'revealed' : 'masked')}>
        <Icon name={shown ? 'unlock' : 'lock'} />
        <span>{shown ? p.value : MASK}</span>
      </div>
      {p.notes && (
        <div className="snote"><span className="t-label">Notes</span>{p.notes}</div>
      )}
      <div className="sactions">
        <button className={'btn ' + (shown ? 'btn-secondary' : 'btn-primary')} onClick={toggle} aria-pressed={shown}>
          <Icon name={shown ? 'eyeOff' : 'eye'} />
          {shown ? 'Hide' : 'Reveal'}
        </button>
        <button className="btn btn-secondary" onClick={copy} disabled={!canCopy}>
          <Icon name={left > 0 ? 'check' : 'copy'} />
          {left > 0 ? 'Copied' : 'Copy'} <span className="sub">{left > 0 ? `clears in ${left}s` : `clears in ${CLIPBOARD_CLEAR_S}s`}</span>
        </button>
        {!canCopy && <span className="t-small muted">Reveal once to copy. It's deleted from the server when you do.</span>}
        {left > 0 && <span className="notice ok" role="status">The clipboard clears in {left}s.</span>}
        {err && <span className="hint err" role="alert"><Icon name="warn" size="sm" />{err}</span>}
      </div>
    </article>
  )
}
