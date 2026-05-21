import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { ToastProvider } from './components/Toast'
import { ActivityFeedProvider } from './components/ActivityFeed'
import AuthGate from './components/Login'
import { runStorageHealthGuard } from './services/storageHealthGuard'

// CRÍTICO: corre antes de cualquier import de persistence o hidratación.
// Si detecta storage envenenado (corrupto, sobre-tamaño, o crash previo),
// purga localStorage + IDB y deja un flag en sessionStorage para que App
// muestre un toast informativo. Previene "Aw, Snap! Error code 5" en boot.
runStorageHealthGuard()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthGate>
      <ToastProvider>
        <ActivityFeedProvider>
          <App />
        </ActivityFeedProvider>
      </ToastProvider>
    </AuthGate>
  </React.StrictMode>,
)
