# Security Audit - Midas (flujo-senda)

Auditoria actualizada: 2026-05-14

## Resumen ejecutivo

| # | Hallazgo | Severidad | Estado |
|---|----------|-----------|--------|
| F1 | Secretos reales en `.env.example` e historial git | Critica | Repo sanitizado; rotacion e historial pendientes de operacion |
| F2 | OpenAI/JDE/Cognos tokens enviados desde el browser | Alta | Migrado a rutas internas `/api/*`; el backend/proxy debe inyectar secretos |
| F3 | Gate de login client-side bypaseable | Alta | Removido como control de seguridad; queda solo gate local opcional |
| F4 | Falta de escaneo preventivo de secretos | Media | Agregados scripts `security:secrets` y `security:gitleaks` |
| F5 | Dependencias con advisories moderados | Media | Documentado; actualizar Vite/Vitest/PostCSS en entrega separada |

## Estado actual

- `.env.example` contiene solo placeholders. Ningun token, password o API key real debe volver a entrar al repo.
- El frontend usa rutas internas estables: `/api/jde`, `/api/tress`, `/api/cognos`, `/api/openai`.
- Los secretos productivos deben vivir en variables server-side: `JDE_TOKEN`, `COGNOS_TOKEN`, `OPENAI_API_KEY`.
- El browser no debe configurar valores `VITE_*` para tokens, passwords o API keys en produccion.
- El gate `Login.tsx` no protege datos. La proteccion real debe estar en el backend/SSO y en los endpoints `/api/*`.

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
