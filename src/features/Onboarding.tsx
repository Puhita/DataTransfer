import { useState, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { createKeyBundle, unlockWithPassphrase, unlockWithRecoveryKey } from '../crypto'
import { createProfile, getMyProfile, storedKeys, type ProfileRow } from '../lib/api'
import { keystore } from '../lib/keystore'
import { Avatar, Icon, SecretInput } from '../ui/Icon'

export function SetupScreen(props: { session: Session; onDone: (p: ProfileRow) => void; onLogout: () => void }) {
  const meta = props.session.user.user_metadata as { username?: string }
  const [username, setUsername] = useState(meta.username ?? '')
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [recovery, setRecovery] = useState<{ key: string; profile: ProfileRow } | null>(null)
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)

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

  if (recovery) {
    const groups = recovery.key.replace(/-/g, '').match(/.{1,4}/g) ?? []
    return (
      <div className="center-screen">
        <section className="authcard" style={{ maxWidth: 440 }}>
          <div className="stack" style={{ gap: 8 }}>
            <span className="t-label">Encryption setup · 2 of 2</span>
            <h2 className="t-h1" style={{ margin: 0 }}>Save your recovery key</h2>
            <p className="t-body muted" style={{ margin: 0 }}>
              If you forget your passphrase, this key is the only way back in. We can't recover it for you.
            </p>
          </div>
          <div className="banner banner-warn" style={{ alignItems: 'center' }}>
            <Icon name="eye" />
            <div className="body"><b>Shown once.</b> Store it in a password manager or somewhere offline.</div>
          </div>
          <div className="keybox" role="textbox" aria-readonly="true" aria-label="Recovery key">
            {groups.map((g, i) => <span key={i}>{g}</span>)}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(recovery.key)
                  setCopied(true)
                } catch {
                  /* clipboard blocked: user can still download */
                }
              }}
            >
              <Icon name={copied ? 'check' : 'copy'} />
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              className="btn btn-secondary"
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
              <Icon name="download" />
              Download
            </button>
          </div>
          <label className="check">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            <span>I stored it safely</span>
          </label>
          <button className="btn btn-primary btn-block" type="button" disabled={!saved} onClick={() => props.onDone(recovery.profile)}>
            Continue
          </button>
          {!saved && <span className="hint" style={{ justifyContent: 'center' }}>Continue unlocks when you tick the box.</span>}
        </section>
      </div>
    )
  }

  return (
    <div className="center-screen">
      <form className="authcard" style={{ maxWidth: 440 }} onSubmit={submit}>
        <div className="stack" style={{ gap: 8 }}>
          <span className="t-label">Encryption setup · 1 of 2</span>
          <h2 className="t-h1" style={{ margin: 0 }}>Choose an encryption passphrase</h2>
          <p className="t-body muted" style={{ margin: 0 }}>
            It locks your messages and secrets on this device. It is a second, separate secret.
          </p>
        </div>
        <div className="compare">
          <div>
            <div className="h"><Icon name="mail" />Login password</div>
            <span>Signs you in to your account.</span>
            <span className="rule"><Icon name="check" size="sm" />Can be reset by email</span>
          </div>
          <div style={{ border: '1.5px solid var(--accent)', background: 'var(--accent-soft)' }}>
            <div className="h"><Icon name="key" />Encryption passphrase</div>
            <span>Unlocks your messages and secrets.</span>
            <span className="rule no"><Icon name="warn" size="sm" />Can't be reset</span>
          </div>
        </div>
        {!meta.username && (
          <div className="field">
            <label className="lbl" htmlFor="su">Username</label>
            <input id="su" className="input" required value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
        )}
        <div className="field">
          <label className="lbl" htmlFor="p1">Encryption passphrase</label>
          <SecretInput id="p1" label="passphrase" value={pass} onChange={setPass} autoComplete="new-password" autoFocus />
          <span className="hint">At least 12 characters. Pick a long phrase you can remember. It never leaves your device.</span>
        </div>
        <div className="field">
          <label className="lbl" htmlFor="p2">Confirm passphrase</label>
          <SecretInput id="p2" label="passphrase" value={pass2} onChange={setPass2} placeholder="Type it again" autoComplete="new-password" invalid={pass2.length > 0 && pass !== pass2} />
        </div>
        {error && (
          <div className="banner banner-err" role="alert"><Icon name="warn" /><div className="body">{error}</div></div>
        )}
        <button className={'btn btn-primary btn-block' + (busy ? ' is-loading' : '')} disabled={busy}>
          {busy ? 'Generating keys…' : 'Continue'}
        </button>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <button type="button" className="linkbtn" onClick={props.onLogout}>Log out</button>
        </div>
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
      setError(useRecovery ? 'That recovery key is not valid.' : 'Wrong passphrase.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="center-screen">
      <form className="authcard" style={{ maxWidth: 440 }} onSubmit={submit}>
        <div className="round"><Icon name="lock" size="xl" /></div>
        <div className="stack" style={{ gap: 8 }}>
          <h2 className="t-h1" style={{ margin: 0 }}>Unlock DataTransfer</h2>
          <p className="t-body muted" style={{ margin: 0 }}>
            Your keys lock after a reload or 15 minutes idle. Enter your {useRecovery ? 'recovery key' : 'encryption passphrase'} to continue.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px 8px 8px', border: '1px solid var(--border)', borderRadius: 999, alignSelf: 'flex-start', background: 'var(--panel-2)' }}>
          <Avatar name={props.profile.username} small />
          <span style={{ fontWeight: 600 }}>@{props.profile.username}</span>
        </div>
        <div className="field">
          <label className="lbl" htmlFor="u1">{useRecovery ? 'Recovery key' : 'Encryption passphrase'}</label>
          {useRecovery ? (
            <input id="u1" className={'input mono' + (error ? ' is-error' : '')} required autoFocus autoComplete="off" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} />
          ) : (
            <SecretInput id="u1" label="passphrase" value={secret} onChange={setSecret} autoComplete="off" autoFocus invalid={!!error} />
          )}
          {error && <span className="hint err" role="alert"><Icon name="warn" size="sm" />{error}</span>}
        </div>
        <button className={'btn btn-primary btn-block' + (busy ? ' is-loading' : '')} disabled={busy}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="linkbtn"
            onClick={() => {
              setUseRecovery(!useRecovery)
              setSecret('')
              setError('')
            }}
          >
            {useRecovery ? 'Use passphrase instead' : 'Use recovery key instead'}
          </button>
          <button type="button" className="linkbtn" onClick={props.onLogout}>Log out</button>
        </div>
      </form>
    </div>
  )
}
