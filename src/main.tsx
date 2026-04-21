import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { ToastProvider } from './components/Toast'
import { ActivityFeedProvider } from './components/ActivityFeed'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ToastProvider>
      <ActivityFeedProvider>
        <App />
      </ActivityFeedProvider>
    </ToastProvider>
  </React.StrictMode>,
)
