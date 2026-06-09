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

- `localAuth.ts` is the credential authority. Passwords are `SHA-256(salt:pwd)`;
  JSON entries seed them, and a `localStorage` overlay
  (`midas.auth.localOverrides.v1`) holds passwords that were changed, set by an
  admin, or defined on first login. It works for any email (JSON-seeded or
  registered by an admin).
- **First login = register.** A user an admin registered in the Usuarios module
  (registry entry, no password yet) sets their own password on first login:
  `requiresPasswordSetup(email)` routes them to a set-password screen, and
  `completeFirstLogin` fixes the password and opens the session.
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
