import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { ToastProvider } from './components/Toast'
import { ActivityFeedProvider } from './components/ActivityFeed'
import AuthGate from './components/Login'

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
