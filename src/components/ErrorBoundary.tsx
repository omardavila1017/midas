import { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallbackLabel?: string;
  // Cuando cualquiera de estos valores cambia y el boundary está en error, se
  // resetea automáticamente. Lo usa el shell de tabs (resetKeys={[activeTab]})
  // para que un crash en un submódulo NO bloquee navegar a sus hermanos: sin
  // esto el boundary es único y compartido (no se puede keyear por activeTab
  // sin remontar el KeepAlive de Proyección) y hasError persiste entre tabs.
  resetKeys?: ReadonlyArray<unknown>;
}
interface State { hasError: boolean; error: Error | null; }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidUpdate(prev: Props): void {
    if (!this.state.hasError) return;
    const a = prev.resetKeys;
    const b = this.props.resetKeys;
    // No resetKeys on either side = manual-reset only (button click). Without
    // this guard the old `!a || !b` clause flipped `changed` to true on every
    // parent re-render, silently auto-recovering from crashes for boundaries
    // that don't opt into resetKeys — the user saw the error UI flash and
    // disappear.
    if (!a || !b) return;
    const changed =
      a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
    if (changed) this.setState({ hasError: false, error: null });
  }

  // Sin esto los crashes en producción desaparecen sin rastro — al menos dejar
  // el stack en la consola del navegador para poder diagnosticar.
  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(
      `[ErrorBoundary] ${this.props.fallbackLabel ?? 'módulo'} crasheó:`,
      error,
      info.componentStack,
    );
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-14 h-14 rounded-[var(--radius-lg)] bg-[var(--danger)]/10 flex items-center justify-center mb-4">
            <AlertTriangle className="w-6 h-6 text-[var(--danger)]" />
          </div>
          <h2 className="text-[18px] font-bold text-[var(--gray-950)] mb-1">
            Error en {this.props.fallbackLabel ?? 'este módulo'}
          </h2>
          <p className="text-[13px] text-[var(--gray-400)] max-w-[400px] mb-4">
            {this.state.error?.message ?? 'Ocurrió un error inesperado.'}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="flex items-center gap-2 px-4 py-2 rounded-[var(--radius)] bg-[var(--primary)] text-white text-[13px] font-medium hover:bg-[var(--primary-hover)] transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" /> Reintentar
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
