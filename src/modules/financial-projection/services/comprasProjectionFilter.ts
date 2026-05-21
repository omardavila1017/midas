/**
 * Business rule (and structural volume guard): a forward cash projection must
 * NOT include a purchase order (API COMPRAS) whose PROJECTED PAYMENT date
 * (`fechaPagoProyectada`) is already in the past — it would never produce a
 * future cash movement and only inflates the canonical (with 332k+ historical
 * OCs this was the primary OOM driver, rebuilt on every input change).
 *
 * Kept: OCs with `fechaPagoProyectada >= today`, and OCs WITHOUT a projected
 * payment date (not-yet-received PROJECTED orders — their payment is future by
 * construction: pedido + lead time + credit).
 *
 * Pure + generic so it is unit-testable and reusable; the dashboard state stays
 * full (Compras / taxes views are untouched) — only the projection slice uses this.
 */
export function selectComprasForProjection<T extends { fechaPagoProyectada?: string | null }>(
  records: readonly T[],
  today: string,
): T[] {
  const out: T[] = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const pay = r.fechaPagoProyectada ? String(r.fechaPagoProyectada).slice(0, 10) : '';
    if (pay && pay < today) continue; // past projected payment → drop
    out.push(r);
  }
  return out;
}
