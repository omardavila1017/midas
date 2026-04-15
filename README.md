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
