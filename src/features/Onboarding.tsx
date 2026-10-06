import { useState, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { createKeyBundle, unlockWithPassphrase, unlockWithRecoveryKey } from '../crypto'
import { createProfile, getMyProfile, storedKeys, type ProfileRow } from '../lib/api'
import { keystore } from '../lib/keystore'

export function SetupScreen(props: { session: Session; onDone: (p: ProfileRow) => void; onLogout: () => void }) {
  const meta = props.session.user.user_metadata as { username?: string }
  const [username, setUsername] = useState(meta.username ?? '')
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [recovery, setRecovery] = useState<{ key: string; profile: ProfileRow } | null>(null)
  const [saved, setSaved] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (pass.length < 12) return setError('Passphrase must be at least 12 characters.')
    if (pass !== pass2) return setError('Passphrases do not match.')
    setBusy(true)
    try {
      const { identity, bundle, recoveryKey } = await createKeyBundle(pass)
      await createProfile(props.session.user.id, username, bundle)
      const profile = await getMyProfile(props.session.user.id)
      if (!profile) throw new Error('Profile was not saved.')
      keystore.identity = identity
      setRecovery({ key: recoveryKey, profile })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (recovery)
    return (
      <div className="center">
        <div className="card">
          <h1>Save your recovery key</h1>
          <p>
            This is the <b>only</b> way back into your encrypted data if you forget your passphrase. It is shown once and never
            stored on the server.
          </p>
          <pre className="recovery">{recovery.key}</pre>
          <div className="row">
            <button type="button" onClick={() => navigator.clipboard.writeText(recovery.key)}>
              Copy
            </button>
            <button
              type="button"
              onClick={() => {
                const url = URL.createObjectURL(new Blob([recovery.key + '\n'], { type: 'text/plain' }))
                const a = document.createElement('a')
                a.href = url
                a.download = 'datatransfer-recovery-key.txt'
                a.click()
                URL.revokeObjectURL(url)
              }}
            >
              Download
            </button>
          </div>
          <label className="check">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I stored it somewhere safe
          </label>
          <button disabled={!saved} onClick={() => props.onDone(recovery.profile)}>
            Continue
          </button>
        </div>
      </div>
    )

  return (
    <div className="center">
      <form className="card" onSubmit={submit}>
        <h1>Set up encryption</h1>
        <p className="muted">
          Your keys are created in this browser. The passphrase protects them. It is <b>not</b> your login password, so use a
          different one. We cannot reset it.
        </p>
        <label>
          Username
          <input required value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>
          Encryption passphrase
          <input type="password" required autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />
        </label>
        <label>
          Repeat passphrase
          <input type="password" required autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} />
        </label>
        {error && <p className="err">{error}</p>}
        <button disabled={busy}>{busy ? 'Generating keys…' : 'Create keys'}</button>
        <p className="muted small">
          <a onClick={props.onLogout}>Log out</a>
        </p>
      </form>
    </div>
  )
}

export function UnlockScreen(props: { profile: ProfileRow; onUnlocked: (p: ProfileRow) => void; onLogout: () => void }) {
  const [useRecovery, setUseRecovery] = useState(false)
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const keys = storedKeys(props.profile)
      keystore.identity = useRecovery ? await unlockWithRecoveryKey(secret, keys) : await unlockWithPassphrase(secret, keys)
      props.onUnlocked(props.profile)
    } catch {
      setError(useRecovery ? 'Recovery key is not valid.' : 'Wrong passphrase.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="center">
      <form className="card" onSubmit={submit}>
        <h1>Unlock</h1>
        <p className="muted">Hi {props.profile.username}. Your keys are locked in this browser session.</p>
        <label>
          {useRecovery ? 'Recovery key' : 'Encryption passphrase'}
          <input
            type={useRecovery ? 'text' : 'password'}
            required
            autoFocus
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </label>
        {error && <p className="err">{error}</p>}
        <button disabled={busy}>{busy ? 'Unlocking…' : 'Unlock'}</button>
        <p className="muted small">
          <a
            onClick={() => {
              setUseRecovery(!useRecovery)
              setSecret('')
              setError('')
            }}
          >
            {useRecovery ? 'Use passphrase' : 'Forgot passphrase? Use recovery key'}
          </a>
          <a onClick={props.onLogout}>Log out</a>
        </p>
      </form>
    </div>
  )
}
