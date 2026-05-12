import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CollectionProjection from './CollectionProjection';
import type { Client, CashFlowAssumptions } from '../domain/types';
import type { BankAccountStatement, CobranzaPayment, CobranzaRecord } from '../services/jdeTypes';
import { downloadFile } from '../utils/export';

vi.mock('../utils/export', async () => {
  const actual = await vi.importActual<typeof import('../utils/export')>('../utils/export');
  return {
    ...actual,
    downloadFile: vi.fn(),
  };
});

function stubMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q: string) => ({
      matches: false,
      media: q,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    }),
  });
}

const ASSUMPTIONS: CashFlowAssumptions = {
  year: 2026,
  globalCompliance: 0.95,
  factorajeDays: 30,
};

function makeClient(overrides: Partial<Client> = {}): Client {
  return {
    id: overrides.id ?? 'c1',
    name: overrides.name ?? 'Cliente Demo',
    paymentDay: { kind: 'ANY' },
    frequency: 'Mensual',
    creditDays: 30,
    monthlyBilling: new Array(12).fill(100_000),
    ...overrides,
  };
}

function makeCobranzaRecord(overrides: Partial<CobranzaRecord> = {}): CobranzaRecord {
  return {
    cia: '00011',
    noCliente: '9001',
    nombreCliente: 'Cliente Demo',
    noFactura: 'F-100',
    fechaFactura: '2026-05-01',
    fechaVence: '2026-05-31',
    fechaCobro: '',
    diasVencida: 0,
    importeBrutoPesos: 2500,
    importePendientePesos: 2500,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXN',
    condPago: '30',
    estatus: 'PENDIENTE',
    tipoCambio: 1,
    ...overrides,
  };
}

function makeBankStatement(overrides: Partial<BankAccountStatement> = {}): BankAccountStatement {
  return {
    cia: '00011',
    banco: 'BANAMEX',
    nombreBanco: 'BANAMEX',
    cuenta: '12345',
    moneda: 'MXN',
    fechaEstadoCuenta: isoForCurrentMonthDay(15),
    movimientos: [
      {
        cia: '00011',
        banco: 'BANAMEX',
        nombreBanco: 'BANAMEX',
        cuenta: '12345',
        moneda: 'MXN',
        fechaOperacion: isoForCurrentMonthDay(15),
        referencia: 'SPEI-1',
        concepto: 'TRANSFERENCIA SPEI',
        tipoMovimiento: 'ABONO',
        importe: 2500,
      },
    ],
    ...overrides,
  };
}

function makeCobranzaPayment(overrides: Partial<CobranzaPayment> = {}): CobranzaPayment {
  const idPago = overrides.idPago ?? 'PAY-REC';
  return {
    idPago,
    cia: overrides.cia ?? '00011',
    fechaCobro: overrides.fechaCobro ?? isoForCurrentMonthDay(15),
    fechaContable: overrides.fechaContable ?? isoForCurrentMonthDay(15),
    cuentaBancaria: overrides.cuentaBancaria ?? '12345',
    banco: overrides.banco ?? 'BANAMEX',
    noRecibo: overrides.noRecibo ?? 'RI-REC',
    importeRecibo: overrides.importeRecibo ?? 2500,
    pendienteAplicar: overrides.pendienteAplicar ?? 0,
    noCliente: overrides.noCliente ?? '9001',
    cliente: overrides.cliente ?? 'Cliente Demo',
    noBatch: overrides.noBatch ?? 'B-1',
    tipoCambio: overrides.tipoCambio ?? 1,
    applications: overrides.applications ?? [{
      idPago,
      cia: overrides.cia ?? '00011',
      fechaAplicacion: isoForCurrentMonthDay(15),
      noCliente: '9001',
      cliente: 'Cliente Demo',
      tipoDocto: 'RI',
      noFactura: 'F-JDE',
      noFacturaNormalizada: 'FJDE',
      fechaFactura: isoForCurrentMonthDay(1),
      fechaVencimiento: isoForCurrentMonthDay(28),
      diasAntiguedadFafv: 0,
      importeCobrado: 2500,
      importeOriginalFactura: 2500,
      importePteFactura: 0,
      tasaIva: 'IVA16',
      importeIvaFacturaOriginal: 400,
    }],
  };
}

function isoForCurrentMonthDay(day: number): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(day).padStart(2, '0'),
  ].join('-');
}

