# AUTH REPORT

Generated: 2026-05-14
Artifact: flujo-senda

## Verdict

Frontend auth is not a security boundary.

## Current Model

- Shared deployments must be protected by `/api/auth/*` backed by an SSO provider or a backend session layer.
- API routes under `/api/*` must enforce access before proxying JDE, TRESS, Cognos, or OpenAI.
- Production secrets must be server-side only: `JDE_TOKEN`, `COGNOS_TOKEN`, `OPENAI_API_KEY`.
- The React app calls `/api/auth/session`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/password/change`, and password reset endpoints with `credentials: include`.
- The React app stores no session token or password. It may remember the last email only to prefill the login.

## Required Runtime Controls

- Session cookies, if issued by the app backend, must be `HttpOnly`, `Secure`, and `SameSite=Lax` or stricter.
- Browser-visible `VITE_*` variables must never contain tokens, passwords, API keys, or service credentials.
- Backend proxy errors must be generic and must not include upstream credentials or request headers.
- Password reset responses must not reveal whether an email exists.
- Password reset tokens must be one-time-use, short-lived, and validated only by the backend.
