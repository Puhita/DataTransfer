import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const configured = Boolean(url && key)

/** Where email links (confirm, reset) send people. Inside the Android app location.origin is https://localhost, so the real web address must be configured. */
export const publicUrl = (import.meta.env.VITE_PUBLIC_URL as string | undefined) || location.origin + location.pathname

export const supabase = createClient(url ?? 'http://localhost', key ?? 'missing', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
})
