import * as XLSX from 'xlsx';
import { FlowPlan, FlowConcept } from '../types';

// Row-to-concept mapping
interface ConceptMapping {
  row: number;
  name: string;
  parentRow: number | null;
  type: 'ingreso' | 'egreso' | 'resumen' | 'reserva';
  responsible: string | null;
}

const CONCEPT_MAP: ConceptMapping[] = [
  { row: 5, name: 'Caja Inicial', parentRow: null, type: 'resumen', responsible: null },
  { row: 7, name: 'Ingresos', parentRow: null, type: 'ingreso', responsible: 'Blanca Nelly' },
  { row: 8, name: 'Federal', parentRow: 7, type: 'ingreso', responsible: null },
  { row: 9, name: 'Taquilla', parentRow: 7, type: 'ingreso', responsible: null },
  { row: 10, name: 'Cobranza Federal', parentRow: 7, type: 'ingreso', responsible: null },
  { row: 11, name: 'Citi', parentRow: 7, type: 'ingreso', responsible: null },
  { row: 12, name: 'Sendex', parentRow: 7, type: 'ingreso', responsible: null },
  { row: 13, name: 'Otros Ingresos', parentRow: 7, type: 'ingreso', responsible: null },
  { row: 14, name: 'Nómina', parentRow: null, type: 'egreso', responsible: 'Hugo Katz' },
  { row: 15, name: 'Semana', parentRow: 14, type: 'egreso', responsible: null },
  { row: 16, name: 'Quincena', parentRow: 14, type: 'egreso', responsible: null },
  { row: 17, name: 'Operadores', parentRow: 14, type: 'egreso', responsible: null },
  { row: 18, name: 'Aguinaldo, PTU, Bono', parentRow: 14, type: 'egreso', responsible: null },
  { row: 19, name: 'Fondo y Caja', parentRow: 14, type: 'egreso', responsible: null },
  { row: 20, name: 'Vales', parentRow: 14, type: 'egreso', responsible: null },
  { row: 21, name: 'Asimilados / Facilidades', parentRow: 14, type: 'egreso', responsible: null },
  { row: 22, name: 'SAHUMA', parentRow: 14, type: 'egreso', responsible: null },
  { row: 23, name: 'Visión Conservación', parentRow: 14, type: 'egreso', responsible: null },
  { row: 24, name: 'Vigilancia', parentRow: 14, type: 'egreso', responsible: null },
  { row: 25, name: 'Comedor', parentRow: 14, type: 'egreso', responsible: null },
  { row: 26, name: 'Fonacot', parentRow: 14, type: 'egreso', responsible: null },
  { row: 27, name: 'Otros nómina', parentRow: 14, type: 'egreso', responsible: null },
  { row: 28, name: 'Finiquitos', parentRow: 14, type: 'egreso', responsible: 'RH' },
  { row: 29, name: 'Finiquito nómina', parentRow: 28, type: 'egreso', responsible: null },
  { row: 30, name: 'Convenios / Demandas', parentRow: 28, type: 'egreso', responsible: null },
  { row: 31, name: 'Reestructura', parentRow: 28, type: 'egreso', responsible: null },
  { row: 32, name: 'Diésel', parentRow: null, type: 'egreso', responsible: null },
  { row: 33, name: 'Gas', parentRow: null, type: 'egreso', responsible: 'David Silva' },
  { row: 34, name: 'Lubricantes y Otros', parentRow: null, type: 'egreso', responsible: 'David Silva' },
  { row: 35, name: 'Distribuidores', parentRow: null, type: 'egreso', responsible: 'Elvira Iturralde' },
  { row: 36, name: 'Gasolineros', parentRow: null, type: 'egreso', responsible: 'David Silva' },
  { row: 37, name: 'Impuestos', parentRow: null, type: 'egreso', responsible: 'Jose Luis Gallegos' },
  { row: 38, name: 'IVA', parentRow: 37, type: 'egreso', responsible: null },
  { row: 39, name: 'Impuestos retenidos', parentRow: 37, type: 'egreso', responsible: null },
  { row: 40, name: 'Estatales', parentRow: 37, type: 'egreso', responsible: null },
  { row: 41, name: 'IMSS / Infonavit', parentRow: 37, type: 'egreso', responsible: null },
  { row: 42, name: 'Financiamiento Impuestos', parentRow: 37, type: 'egreso', responsible: null },
  { row: 43, name: 'Gastos Operativos', parentRow: null, type: 'egreso', responsible: null },
  { row: 44, name: 'Refacciones y Otros', parentRow: 43, type: 'egreso', responsible: null },
  { row: 45, name: 'Llantas', parentRow: 43, type: 'egreso', responsible: null },
  { row: 46, name: 'CAPEX', parentRow: 43, type: 'egreso', responsible: null },
  { row: 47, name: 'Préstamo DRB 26.8', parentRow: 43, type: 'egreso', responsible: null },
  { row: 48, name: 'Corporativo Babilonia / Reyes Orona', parentRow: 43, type: 'egreso', responsible: null },
  { row: 49, name: 'Préstamo DRB 10', parentRow: 43, type: 'egreso', responsible: null },
  { row: 50, name: 'Préstamo MALELE 7', parentRow: 43, type: 'egreso', responsible: null },
  { row: 51, name: 'Siniestro Turimex 2021', parentRow: 43, type: 'egreso', responsible: null },
  { row: 52, name: 'Pago de Propiedad Familia RDZ', parentRow: 43, type: 'egreso', responsible: null },
  { row: 53, name: 'Convenios Multicarga', parentRow: 43, type: 'egreso', responsible: null },
  { row: 54, name: 'Dotaciones y Contingencias', parentRow: 43, type: 'egreso', responsible: null },
  { row: 55, name: 'Servicios Públicos', parentRow: 43, type: 'egreso', responsible: null },
  { row: 56, name: 'Rentas', parentRow: 43, type: 'egreso', responsible: null },
  { row: 57, name: 'Salidas y Gastos Centrales', parentRow: 43, type: 'egreso', responsible: null },
  { row: 58, name: 'Autopistas', parentRow: 43, type: 'egreso', responsible: null },
  { row: 59, name: 'Fundaciones', parentRow: 43, type: 'egreso', responsible: null },
  { row: 60, name: 'DAES', parentRow: 43, type: 'egreso', responsible: null },
  { row: 61, name: 'Permisos y Placas', parentRow: 43, type: 'egreso', responsible: null },
  { row: 62, name: 'Legal', parentRow: 43, type: 'egreso', responsible: null },
  { row: 63, name: 'Seguros', parentRow: 43, type: 'egreso', responsible: null },
  { row: 64, name: 'GPS / Tracking', parentRow: 43, type: 'egreso', responsible: null },
  { row: 65, name: 'Salud Ocupacional', parentRow: 43, type: 'egreso', responsible: null },
  { row: 66, name: 'Cámaras metro', parentRow: 43, type: 'egreso', responsible: null },
  { row: 67, name: 'Tour Solver', parentRow: 43, type: 'egreso', responsible: null },
  { row: 68, name: 'iPlace / Competitividad', parentRow: 43, type: 'egreso', responsible: null },
  { row: 69, name: 'Regalías Betterez', parentRow: 43, type: 'egreso', responsible: null },
  { row: 70, name: 'Limpieza Unidades', parentRow: 43, type: 'egreso', responsible: null },
  { row: 71, name: 'Servicios Generales', parentRow: 43, type: 'egreso', responsible: null },
  { row: 72, name: 'Mtto JETVAN', parentRow: 43, type: 'egreso', responsible: null },
  { row: 73, name: 'Proveedores TI', parentRow: 43, type: 'egreso', responsible: null },
  { row: 74, name: 'Otros', parentRow: 43, type: 'egreso', responsible: null },
  { row: 75, name: 'Total Gastos Operación', parentRow: 43, type: 'resumen', responsible: null },
  { row: 76, name: 'Asesores CM y fiscal', parentRow: null, type: 'egreso', responsible: null },
  { row: 77, name: 'GGA', parentRow: 76, type: 'egreso', responsible: null },
  { row: 78, name: 'Firma Jurídica', parentRow: 76, type: 'egreso', responsible: null },
  { row: 79, name: 'GOLDCO', parentRow: 76, type: 'egreso', responsible: null },
  { row: 80, name: 'Aztlán', parentRow: 76, type: 'egreso', responsible: null },
  { row: 81, name: 'Otros CM', parentRow: 76, type: 'egreso', responsible: null },
  { row: 82, name: 'ADS', parentRow: 76, type: 'egreso', responsible: null },
  { row: 83, name: 'Proyectos', parentRow: null, type: 'egreso', responsible: null },
  { row: 84, name: 'Inversiones', parentRow: 83, type: 'egreso', responsible: null },
  { row: 85, name: 'Plan de Pago', parentRow: 83, type: 'egreso', responsible: null },
  { row: 86, name: 'Energex', parentRow: 83, type: 'egreso', responsible: null },
  { row: 87, name: 'Otros', parentRow: 83, type: 'egreso', responsible: null },
  { row: 88, name: 'Pasivos Financieros', parentRow: null, type: 'egreso', responsible: null },
  { row: 89, name: 'Penske', parentRow: 88, type: 'egreso', responsible: null },
  { row: 90, name: 'TLJ 26 Unidades', parentRow: 88, type: 'egreso', responsible: null },
  { row: 91, name: 'TLJ 100 Unidades 2026', parentRow: 88, type: 'egreso', responsible: null },
  { row: 92, name: 'TLJ 14 Unidades (Seminuevas)', parentRow: 88, type: 'egreso', responsible: null },
  { row: 93, name: 'TLJ (Bajío)', parentRow: 88, type: 'egreso', responsible: null },
  { row: 94, name: 'TLJ 331 Unidades', parentRow: 88, type: 'egreso', responsible: null },
  { row: 95, name: 'TLJ 23 unidades', parentRow: 88, type: 'egreso', responsible: null },
  { row: 96, name: 'DINA 300 unidades', parentRow: 88, type: 'egreso', responsible: null },
  { row: 97, name: 'Navistar', parentRow: 88, type: 'egreso', responsible: null },
  { row: 98, name: 'UNIFIN', parentRow: 88, type: 'egreso', responsible: null },
  { row: 99, name: 'Banorte', parentRow: 88, type: 'egreso', responsible: null },
  { row: 100, name: 'Daimler (SIR)', parentRow: 88, type: 'egreso', responsible: null },
  { row: 101, name: 'CHG Meridian', parentRow: 88, type: 'egreso', responsible: null },
  { row: 102, name: 'Pasivos CM', parentRow: 88, type: 'egreso', responsible: null },
  { row: 103, name: 'Jetvan Rentas', parentRow: 88, type: 'egreso', responsible: null },
  { row: 104, name: 'Financiamiento USD', parentRow: 88, type: 'egreso', responsible: null },
  { row: 105, name: 'Compra / Venta USD', parentRow: null, type: 'egreso', responsible: null },
  { row: 114, name: 'Variación en Caja', parentRow: null, type: 'resumen', responsible: null },
  { row: 115, name: 'Caja Final', parentRow: null, type: 'resumen', responsible: null },
];

