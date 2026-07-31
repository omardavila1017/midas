/**
 * Aviso discreto de "las cifras en pantalla son del build anterior mientras se
 * recalcula el nuevo".
 *
 * Existe por la INVARIANTE DE ESTABILIDAD de los tableros financieros: cuando
 * llega una ola de datos de fondo (delta de bancos, backfill de un año
 * histórico, revalidación de compras/pagos) la huella de los inputs cambia y el
 * canónico se reconstruye. Antes ese instante desmontaba el tablero y lo
 * reemplazaba por el shell de carga — el usuario veía todos sus números
 * desaparecer al segundo de haberlos visto. Ahora se conservan las cifras
 * previas y se avisa aquí que hay un recálculo en curso, en vez de vaciar la
 * pantalla.
 *
 * Es informativo, no bloqueante: el usuario puede seguir operando con lo que ve.
 */

export default function StaleDataBadge({
  label = 'Actualizando cifras…',
}: {
  label?: string;
}) {
  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full border border-[var(--gray-200)] bg-white px-3 py-1.5 shadow-[var(--shadow-sm)]"
      role="status"
      aria-live="polite"
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent-blue)] opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--accent-blue)]" />
      </span>
      <span className="text-[12px] font-medium text-[var(--gray-600)]">{label}</span>
    </div>
  );
}
