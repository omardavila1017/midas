# Security Audit — Midas (flujo-senda)

Auditoría: 2026-04-27
Branch: `claude/security-audit-api-keys-Joifs`
Alcance: exposición de credenciales, pen-test del frontend, configuración de
APIs (JDE / Cognos), persistencia local y dependencias.

> **Nota 2026-05-13** — Vercel fue removido del stack. Las mitigaciones F3,
> F4 y F6 que dependían de Vercel Serverless Functions y `vercel.json` ya no
> aplican: hoy la app corre solo en localhost y `VITE_JDE_TOKEN` viaja
> embebido en el bundle de dev. Cuando se migre a un servidor real, reaplicar
> el patrón de proxy server-side (sin Vercel) y reintroducir los headers de
> seguridad a nivel del nuevo host.

---

## 1. Resumen ejecutivo

| # | Hallazgo | Severidad | Estado |
|---|----------|-----------|--------|
| F1 | Token JDE filtrado en historial git (`.env.example`, commit `4db51c0` y anteriores) | 🔴 Crítica | Mitigado en repo / **token debe rotarse** |
| F2 | Password de admin en plain text en `src/components/Login.tsx` | 🔴 Crítica | Mitigado (hash SHA-256 vía env) / **password debe rotarse** |
| F3 | Tokens `VITE_JDE_TOKEN` / `VITE_COGNOS_TOKEN` quedan inlined en el bundle público | 🔴 Crítica | Mitigado (proxy serverless `api/jde/[...path].ts`) |
| F4 | `vercel.json` rewrite directo a `api.gruposenda.com` sin auth server-side | 🟡 Alta | Mitigado (sustituido por Function) |
| F5 | Auth gate de admin se puede saltar desde DevTools (`sessionStorage`) | 🟡 Alta | Documentado (auth real → Atlas SSO) |
| F6 | Sin Content-Security-Policy ni headers de seguridad | 🟡 Media | Mitigado (`vercel.json` → CSP, HSTS, XFO, etc.) |
| F7 | 6 vulnerabilidades npm moderadas (vite/postcss/esbuild/vitest, devDeps) | 🟡 Media | Documentado, fix mayor disponible |
| F8 | `.gitignore` no excluía `.env`, `*.pem`, etc. | 🟢 Baja | Mitigado |

Resultado tras mitigaciones: build verde, 155/155 tests passing, ningún
secreto en `dist/`.

---

## 2. Hallazgos detallados

### 🔴 F1 — Token JDE filtrado en git history

`.env.example` contuvo durante varios commits un Bearer token real:

```
VITE_JDE_TOKEN= Smv9xKp2rNqLwA4jTdYe7BhCuZoV3mFgXi6nWsR
```

Commit que lo retiró: `4db51c0` ("Banco a cashflow"). Sigue accesible vía:

```bash
git log --all --full-history -p --pickaxe-regex -S 'Smv9xKp2rNqLwA4jTdYe7BhCuZoV3mFgXi6nWsR'
```

**Impacto**: cualquiera con acceso al repositorio (público en GitHub) puede
extraer el token y golpear los endpoints `/v1/erp/tesoreria/*` con privilegios
de tesorería: leer antigüedad de saldos, estados de cuenta bancarios y
catálogos de empresas de Grupo Senda.

**Acciones requeridas (fuera del scope de este PR)**:

1. **Rotar el token JDE inmediatamente** con el equipo de JDE/Tesorería.
2. (Opcional, requiere autorización explícita) reescribir el historial con
   `git filter-repo --invert-paths --path .env.example` o `git filter-repo
   --replace-text`. Implica force-push y coordinación con todos los clones.
   Si el token ya se rotó, el riesgo residual de dejar el histórico es
   bajo y este paso puede omitirse.
3. Habilitar GitHub secret scanning / push protection en el repo.

---

### 🔴 F2 — Password admin en plain text

`src/components/Login.tsx` definía:

```ts
const ADMIN_USER = 'admin';
const ADMIN_PASSWORD = 'ARomo1$';
```

**Impacto**: el password queda en el repositorio y, una vez compilado, en el
bundle JavaScript público (`dist/assets/*.js`). Cualquier visitante de la app
desplegada podía buscar el string en DevTools y recuperar la credencial.

**Mitigación aplicada (este PR)**:
- El password en plain text fue eliminado del código.
- Se sustituyó por verificación `SHA-256` con comparación constant-time
  (Web Crypto API).
- El hash se lee desde `VITE_ADMIN_PASSWORD_SHA256`. Si la variable no
  está configurada, el placeholder por defecto NO autoriza ningún login
  (es el hash de `change-me`).
