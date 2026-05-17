# AUTH REPORT

Generated: 2026-05-14
Artifact: flujo-senda

## Verdict

Frontend auth is not a security boundary.

## Current Model

- Shared deployments must be protected by Atlas SSO or a backend session layer.
- API routes under `/api/*` must enforce access before proxying JDE, TRESS, Cognos, or OpenAI.
- Production secrets must be server-side only: `JDE_TOKEN`, `COGNOS_TOKEN`, `OPENAI_API_KEY`.
- The React app may show an optional local development gate with `VITE_ENABLE_LOCAL_AUTH_GATE=true`, but it stores no session token and is not authorization.

## Required Runtime Controls

- Session cookies, if issued by the app backend, must be `HttpOnly`, `Secure`, and `SameSite=Lax` or stricter.
- Browser-visible `VITE_*` variables must never contain tokens, passwords, API keys, or service credentials.
- Backend proxy errors must be generic and must not include upstream credentials or request headers.
