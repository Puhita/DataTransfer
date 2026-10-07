# DataTransfer — Master Plan (v0)

Encrypted 1:1 / small-group chat with a per-chat "Secrets" room for API keys and env vars.
Goal: one-shot build, adjust afterwards.

## 1. Non-negotiable requirements (from the brief)

1. Email + password auth with email confirmation.
2. Find users by email or unique username.
3. Starting a chat creates two rooms: **Chat** and **Secrets**.
4. Every message is encrypted in transit and at rest. Plaintext exists only in the browser, in the open chat room.
5. Only free-to-publish technology.

Requirement 4 forces **end-to-end encryption (E2EE)**. Server-side encryption is not enough: if the server can decrypt, it has plaintext. Everything below follows from this.

## 2. Stack (all free / open source / free-tier hostable)

| Layer | Choice | Why |
|---|---|---|
| Frontend | React + Vite + TypeScript | Static build, hostable anywhere |
| UI | Tailwind CSS | Fast, no runtime cost |
| Crypto | libsodium (`libsodium-wrappers`) | Audited; X25519, XChaCha20-Poly1305, Argon2id, Ed25519 |
| Auth + DB + Realtime | Supabase (Postgres + GoTrue + Realtime), free tier, or self-hosted | Email confirmation, RLS, websockets out of the box |
| Email delivery | Custom SMTP (Resend/Brevo free tier) | Supabase default mailer is heavily rate-limited; unusable beyond testing |
| Hosting | Cloudflare Pages (static) | Free, global, lets us set strict headers |
| CI | GitHub Actions | Lint, typecheck, tests, deploy |
| Tests | Vitest (unit/crypto), Playwright (e2e) | |

Fallback if you reject Supabase: Node + Fastify + Postgres + WebSocket + Lucia/own auth. More work, same crypto layer.

## 3. Security architecture

### 3.1 Keys
- At signup the browser generates: **X25519** keypair (encryption) and **Ed25519** keypair (signing).
- Private keys are wrapped with a key derived via **Argon2id** from a **separate encryption passphrase** (not the login password — Supabase sees the login password, so deriving keys from it defeats E2EE).
- A random **recovery key** is generated at signup and shown once (download/print). Without passphrase or recovery key, data is unrecoverable by design.
- Server stores: public keys, wrapped private keys (ciphertext), Argon2 salt/params. Never plaintext keys.
- Decrypted private keys live **in memory only**. Reload = unlock again with passphrase.

### 3.2 Rooms and messages
- Each room has a random 256-bit **room key**.
- Room key is wrapped per member with their public key (`crypto_box_seal`) and stored in `room_members.wrapped_key`.
- Message = XChaCha20-Poly1305(room_key, random nonce, plaintext), signed by sender's Ed25519 key. Server stores `ciphertext, nonce, sender_id, room_id, created_at`.
- Adding a member: wrap key for them. Removing a member: **rotate** room key, re-wrap for the rest (new messages only; old ciphertext they already had stays readable to them — unavoidable).
- Chat room and Secrets room have separate keys.

### 3.3 Secrets room
- Structured entries, not free chat: `name`, `value`, `notes`, `type` (env var / API key / file-less text), optional **expiry** and **burn-after-read**.
- Values masked by default; explicit reveal and copy; clipboard auto-clear after N seconds.
- Entry payload encrypted client-side the same way as messages.

### 3.4 Identity verification
- Server could swap a user's public key (MITM by operator). Mitigation: show a **safety number** (fingerprint of both public keys) per chat; users compare out-of-band; UI warns if a peer's key changes.

### 3.5 Discovery
- Search by exact username (prefix search allowed) or **exact** email match only. No email enumeration listing.
- Per-user toggle "discoverable by email". Rate-limited lookup function (Postgres `security definer` RPC).
- Chat starts as a **request**; recipient must accept before key wrapping is finalised.

### 3.6 Platform hardening
- Row Level Security on every table; no table readable without membership check.
- Strict CSP (no inline scripts, no third-party scripts, `connect-src` pinned), `Referrer-Policy: no-referrer`, HSTS, SRI; dependencies pinned and audited.
- No analytics, no logging of payloads.
- Rate limits on auth, lookup, and message insert.
- Session: short JWT, refresh rotation, logout wipes memory and IndexedDB.

