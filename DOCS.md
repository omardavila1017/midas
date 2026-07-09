# Documentation index

Every Markdown doc in this repo, what it's for, and whether it's current.
Updated 2026-06-05 for delivery handoff.

## Start here

| If you are… | Read, in order |
|-------------|----------------|
| A new dev or an agent | `CLAUDE.md` → `ARCHITECTURE.md` → `README.md` |
| Deploying / on DevOps | `README.md` → `.env.example` → `AUTH.md` → `SECURITY-AUDIT.md` |
| An end user (treasury) | `MANUAL.md` |
| Auditing the business logic | `RULES.md` → `PURPOSE.md` |

## Current documents (authoritative)

| Doc | Purpose | Audience |
|-----|---------|----------|
| `CLAUDE.md` | **Source of truth.** Code layout, data flow, the two engines, scenario pipeline, invariants, performance architecture, "rules that bite", delivery state. | Devs / agents |
| `AGENTS.md` | Thin pointer to `CLAUDE.md` + the non-negotiable invariants (so the two never drift). | Agents |
| `ARCHITECTURE.md` | High-level layered view (layers, data flow, persistence). Orientation that `src/domain/types.ts` references. | Devs |
| `README.md` | Deploy, environment variables, tech stack, project structure, business surface. | Devs / DevOps |
| `MANUAL.md` | How to use the tool, in plain Spanish (es-MX), no jargon. | End users |
| `RULES.md` | The business rules behind the numbers (20 rules: Base scenario, collection calendar, factoring, CXP aging, provider flexibility, internal transfers, …). | Users / audit |
| `AUTH.md` | Auth model + required runtime controls. Frontend RBAC is **not** a security boundary. | Security / DevOps |
| `SECURITY-AUDIT.md` | Security findings, mandatory operational actions, pre-deploy gate. | Security / DevOps |
| `EXCLUSION_RULES.md` | The company exclusion filter (currently **empty** — nothing excluded; mechanism preserved). | Devs |
| `AUDITORIA-INTEGRACION-MODULOS.md` | Module ↔ module / API integration map, persistence inventory, risk map, roadmap (snapshot 2026-05-19). | Devs / architects |
| `AUDITORIA-CUADRE-PLANEACION.md` | Why the Base cash flow didn't square across modules: internal-transfer classification fix (2026-06-10), by-design divergences, the definitive missing-information list, how to verify the cuadre with real data. | Devs / treasury |
| `docs/MAPA-CONEXIONES-APIS.md` | The API datalake join map (2026-07-05): every API↔API cross with its exact keys/normalizers, file:function, consumer and status (ACTIVE/DISPLAY/LEGACY); canonical normalizers; known divergences; missing connections and the open questions that block them. | Devs / integration |
| `REPORTES-TRESS-COMPRAS-MAPEO.md` | Field-mapping spec for the TRESS (nómina) and Compras APIs, including fields still requested from the API. | Devs / integration |
| `docs/MIGRACION-ESTADO-SERVIDOR.md` | Migración de estado a servidor (junta 2026-06-23): clear-on-entry de caches JDE/TRESS + modelo de datos y contrato de APIs (insert/consult/update) para escenarios/planeación que construye el equipo de backend. | Backend / integración |
| `docs/COMPENSACIONES-COBRANZA.md` | Regla de excepción de compensaciones en el cuadre cobranza vs banco (junta 2026-07-09): nomenclatura de esquemas (`aplica-a-proveedor` / `descuento-en-origen`), comportamiento exacto del bucket `compensacion` y cómo agregar un cliente. Feeds `src/config/compensationClientsCatalog.ts`. | Tesorería / devs |
| `docs/fiscal/README.md` | Mapa de negocio fiscal (José Luis Gallegos + escritos CANAPAT + reportes JDE): coordinados fiscales TT/SIR con RFC autoritativos, exclusiones de IVA acreditable y tasas de ingreso 16 %/8 %. Feeds `src/config/coordinadoFiscalCatalog.ts` · `ivaCreditableExclusions.ts` · `ivaRegionRates.ts`. | Fiscal / devs |
| `PURPOSE.md` | Product purpose statement and rationale. | Product / leadership |
| `loop.md` | Checklist de cierre de sesión (4 fases: verificar/enviar → recordar → revisar/aplicar → reportar), adaptado del skill wrap-up con los baselines y convenciones de Midas. | Devs / agents |
| `PRODUCT.md` / `.impeccable.md` | Design-system context (Senda DS) read by the visual-tooling skills. | Design tooling |
| `.env.example` | Authoritative, fully-commented environment template. | DevOps |

## Historical (do not treat as current)

`docs/archive/` holds frozen snapshots kept for provenance — see
`docs/archive/README.md`:

- `COBRANZA-HANDOFF.md` (2026-05-03) — cobranza/bank-cross handoff; its bugs are resolved.
- `2026-05-05-impeccable-handoff.md` — visual/DS audit plan (was the broken-named `"  .md"` at root).
- `2026-05-11-audit.md` — read-only multi-lens audit.
- `UI-PROPOSALS.md` (2026-04-20) — UI proposals, mostly implemented.

The auto-generated SendaStack pipeline reports (`API.md`, `AUDIT.md`, `CLEAN.md`,
`CONVERT.md`, `UI.md`, `QA.md`) were **deleted** (reproducible machine output that
contradicted the current code — a defunct deployment target, an unshipped Cognos
migration, dark-mode/Excel claims that are no longer true). They live in git
history if needed.

## Conventions

- **`CLAUDE.md` wins** on any conflict between docs.
- Update the relevant doc **in the same PR** as the code change (doc drift is the
  recurring failure here).
- Spanish for user-facing copy; English for code/identifiers/commits.
