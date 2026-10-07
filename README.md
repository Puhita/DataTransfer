# DataTransfer

End-to-end encrypted 1:1 chat with a per-chat **Secrets** room for API keys and env vars.
React + Vite + libsodium on the client; Supabase (Auth, Postgres, Realtime) as a dumb ciphertext store.
See `PLAN.md` for the design and threat model.

## Setup (about 15 minutes)

1. **Supabase**: create a free project. In *SQL editor* run `supabase/migrations/0001_init.sql`.
   Also run `supabase/migrations/0004_delete_secrets.sql` (lets either member delete secrets).
   For **projects** (groups), also run `supabase/migrations/0003_projects.sql` (after 0001 and 0002), and redeploy the `notify` function.
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

## Android app (APK) and GitHub Pages

The web app is wrapped with Capacitor (`android/`). The JavaScript is bundled inside the APK. Two workflows do the work:

- `.github/workflows/pages.yml` deploys the web app on every push to `main` and adds `/download.html`, a page linking the latest APK.
- `.github/workflows/android.yml` builds a **signed** APK when you push a tag like `v1.0.0` (or run it manually) and attaches `DataTransfer.apk` to a GitHub Release.

One-time setup:

1. Repo Settings -> Pages -> Source: **GitHub Actions**.
2. Create a signing key (keep the file and passwords safe; losing it means everyone must uninstall to update):
   ```
   keytool -genkeypair -v -keystore release.jks -alias datatransfer -keyalg RSA -keysize 2048 -validity 10000
   ```
   Then base64 it. PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("release.jks")) | Set-Clipboard`
3. Repo Settings -> Secrets and variables -> Actions, add:
   `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (datatransfer), `ANDROID_KEY_PASSWORD`.
4. Supabase -> Authentication -> URL configuration: set **Site URL** to `https://<user>.github.io/<repo>/` and add it to Redirect URLs.
5. Release: `git tag v1.0.0 && git push origin v1.0.0`. Share `https://<user>.github.io/<repo>/download.html` with the team.

Teammates must allow "install unknown apps" for their browser once. Updates are manual: download the new APK over the old one (same signing key, so it upgrades in place).
Email confirmation links open the web version in the browser, not the app; confirm there, then log in on the phone.

## Push notifications (Android app)

When someone sends a message or secret, the other person's phone gets a push: "@sender · New message" or "Shared a new secret". The text is never included (the server cannot read it).
Google's Firebase Cloud Messaging delivers it, so Google learns that someone messaged someone, and when. It never sees content. The web version has no push yet.

One-time setup:

1. **Firebase** (free): console.firebase.google.com -> create a project (analytics off) -> add an **Android app** with package name `dev.datatransfer.app` -> download `google-services.json`.
   Paste the whole file into a GitHub repo secret named `GOOGLE_SERVICES_JSON`. Never commit it (it is gitignored).
2. Firebase -> Project settings -> **Service accounts** -> Generate new private key. This JSON stays secret.
3. Supabase SQL editor: run `supabase/migrations/0002_push.sql`.
4. Supabase secrets (Dashboard -> Edge Functions -> Secrets, or `supabase secrets set`):
   - `FIREBASE_SERVICE_ACCOUNT` = the whole service-account JSON from step 2
   - `WEBHOOK_SECRET` = any long random string (e.g. 40+ random characters)
5. Deploy the function: `supabase login && supabase link --project-ref <ref> && supabase functions deploy notify --no-verify-jwt`
6. Supabase -> Database -> **Webhooks** -> Create: table `messages`, event **Insert**, type **HTTP Request**, method POST,
   URL `https://<ref>.supabase.co/functions/v1/notify`, add header `x-webhook-secret` = the same `WEBHOOK_SECRET`.
7. Push a new release tag (the APK must be rebuilt after `GOOGLE_SERVICES_JSON` exists). On first launch Android asks to allow notifications.

Tapping a notification opens that chat (after unlocking). Pushes are not shown while the app is open in the foreground.
