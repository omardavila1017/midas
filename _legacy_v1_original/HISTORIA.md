# Tu código original (rescatado del git history)

Carpeta generada a partir del **commit raíz** del repo — la primera versión que existió antes de 110 commits, 8 ramas remotas y múltiples merges.

## Origen

- **Commit:** `3ac24a6`
- **Autor:** Santiago MLR
- **Fecha:** 2026-04-14 21:03:52 -06:00
- **Mensaje:** *feat: UI overhaul — white/light theme, Apple-quality design*

Es literalmente el primer commit del repositorio (no tiene padre).

## Qué había en ese momento

Solo estos archivos de código:

```
src/
├── App.tsx                          (  97 líneas)
├── main.tsx
├── index.css
├── types.ts                         (  62 líneas)
├── components/
│   ├── Dashboard.tsx                ( 439 líneas)
│   ├── ProposalCreator.tsx          ( 624 líneas)
│   ├── Simulator.tsx                ( 562 líneas)
│   └── Upload.tsx
└── utils/
    ├── calculations.ts
    └── excelParser.ts
```

Comparado con hoy (branch `feat/scenarios-workspace`, commit `45e98d5`):

| Archivo                         | Entonces  | Hoy       | Crecimiento |
| ------------------------------- | --------- | --------- | ----------- |
| src/App.tsx                     |  97       | 1334      | **×13.7**   |
| src/components/ProposalCreator  | 624       | 1587      | ×2.5        |
| src/components/Simulator        | 562       |  816      | ×1.5        |
| src/components/Dashboard        | 439       |  452      | ×1.0        |
| src/types.ts                    |  62       |  307      | ×5.0        |
| src/components/Forecast.tsx     | —         | 1416      | nuevo       |
| src/domain/scenarioEngine.ts    | —         |  869      | nuevo       |

Nada de `Forecast.tsx`, `ScenariosWorkspace.tsx`, `ProjectionWorkspace.tsx`, `scenarioEngine.ts`, `proposalCompiler.ts`, `persistence.ts`, ni carpeta `domain/`. Era un prototipo plano y delgado.

## Hitos importantes en el historial

```
3ac24a6  2026-04-14 21:03  Santiago MLR   feat: UI overhaul  ← RAÍZ (esta carpeta)
fe1d2b7  2026-04-14 21:57  Paolordz       Comit 1 framework
07d3034  2026-04-14 22:01  Paolordz       Claude lauch
6c144bb  2026-04-14 22:01  Santiago MLR   cxp-first-push
...
cd07cbf  2026-04-20 10:17  Paolordz       Plan: Motor Unificado de Propuestas, Escenarios y Simulaciones
916c838  2026-04-20 12:50  Santiago MLR   forecast
1bf43d0  2026-04-20 19:31  Paolordz       escenarios
b19ab76  2026-04-20 21:33  Santiago MLR   overhaul de flujo de efectivo
a933daf  2026-04-21 17:17  santiagomlr    refactor: bump store to v3
45e98d5  2026-04-21 17:19  santiagomlr    Merge PR #14                ← HEAD actual
```

La explosión de complejidad se concentró entre el **20 y 21 de abril** (hace 1-2 días).

## Cómo visualizar más en tu terminal

```bash
# Historial completo (110 commits)
git log --all --oneline

# Ver el commit raíz tal cual
git show 3ac24a6

# Ver qué cambió en un archivo desde entonces hasta hoy
git diff 3ac24a6..HEAD -- src/App.tsx

# Ver el archivo tal como estaba en el commit raíz
git show 3ac24a6:src/App.tsx

# Abrir esa versión antigua en tu editor (sin afectar nada)
git show 3ac24a6:src/App.tsx > /tmp/App.original.tsx

# Ver el historial de un archivo específico
git log --all --oneline -- src/components/ProposalCreator.tsx

# Cambiarte TEMPORALMENTE al commit raíz (read-only, "detached HEAD")
git checkout 3ac24a6
# ... explorar el árbol ...
# Y volver
git checkout feat/scenarios-workspace

# Crear una rama local que apunte al origen (sin pushear)
git branch legado/v1-original 3ac24a6
# Luego te mueves con: git checkout legado/v1-original
```

## Notas

- Esta carpeta es una copia, no un checkout. Puedes borrarla sin afectar nada.
- El `.git/config` del repo estaba corrupto (todo null bytes) y tuve que reemplazarlo por una config mínima. El original corrupto quedó como `.git/config.corrupted.bak`. Todos los objetos y refs están íntegros.
- No se pusheó nada. Solo lectura del historial.
