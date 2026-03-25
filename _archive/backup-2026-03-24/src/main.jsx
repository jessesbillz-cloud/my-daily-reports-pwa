import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/global.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

// ── Service Worker: nuclear reset then register ──
// On iOS Safari, old SWs can linger and intercept requests even after deploy.
// This ensures the old broken SW is fully removed before the new clean one activates.
if ('serviceWorker' in navigator) {
  const SW_VERSION = '__SW_RESET_VERSION__' // replaced at build time
  const lastVersion = localStorage.getItem('mdr_sw_version')

  async function resetAndRegister() {
    // If SW version changed (new deploy), nuke everything first
    if (lastVersion !== SW_VERSION) {
      console.log('[SW] New version detected — clearing all old SWs and caches')
      // 1. Unregister ALL existing service workers
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map(r => r.unregister()))
      // 2. Delete ALL caches (old mdr-api-v1, old mdr-offline-queue, old cache versions)
      const keys = await caches.keys()
      await Promise.all(keys.map(k => caches.delete(k)))
      // 3. Mark this version so we don't nuke on every load
      localStorage.setItem('mdr_sw_version', SW_VERSION)
      console.log('[SW] Old SWs and caches cleared')
    }

    // Now register the clean SW
    const reg = await navigator.serviceWorker.register('/sw.js')
    console.log('[SW] Registered:', reg.scope)
    // Check for updates every 30 minutes
    setInterval(() => reg.update(), 30 * 60 * 1000)
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing
      if (!nw) return
      nw.addEventListener('statechange', () => {
        if (nw.state === 'activated') {
          window.location.reload()
        }
      })
    })
  }

  resetAndRegister().catch(e => console.log('SW setup failed:', e))
}