interface YearBlock {
  year: number;
  startCol: number;
  weekCount: number;
}

function serializeDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function parseExcelDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === 'number') {
    // Excel serial number: days since 1899-12-30
    const excelEpoch = new Date(1899, 11, 30);
    const result = new Date(excelEpoch.getTime() + value * 86400000);
    return result;
  }

  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return null;
}

function getYearFromDate(date: Date): number {
  return date.getFullYear();
}

function findYearBlocks(data: unknown[][]): YearBlock[] {
  const row1 = data[1]; // week numbers
  const row2 = data[2]; // dates
  if (!row2) return [];

  // First pass: find all columns that have dates in row 2
  const dateCols: { col: number; date: Date; year: number }[] = [];
  for (let col = 0; col < row2.length; col++) {
    const parsedDate = parseExcelDate(row2[col]);
    if (parsedDate && parsedDate.getFullYear() >= 2020) {
      dateCols.push({ col, date: parsedDate, year: parsedDate.getFullYear() });
    }
  }

  // Group by year
  const byYear = new Map<number, typeof dateCols>();
  for (const dc of dateCols) {
    const arr = byYear.get(dc.year) || [];
    arr.push(dc);
    byYear.set(dc.year, arr);
  }

  // For each year, find the week-1 column (where row1 = 1) and count weeks
  const blocks: YearBlock[] = [];
  for (const [year, cols] of byYear.entries()) {
    // Find the col where week number resets to 1 for this year
    let startCol = cols[0].col;
    for (const dc of cols) {
      const weekNum = row1?.[dc.col];
      if (weekNum === 1) {
        startCol = dc.col;
        break;
      }
    }

    // Count weeks from startCol forward in 7-col steps
    let weekCount = 0;
    for (let c = startCol; c < row2.length; c += 7) {
      const d = parseExcelDate(row2[c]);
      if (!d) break;
      if (d.getFullYear() !== year && weekCount > 0) break;
      weekCount++;
    }

    if (weekCount > 10) { // Ignore fragments
      blocks.push({ year, startCol, weekCount });
    }
  }

  return blocks;
}

