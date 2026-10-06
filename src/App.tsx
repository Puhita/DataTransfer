import { useCallback, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { configured, supabase } from './lib/supabase'
import { keystore } from './lib/keystore'
import { getMyProfile, type ProfileRow } from './lib/api'
import { AuthScreen } from './features/Auth'
import { SetupScreen, UnlockScreen } from './features/Onboarding'
import { Main } from './features/Main'

type Stage =
  | { kind: 'loading' }
  | { kind: 'signedOut' }
  | { kind: 'setup'; session: Session }
  | { kind: 'locked'; session: Session; profile: ProfileRow }
  | { kind: 'ready'; session: Session; profile: ProfileRow }
  | { kind: 'error'; message: string }

export function App() {
  const [stage, setStage] = useState<Stage>({ kind: 'loading' })

  const resolve = useCallback(async (session: Session | null) => {
    if (!session) {
      keystore.clear()
      setStage({ kind: 'signedOut' })
      return
    }
    try {
      const profile = await getMyProfile(session.user.id)
      if (!profile) setStage({ kind: 'setup', session })
      else if (keystore.identity) setStage({ kind: 'ready', session, profile })
      else setStage({ kind: 'locked', session, profile })
    } catch (e) {
      setStage({ kind: 'error', message: (e as Error).message })
    }
  }, [])

  useEffect(() => {
    if (!configured) return
    supabase.auth.getSession().then(({ data }) => resolve(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      // token refreshes must not re-lock an unlocked session
      if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') return
      void resolve(session)
    })
    return () => sub.subscription.unsubscribe()
  }, [resolve])

  const logout = useCallback(async () => {
    keystore.clear()
    await supabase.auth.signOut()
  }, [])

  const lock = useCallback(() => {
    keystore.clear()
    setStage((s) => (s.kind === 'ready' ? { kind: 'locked', session: s.session, profile: s.profile } : s))
  }, [])

  if (!configured)
    return (
      <div className="center">
        <div className="card">
          <h1>Not configured</h1>
          <p>
            Copy <code>.env.example</code> to <code>.env.local</code> and set <code>VITE_SUPABASE_URL</code> and{' '}
            <code>VITE_SUPABASE_ANON_KEY</code>. See README.md.
          </p>
        </div>
      </div>
    )

  switch (stage.kind) {
    case 'loading':
      return <div className="center">Loading…</div>
    case 'error':
      return (
        <div className="center">
          <div className="card">
            <h1>Something went wrong</h1>
            <p className="err">{stage.message}</p>
            <button onClick={() => location.reload()}>Reload</button>
          </div>
        </div>
      )
    case 'signedOut':
      return <AuthScreen />
    case 'setup':
      return (
        <SetupScreen
          session={stage.session}
          onDone={(profile) => setStage({ kind: 'ready', session: stage.session, profile })}
          onLogout={logout}
        />
      )
    case 'locked':
      return (
        <UnlockScreen
          profile={stage.profile}
          onUnlocked={(profile) => setStage({ kind: 'ready', session: stage.session, profile })}
          onLogout={logout}
        />
      )
    case 'ready':
      return <Main session={stage.session} profile={stage.profile} onProfile={(p) => setStage({ ...stage, profile: p })} onLock={lock} onLogout={logout} />
  }
}
