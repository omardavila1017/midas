import { useState, useCallback } from 'react';
import { FlowPlan } from '../types';
import { fetchCashFlowPlan } from '../services/cashFlow.service';
import { Database, Zap, Loader2, AlertCircle, CheckCircle } from 'lucide-react';

interface UploadProps {
  onPlanLoaded: (plan: FlowPlan) => void;
}

const Upload = ({ onPlanLoaded }: UploadProps) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleLoad = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const plan = await fetchCashFlowPlan();
      setSuccess(true);
      setTimeout(() => {
        onPlanLoaded(plan);
      }, 800);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Error al consultar los datos';
      setError(errorMessage);
      setLoading(false);
    }
  }, [onPlanLoaded]);

  return (
    <div className="min-h-screen bg-[var(--gray-50)] flex items-center justify-center p-6">
      <div className="w-full max-w-lg animate-page-in">
        {/* Logo and Header */}
        <div className="text-center mb-10">
          <div className="flex items-center justify-center gap-3 mb-4 animate-scale-in">
            <div className="w-12 h-12 rounded-2xl bg-[var(--primary)] flex items-center justify-center shadow-lg shadow-[var(--primary)]/15">
              <Zap className="text-white" size={24} strokeWidth={1.5} />
            </div>
          </div>
          <h1 className="text-[28px] font-bold text-[var(--gray-950)] tracking-[-0.02em] mb-1 animate-card-in stagger-1">FlowSense</h1>
          <p className="text-[15px] text-[var(--gray-400)] animate-card-in stagger-2">Análisis de Flujo de Efectivo</p>
        </div>

        {/* Main Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-[var(--gray-200)]/40 p-8 animate-card-in stagger-3 hover-lift">
          {!loading && !success && !error && (
            <>
              <div
                className="border-2 border-dashed rounded-2xl p-14 text-center transition-all border-[var(--gray-200)] bg-[var(--surface-alt)]"
              >
                <div className="w-14 h-14 rounded-2xl bg-[var(--gray-50)] flex items-center justify-center mx-auto mb-4">
                  <Database className="text-[var(--gray-400)]" size={28} />
                </div>
                <p className="text-[15px] font-semibold text-[var(--gray-950)] mb-1">
                  Cargar flujo consolidado
                </p>
                <p className="text-[13px] text-[var(--gray-400)]">
                  Se consultará el servicio configurado para Atlas.
                </p>
                <button
                  onClick={handleLoad}
                  className="mt-5 inline-flex items-center gap-2 px-4 h-10 rounded-xl bg-[var(--primary)] text-white text-[13px] font-medium hover:bg-[var(--primary-hover)] hover-press"
                >
                  <Database size={16} /> Cargar datos
                </button>
              </div>

              <div className="mt-6 flex items-center gap-3 px-1">
                <Database size={16} className="text-[var(--gray-400)] flex-shrink-0" />
                <p className="text-[12px] text-[var(--gray-400)]">
                  Si Atlas aún no tiene credenciales, se usa un plan de respaldo para validación.
                </p>
              </div>
            </>
          )}

          {/* Loading State */}
          {loading && !success && (
            <div className="text-center py-14">
              <Loader2 className="text-[var(--primary)] animate-spin mx-auto mb-4" size={40} />
              <p className="text-[15px] font-semibold text-[var(--gray-950)] mb-1">Consultando datos...</p>
              <p className="text-[13px] text-[var(--gray-400)]">Preparando flujo consolidado</p>
              <div className="mt-6 h-1 bg-[var(--gray-50)] rounded-full overflow-hidden max-w-xs mx-auto">
                <div className="h-full bg-[var(--primary)] rounded-full animate-pulse" style={{ width: '60%' }} />
              </div>
            </div>
          )}

          {/* Success State */}
          {success && (
            <div className="text-center py-14 animate-scale-in">
              <div className="w-14 h-14 rounded-full bg-[var(--success-muted)] flex items-center justify-center mx-auto mb-4">
                <CheckCircle className="text-[var(--success)]" size={28} />
              </div>
              <p className="text-[15px] font-semibold text-[var(--gray-950)]">Datos cargados</p>
              <p className="text-[13px] text-[var(--gray-400)] mt-1">Cargando dashboard...</p>
            </div>
          )}

          {/* Error State */}
          {error && !loading && (
            <div className="bg-[var(--danger-muted)] border border-red-100 rounded-xl p-5 animate-slide-down">
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-[var(--danger)/20] flex items-center justify-center flex-shrink-0 mt-0.5">
                  <AlertCircle className="text-[var(--danger)]" size={16} />
                </div>
                <div>
                  <p className="text-[14px] font-semibold text-[var(--gray-950)]">Error al consultar</p>
                  <p className="text-[13px] text-[var(--gray-500)] mt-1">{error}</p>
                  <button
                    onClick={() => { setError(null); handleLoad(); }}
                    className="mt-3 text-[13px] font-medium text-[var(--primary)] hover:text-[var(--primary-hover)]"
                  >
                    Intentar de nuevo
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Upload;
