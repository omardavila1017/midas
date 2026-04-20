import { Component, ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface Props { children: ReactNode; fallbackLabel?: string; }
interface State { hasError: boolean; error: Error | null; }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-14 h-14 rounded-2xl bg-[var(--danger)]/10 flex items-center justify-center mb-4">
            <AlertTriangle className="w-6 h-6 text-[var(--danger)]" />
          </div>
          <h2 className="text-[18px] font-semibold text-[var(--gray-950)] mb-1">
            Error en {this.props.fallbackLabel ?? 'este módulo'}
          </h2>
          <p className="text-[13px] text-[var(--gray-400)] max-w-[400px] mb-4">
            {this.state.error?.message ?? 'Ocurrió un error inesperado.'}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[var(--primary)] text-white text-[13px] font-medium hover:bg-[var(--primary-hover)] transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" /> Reintentar
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