## 4. Honest limitations (so there are no surprises)

1. **Web E2EE trusts whoever serves the JavaScript.** A compromised host or XSS can steal keys. CSP and pinned deps reduce, not remove, this. A desktop/mobile app would be stronger — not in v1.
2. **Metadata is visible to the server**: who talks to whom, when, message sizes, email/username.
3. **Forgot passphrase + lost recovery key = history is gone.** Email password reset only restores login, not data.
4. Not a replacement for a real secrets manager (Vault, Doppler, 1Password) for production infrastructure. This is a secure courier, not a vault with audit/rotation.
5. Recipients can copy secrets; E2EE protects transport and storage, not a malicious or compromised recipient.

## 5. Data model (Postgres)

- `profiles(id → auth.users, username unique, discoverable_by_email, public_enc_key, public_sign_key, wrapped_private_keys, kdf_salt, kdf_params, created_at)`
- `chats(id, created_by, status[pending|active], created_at)`
- `rooms(id, chat_id, kind[chat|secrets], key_version)`
- `room_members(room_id, user_id, wrapped_room_key, key_version, joined_at)`
- `messages(id, room_id, sender_id, ciphertext, nonce, signature, key_version, created_at)`
- `secrets(id, room_id, sender_id, ciphertext, nonce, signature, key_version, expires_at, burn_after_read, created_at)` (name/value/notes all inside ciphertext)
- RLS: select/insert only if `auth.uid()` in `room_members` for the room; no updates to ciphertext rows; deletes by sender only.

## 6. Frontend structure

```
/src
  /crypto      keys.ts  kdf.ts  roomKey.ts  message.ts  fingerprint.ts   (+ vitest)
  /lib         supabase.ts  session.ts  search.ts
  /features
    /auth      Signup, Login, ConfirmEmail, Unlock, RecoveryKey
    /chats     ChatList, NewChat (search), Requests
    /room      ChatRoom, SecretsRoom, SecretItem, SafetyNumber
    /settings  Profile, Discoverability, Devices, ChangePassphrase
  /ui          shared components
/supabase
  /migrations  schema + RLS
  /tests       RLS policy tests
```

## 7. Build phases

| # | Phase | Output | Est. |
|---|---|---|---|
| 0 | Repo scaffold, lint, CI, CSP headers | Empty app deploys | 0.5 d |
| 1 | Crypto core + tests (keygen, wrap, seal, sign, KDF) | `/crypto` with passing tests | 1.5 d |
| 2 | Schema + RLS + RLS tests | Migrations | 1 d |
| 3 | Auth: signup, email confirm, login, passphrase setup, recovery key, unlock | Working onboarding | 1.5 d |
| 4 | User search + chat request/accept flow | Find users, start chats | 1 d |
| 5 | Chat room (realtime, encrypt/decrypt, signatures) | Live encrypted chat | 1.5 d |
| 6 | Secrets room (masked, copy, expiry, burn-after-read) | Secret sharing | 1 d |
| 7 | Safety numbers, key-change warnings | Verification UX | 0.5 d |
| 8 | Hardening: rate limits, headers, dep audit, XSS review | Security pass | 1 d |
| 9 | e2e tests, deploy docs, README | Shippable v1 | 1 d |

Total ≈ 10–11 working days of focused effort for a human; much less wall-clock with me generating it, but phases 1, 2, 8 deserve your review regardless.

## 8. Explicitly out of scope for v1

Group chats outside projects (projects, see migration 0003, are the group feature), file attachments, multi-device key sync, push notifications, mobile apps, forward secrecy / double ratchet (room key is static per rotation), message search over ciphertext, admin panel.

## 9. Decisions I'm assuming unless you object

1. Supabase + custom SMTP (needs you to create the free Supabase project and SMTP account; I can't do that).
2. Separate encryption passphrase + recovery key (not derived from login password).
3. 1:1 chats only in v1, each with Chat + Secrets rooms.
4. Chat requests must be accepted.
5. English UI, dark/light theme.
6. MIT license.

## 10. Build status (v1 implemented)

Done: phases 0-9 for the scope above, except automated browser e2e against live Supabase (manual run-through required) and room-key rotation (1:1 only).
Added beyond the plan: GitHub Actions keep-alive + nightly `pg_dump` for the free-tier gaps, 15-minute idle auto-lock, passphrase change.
