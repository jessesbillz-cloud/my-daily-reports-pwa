import React, { useState, useEffect } from 'react'
import { C } from '../constants/theme'

function OfflineBanner() {
  const [offline, setOffline] = useState(!navigator.onLine)
  const [synced, setSynced] = useState(false)

  useEffect(() => {
    const on = () => { setOffline(false); setSynced(false) }
    const off = () => { setOffline(true); setSynced(false) }
    const syncDone = () => { setSynced(true); setTimeout(() => setSynced(false), 3000) }

    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    document.addEventListener('mdr-synced', syncDone)

    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
      document.removeEventListener('mdr-synced', syncDone)
    }
  }, [])

  if (synced) {
    return (
      <div style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        padding: "6px 0",
        background: C.ok,
        color: "#fff",
        textAlign: "center",
        fontSize: 12,
        fontWeight: 700,
        zIndex: 99998
      }}>
        Changes synced successfully
      </div>
    )
  }

  if (!offline) return null

  return (
    <div style={{
      position: "fixed",
      top: 0,
      left: 0,
      right: 0,
      padding: "6px 0",
      background: C.org,
      color: "#fff",
      textAlign: "center",
      fontSize: 12,
      fontWeight: 700,
      zIndex: 99998
    }}>
      Offline — changes will sync when you reconnect
    </div>
  )
}

export default OfflineBanner
