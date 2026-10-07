# DataTransfer

End-to-end encrypted 1:1 chat with a per-chat **Secrets** room for API keys and env vars.
React + Vite + libsodium on the client; Supabase (Auth, Postgres, Realtime) as a dumb ciphertext store.
See `PLAN.md` for the design and threat model.

## Setup (about 15 minutes)

1. **Supabase**: create a free project. In *SQL editor* run `supabase/migrations/0001_init.sql`, then `0002_delete_secrets.sql` (in that order).
2. **Auth settings** (Authentication):
   - Providers → Email: enable, keep *Confirm email* **on**.
   - URL configuration: set *Site URL* to your deployed URL (and add `http://localhost:5173` to redirect URLs for dev).
   - SMTP: configure a custom SMTP (Resend/Brevo free tier). The built-in mailer allows ~2 mails/hour.
   - Password: minimum length 10.
3. **Env**: `cp .env.example .env.local` and fill `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (the *anon public* key, never the service-role key).
4. `npm install && npm run dev`.

## Deploy (Cloudflare Pages, free)

Build command `npm run build`, output `dist`. Set the two `VITE_` variables. `public/_headers` ships the CSP and other security headers.
If you host elsewhere, replicate those headers.

## Maintenance (free-tier gaps)

`.github/workflows/maintenance.yml` pings Supabase daily (prevents the 7-day pause) and stores a 14-day `pg_dump` as a workflow artifact.
Add repo secrets `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_DB_URL`. Expired secrets are hidden by RLS but not purged; optionally schedule
`delete from messages where expires_at < now();`.

## Tests

`npm test` runs the crypto tests and executes the real migration against an in-process Postgres (PGlite) to test RLS and the RPCs.
UI flows against a live Supabase project are **not** automated; do a manual two-account run-through after setup.

## How it works, short

- Signup (email + login password) -> confirm email -> log in -> pick a separate **encryption passphrase**; keys are generated in the browser, private keys are wrapped by the passphrase (Argon2id) and by a one-time **recovery key**.
- Starting a chat creates a Chat room and a Secrets room, each with its own random key wrapped for both people. The other person must accept.
- Every message/secret is XChaCha20-Poly1305 encrypted and Ed25519-signed in the browser, bound to room, sender and key version. The server stores ciphertext only.
- Plaintext lives in React state while a room is open. Decrypted keys are memory-only; reload or 15 min idle locks the app.
- Compare the **safety number** (Verify button) out-of-band; key changes show a warning.

## Known limits (v1)

Web E2EE trusts the host serving the JavaScript. Metadata (who, when, sizes) is visible to the server. Losing both passphrase and recovery key loses the data.
1:1 only; no room-key rotation, forward secrecy, attachments, or multi-device key sync (use the same passphrase on each device; keys are fetched wrapped).
