import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { ToastProvider } from './components/Toast'
import AuthGate from './components/Login'
import { runStorageHealthGuard } from './services/storageHealthGuard'
import { installRuntimeGuardian } from './services/runtimeGuardian'
import { installNominaDebug } from './modules/payroll/services/nominaDebug'
import { installBuildInfo } from './config/buildInfo'

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

// Helper read-only de diagnóstico de Nómina: expone `window.__midas__.nomina`
// (dump/byMonth) para inspeccionar heavy-store vs nominaLoadedKeys desde la
// consola. No dispara fetches ni toca estado.
installNominaDebug()

// `window.__midas__.build` = { appVersion, buildId }. El buildId es el hash del
// código desplegado: permite confirmar en un segundo QUÉ código está corriendo
// el navegador antes de concluir que un fix no funcionó.
installBuildInfo()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthGate>
      <ToastProvider>
        <App />
      </ToastProvider>
    </AuthGate>
  </React.StrictMode>,
)
