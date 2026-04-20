# FlowSense

A cash flow analysis platform for Mexican transportation companies. Upload weekly cash flow plans in Excel, explore interactive dashboards, create proposals, and simulate scenarios.

## Project Structure

```
FlowSense/
├── src/
│   ├── components/
│   │   ├── Upload.tsx              # Excel file upload interface (stub)
│   │   ├── Dashboard.tsx           # Main cash flow visualization (stub)
│   │   ├── ProposalCreator.tsx    # Create/manage improvement proposals (stub)
│   │   └── Simulator.tsx           # Scenario simulation tool (stub)
│   ├── App.tsx                     # Main app layout with tabs
│   ├── types.ts                    # TypeScript interfaces for data models
│   ├── main.tsx                    # React entry point
│   └── index.css                   # Global styles + Tailwind
├── index.html                      # HTML template
├── vite.config.ts                  # Vite configuration
├── tsconfig.json                   # TypeScript configuration
├── tailwind.config.js              # Tailwind CSS configuration
├── postcss.config.js               # PostCSS configuration
├── package.json                    # Dependencies
└── .gitignore                      # Git ignore rules
```

## Setup

```bash
npm install
npm run dev        # Start dev server
npm run build      # Build for production
npm run preview    # Preview production build
```

## Consumo de APIs JDE (localhost)

La app lee el catálogo de compañías, la antigüedad de saldos (CXP) y los
estados de cuenta bancarios directamente desde los APIs de JD Edwards.

### Arranque rápido

```bash
cp .env.example .env.local
# edita .env.local — coloca el Bearer token real en VITE_JDE_TOKEN
npm install
npm run dev
# http://localhost:5173
```

La máquina que corre el dev server debe poder alcanzar `srv-desarrollo:90`. Si
no tiene acceso directo:

- Sobrescribe `VITE_JDE_UPSTREAM` en `.env.local` apuntando a un host alcanzable
  (túnel SSH `http://localhost:8090`, mock, etc.); el proxy de Vite reenviará
  `/api/jde/*` hacia ahí.
- Alternativamente, fija `VITE_JDE_BASE_URL` a una URL pública final (el host
  tendrá que permitir CORS).

### Endpoints consumidos

| Endpoint | Método | Dónde se usa |
|---|---|---|
| `/JDEdwards/Empresas` | GET | Selector de compañía en el header |
| `/JDEdwards/AntiguedadSaldos` | POST | Pagos → CXP → "Consultar Antigüedad" |
| `/JDEdwards/Bancos` | POST | Pagos → Bancos |

### Troubleshooting

- **401 Unauthorized** → falta o es inválido `VITE_JDE_TOKEN`. Edita
  `.env.local` y reinicia `npm run dev`.
- **Network error / timeout** → el host `srv-desarrollo:90` no es alcanzable.
  Prueba `curl http://srv-desarrollo:90/JDEdwards/Empresas` desde la máquina;
  si falla, ajusta `/etc/hosts` o cambia `VITE_JDE_UPSTREAM`.
- **CORS** → asegúrate de usar el proxy (`VITE_JDE_BASE_URL=/api/jde`, valor
  por defecto). No llames al host directo desde el navegador.
- **0 registros devueltos** → verifica que la compañía seleccionada en el
  header tenga saldos abiertos, o que la fecha/formato enviado a Bancos sea
  válido para el día de consulta.
- **Ambiente productivo** → cuando JDE publique la URL productiva, actualiza
  `VITE_JDE_BASE_URL` y `VITE_JDE_TOKEN` en `.env.local` (no subir el token
  al repo).

## Architecture

- **Tech Stack**: React 18 + Vite + TypeScript + Tailwind CSS
- **Charts**: Recharts for data visualization
- **Icons**: Lucide React for UI icons
- **Excel Parsing**: XLSX for reading Excel files
- **State Management**: Simple React useState (no context needed for MVP)

## Data Models

### FlowPlan
Main data structure containing:
- Plan name and year
- Initial cash balance (cajaInicial)
- Hierarchical flow concepts (income/expense/summary)
- 52 weeks of data + 12 months aggregations

### FlowConcept
Individual cash flow line items with:
- Parent-child relationships for drilling down
- Weekly and monthly data arrays
- Type classification (ingreso/egreso/resumen/reserva)
- Responsible party tracking

### Proposal
Improvement initiative with:
- Categories: Cost Reduction, Revenue Growth, Deferment, Renegotiation
- Probability and impact calculations
- Monthly impact simulation

### Scenario
What-if analysis combining multiple proposals.

## Component Status

All components are currently stubs with proper TypeScript interfaces. Each accepts the correct props from App.tsx and renders a placeholder div. Ready for implementation by specialized agents.

## Next Steps

1. Implement Upload component (Excel parsing, FlowPlan construction)
2. Build Dashboard (tree visualization, drill-down, key metrics)
3. Create ProposalCreator (form, list management, impact calc)
4. Build Simulator (scenario selection, impact aggregation)
