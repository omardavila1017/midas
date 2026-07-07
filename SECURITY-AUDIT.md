# Security Audit - Midas (flujo-senda)

Auditoria actualizada: 2026-07-07

## Resumen ejecutivo

| # | Hallazgo | Severidad | Estado |
|---|----------|-----------|--------|
| F1 | Secretos reales en `.env.example` e historial git | Critica | Repo sanitizado; rotacion e historial pendientes de operacion |
| F2 | OpenAI/JDE/Cognos tokens enviados desde el browser | Alta | Migrado a rutas internas `/api/*`; el backend/proxy debe inyectar secretos |
| F3 | Gate de login client-side bypaseable | Alta | Removido como control de seguridad; queda solo gate local opcional |
| F4 | Falta de escaneo preventivo de secretos | Media | Agregados scripts `security:secrets` y `security:gitleaks` |
| F5 | Dependencias con advisories moderados | Media | Documentado; actualizar Vite/Vitest/PostCSS en entrega separada |
| F6 | Cartera de clientes servida como asset estatico pre-auth (`public/clientes-db.json`) | Alta | Documentado 2026-07-07; mitigacion operativa (auth delante de estaticos) |
| F7 | Inventario de cuentas bancarias reales dentro del bundle JS | Media | Documentado 2026-07-07; mismo mitigante que F6 |
| F8 | Proxies dev/QA con `secure: false` reenviando `JDE_TOKEN` | Baja | Documentado 2026-07-07; solo aplica a `npm run dev` |

## Estado actual

- `.env.example` contiene solo placeholders. Ningun token, password o API key real debe volver a entrar al repo.
- El frontend usa rutas internas estables: `/api/jde`, `/api/tress`, `/api/cognos`, `/api/openai`.
- Los secretos productivos deben vivir en variables server-side: `JDE_TOKEN`, `COGNOS_TOKEN`, `OPENAI_API_KEY`.
- El browser no debe configurar valores `VITE_*` para tokens, passwords o API keys en produccion.
- El gate `Login.tsx` no protege datos. La proteccion real debe estar en el backend/SSO y en los endpoints `/api/*`.

## F6-F8: exposicion de datos fuera del perimetro `/api/*` (auditoria 2026-07-07)

Los controles F2/F3 asumen que la autorizacion vive en el backend/proxy de `/api/*`. Estos hallazgos estan FUERA de ese perimetro:

- **F6 (Alta).** `public/clientes-db.json` se sirve como asset estatico (lo consume `src/domain/loadClientsCatalog.ts` via `fetch(BASE_URL + 'clientes-db.json')`). Contiene ~129 clientes reales con razon social, venta mensual estimada, dias de credito y calendario de pago. Se descarga SIN login: los estaticos no pasan por `/api/*`, asi que un backend perfectamente protegido no lo cubre. Mitigacion: el reverse-proxy/SSO que protege `/api/*` debe cubrir TAMBIEN los assets estaticos (todo el sitio detras de sesion). Mover el JSON al bundle NO mitiga (el bundle es igual de publico); no hacerlo como "fix".
- **F7 (Media).** `src/assets/bankAccountsCatalog.json` (numeros de cuenta reales del grupo, con rol concentradora/pagadora) se importa al bundle JS — extraible por cualquiera que descargue la app. Riesgo: ingenieria social / fraude de cambio de cuenta bancaria de proveedor. Mismo mitigante que F6. El catalogo es load-bearing (deteccion de traspasos internos, roles de cuenta) — no removerlo del codigo.
- **F8 (Baja).** `vite.config.ts` usa `secure: false` en los proxies dev (`/api/jde`, `/api/citi`, `/api/viajes-especiales`, `/api/store`) mientras adjunta `Bearer JDE_TOKEN`. Solo afecta `npm run dev` en redes dev/QA (un atacante on-path con cert forjado captura el token). No endurecer sin coordinar: los upstreams QA usan certs self-signed; si se activa la verificacion, distribuir la CA interna.

Recordatorio (implicito en F2/F3, se explicita porque muerde en deploy): las funciones `api/*` NO validan sesion por si mismas — adjuntan el token privilegiado y reenvian. `api/store/[...path].ts` acepta GET/POST/PUT/DELETE con fallback a `JDE_TOKEN`; sin SSO/sesion delante, cualquier acceso de red equivale a un proxy JDE autenticado.

## Acciones operativas obligatorias

1. Rotar inmediatamente las credenciales expuestas: JDE, OpenAI, Cognos si aplica, y passwords humanos que hayan sido reutilizados.
2. Despues de rotar, coordinar una ventana para purgar historial con `git filter-repo` o BFG y force-push.
3. Invalidar clones/caches antiguos o pedir reclone a colaboradores despues del force-push.
4. Habilitar secret scanning y push protection en GitHub.
5. Ejecutar antes de cada push:

```bash
npm run security:secrets
```

Si `gitleaks` esta instalado:

```bash
npm run security:gitleaks
```

## Pre-deployment gate

- `npm run typecheck`
- `npm test`
- `npm run build`
- Buscar en `dist/` patrones de secretos: OpenAI keys, JWTs, valores `VITE_*` sensibles y bearer headers literales.
- Confirmar que el backend/proxy protege `/api/*` con SSO/sesion y que inyecta secretos server-side.
