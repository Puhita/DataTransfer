import { useState, type FormEvent } from 'react'
import { rewrapWithPassphrase, unlockWithPassphrase } from '../crypto'
import { setDiscoverable, storedKeys, updatePassphraseWrap, type ProfileRow } from '../lib/api'
import { keystore } from '../lib/keystore'

export function Settings(props: { me: ProfileRow; onClose: () => void; onProfile: (p: ProfileRow) => void; onLogout: () => void }) {
  const [disc, setDisc] = useState(props.me.discoverable_by_email)
  const [oldPass, setOldPass] = useState('')
  const [newPass, setNewPass] = useState('')
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function toggle(v: boolean) {
    setDisc(v)
    try {
      await setDiscoverable(props.me.id, v)
      props.onProfile({ ...props.me, discoverable_by_email: v })
    } catch (e) {
      setDisc(!v)
      setError((e as Error).message)
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
      setMsg('Passphrase changed.')
    } catch {
      setError('Current passphrase is wrong, or the update failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal" onClick={props.onClose}>
      <div className="card" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <label className="check">
          <input type="checkbox" checked={disc} onChange={(e) => toggle(e.target.checked)} /> Let people find me by my exact email
        </label>
        <form onSubmit={change}>
          <h3>Change encryption passphrase</h3>
          <input type="password" placeholder="Current passphrase" required value={oldPass} onChange={(e) => setOldPass(e.target.value)} />
          <input type="password" placeholder="New passphrase" required value={newPass} onChange={(e) => setNewPass(e.target.value)} />
          <button disabled={busy}>Change</button>
        </form>
        {msg && <p className="ok">{msg}</p>}
        {error && <p className="err">{error}</p>}
        <div className="row">
          <button className="ghost" onClick={props.onLogout}>
            Log out
          </button>
          <span className="spacer" />
          <button onClick={props.onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
