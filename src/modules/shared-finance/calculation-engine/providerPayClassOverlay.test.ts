import { describe, expect, it } from 'vitest';
import {
  buildProviderPayClassOverlay,
  payClassPairFrom,
  rawPayClass,
} from './providerPayClassOverlay';
import { normalizeJde } from '../sourceRecords';

describe('rawPayClass', () => {
  it('conserva el prefijo numérico y los centinelas que JDE manda como texto', () => {
    // Los tres valores medidos en `jde.Pago_Proveedor` 2026. La normalización
    // de `usableJdeProviderCategory` los tira a `undefined` a propósito para
    // poder bucketizar; aquí tienen que sobrevivir.
    expect(rawPayClass('220 - Por Clasificar')).toBe('220 - Por Clasificar');
    expect(rawPayClass('010 - Refacciones y Llantas')).toBe('010 - Refacciones y Llantas');
    expect(rawPayClass('" "')).toBe('" "');
  });

  it('colapsa runs de whitespace para que un mismo valor no fragmente el grupo', () => {
    expect(rawPayClass('-                              .')).toBe('- .');
    expect(rawPayClass('-    .')).toBe('- .');
    expect(rawPayClass('  Servicios  ')).toBe('Servicios');
  });

  it('trata como ausencia lo que queda vacío al recortar', () => {
    expect(rawPayClass('   ')).toBeUndefined();
    expect(rawPayClass('')).toBeUndefined();
    expect(rawPayClass(undefined)).toBeUndefined();
    expect(rawPayClass(null)).toBeUndefined();
  });
});

describe('buildProviderPayClassOverlay', () => {
  const enrichment = (
    key: string,
    payments: Array<{
      claveProveedor?: string;
      clasificacionProveedor?: string;
      clasificacionProveedorFinanciera?: string;
    }>,
    status: 'MATCHED' | 'ORPHAN' = 'MATCHED',
  ) => [key, { status, payments }] as const;

  it('presta el par del pago cruzado, llaveado igual que las OCs', () => {
    const overlay = buildProviderPayClassOverlay(
      new Map([
        enrichment('k1', [{
          claveProveedor: '0055501',
          clasificacionProveedor: 'Servicios',
          clasificacionProveedorFinanciera: '010 - Refacciones y Llantas',
        }]),
      ]),
      normalizeJde,
    );

    // `normalizeJde` colapsa los ceros a la izquierda, así que la línea de CXP
    // u OC con `noProveedor: '55501'` empata. Si las dos llaves divergieran, el
    // overlay quedaría inerte sin ningún error visible.
    expect(overlay.get('55501')).toEqual({
      payClass: 'Servicios',
      payClassFinanciera: '010 - Refacciones y Llantas',
    });
  });

  it('ignora los ORPHAN y los pagos sin clasificación — nunca inventa', () => {
    const overlay = buildProviderPayClassOverlay(
      new Map([
        enrichment('k1', [{ claveProveedor: '900', clasificacionProveedor: 'Servicios' }], 'ORPHAN'),
        enrichment('k2', [{ claveProveedor: '901' }]),
        enrichment('k3', [{ clasificacionProveedor: 'Servicios' }]),
      ]),
      normalizeJde,
    );

    expect(overlay.size).toBe(0);
  });

  it('gana el par MÁS COMPLETO del proveedor, no el primero visto', () => {
    const overlay = buildProviderPayClassOverlay(
      new Map([
        enrichment('k1', [{ claveProveedor: '77', clasificacionProveedor: 'Servicios' }]),
        enrichment('k2', [{
          claveProveedor: '77',
          clasificacionProveedor: 'Servicios',
          clasificacionProveedorFinanciera: '160 - Autopistas',
        }]),
        // Un tercer pago menos completo no degrada lo ya aprendido.
        enrichment('k3', [{ claveProveedor: '77', clasificacionProveedorFinanciera: '160 - Autopistas' }]),
      ]),
      normalizeJde,
    );

    expect(overlay.get('77')).toEqual({
      payClass: 'Servicios',
      payClassFinanciera: '160 - Autopistas',
    });
  });

  it('sin enrichments devuelve un overlay vacío en vez de tronar', () => {
    expect(buildProviderPayClassOverlay(undefined, normalizeJde).size).toBe(0);
  });
});

describe('payClassPairFrom', () => {
  it('normaliza ambos lados con la misma regla', () => {
    expect(payClassPairFrom('  Servicios ', '-      .')).toEqual({
      payClass: 'Servicios',
      payClassFinanciera: '- .',
    });
  });
});