- Se marcó el componente como gate de cliente disuasivo, no como
  autenticación real. La autenticación robusta debe correr en Atlas SSO
  (consistente con `AUTH.md`).

**Acciones requeridas (operación)**:

1. **Rotar el password** que se filtró en git.
2. Calcular el hash con: `printf '%s' '<nuevo-password>' | sha256sum`
3. Configurar `VITE_ADMIN_PASSWORD_SHA256` en Vercel y `.env.local`.

---

### 🔴 F3 — Tokens `VITE_*` expuestos en bundle público

Vite reemplaza referencias a `import.meta.env.VITE_*` en compile-time
inyectando el valor literal en el bundle. Eso aplica también a:
- `VITE_JDE_TOKEN`
- `VITE_COGNOS_TOKEN`

**Impacto**: cualquiera que abra DevTools en la app desplegada podía leer
los Bearer tokens y reusar cuentas server-side de tesorería. Esto equivale
a dejar credenciales privadas en HTML público.

**Mitigación aplicada (este PR)**:

- Nueva Vercel Serverless Function `api/jde/[...path].ts`:
  - Lee `JDE_TOKEN` (sin prefijo `VITE_`) — variable server-side, NO se
    inlinea en el bundle.
  - Reescribe `/api/jde/<path>` → `${JDE_UPSTREAM}/<path>` e inyecta
    `Authorization: Bearer ${JDE_TOKEN}` server-side.
  - Soporta GET/POST/PUT/DELETE/PATCH y reenvía body, query y status del
    upstream con `Cache-Control: no-store`.

- `vercel.json`: se quitó el rewrite directo a `api.gruposenda.com`. Ahora
  la Function maneja `/api/jde/*`. El frontend nunca ve el token.

- `src/services/jdeClient.ts`: si `VITE_JDE_TOKEN` está vacío y el `baseUrl`
  apunta al proxy interno (`/api/jde`), el cliente NO envía el header
  `Authorization` desde el navegador. Lo inyecta la Function. Esto permite
  desplegar a producción sin filtrar el token.

- `src/config/api.config.ts`: emite warning en consola si detecta que la
  build de producción incluye una `VITE_JDE_TOKEN` o `VITE_COGNOS_TOKEN`
  no vacía (recordatorio operativo).

**Migración recomendada para Cognos**:

Replicar el patrón con una Function `api/cognos/[...path].ts` que lea
`COGNOS_TOKEN` server-side. Mientras tanto, en producción no configurar
`VITE_COGNOS_TOKEN`: el código degrada a mocks (ver `catalog.service.ts`)
y no expone credenciales.

---

### 🟡 F4 — Rewrite directo en `vercel.json`

La configuración previa:

```json
{ "source": "/api/jde/:path*", "destination": "https://api.gruposenda.com/v1/erp/tesoreria/:path*" }
```

es un rewrite Edge: Vercel solo cambia la URL, no inyecta headers ni hace
auth. El token tenía que viajar desde el navegador. Esto ya quedó sustituido
por la Function (F3). Se removió la entrada del `rewrites`.

---

### 🟡 F5 — Auth gate trivialmente bypaseable

El gate guarda el resultado del login en `sessionStorage['midas-auth-v1'] = 'ok'`.
Cualquier visitante puede saltarlo desde DevTools:

```js
sessionStorage.setItem('midas-auth-v1', 'ok'); location.reload();
```

**Impacto**: el "login" es decorativo. No protege el contenido — protege
contra "alguien que abre la URL sin saber el password". Cualquier atacante
con DevTools entra.

**Mitigación**:
- Documentado en código y en este audit.
- El gate sigue útil como UX (que un usuario casual no entre por accidente).
- Para auth real: delegar a Atlas SSO / Vercel Authentication (Project →
  Settings → Deployment Protection). `AUTH.md` ya menciona esto.

---

### 🟡 F6 — Sin headers de seguridad

`index.html` y `vercel.json` no declaraban Content-Security-Policy,
Strict-Transport-Security, X-Frame-Options ni Referrer-Policy. Permite
clickjacking, MIME-sniffing y degradación HTTPS.

**Mitigación aplicada** (`vercel.json`):

- `Content-Security-Policy` restrictivo (`default-src 'self'`,
  `frame-ancestors 'none'`, `object-src 'none'`).
- `Strict-Transport-Security` con preload.
- `X-Content-Type-Options: nosniff`.
- `X-Frame-Options: DENY`.
- `Referrer-Policy: strict-origin-when-cross-origin`.
- `Permissions-Policy` denegando camera/mic/geolocation/FLoC.

Validar tras el primer deploy: si Recharts/Lucide requieren `unsafe-inline`
para algún estilo crítico, ajustar el CSP. La política actual permite
`style-src 'self' 'unsafe-inline'` precisamente por eso.

