import { useState, type FormEvent } from 'react'
import { publicUrl, supabase } from '../lib/supabase'
import { Brand, Icon, SecretInput, type IconName } from '../ui/Icon'

type Mode = 'login' | 'signup' | 'reset'

const POINTS: { icon: IconName; text: string }[] = [
  { icon: 'lock', text: 'Messages are encrypted on your device before they leave it.' },
  { icon: 'key', text: 'Every chat has a Secrets room for API keys and .env values, with expiry and burn-after-reveal.' },
  { icon: 'shieldCheck', text: 'The server only ever holds ciphertext.' },
]

const maskEmail = (e: string) => {
  const [u, d] = e.split('@')
  return u && d ? `${u.slice(0, 2)}•••@${d}` : e
}

export function AuthScreen() {
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState<'signup' | 'reset' | null>(null)

  const go = (m: Mode) => {
    setMode(m)
    setError('')
    setSent(null)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      if (mode === 'signup') {
        if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) throw new Error('Username: 3-24 letters, digits or underscore.')
        if (password.length < 10) throw new Error('Password must be at least 10 characters.')
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: publicUrl, data: { username } },
        })
        if (error) throw error
        if (!data.session) setSent('signup')
      } else if (mode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: publicUrl })
        if (error) throw error
        setSent('reset')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const card = sent ? (
    <section className="authcard" style={{ alignItems: 'flex-start' }}>
      <Brand />
      <div className="round">
        <Icon name="mail" size="xl" />
      </div>
      <div className="stack" style={{ gap: 8 }}>
        <h2 className="t-h1" style={{ margin: 0 }}>
          Check your inbox
        </h2>
        <p className="t-body muted" style={{ margin: 0 }}>
          {sent === 'signup' ? (
            <>
              We sent a confirmation link to <b className="mono" style={{ color: 'var(--text)', fontWeight: 500 }}>{maskEmail(email)}</b>. Click it, then log in.
            </>
          ) : (
            <>
              If an account exists for <b className="mono" style={{ color: 'var(--text)', fontWeight: 500 }}>{maskEmail(email)}</b>, a reset link is on its way. It resets your login password only, never your encrypted data.
            </>
          )}
        </p>
      </div>
      <button className="btn btn-primary btn-block" onClick={() => go('login')}>
        Back to log in
      </button>
      <button className="linkbtn" style={{ alignSelf: 'center' }} onClick={() => setSent(null)}>
        Wrong address? Try again
      </button>
    </section>
  ) : (
    <form className="authcard" onSubmit={submit}>
      {mode !== 'login' && <Brand />}
      <div className="stack" style={{ gap: 6 }}>
        <h2 className="t-h1" style={{ margin: 0 }}>
          {mode === 'login' ? 'Log in' : mode === 'signup' ? 'Create account' : 'Forgot password?'}
        </h2>
        <p className="t-body muted" style={{ margin: 0 }}>
          {mode === 'login'
            ? 'Welcome back. Use your email and login password.'
            : mode === 'signup'
              ? "Three details. You'll set your encryption passphrase next."
              : "Enter your email and we'll send a link to reset your login password."}
        </p>
      </div>

      <div className="field">
        <label className="lbl" htmlFor="em">Email</label>
        <input id="em" className="input" type="email" required placeholder="you@team.dev" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>

      {mode === 'signup' && (
        <div className="field">
          <label className="lbl" htmlFor="un">Username</label>
          <div className="inwrap">
            <span className="mono" style={{ position: 'absolute', left: 14, color: 'var(--muted)' }}>@</span>
            <input id="un" className="input" style={{ paddingLeft: 34, paddingRight: 14 }} required placeholder="maya.k" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <span className="hint">Teammates find you by this. Letters, digits and underscore.</span>
        </div>
      )}

      {mode !== 'reset' && (
        <div className="field">
          <div className="cluster" style={{ justifyContent: 'space-between' }}>
            <label className="lbl" htmlFor="pw">Login password</label>
            {mode === 'login' && (
              <a className="link-a t-small" onClick={() => go('reset')}>Forgot password?</a>
            )}
          </div>
          <SecretInput
            id="pw"
            label="password"
            value={password}
            onChange={setPassword}
            placeholder={mode === 'signup' ? 'Choose a login password' : 'Your login password'}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          />
          {mode === 'signup' && <span className="hint">At least 10 characters. Used to log in; can be reset by email.</span>}
        </div>
      )}

      {mode === 'reset' && (
        <div className="banner banner-info">
          <Icon name="info" />
          <div className="body">This only resets your login password. It can't recover your encryption passphrase.</div>
        </div>
      )}

      {error && (
        <div className="banner banner-err" role="alert">
          <Icon name="warn" />
          <div className="body">{error}</div>
        </div>
      )}

      <button className={'btn btn-primary btn-block' + (busy ? ' is-loading' : '')} type="submit" disabled={busy}>
        {mode === 'login' ? 'Log in' : mode === 'signup' ? 'Create account' : 'Send reset link'}
      </button>

      {mode === 'login' && (
        <div className="hint" style={{ justifyContent: 'center' }}>
          <Icon name="info" size="sm" />
          Next, you'll unlock your keys with your separate encryption passphrase.
        </div>
      )}

      <div className="t-body" style={{ borderTop: '1px solid var(--border)', paddingTop: 12, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6 }}>
        {mode === 'login' ? (
          <>
            <span className="muted">New here?</span>
            <a className="link-a" onClick={() => go('signup')}>Create an account</a>
          </>
        ) : mode === 'signup' ? (
          <>
            <span className="muted">Have an account?</span>
            <a className="link-a" onClick={() => go('login')}>Log in</a>
          </>
        ) : (
          <a className="link-a" onClick={() => go('login')}>
            <Icon name="back" size="sm" />
            Back to log in
          </a>
        )}
      </div>
    </form>
  )

  return (
    <div className="split">
      <div className="hero">
        <Brand light />
        <i className="ring" style={{ width: 420, height: 420, right: -120, bottom: -110, opacity: 0.28 }} />
        <i className="ring" style={{ width: 300, height: 300, right: -60, bottom: -50, opacity: 0.4 }} />
        <i className="ring" style={{ width: 180, height: 180, right: 0, bottom: 10, opacity: 0.55 }} />
        <div className="pts">
          <h1 className="t-display" style={{ margin: 0, color: 'var(--code-text)' }}>Private chat for small dev teams.</h1>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {POINTS.map((p) => (
              <div className="pt" key={p.icon}>
                <Icon name={p.icon} size="lg" />
                <span className="t-lead">{p.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="form">{card}</div>
    </div>
  )
}
