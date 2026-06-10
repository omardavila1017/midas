---
name: loop
description: Use when user says "wrap up", "cierra la sesión", "close session",
  "termina la tarea", "wrap things up", or invokes /loop — runs the Midas
  end-of-session checklist for verification, shipping, memory, and
  self-improvement
---

# Midas — Cierre de sesión (loop)

Checklist de fin de sesión para cualquier dev o agente que trabajó en este
repo. Corre **cuatro fases en orden**. Cada fase es conversacional e inline —
sin documentos separados. Todas las fases se auto-aplican sin pedir permiso
ítem por ítem; al final se presenta **un solo reporte consolidado**.

Fuente de verdad de código/arquitectura: `CLAUDE.md`. Índice de docs:
`DOCS.md`. Este archivo no duplica esa información — la operacionaliza como
ciclo de cierre.

## Fase 1: Verificar y enviar (Ship It)

**Verificación (gate — no se commitea sin esto):**

1. `npm run typecheck` → limpio. Cualquier error nuevo es tuyo.
2. `npm test` → baseline 2026-06-10: **111 files, 1011 passed, 12 skipped,
   0 failed** (~35s). Los 12 skips son los `it.skip` de
   `canonicalProjection.test.ts` (proyección de largo plazo eliminada);
   cualquier falla nueva es tuya.
3. `npm run build` → pasa con UNA advertencia esperada: el chunk
   `AppCoreWithProviders` ~775 kB (>500 kB del umbral de Vite). No es
   bloqueante; cualquier otra advertencia o error sí lo es.
4. Si hubo cambios visuales: smoke con `npm run dev` del path tocado y
   toggle de dark mode (clase `dark` en `<html>` vía DevTools) — splash,
   grid de planeación, charts, CommandPalette (⌘K), modals e inputs deben
   leerse bien en ambos modos.
5. NUNCA correr `npm audit fix --force` — la deuda de devDeps (vite 5→8,
   vitest 2→4) es deliberada y `npm audit --omit=dev` está limpio.

**Commit / push:**

6. `git status` en el repo. Si hay cambios sin commitear, commit con mensaje
   descriptivo **en inglés** (convención del repo: español para copy de UI,
   inglés para código/identificadores/commits), siempre en la branch de
   trabajo — nunca directo a `main`.
7. Push a la branch y, si no existe, abrir el PR como **draft**.

**Colocación de archivos:**

8. Docs nuevos (`.md`) van en la **raíz** del repo (convención actual) y se
   **registran en `DOCS.md` en el mismo PR**. Snapshots históricos van a
   `docs/archive/` (congelados — nunca se "actualiza" uno).
9. Keys nuevas de `localStorage` / IndexedDB se registran en
   `src/domain/storageRegistry.ts` **en el mismo PR** — lo hace cumplir
   `storageRegistry.test.ts` (escanea `src/` por literales `midas.*` y falla
   si alguna no está registrada).

**Deploy:**

10. Midas no tiene deploy desde la sesión — lo opera el equipo que despliega
    (ver `README.md`). Saltar siempre; no preguntar por deploy manual.

**Limpieza de tareas:**

11. Revisar la lista de pendientes de la sesión: marcar lo completado, y
    cualquier cosa que quedó a medias se dice **explícitamente** en el PR —
    nunca se reporta como terminado lo que no se verificó.

## Fase 2: Recordar (Remember It)

Repasar lo aprendido en la sesión y decidir dónde vive cada pieza de
conocimiento — la jerarquía real de este repo:

- **`CLAUDE.md`** — fuente de verdad de código/arquitectura/invariantes. Si
  la sesión cambió la arquitectura, se actualiza **en el mismo PR** — el
  doc drift es el riesgo #4 de "Risks that bite".
- **`DOCS.md`** — el índice de todos los docs. Todo doc nuevo o cambio de
  estado (vigente ↔ archivado) se refleja ahí.
- **`AGENTS.md`** — apuntador delgado a `CLAUDE.md`. **No duplicar contenido
  aquí**: se diseñó así a propósito para que los dos no driften.
- **`RULES.md`** — reglas de negocio numeradas (audiencia: usuarios y
  auditoría, en español). Una regla de negocio nueva o corregida va aquí.
- **`docs/archive/`** — snapshots congelados con valor histórico. Material
  superado se archiva, no se borra ni se edita en sitio.

**Marco de decisión:**

- ¿Convención permanente de código o invariante? → `CLAUDE.md`
- ¿Regla de negocio detrás de los números? → `RULES.md`
- ¿Doc nuevo o cambio de vigencia? → `DOCS.md`
- ¿Contexto superado pero con valor de procedencia? → `docs/archive/`
- ¿Está duplicando algo que ya vive en otro doc? → referencia, no copia

## Fase 3: Revisar y aplicar (Review & Apply)

Analizar la conversación/sesión en busca de hallazgos de auto-mejora. Si la
sesión fue corta o rutinaria y no hay nada notable, decir "Nada que mejorar"
y pasar a la Fase 4.

**Auto-aplicar todos los hallazgos accionables de inmediato** — sin pedir
aprobación por cada uno. Aplicar, commitear, y presentar el resumen.

**Categorías de hallazgo:**

- **Skill gap** — cosas que costaron varios intentos o salieron mal.
- **Fricción** — pasos manuales repetidos o cosas que el usuario tuvo que
  pedir explícitamente y debieron ser automáticas.
- **Conocimiento** — datos del proyecto/setup que no se sabían y se debían
  saber.
- **Automatización** — patrones repetitivos que podrían volverse script o
  skill.

**Checks específicos de Midas (han mordido antes):**

- ¿Se violó (o casi) alguna invariante? — el Escenario Base (`id === 'base'`,
  solo datos reales de API, sin futuro, read-only), la inversión de
  terminología Simulación/Escenario/Propuesta (UI) vs.
  scenario/adjustment (código), leer persistencia sin pasar por el
  normalizer, cómputo pesado fuera de `src/workers/`, borrar
  `INTERNAL_RECON` creyendo que es ruido, o re-aplicar el filtro de
  exclusiones dentro de `canonicalProjection.ts` (doble filtro).
- Si una invariante casi se rompe, la lección se agrega a `CLAUDE.md`
  ("Risks that bite") **en el mismo PR** — así el siguiente no tropieza igual.

**Formato del resumen** (aplicados primero, luego sin acción):

```
Hallazgos (aplicados):

1. ✅ Skill gap: …
   → [CLAUDE.md] …

---
Sin acción:

2. Conocimiento: …
   Ya documentado en CLAUDE.md
```

## Fase 4: Reportar (handoff)

Midas es una app interna de tesorería — **no hay publicación externa**; esta
fase es de handoff, no de marketing.

**Si la sesión cambió arquitectura, baselines o estado de entrega:**

- Actualizar la sección "Delivery / handoff state" de `CLAUDE.md` (fecha,
  baseline verificado de typecheck/test/build, artefactos intencionales,
  follow-ups abiertos) para que el siguiente que llegue arranque del estado
  real.

**Si no hay nada que reportar:**

- Decir "Nada que actualizar en el handoff".

Cerrar con el **reporte consolidado de las cuatro fases**: qué se verificó
(con los números reales), qué se commiteó/pusheó y a qué PR, qué se recordó
y dónde, qué hallazgos se aplicaron, y qué quedó pendiente.
