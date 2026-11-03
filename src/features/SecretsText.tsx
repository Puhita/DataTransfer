import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import type { Decoded } from '../lib/api'
import { isEnvName, parseEnv, planChanges, serializeEnv, type Existing } from '../lib/envText'
import { exportName, exportTextFile } from '../lib/exportFile'
import { Icon } from '../ui/Icon'
import { CLIPBOARD_CLEAR_S, useClipboardClear } from './useClipboardClear'

const MAX_FILE_BYTES = 200_000

export interface TextSecret {
  m: Decoded
  name: string
  value: string
  notes?: string
}

/** The secrets of one room as editable .env text. Saving adds new lines and updates changed ones; it never deletes. */
export function SecretsText(props: {
  title: string
  /** Readable secrets, newest first. */
  secrets: TextSecret[]
  /** Burn-after-reveal secrets nobody has revealed yet: left out so reading them here cannot skip the burn. */
  hiddenBurn: number
  loading: boolean
  /** True when the Cards form has an expiry or burn setting that new and updated secrets will inherit. */
  usesOptions: boolean
  add: (name: string, value: string, notes?: string) => Promise<void>
  replace: (old: TextSecret, value: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [synced, setSynced] = useState<string | null>(null) // the text we last put in the editor from the room
  const [stale, setStale] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const file = useRef<HTMLInputElement>(null)
  const clip = useClipboardClear()

  const envable = useMemo(() => props.secrets.filter((s) => isEnvName(s.name)), [props.secrets])
  const unwritable = props.secrets.length - envable.length
  const base = useMemo(() => serializeEnv(envable.map((s) => ({ name: s.name, value: s.value }))), [envable])

  // Follow the room while the user has not edited; if they have, only offer a reload.
  useEffect(() => {
    if (!open || saving) return
    if (synced === null || text === synced) {
      setText(base)
      setSynced(base)
    } else if (base !== synced) {
      setStale(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, open])

  const parsed = useMemo(() => parseEnv(text), [text])
  const existing: Existing[] = useMemo(() => envable.map((s) => ({ id: s.m.id, name: s.name, value: s.value, notes: s.notes })), [envable])
  const plan = useMemo(() => planChanges(existing, parsed.entries), [existing, parsed.entries])
  const changes = plan.add.length + plan.change.length
  const dirty = synced !== null && text !== synced

  function reveal() {
    setErr('')
    setMsg('')
    setSynced(base)
    setText(base)
    setStale(false)
    setOpen(true)
  }

  function hide() {
    setOpen(false)
    setSynced(null)
    setStale(false)
    setMsg('')
    setErr('')
  }

  async function upload(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = '' // lets the same file be chosen again
    if (!f) return
    setErr('')
    setMsg('')
    if (f.size > MAX_FILE_BYTES) return setErr(`That file is ${Math.round(f.size / 1000)} KB. The limit is ${MAX_FILE_BYTES / 1000} KB.`)
    const content = await f.text()
    if (content.includes('\u0000')) return setErr('That looks like a binary file, not text.')
    const added = parseEnv(content).entries.length
    setText((t) => t + (t && !t.endsWith('\n') ? '\n' : '') + content)
    setMsg(`Added ${f.name} to the text (${added} ${added === 1 ? 'entry' : 'entries'}). Review it, then save.`)
  }

  async function save() {
    setErr('')
    setMsg('')
    if (plan.change.length) {
      const names = plan.change.map((c) => c.entry.name).join(', ')
      if (!window.confirm(`Update ${plan.change.length} existing ${plan.change.length === 1 ? 'secret' : 'secrets'} (${names})? The old versions are deleted for everyone in this room.`)) return
    }
    setSaving(true)
    let done = 0
    try {
      for (const e of plan.add) {
        await props.add(e.name, e.value)
        done++
      }
      for (const c of plan.change) {
        const old = props.secrets.find((s) => s.m.id === c.old.id)
        if (old) await props.replace(old, c.entry.value)
        done++
      }
      setSynced(text)
      setStale(false)
      setMsg(`Saved: ${plan.add.length} added, ${plan.change.length} updated.`)
    } catch (e) {
      setErr(`Stopped after ${done} of ${changes}: ${(e as Error).message}. Your text is still here; fix the problem and save again.`)
    } finally {
      setSaving(false)
    }
  }

  async function copy() {
    setErr('')
    try {
      await clip.copy(text)
    } catch {
      setErr('The browser blocked clipboard access.')
    }
  }

  async function exportFile() {
    setErr('')
    try {
      await exportTextFile(exportName(props.title), text)
    } catch (e) {
      setErr((e as Error).message || 'Could not export the file.')
    }
  }

  if (props.loading)
    return (
      <div className="scard" aria-busy="true">
        <div className="cluster"><span className="spin" /><span className="t-small muted" style={{ fontWeight: 600 }}>Decrypting…</span></div>
        <span className="skel" style={{ width: '100%', height: 120 }} />
      </div>
    )

  if (!open)
    return (
      <div className="empty">
        <div className="round"><Icon name="lock" size="xl" /></div>
        <h2 className="t-h3" style={{ margin: 0 }}>Text view is hidden</h2>
        <p className="t-body muted" style={{ margin: 0, maxWidth: 460 }}>
          Shows every secret in this room as plain <span className="mono">NAME=value</span> lines, like a .env file. You can edit it, paste, upload a file into it, copy it, or export it.
        </p>
        <button className="btn btn-primary" onClick={reveal}>
          <Icon name="eye" />
          Show as text
        </button>
      </div>
    )

  const blocked = parsed.problems.length > 0
  return (
    <div className="compose">
      <div className="cluster" style={{ justifyContent: 'space-between' }}>
        <div className="stack" style={{ gap: 4 }}>
          <h2 className="t-h3" style={{ margin: 0 }}>.env text</h2>
          <span className="hint"><Icon name="unlock" size="sm" />Values are visible. Comments you type are not saved with the secrets.</span>
        </div>
        <button className="btn btn-secondary" onClick={hide}><Icon name="eyeOff" />Hide</button>
      </div>

      <div className="cluster">
        <button className="btn btn-secondary" onClick={() => file.current?.click()}><Icon name="upload" />Upload file</button>
        <input ref={file} type="file" hidden onChange={upload} />
        <button className="btn btn-secondary" onClick={exportFile} disabled={!text.trim()}><Icon name="download" />Export file</button>
        <button className="btn btn-secondary" onClick={copy} disabled={!text.trim()}>
          <Icon name={clip.left > 0 ? 'check' : 'copy'} />
          {clip.left > 0 ? 'Copied' : 'Copy all'} <span className="sub">{clip.left > 0 ? `clears in ${clip.left}s` : `clears in ${CLIPBOARD_CLEAR_S}s`}</span>
        </button>
      </div>

      {stale && (
        <div className="banner banner-warn" role="status">
          <Icon name="warn" />
          <div className="body">The secrets in this room changed while you were editing.</div>
          <button className="btn btn-secondary btn-sm" onClick={reveal}>Reload (discards your edits)</button>
        </div>
      )}

      <div className="field">
        <label className="lbl sr-only" htmlFor="envtext">Secrets as .env text</label>
        <textarea
          id="envtext"
          className={'input mono envarea' + (blocked ? ' is-error' : '')}
          rows={14}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'STRIPE_KEY=sk_test_123\nDATABASE_URL="postgres://user:pass@host/db"\n# comments are ignored'}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          wrap="off"
        />
      </div>

      {blocked && (
        <div className="banner banner-err" role="alert">
          <Icon name="warn" />
          <div className="body">
            <b>Fix these lines before saving:</b>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{parsed.problems.slice(0, 6).map((p) => <li key={p}>{p}</li>)}</ul>
            {parsed.problems.length > 6 && <span>…and {parsed.problems.length - 6} more.</span>}
          </div>
        </div>
      )}
      {parsed.duplicates.length > 0 && !blocked && (
        <div className="hint"><Icon name="warn" size="sm" />{[...new Set(parsed.duplicates)].join(', ')} appears more than once. The last one is used.</div>
      )}
      {props.hiddenBurn > 0 && (
        <div className="hint"><Icon name="flame" size="sm" />{props.hiddenBurn} burn-after-reveal {props.hiddenBurn === 1 ? 'secret is' : 'secrets are'} not shown here. Reveal {props.hiddenBurn === 1 ? 'it' : 'them'} in the card list first, so the burn still happens.</div>
      )}
      {unwritable > 0 && (
        <div className="hint"><Icon name="info" size="sm" />{unwritable} {unwritable === 1 ? 'secret has a name' : 'secrets have names'} that can't be written as NAME=value. Manage {unwritable === 1 ? 'it' : 'them'} in the card list.</div>
      )}

      <div className="hint" aria-live="polite">
        <Icon name="info" size="sm" />
        {blocked ? 'Nothing to save yet.' : changes === 0 ? (dirty ? 'No changes to the secrets.' : 'Nothing changed.') : `Will add ${plan.add.length} and update ${plan.change.length}. Secrets missing from the text are kept.`}
        {changes > 0 && props.usesOptions && ' New and updated secrets use the expiry and burn settings from the Cards view.'}
      </div>

      {msg && <div className="notice ok" role="status"><Icon name="check" size="sm" />{msg}</div>}
      {err && <div className="banner banner-err" role="alert"><Icon name="warn" /><div className="body">{err}</div></div>}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className={'btn btn-primary' + (saving ? ' is-loading' : '')} onClick={save} disabled={saving || blocked || changes === 0}>
          <Icon name="lock" />
          Save {changes > 0 ? `${changes} ${changes === 1 ? 'change' : 'changes'}` : 'changes'}
        </button>
      </div>
    </div>
  )
}
