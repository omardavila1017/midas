import { useState, useCallback, useRef } from 'react';
import { FlowPlan } from '../types';
import { parseFlowExcel } from '../utils/excelParser';
import { Upload as UploadIcon, FileSpreadsheet, Zap, Loader2, AlertCircle, CheckCircle } from 'lucide-react';

interface UploadProps {
  onPlanLoaded: (plan: FlowPlan) => void;
}

const Upload = ({ onPlanLoaded }: UploadProps) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    if (!file.name.endsWith('.xlsx') && !file.name.endsWith('.xls')) {
      setError('Solo se aceptan archivos .xlsx o .xls');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const plan = await parseFlowExcel(file);
      setSuccess(true);
      setTimeout(() => {
        onPlanLoaded(plan);
      }, 800);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Error al procesar el archivo';
      setError(errorMessage);
      setLoading(false);
    }
  }, [onPlanLoaded]);

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      handleFile(files[0]);
    }
  }, [handleFile]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFile(e.target.files[0]);
    }
  };

  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  return (
    <div className="min-h-screen bg-[var(--gray-50)] flex items-center justify-center p-6">
      <div className="w-full max-w-lg animate-page-in">
        {/* Logo and Header */}
        <div className="text-center mb-10">
          <div className="flex items-center justify-center gap-3 mb-4 animate-scale-in">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[var(--primary)] to-[var(--info)] flex items-center justify-center shadow-lg shadow-blue-200/40">
              <Zap className="text-white" size={24} />
            </div>
          </div>
          <h1 className="text-[28px] font-bold text-[var(--gray-950)] tracking-[-0.02em] mb-1 animate-card-in stagger-1">FlowSense</h1>
          <p className="text-[15px] text-[var(--gray-400)] animate-card-in stagger-2">Análisis de Flujo de Efectivo</p>
        </div>

        {/* Main Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-[var(--gray-200)]/40 p-8 animate-card-in stagger-3 hover-lift">
          {!loading && !success && !error && (
            <>
              {/* Drag & Drop Zone */}
              <div
                onDragEnter={handleDrag}
                onDragLeave={handleDrag}
                onDragOver={handleDrag}
                onDrop={handleDrop}
                onClick={triggerFileInput}
                className={`border-2 border-dashed rounded-2xl p-14 text-center cursor-pointer transition-all ${
                  dragActive
                    ? 'border-[var(--primary)] bg-[var(--primary-muted)]'
                    : 'border-[var(--gray-200)] hover:border-[var(--primary)] hover:bg-[var(--surface-alt)]'
                }`}
              >
                <div className="w-14 h-14 rounded-2xl bg-[var(--gray-50)] flex items-center justify-center mx-auto mb-4">
                  <UploadIcon className="text-[var(--gray-400)]" size={28} />
                </div>
                <p className="text-[15px] font-semibold text-[var(--gray-950)] mb-1">
                  Arrastra tu Excel aquí
                </p>
                <p className="text-[13px] text-[var(--gray-400)]">
                  o haz clic para seleccionar — .xlsx, .xls
                </p>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                onChange={handleInputChange}
                className="hidden"
              />

              {/* Footer Note */}
              <div className="mt-6 flex items-center gap-3 px-1">
                <FileSpreadsheet size={16} className="text-[var(--gray-400)] flex-shrink-0" />
                <p className="text-[12px] text-[var(--gray-400)]">
                  Formato esperado: Plan de Flujo Ajustado con datos semanales
                </p>
              </div>
            </>
          )}

          {/* Loading State */}
          {loading && !success && (
            <div className="text-center py-14">
              <Loader2 className="text-[var(--primary)] animate-spin mx-auto mb-4" size={40} />
              <p className="text-[15px] font-semibold text-[var(--gray-950)] mb-1">Procesando Excel...</p>
              <p className="text-[13px] text-[var(--gray-400)]">Analizando estructura y datos</p>
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
              <p className="text-[15px] font-semibold text-[var(--gray-950)]">Archivo procesado</p>
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
                  <p className="text-[14px] font-semibold text-[var(--gray-950)]">Error al procesar</p>
                  <p className="text-[13px] text-[var(--gray-500)] mt-1">{error}</p>
                  <button
                    onClick={() => { setError(null); triggerFileInput(); }}
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
