# FlowSense Architecture

## Overview

FlowSense is a React-based cash flow analysis platform for Mexican transportation companies. It provides Excel upload, interactive dashboards with drill-down capabilities, proposal management, and scenario simulation.

## Core Data Flow

```
Excel Upload → FlowPlan → Dashboard (visualization)
           ↓
           ├→ ProposalCreator (create improvements)
           │     ↓
           └→ Simulator (combine & test scenarios)
```

## Component Hierarchy

### App.tsx (Root)
- **State**: plan, proposals, scenarios, activeTab
- **Role**: Layout shell, tab management, state orchestration
- **Children**: Upload | Dashboard | ProposalCreator | Simulator

### Upload Component
**Input**: Excel file
**Output**: FlowPlan object
**Responsibilities**:
- File validation & parsing (xlsx)
- Extract planning period & initial cash
- Build hierarchical concept tree
- Generate 52-week dates + monthly aggregation

**Expected Props**:
```typescript
interface UploadProps {
  onPlanLoaded: (plan: FlowPlan) => void;
}
```

### Dashboard Component
**Input**: FlowPlan, Proposal[]
**Output**: None (display-only)
**Responsibilities**:
- Tree visualization of concepts
- Month/week selection
- Drill-down into subcategories
- KPI cards (cash balance trend, top inflows/outflows)
- Monthly bar/line charts
- Proposal impact overlay

**Expected Props**:
```typescript
interface DashboardProps {
  plan: FlowPlan;
  proposals: Proposal[];
}
```

### ProposalCreator Component
**Input**: FlowPlan, Proposal[]
**Output**: New/updated Proposal objects
**Responsibilities**:
- Proposal form (category, percentage, probability, distribution)
- Automatic impact calculation from FlowPlan data
- List view with edit/delete
- Status management (Pending → In Progress → Approved)

**Expected Props**:
```typescript
interface ProposalCreatorProps {
  plan: FlowPlan;
  proposals: Proposal[];
  onAdd: (proposal: Proposal) => void;
  onUpdate: (proposal: Proposal) => void;
  onDelete: (id: string) => void;
}
```

### Simulator Component
**Input**: FlowPlan, Proposal[], Scenario[]
**Output**: Scenario objects + combined impact visualization
**Responsibilities**:
- Checkboxes to select which proposals apply
- Combined cash flow projection
- Before/after comparison
- Save scenarios with names
- Compare multiple scenarios side-by-side

**Expected Props**:
```typescript
interface SimulatorProps {
  plan: FlowPlan;
  proposals: Proposal[];
  scenarios: Scenario[];
  onSaveScenario: (scenario: Scenario) => void;
}
```

## Data Structures

### FlowPlan
Represents one uploaded Excel file with its full cash flow plan.

```typescript
{
  name: "Q2 2024 Plan",
  year: 2024,
  cajaInicial: 500000,              // Starting cash (MXN)
  concepts: [...],                  // Hierarchical tree
  weekDates: ["2024-01-01", ...]   // 52 ISO date strings
}
```

### FlowConcept
Individual line item (income/expense category).

```typescript
{
  id: "ingresos_001",
  excelRow: 5,                      // Source row for audit
  name: "Ingresos por Fletes",
  parentId: null,                   // null = root level
  responsible: "Gerencia Comercial",
  conceptType: "ingreso",           // 'ingreso'|'egreso'|'resumen'|'reserva'
  sortOrder: 1,
  weeklyData: [50000, 52000, ...],  // 52 weeks
  monthlyData: [400000, 420000, ...],  // 12 months (sum)
  children: [...]                   // SubConcepts
}
```

**Hierarchy Rules**:
- Concepts can nest up to N levels deep
- Children's totals feed up to parent
- "resumen" types are typically parent aggregations
- "reserva" types are safety/contingency buffers

### Proposal
Improvement initiative with projected impact.

```typescript
{
  id: "prop_001",
  conceptId: "egresos_combustible",  // Links to concept being improved
  conceptName: "Combustible",
  category: "Reducción de Costos",  // Cost reduction proposal
  name: "Optimizar rutas de distribución",
  reductionPct: 0.15,               // 15% savings
  probability: 0.80,                // 80% confidence
  startMonth: 2,                    // Begin in February
  distribution: "Mensual",          // Gradual rollout
  status: "En proceso",
  monthlyRealAmount: 50000,         // Avg monthly spend
  annualImpact: 90000,              // 15% × 50k × 12 × 80% probability
  monthlyImpact: [0, 6000, 6000, ...], // Month-by-month impact
  notes: "Requires driver training",
  createdAt: "2024-01-15T10:30:00Z"
}
```

**Impact Calculation Logic**:
```
monthlyImpact[m] = {
  if m < startMonth: 0
  if m === startMonth: monthlyRealAmount × reductionPct × probability × (distribution factor)
  if m > startMonth: monthlyRealAmount × reductionPct × probability
}
annualImpact = sum(monthlyImpact)
```

### Scenario
Named "what-if" combining multiple proposals.

```typescript
{
  id: "scen_q2_aggressive",
  name: "Agresivo Q2",
  description: "All cost reductions + new revenue stream",
  selectedProposalIds: ["prop_001", "prop_003", "prop_005"],
  createdAt: "2024-01-20T14:00:00Z"
}
```

## Styling

- **Framework**: Tailwind CSS with dark slate theme
- **Color Palette**:
  - Background: `bg-slate-950` (dark navy)
  - Cards/Panels: `bg-slate-800` with `border-slate-700`
  - Primary accent: `text-cyan-400` (bright cyan)
  - Text: `text-slate-300` (light gray)

- **Icons**: Lucide React (lightweight SVG icons)
  - Dashboard: `LayoutDashboard`
  - Proposals: `PlusCircle`
  - Simulator: `FlaskConical`
  - Upload: `Upload`

- **Charts**: Recharts for line/bar/area visualizations

## State Management Strategy

**Current (MVP)**: React useState in App.tsx
- Pros: Minimal, no boilerplate
- Cons: Not scalable beyond MVP

**Future**: Consider Context API or Zustand if:
- Components need deep prop drilling
- Undo/redo functionality needed
- Persistent state across sessions

## Excel Parsing Strategy

Upload component should:
1. Use `xlsx` library to read Excel file
2. Identify plan metadata (name, year, cajaInicial) from sheet header
3. Parse rows for concepts:
   - Column A: Concept name
   - Column B: Type (ingreso/egreso)
   - Column C: Responsible party
   - Columns D-AG: 52 weeks (or 12 months)
4. Build hierarchy based on indentation/grouping
5. Auto-generate IDs, compute monthly sums
6. Validate: 52 week cols or 12 month cols, numeric values

## Performance Considerations

- **Large Plans**: 1000+ concepts → virtualize tree display
- **Charts**: Use Recharts with responsiveContainer for responsive sizing
- **Scenario Comparison**: Pre-calculate impacts at creation time, not render time

## Future Enhancements

1. **Backend Integration**: Export scenarios to API, store plans in DB
2. **Collaboration**: Share plans/proposals with team
3. **Comments/Approval**: Track who approved what and when
4. **Sensitivity Analysis**: Monte Carlo simulation of scenarios
5. **Export**: PDF reports, Excel rollups
6. **Audit Trail**: Log all changes, restore previous versions
