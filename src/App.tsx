import { lazy, Suspense } from 'react';

const AppCoreWithProviders = lazy(() => import('./AppCoreWithProviders'));
const sendaLogoUrl = `${import.meta.env.BASE_URL}logos/senda-corporativo.svg`;

function AppBootShell() {
  return (
    <div className="min-h-screen bg-[var(--surface-alt)] text-[var(--gray-950)]">
      <div className="flex min-h-screen items-center justify-center px-6">
        <div className="w-full max-w-sm text-center">
          <img
            src={sendaLogoUrl}
            alt="Senda"
            className="mx-auto mb-5 h-10 w-auto"
            decoding="async"
            fetchpriority="high"
          />
          <div className="mx-auto h-1.5 w-48 overflow-hidden rounded-full bg-[var(--gray-200)]">
            <div className="h-full w-1/3 animate-[midas-loading_1.1s_ease-in-out_infinite] rounded-full bg-[var(--accent-blue)]" />
          </div>
          <p className="mt-4 text-[13px] font-medium text-[var(--gray-500)]">
            Preparando Midas
          </p>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<AppBootShell />}>
      <AppCoreWithProviders />
    </Suspense>
  );
}