function renderRealCobranzaView() {
  const currentYear = new Date().getFullYear();
  const jdeDate = isoForCurrentMonthDay(15);
  const records = [
    makeCobranzaRecord({
      noFactura: 'F-JDE',
      fechaFactura: isoForCurrentMonthDay(1),
      fechaVence: isoForCurrentMonthDay(28),
      fechaCobro: jdeDate,
      importePendientePesos: 0,
      estatus: 'PAGADA',
    }),
  ];
  render(
    <CollectionProjection
      clients={[
        makeClient({ id: '9001', name: 'Cliente Demo' }),
        makeClient({ id: 'proy-1', name: 'Cliente Proyectado', monthlyBilling: new Array(12).fill(5000) }),
      ]}
      assumptions={{ ...ASSUMPTIONS, year: currentYear }}
      onAssumptionsChange={() => {}}
      confirmedPayments={[]}
      onConfirm={() => {}}
      onUnconfirm={() => {}}
      companies={[{ cia: '00011', nombre: 'Senda Demo' }]}
      cobranzaRecords={records}
      cobranzaLoadedCias={{ '00011': `${jdeDate}T12:00:00.000Z` }}
      bankStatements={[]}
      selectedCia="00011"
    />,
  );
  return { jdeDate };
}

describe('<CollectionProjection />', () => {
  beforeEach(() => {
    stubMatchMedia();
    vi.clearAllMocks();
  });

  it('muestra un empty state cuando no hay clientes', () => {
    render(
      <CollectionProjection
        clients={[]}
        assumptions={ASSUMPTIONS}
        onAssumptionsChange={() => {}}
        confirmedPayments={[]}
        onConfirm={() => {}}
        onUnconfirm={() => {}}
      />,
    );
    expect(screen.getByText(/Sin clientes cargados/i)).toBeTruthy();
    expect(screen.getByText(/Importa el catálogo/i)).toBeTruthy();
  });

  it('renderiza el header y los KPIs de resumen con datos', () => {
    const clients = [
      makeClient({ id: 'a', name: 'Cliente Alfa' }),
      makeClient({ id: 'b', name: 'Cliente Beta', frequency: 'Semanal' }),
    ];
    render(
      <CollectionProjection
        clients={clients}
        assumptions={ASSUMPTIONS}
        onAssumptionsChange={() => {}}
        confirmedPayments={[]}
        onConfirm={() => {}}
        onUnconfirm={() => {}}
      />,
    );
    expect(screen.getByRole('heading', { name: /Proyección de cobranza/i })).toBeTruthy();
    expect(screen.getByText(/Total proyectado 2026/i)).toBeTruthy();
    expect(screen.getByText(/Días promedio de lag/i)).toBeTruthy();
  });

  it('cambia entre vistas Por mes / Por cliente desde el acordeón', () => {
    const clients = [makeClient()];
    render(
      <CollectionProjection
        clients={clients}
        assumptions={ASSUMPTIONS}
        onAssumptionsChange={() => {}}
        confirmedPayments={[]}
        onConfirm={() => {}}
        onUnconfirm={() => {}}
      />,
    );
    // Calendario siempre visible → hay un botón "Exportar mes".
    expect(screen.getByLabelText(/Exportar mes/i)).toBeTruthy();

    // Abrir acordeón "Filtros y otras vistas".
    fireEvent.click(screen.getByRole('button', { name: /Filtros y otras vistas/i }));

    fireEvent.click(screen.getByRole('button', { name: /Por mes/i }));
    expect(screen.getByText(/Entrada de efectivo por mes/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Por cliente/i }));
    expect(screen.getByText(/Ranking por cliente/i)).toBeTruthy();
  });

  it('filtra por búsqueda y muestra el contador filtrado', () => {
    const clients = [
      makeClient({ id: 'a', name: 'Abarrotes del Norte' }),
      makeClient({ id: 'b', name: 'Zapatería Sur' }),
    ];
    render(
      <CollectionProjection
        clients={clients}
        assumptions={ASSUMPTIONS}
        onAssumptionsChange={() => {}}
        confirmedPayments={[]}
        onConfirm={() => {}}
        onUnconfirm={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Filtros y otras vistas/i }));
    const search = screen.getByPlaceholderText(/Buscar cliente/i);
    fireEvent.change(search, { target: { value: 'Abarrotes' } });
    // Aparece "Limpiar filtros" cuando hay filtros activos.
    expect(screen.getByRole('button', { name: /Limpiar filtros/i })).toBeTruthy();
  });

  it('toggle de supuestos muestra y oculta el panel', () => {
    const clients = [makeClient()];
    const onChange = vi.fn();
    render(
      <CollectionProjection
        clients={clients}
        assumptions={ASSUMPTIONS}
        onAssumptionsChange={onChange}
        confirmedPayments={[]}
        onConfirm={() => {}}
        onUnconfirm={() => {}}
      />,
    );
    const btn = screen.getByRole('button', { name: /Supuestos/i });
    fireEvent.click(btn);
    // El input del año ahora es visible.
    const yearInput = screen.getByDisplayValue('2026');
    expect(yearInput).toBeTruthy();
    fireEvent.change(yearInput, { target: { value: '2027' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ year: 2027 }));
  });

  it('el empty state del ranking aparece cuando filtros excluyen todo', () => {
    const clients = [makeClient({ id: 'a', name: 'Alfa' })];
    render(
      <CollectionProjection
        clients={clients}
        assumptions={ASSUMPTIONS}
        onAssumptionsChange={() => {}}
        confirmedPayments={[]}
        onConfirm={() => {}}
        onUnconfirm={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Filtros y otras vistas/i }));
    fireEvent.click(screen.getByRole('button', { name: /Por cliente/i }));
    const search = screen.getByPlaceholderText(/Buscar cliente/i);
    fireEvent.change(search, { target: { value: 'no-existe-nunca' } });
    expect(screen.getByText(/Sin datos con los filtros actuales/i)).toBeTruthy();
  });

  it('muestra el calendario unico con filtros por fuente y colores operativos', () => {
    renderRealCobranzaView();

    expect(screen.getByRole('button', { name: /^Todas$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Real banco$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Banco sin CXC$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^JDE$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^JDE por cobrar$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Sin factura$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Sin regla$/i })).toBeTruthy();
  });

  it('filtra JDE contra proyectado en el calendario combinado', () => {
    const { jdeDate } = renderRealCobranzaView();

    fireEvent.click(screen.getByRole('button', { name: /^JDE$/i }));
    expect(screen.getByRole('button', { name: new RegExp(`${jdeDate}: 1 evento`) })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Sin factura$/i }));
    expect(screen.getByRole('button', { name: new RegExp(`${jdeDate}: 0 eventos`) })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /: [1-9]\d* evento/ }).length).toBeGreaterThan(0);
  });

  it('separa facturas JDE emitidas de proyección sin factura', () => {
    renderRealCobranzaView();

    expect(screen.getByText(/Facturas JDE emitidas/i)).toBeTruthy();
    expect(screen.getByText(/Pagado JDE sin banco/i)).toBeTruthy();
    expect(screen.getByText(/Por cobrar JDE/i)).toBeTruthy();
    expect(screen.getByText(/Proyectado/i)).toBeTruthy();
  });

  it('al hacer click en un evento muestra fuente, estado y regla aplicada', () => {
    const { jdeDate } = renderRealCobranzaView();

    fireEvent.click(screen.getByRole('button', { name: new RegExp(`${jdeDate}: 1 evento`) }));

    expect(screen.getByText(/Fuente del dato/i)).toBeTruthy();
    expect(screen.getAllByText(/Ingreso/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/JDE reporta Fecha_Pago/i)).toBeTruthy();
    expect(screen.getByText(/Fecha confirmada por JDE/i)).toBeTruthy();
  });

  it('auto-confirma cruces por monto exacto incluso sin identidad fuerte de cliente', () => {
    render(
      <CollectionProjection
        clients={[makeClient({ id: 'x', name: 'Cliente X' })]}
        assumptions={{ ...ASSUMPTIONS, year: new Date().getFullYear() }}
        onAssumptionsChange={() => {}}
        confirmedPayments={[]}
        onConfirm={() => {}}
        onUnconfirm={() => {}}
        companies={[{ cia: '00011', nombre: 'Senda Demo' }]}
        cobranzaRecords={[makeCobranzaRecord({ nombreCliente: 'Cliente sin identidad fuerte' })]}
        cobranzaLoadedCias={{ '00011': new Date().toISOString() }}
        bankStatements={[makeBankStatement()]}
        selectedCia="00011"
      />,
    );

    expect(screen.getByText(/COBRANZA CRUZADA CON BANCO/i)).toBeTruthy();
  });

  it('permite cargar bancos sólo del rango visible', () => {
    const ensure = vi.fn();
    render(
      <CollectionProjection
        clients={[makeClient()]}
        assumptions={{ ...ASSUMPTIONS, year: new Date().getFullYear() }}
        onAssumptionsChange={() => {}}
        confirmedPayments={[]}
        onConfirm={() => {}}
        onUnconfirm={() => {}}
        companies={[{ cia: '00011', nombre: 'Senda Demo' }]}
        cobranzaRecords={[makeCobranzaRecord()]}
        cobranzaLoadedCias={{ '00011': new Date().toISOString() }}
        bankStatements={[]}
        selectedCia="00011"
        onEnsureBankCoverage={ensure}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Cargar bancos del mes/i }));
    expect(ensure).toHaveBeenCalledWith(expect.objectContaining({
      from: expect.stringMatching(/^\d{4}-\d{2}-01$/),
      to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      ciaFilter: ['00011'],
    }));
  });

  it('exporta CSV de cobranza con columnas del calendario unificado', () => {
    const mockedDownloadFile = vi.mocked(downloadFile);
    renderRealCobranzaView();

    fireEvent.click(screen.getByRole('button', { name: /Exportar CSV/i }));

    expect(mockedDownloadFile).toHaveBeenCalledTimes(1);
    const csv = mockedDownloadFile.mock.calls[0][0];
    expect(csv).toContain('FuenteDato');
    expect(csv).toContain('FechaCalendario');
    expect(csv).toContain('EstadoCalendario');
    expect(csv).toContain('ReglaAplicada');
    expect(csv).toContain('MotivoFecha');
    expect(csv).toContain('Ingreso');
  });

  it('muestra recibos JDE conciliados con banco, detalle de facturas y filtro sin banco', () => {
    const currentYear = new Date().getFullYear();
    const matchedPayment = makeCobranzaPayment();
    const unmatchedPayment = makeCobranzaPayment({
      idPago: 'PAY-NOBANK',
      noRecibo: 'RI-NOBANK',
      fechaCobro: isoForCurrentMonthDay(16),
      // fechaContable también fuera de la ventana del banco (día 15) para
      // que el match Banco→IndicadoresCobranza no lo confunda con
      // PAY-REC. El engine indexa pagos por fechaCobro Y fechaContable.
      fechaContable: isoForCurrentMonthDay(16),
      applications: [{
        ...matchedPayment.applications[0],
        idPago: 'PAY-NOBANK',
        noFactura: 'F-NOBANK',
        noFacturaNormalizada: 'FNOBANK',
      }],
    });
    render(
      <CollectionProjection
        clients={[makeClient({ id: '9001', name: 'Cliente Demo' })]}
        assumptions={{ ...ASSUMPTIONS, year: currentYear }}
        onAssumptionsChange={() => {}}
        confirmedPayments={[]}
        onConfirm={() => {}}
        onUnconfirm={() => {}}
        companies={[{ cia: '00011', nombre: 'Senda Demo' }]}
        cobranzaRecords={[makeCobranzaRecord({ noFactura: 'F-JDE', importeBrutoPesos: 2500 })]}
        cobranzaPayments={[matchedPayment, unmatchedPayment]}
        cobranzaLoadedCias={{ '00011': new Date().toISOString() }}
        bankStatements={[makeBankStatement({
          movimientos: [{
            ...makeBankStatement().movimientos[0],
            referencia: 'PAGO RI-REC',
            concepto: 'TRANSFERENCIA SPEI RI-REC',
          }],
        })]}
        selectedCia="00011"
      />,
    );

    expect(screen.getByText(/Recibos JDE \/ Banco/i)).toBeTruthy();
    expect(screen.getByText('PAY-REC')).toBeTruthy();
    expect(screen.getByText('RI-REC')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: /Ver detalle/i })[0]);
    expect(screen.getByText(/Banco ligado/i)).toBeTruthy();
    expect(screen.getAllByText(/Facturas aplicadas/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText('F-JDE').length).toBeGreaterThan(0);

    fireEvent.change(screen.getByDisplayValue('Todos los estados'), { target: { value: 'UNMATCHED' } });
    expect(screen.getByText('PAY-NOBANK')).toBeTruthy();
    expect(screen.queryByText('PAY-REC')).toBeNull();
  });
});