function getTargetYear(blocks: YearBlock[]): YearBlock | null {
  if (blocks.length === 0) return null;
  // Pick latest year that has >= 40 weeks of data; fallback to most-weeks block
  const fullBlocks = blocks.filter((b) => b.weekCount >= 40);
  if (fullBlocks.length > 0) {
    return fullBlocks.reduce((latest, b) => (b.year > latest.year ? b : latest));
  }
  return blocks.reduce((max, b) => (b.weekCount > max.weekCount ? b : max));
}

function aggregateToMonthly(
  weeklyTotals: number[],
  weekDates: string[],
  isLastValueOnly: boolean = false,
): number[] {
  const monthly: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

  for (let i = 0; i < weeklyTotals.length && i < weekDates.length; i++) {
    const dateStr = weekDates[i];
    const date = new Date(dateStr);
    const monthIndex = date.getMonth();

    const value = weeklyTotals[i] ?? 0;

    if (isLastValueOnly) {
      monthly[monthIndex] = value;
    } else {
      monthly[monthIndex] += value;
    }
  }

  return monthly;
}

function buildConceptTree(concepts: FlowConcept[]): FlowConcept[] {
  const conceptMap = new Map<string, FlowConcept>();
  concepts.forEach((c) => {
    conceptMap.set(c.id, c);
  });

  const roots: FlowConcept[] = [];

  concepts.forEach((concept) => {
    if (concept.parentId === null) {
      roots.push(concept);
    } else {
      const parent = conceptMap.get(concept.parentId);
      if (parent) {
        if (!parent.children) {
          parent.children = [];
        }
        parent.children.push(concept);
      }
    }
  });

  // Sort children under each parent by sortOrder
  const sortChildren = (concept: FlowConcept) => {
    if (concept.children) {
      concept.children.sort((a, b) => a.sortOrder - b.sortOrder);
      concept.children.forEach(sortChildren);
    }
  };

  roots.forEach(sortChildren);
  roots.sort((a, b) => a.sortOrder - b.sortOrder);

  return roots;
}

