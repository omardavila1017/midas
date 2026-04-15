export interface FlowPlan {
  name: string;
  year: number;
  cajaInicial: number;
  concepts: FlowConcept[];
  weekDates: string[]; // ISO dates for each week
}

export interface FlowConcept {
  id: string;
  excelRow: number;
  name: string;
  parentId: string | null;
  responsible: string | null;
  conceptType: 'ingreso' | 'egreso' | 'resumen' | 'reserva';
  sortOrder: number;
  weeklyData: number[]; // 52 values
  monthlyData: number[]; // 12 values
  children?: FlowConcept[];
}

export interface Proposal {
  id: string;
  category: 'Reducción de Costos' | 'Incremento de Ingresos' | 'Diferimiento' | 'Renegociación';
  name: string;
  monthlyAmount: number; // estimated monthly impact in $M (positive = improvement)
  probability: number; // 0-1
  startMonth: number; // 1-12
  distribution: 'Mensual' | 'Semestral' | 'Único';
  status: 'Pendiente' | 'En proceso' | 'Aprobada' | 'Descartada';
  annualImpact: number; // calculated from monthlyAmount × probability × distribution
  monthlyImpact: number[]; // 12 values, calculated
  responsible: string; // who owns this proposal
  notes: string;
  createdAt: string;
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  selectedProposalIds: string[];
  createdAt: string;
}

export interface DrillDownLevel {
  label: string;
  conceptId: string | null;
  month: number | null; // null = full year
}

export type TabId = 'dashboard' | 'proposals' | 'simulator' | 'providers' | 'collections' | 'cxp';

export const MONTHS = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
export const MONTHS_FULL = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

export const CATEGORY_COLORS: Record<string, string> = {
  'Reducción de Costos': '#0071e3',
  'Incremento de Ingresos': '#34c759',
  'Diferimiento': '#ff9f0a',
  'Renegociación': '#af52de',
};
