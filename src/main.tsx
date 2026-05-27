import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { ToastProvider } from './components/Toast'
import AuthGate from './components/Login'
import { runStorageHealthGuard } from './services/storageHealthGuard'
import { installRuntimeGuardian } from './services/runtimeGuardian'

// CRÍTICO: corre antes de cualquier import de persistence o hidratación.
// Si detecta storage envenenado (corrupto, sobre-tamaño, o crash previo),
// purga localStorage + IDB y deja un flag en sessionStorage para que App
// muestre un toast informativo. Previene "Aw, Snap! Error code 5" en boot.
runStorageHealthGuard()

// Observabilidad runtime: handlers globales de error/unhandledrejection,
// monitor de heap (Chromium), long-task observer y ring buffer de incidentes.
// Crítico para diagnosticar crashes esporádicos en Chrome/Edge. No bloquea
// boot ni tira si algún feature no existe.
installRuntimeGuardian()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthGate>
      <ToastProvider>
        <App />
      </ToastProvider>
    </AuthGate>
  </React.StrictMode>,
)
