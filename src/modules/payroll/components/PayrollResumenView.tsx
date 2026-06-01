/**
 * Sub-pestaña "Resumen" del dashboard de Nómina.
 *
 * KPIs del mes filtrado + composición del monto por las clasificaciones que
 * entrega el API: tratamiento de caja, tipo de concepto y tipo de nómina.
 */

import { useMemo } from 'react';
import { Banknote, Coins, Download, Users } from 'lucide-react';
import { fmtCurrency } from '../../../formatters';
import KpiCard from '../../../components/ui/KpiCard';
import type { PayrollCostRecord } from '../../shared-finance/types';
import { computeKpis } from '../services/payrollModuleService';
import {
  summarizeByCashTreatment,
  summarizeByConceptType,
  summarizeByPayrollType,
} from '../services/payrollAnalyticsService';
import { ChartCard, CategoryLegend, DonutChart } from './chartPrimitives';

export default function PayrollResumenView({ records }: { records: PayrollCostRecord[] }) {
  const kpis = useMemo(() => computeKpis(records), [records]);
  const byCash = useMemo(() => summarizeByCashTreatment(records), [records]);
  const byConceptType = useMemo(() => summarizeByConceptType(records), [records]);
  const byPayrollType = useMemo(() => summarizeByPayrollType(records), [records]);

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <KpiCard
          label="Nómina Bruta"
          value={fmtCurrency(kpis.totalGross)}
          icon={<Coins className="h-4 w-4" />}
          sublabel="Σ Percepciones"
        />
        <KpiCard
          label="Pago Neto al Empleado"
          value={fmtCurrency(kpis.totalNetCash)}
          icon={<Banknote className="h-4 w-4" />}
          sublabel="Lo que sale del banco en FechaPago"
          tone="success"
        />
        <KpiCard
          label="Retenciones (ISR/IMSS Empleado)"
          value={fmtCurrency(kpis.totalWithholdings)}
          icon={<Download className="h-4 w-4" />}
          sublabel="Se enteran al SAT/IMSS después"
          tone="warning"
        />
        <KpiCard
          label="Aportaciones Patronales"
          value={fmtCurrency(kpis.totalEmployerTaxes)}
          icon={<Users className="h-4 w-4" />}
          sublabel={`${kpis.payingCompanies} cía(s) · ${kpis.periodCount} periodo(s)`}
        />
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <ChartCard title="Por tratamiento de caja" subtitle="Distribución del monto total">
          <DonutChart data={byCash} />
          <div className="mt-3">
            <CategoryLegend data={byCash} />
          </div>
        </ChartCard>
        <ChartCard title="Por tipo de concepto" subtitle="Percepción / Deducción / Aportación / …">
          <DonutChart data={byConceptType} />
          <div className="mt-3">
            <CategoryLegend data={byConceptType} />
          </div>
        </ChartCard>
        <ChartCard title="Por tipo de nómina" subtitle="Semanal vs Quincenal">
          <DonutChart data={byPayrollType} />
          <div className="mt-3">
            <CategoryLegend data={byPayrollType} />
          </div>
        </ChartCard>
      </section>
    </div>
  );
}
