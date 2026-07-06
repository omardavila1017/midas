# AUTH REPORT

Generated: 2026-05-14
Artifact: flujo-senda

## Verdict

Frontend auth is not a security boundary.

## Current Model

- Shared deployments must be protected by `/api/auth/*` backed by an SSO provider or a backend session layer.
- API routes under `/api/*` must enforce access before proxying JDE, TRESS, Cognos, or OpenAI.
- Production secrets must be server-side only: `JDE_TOKEN`, `COGNOS_TOKEN`, `OPENAI_API_KEY`.
- The React app calls `/api/auth/session`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/password/change`, and password reset endpoints with `credentials: include`. The admin "set a user's password directly" action posts to `/api/auth/users/:email/password` (`{ newPassword }`) in backend mode.
- The React app stores no session token or password. The login form starts with an **empty** email (no prefill); the last-used email is still remembered in `localStorage` but is no longer injected into the field.

## Local auth mode (dev / internal — not a security boundary)

`src/config/authLocalUsers.json` (`enabled: true`) runs auth fully client-side
(see `src/services/localAuth.ts`). It is obfuscation, not security: the user
list and code are public in the bundle. In this mode:

- `localAuth.ts` is the credential authority. Passwords are `SHA-256(salt:pwd)`
  and live **only** in a `localStorage` overlay (`midas.auth.localOverrides.v2`).
  The JSON **no longer seeds passwords** — its `users` are just the pre-registered
  list (email + role). Every user starts passwordless and defines their own
  password on first login (register). The overlay holds passwords defined on
  first login, changed by the user, or set by an admin, for any pre-registered
  email (JSON or admin-registered).
- **Password reset (2026-06-09).** Bumping the overlay key `v1 → v2` wiped every
  previously-defined password so everyone starts from zero: all users (JSON +
  admin-registered) must re-register / re-set their password. The user list
  (JSON `users` + the `midas.users.registry.v1` registry) is preserved.
- **First login = register.** A pre-registered email with no password yet — in
  the JSON `users` list **or** registered by an admin in the Usuarios module —
  sets their own password on first login: `requiresPasswordSetup(email)` routes
  them to a set-password screen, and `completeFirstLogin` fixes the password and
  opens the session. An email that is **not** pre-registered can neither register
  nor log in.
- **⚠️ Hardcoded universal password (deliberate, 2026-06-10 — commit `c08ddc3`).**
  On top of the model above, `localAuth.ts` ships `HARDCODED_LOCAL_PASSWORD =
  'Senda123'`: `verifyLocalPassword` short-circuits on that literal for **every
  known account** (even after the user set their own password), and
  `currentHashForEmail` falls back to its hash, so every pre-registered email
  logs in immediately without the first-login setup. Explicit rollout decision
  to unblock all users at once. Consequences: the first-login/register flow is
  effectively bypassed (`hasLocalPassword` is always true), and anyone reading
  the public bundle can authenticate as any user, including admins. Consistent
  with "local mode is obfuscation, not security" — but it **must be removed
  (delete the short-circuit + hash fallback in `localAuth.ts`) before any
  deployment where the UI gate is expected to mean anything**. It does not
  exist in backend mode.
- **Admin sets passwords** directly via `adminSetPassword` (writes the overlay).
- **Per-browser limitation:** the registry and password overlay live in
  `localStorage`, so an admin registering a user / setting a password on their
  own device does **not** propagate to that user on another device. For
  multi-device user management, use the real `/api/auth/*` backend.

## Required Runtime Controls

- Session cookies, if issued by the app backend, must be `HttpOnly`, `Secure`, and `SameSite=Lax` or stricter.
- Browser-visible `VITE_*` variables must never contain tokens, passwords, API keys, or service credentials.
- Backend proxy errors must be generic and must not include upstream credentials or request headers.
- Password reset responses must not reveal whether an email exists.
- Password reset tokens must be one-time-use, short-lived, and validated only by the backend.

## Access control (UX layer — 2026-06-05 redesign)

The app exposes two roles, `admin` and `user` (plus `none`). `admin` sees every
module; a `user` sees only the modules an admin enables for them tab-by-tab in
the **Permisos** module. This is a **UX layer, not a security boundary**:

- Role + per-user permissions live in `localStorage` (`midas.users.registry.v1`,
  via `src/modules/users/services/accessControlStore.ts`), seeded from the
  backend/local auth source. They decide what to *show*, never what the API
  *authorizes*. Binding authorization stays at the backend/proxy `/api/*`.
- The registry is **per-browser**: permission grants an admin sets do **not**
  propagate to that user on another device unless a backend persists them.
  To make per-user permissions authoritative across users, add a backend
  endpoint (e.g. `GET/PUT /api/users/:email/permissions`) and have
  `accessControlStore` read/write it instead of (or alongside) `localStorage`.
- Registering an email in the **Usuarios** module sets its UX role/permissions;
  it does **not** create login credentials. Provisioning for actual sign-in
  remains a backend (or local-auth JSON) responsibility.
- `users` and `permisos` are admin-only and are never grantable as permissions
  (no privilege-escalation path through the permission switches).
