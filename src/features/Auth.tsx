import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'

export function AuthScreen() {
  const [mode, setMode] = useState<'login' | 'signup' | 'reset'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setNotice('')
    setBusy(true)
    try {
      if (mode === 'signup') {
        if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) throw new Error('Username: 3-24 letters, digits or underscore.')
        if (password.length < 10) throw new Error('Password must be at least 10 characters.')
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: location.origin, data: { username } },
        })
        if (error) throw error
        if (!data.session) setNotice('Check your inbox and click the confirmation link, then log in.')
      } else if (mode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: location.origin })
        if (error) throw error
        setNotice('If that account exists, a reset link is on its way. A reset restores login only, never your encrypted data.')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="center">
      <form className="card" onSubmit={submit}>
        <h1>DataTransfer</h1>
        <p className="muted">End-to-end encrypted chat and secret sharing.</p>
        <label>
          Email
          <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {mode === 'signup' && (
          <label>
            Username
            <input required value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          </label>
        )}
        {mode !== 'reset' && (
          <label>
            Login password
            <input
              type="password"
              required
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        )}
        {error && <p className="err">{error}</p>}
        {notice && <p className="ok">{notice}</p>}
        <button disabled={busy}>{mode === 'login' ? 'Log in' : mode === 'signup' ? 'Create account' : 'Send reset link'}</button>
        <p className="muted small">
          {mode !== 'login' && <a onClick={() => setMode('login')}>Log in</a>}
          {mode !== 'signup' && <a onClick={() => setMode('signup')}>Create account</a>}
          {mode !== 'reset' && <a onClick={() => setMode('reset')}>Forgot login password</a>}
        </p>
      </form>
    </div>
  )
}
