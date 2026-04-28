import React from 'react';

/**
 * Tarjeta KPI canónica del producto. Vive aquí (componente compartido) en
 * lugar de estar embebida en Dashboard.tsx para que el resto de los módulos
 * (Proyección Financiera, Planeación Financiera) hereden el mismo lenguaje
 * visual sin duplicar markup ni divergir en spacing/tipografía.
 *
 * Reglas:
 *   - 4 columnas en desktop, responsive a 1/2/4.
 *   - Label en uppercase 11px gray-400, valor en 20px tabular-nums.
 *   - El color del valor lo define el caller (success/danger/gray-950/...).
 *   - El breakdown es opcional; si existe, divide con border-t para
 *     no competir con el valor principal.
 */
export interface KpiBreakdownItem {
  label: string;
  value: string;
  valueColor?: string;
}

export interface KpiCardProps {
  label: string;
  /** Valor formateado como string. El caller decide currency/compact/etc. */
  value: string;
  icon?: React.ReactNode;
  /** Color CSS del valor principal — usar tokens del DS. */
  color?: string;
  sublabel?: string;
  breakdown?: KpiBreakdownItem[];
  /** Tono del card; controla borde + fondo. Default neutro. */
  tone?: 'neutral' | 'warning';
}

export const KpiCard: React.FC<KpiCardProps> = ({
  label, value, icon, color = 'var(--gray-950)', sublabel, breakdown, tone = 'neutral',
}) => {
  const containerClass = tone === 'warning'
    ? 'rounded-xl border-2 border-yellow-300 bg-yellow-50 p-4 flex flex-col'
    : 'rounded-xl border border-[var(--gray-200)] bg-white p-4 flex flex-col';

  return (
    <div className={containerClass}>
      <div className="flex items-center justify-between mb-2">
        <p
          className="text-[11px] font-medium uppercase tracking-wider"
          style={{ color: 'var(--gray-400)' }}
        >
          {label}
        </p>
        {icon && <span style={{ color }}>{icon}</span>}
      </div>
      <p className="text-[20px] font-semibold tabular-nums leading-tight" style={{ color }}>
        {value}
      </p>
      {sublabel && (
        <p className="text-[10px] mt-0.5" style={{ color: 'var(--gray-400)' }}>
          {sublabel}
        </p>
      )}
      {breakdown && breakdown.length > 0 && (
        <div className="mt-2.5 space-y-1 border-t border-[var(--gray-100)] pt-2">
          {breakdown.map((item, idx) => (
            <div key={idx} className="flex items-center justify-between text-[11px]">
              <span style={{ color: 'var(--gray-500)' }}>{item.label}</span>
              <span
                className="font-medium tabular-nums"
                style={{ color: item.valueColor ?? 'var(--gray-950)' }}
              >
                {item.value}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default KpiCard;