---

### 🟡 F7 — npm audit: 6 vulnerabilidades moderadas

Reporte (todas en devDependencies):

| Paquete | CVE / advisory | Impacto |
|---------|----------------|---------|
| esbuild ≤0.24.2 | GHSA-67mh-4wv8-2f99 | Dev server permite cross-origin requests |
| vite ≤6.4.1 | GHSA-4w7w-66w2-5vf9 | Path traversal en `.map` (dev) |
| postcss <8.5.10 | GHSA-qx2v-qp2m-jg93 | XSS vía `</style>` no escapado |
| vitest, vite-node, @vitest/mocker | derivadas | Solo dev |

**Riesgo real**: bajo en producción (afectan dev server y build chain). Fix
disponible vía `npm audit fix --force` que sube vite a 8.x — semver-major,
puede romper config. **Recomendación**: programar una sesión dedicada de
upgrade de toolchain. No bloquea esta auditoría.

---

### 🟢 F8 — `.gitignore` poco estricto

`*.local` cubría `.env.local` por convención de Vite, pero no `.env`,
`.env.production`, `*.pem`, etc.

**Mitigación**: se agregaron reglas explícitas y exclusión de `*.pem`,
`*.key`, `secrets.json`, `credentials.json` para evitar commits accidentales
de credenciales locales.

---

## 3. Pen-test del frontend (resumen)

| Vector | Resultado |
|--------|-----------|
| `dangerouslySetInnerHTML` | No hay usos. ✅ |
| `eval(...)`, `new Function(...)` | No hay usos. ✅ |
| `innerHTML = ...`, `document.write` | No hay usos. ✅ |
| Inputs externos a parseo numérico (JDE) | Saneados con `toNum`/`toStr` en `src/services/jde.ts`. ✅ |
| Datos en `localStorage` | Solo datos no sensibles del propio usuario (forecast, overrides, configuración). No PII de terceros. ✅ |
| Datos en `sessionStorage` | Solo flag `midas-auth-v1` (no contiene credenciales). ⚠️ pero ver F5. |
| CORS / Vercel rewrite | Reemplazado por Function (F3). ✅ |
| CSP / clickjacking | Headers añadidos (F6). ✅ |
| Dependencias con CVEs | 6 moderadas en devDeps (F7). 🟡 |
| Token en bundle | Eliminado vía proxy server-side (F3). ✅ |
| Password en bundle | Eliminado, ahora hash (F2). ✅ |

---

## 4. Plan de remediación operativa

Tareas que requieren intervención humana (no se pueden hacer desde el repo):

1. **🔴 Rotar token JDE** que apareció en git history. Coordinar con admin
   de JDE/Tesorería. El token actual debe considerarse comprometido.
2. **🔴 Rotar password admin** y cargar el SHA-256 en `VITE_ADMIN_PASSWORD_SHA256`
   en Vercel.
3. **🔴 Configurar `JDE_TOKEN` server-side** en Vercel → Project → Settings →
   Environment Variables (Production + Preview). Vaciar `VITE_JDE_TOKEN`.
4. **🟡 Habilitar Vercel Authentication / Atlas SSO** sobre el deployment
   para auth real (ver F5).
5. **🟡 Habilitar GitHub secret scanning + push protection** en
   `santiagomlr/flujo-senda`.
6. **🟡 Programar upgrade del toolchain** (vite 8, vitest 4) para cerrar
   las vulnerabilidades moderadas (F7).
7. **🟢 (Opcional)** reescribir git history para borrar el token filtrado;
   solo si la rotación del paso 1 deja un riesgo residual percibido.

---

## 5. Cambios introducidos en este PR

```
api/jde/[...path].ts          ← nuevo proxy serverless (server-side token)
vercel.json                   ← elimina rewrite directo, agrega CSP + headers
src/components/Login.tsx      ← password plain text → SHA-256 + constant-time
src/config/api.config.ts      ← warning si VITE_*_TOKEN se filtra al bundle
src/services/jdeClient.ts     ← omite Authorization si delega al proxy
src/vite-env.d.ts             ← types de las nuevas env vars
.env.example                  ← documenta modelo VITE_* vs server-side
.gitignore                    ← excluye .env*, *.pem, *.key, secrets.json
SECURITY-AUDIT.md             ← este reporte
```

Verificación:
- `npm test` → 155 passing.
- `npm run build` → OK.
- `grep -r 'ARomo1\$' dist/` → vacío.
- `grep -r 'Smv9xKp2rNqLwA4jTdYe7BhCuZoV3mFgXi6nWsR' dist/` → vacío.
