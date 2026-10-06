import { useEffect, useState, type FormEvent } from 'react'
import { rewrapWithPassphrase, unlockWithPassphrase } from '../crypto'
import { setDiscoverable, storedKeys, updatePassphraseWrap, type ProfileRow } from '../lib/api'
import { keystore } from '../lib/keystore'
import { supabase } from '../lib/supabase'
import { Avatar, Icon, SecretInput } from '../ui/Icon'

export function Settings(props: { me: ProfileRow; onClose: () => void; onProfile: (p: ProfileRow) => void; onLogout: () => void }) {
  const [disc, setDisc] = useState(props.me.discoverable_by_email)
  const [saving, setSaving] = useState(false)
  const [email, setEmail] = useState('')
  const [editing, setEditing] = useState(false)
  const [oldPass, setOldPass] = useState('')
  const [newPass, setNewPass] = useState('')
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? ''))
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])

  async function toggle(v: boolean) {
    setError('')
    setDisc(v)
    setSaving(true)
    try {
      await setDiscoverable(props.me.id, v)
      props.onProfile({ ...props.me, discoverable_by_email: v })
    } catch (e) {
      setDisc(!v)
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function change(e: FormEvent) {
    e.preventDefault()
    setError('')
    setMsg('')
    if (newPass.length < 12) return setError('New passphrase must be at least 12 characters.')
    setBusy(true)
    try {
      // prove knowledge of the current passphrase before replacing the wrap
      await unlockWithPassphrase(oldPass, storedKeys(props.me))
      const id = keystore.identity
      if (!id) throw new Error('Locked')
      const w = await rewrapWithPassphrase(id, newPass)
      await updatePassphraseWrap(props.me.id, w)
      props.onProfile({
        ...props.me,
        kdf_salt: w.kdf.salt,
        kdf_opslimit: w.kdf.opslimit,
        kdf_memlimit: w.kdf.memlimit,
        wrapped_keys_passphrase: w.wrappedByPassphrase,
      })
      setOldPass('')
      setNewPass('')
      setEditing(false)
      setMsg('Passphrase changed.')
    } catch {
      setError('Current passphrase is wrong, or the update failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="scrim" style={{ position: 'fixed', inset: 0, zIndex: 20 }} onClick={props.onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="st" style={{ maxWidth: 520, gap: 8 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head" style={{ marginBottom: 8 }}>
          <div className="cluster" style={{ flexWrap: 'nowrap', gap: 12 }}>
            <Avatar name={props.me.username} />
            <div>
              <h2 id="st" className="t-h2" style={{ margin: 0 }}>Settings</h2>
              <div className="t-small muted">@{props.me.username}{email && ` · ${email}`}</div>
            </div>
          </div>
          <button className="iconbtn" aria-label="Close" onClick={props.onClose}><Icon name="close" /></button>
        </div>

        <div className="setrow">
          <label className={'switch' + (saving ? ' is-loading' : '')} style={{ flex: 1 }}>
            <input type="checkbox" role="switch" checked={disc} disabled={saving} onChange={(e) => toggle(e.target.checked)} />
            <span className="track"><span className="thumb"><Icon name="check" /></span></span>
            <span className="txt">
              <b>Discoverable by email</b>
              <span>People who type your exact email address can find you and send a request.</span>
            </span>
            <span className="state">{saving ? 'Saving…' : disc ? 'On' : 'Off'}</span>
          </label>
        </div>

        <div className="setrow" style={{ flexWrap: 'wrap' }}>
          <div className="stack flex1" style={{ gap: 2 }}>
            <b style={{ fontWeight: 600 }}>Encryption passphrase</b>
            <span className="t-small muted">Change the passphrase that unlocks your keys.</span>
          </div>
          {!editing && (
            <button className="btn btn-secondary" onClick={() => { setEditing(true); setMsg('') }}>
              <Icon name="key" />
              Change passphrase
            </button>
          )}
          {editing && (
            <form onSubmit={change} style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
              <div className="field">
                <label className="lbl" htmlFor="op">Current passphrase</label>
                <SecretInput id="op" label="passphrase" value={oldPass} onChange={setOldPass} autoComplete="off" autoFocus />
              </div>
              <div className="field">
                <label className="lbl" htmlFor="np">New passphrase</label>
                <SecretInput id="np" label="passphrase" value={newPass} onChange={setNewPass} autoComplete="new-password" />
                <span className="hint">At least 12 characters. It can't be reset, so keep your recovery key safe.</span>
              </div>
              <div className="cluster">
                <button className={'btn btn-primary' + (busy ? ' is-loading' : '')} disabled={busy}>Save passphrase</button>
                <button type="button" className="btn btn-secondary" onClick={() => { setEditing(false); setError('') }}>Cancel</button>
              </div>
            </form>
          )}
        </div>

        <div className="setrow">
          <div className="stack flex1" style={{ gap: 2 }}>
            <b style={{ fontWeight: 600 }}>Log out</b>
            <span className="t-small muted">You'll need your login password and passphrase to get back in.</span>
          </div>
          <button className="btn btn-secondary" onClick={props.onLogout}>
            <Icon name="logout" />
            Log out
          </button>
        </div>

        {msg && <div className="notice ok" role="status"><Icon name="check" size="sm" />{msg}</div>}
        {error && <div className="banner banner-err" role="alert"><Icon name="warn" /><div className="body">{error}</div></div>}
      </div>
    </div>
  )
}