export async function parseFlowExcel(file: File): Promise<FlowPlan> {
  const arrayBuffer = await file.arrayBuffer();
  const workbook = XLSX.read(arrayBuffer, { cellDates: true });

  // Always read first (and only) sheet — Plan de Flujo Ajustado
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  // header: 1 → array of arrays (each row is an array of cell values)
  const dataArrays: unknown[][] = XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, defval: null });

  // Find year blocks and pick the target year
  const yearBlocks = findYearBlocks(dataArrays);
  const targetBlock = getTargetYear(yearBlocks);

  if (!targetBlock) {
    throw new Error('No valid year blocks found in Excel file');
  }

  const targetYear = targetBlock.year;
  const yearStartCol = targetBlock.startCol;

  // Extract week dates from row 2
  const weekDates: string[] = [];
  for (let week = 0; week < targetBlock.weekCount; week++) {
    const col = yearStartCol + week * 7;
    const dateValue = dataArrays[2]?.[col];
    const parsedDate = parseExcelDate(dateValue);
    if (parsedDate) {
      weekDates.push(serializeDate(parsedDate));
    }
  }

  // Get Caja Inicial value from row 5, first column of year block
  const cajaInicial = (() => {
    const val = dataArrays[5]?.[yearStartCol];
    return typeof val === 'number' ? val : 0;
  })();

  // Build concepts
  const concepts: FlowConcept[] = [];
  let sortOrder = 0;

  for (const mapping of CONCEPT_MAP) {
    const weeklyData: number[] = [];

    for (let week = 0; week < targetBlock.weekCount; week++) {
      const col = yearStartCol + week * 7; // Each week is 7 columns, col+0 is the weekly total
      const cellValue = dataArrays[mapping.row]?.[col];
      const numValue = typeof cellValue === 'number' ? cellValue : 0;
      weeklyData.push(numValue);
    }

    const monthlyData = aggregateToMonthly(
      weeklyData,
      weekDates,
      mapping.row === 5 || mapping.row === 115, // Use last value for Caja Inicial and Caja Final
    );

    const parentId =
      mapping.parentRow !== null
        ? `concept-row-${mapping.parentRow}`
        : null;

    const concept: FlowConcept = {
      id: `concept-row-${mapping.row}`,
      excelRow: mapping.row,
      name: mapping.name,
      parentId,
      responsible: mapping.responsible,
      conceptType: mapping.type,
      sortOrder,
      weeklyData,
      monthlyData,
    };

    concepts.push(concept);
    sortOrder++;
  }

  // Extract plan name from file name (without .xlsx)
  const planName = file.name.replace(/\.xlsx?$/i, '');

  // Store flat list — components call buildConceptTree() themselves when they need hierarchy
  const plan: FlowPlan = {
    name: planName,
    year: targetYear,
    cajaInicial,
    concepts,
    weekDates,
  };

  return plan;
}

export { buildConceptTree };
