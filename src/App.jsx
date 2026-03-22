import React, { useState, useEffect, useMemo } from 'react'
import { C } from './constants/theme'
import { authGetSession, authHandleOAuthCallback, authLogout, setAuthToken, refreshAuthToken, validateConfig, authHealthCheck } from './utils/auth'
import { db } from './utils/db'
import MDRLogo from './components/MDRLogo'
import OfflineBanner from './components/OfflineBanner'
import LoginScreen from './components/LoginScreen'
import SetupWizard from './components/SetupWizard'
import Dashboard from './components/Dashboard'
import InstallBanner from './components/InstallBanner'
import ConfirmOverlay from './components/ConfirmOverlay'

function App() {
  const [user, setUser] = useState(null)
  const [booting, setBooting] = useState(true)
  const [setupDone, setSetupDone] = useState(null)

  const inviteCompany = useMemo(() => {
    try {
      const p = new URLSearchParams(window.location.search)
      return p.get("company") || ""
    } catch (e) {
      return ""
    }
  }, [])

  useEffect(() => {
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith("mdr_parse_"))
        .forEach(k => localStorage.removeItem(k))
    } catch (e) { }
  }, [])

  // ── Config validation on startup — catches key migration issues immediately ──
  useEffect(() => {
    const issues = validateConfig()
    if (issues.length > 0) {
      console.error("[APP] Config issues detected:", issues)
      // Show a non-dismissible warning so the developer knows immediately
      issues.forEach(msg => console.error("[APP] ⚠️", msg))
    }
  }, [])

  useEffect(() => {
    (async () => {
      const oauthUser = await authHandleOAuthCallback()
      if (oauthUser) {
        setUser(oauthUser)
        // Verify auth actually works with the new keys
        const health = await authHealthCheck()
        if (!health.ok) console.error("[APP] Auth health check FAILED after OAuth:", health.error)
        else console.log("[APP] Auth health check OK:", health.email)
        try {
          const p = await db.getProfile(oauthUser.id)
          setSetupDone(p?.setup_complete === true)
          if (p?.full_name) window._mdrUserName = p.full_name
        } catch (e) {
          setSetupDone(false)
        }
        setBooting(false)
        return
      }

      const u = await authGetSession()
      if (u) {
        setUser(u)
        // Verify auth actually works — catches stale tokens / key migration issues
        const health = await authHealthCheck()
        if (!health.ok) {
          console.error("[APP] Auth health check FAILED on session restore:", health.error)
          // Don't block — just warn. User can still try to use the app.
        } else {
          console.log("[APP] Auth health check OK:", health.email)
        }
        setTimeout(() => {
          try {
            const t = document.createElement("div")
            t.id = "betaToast"
            t.style.cssText = "position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:9999;max-width:420px;width:90%"
            t.innerHTML = `<div style="background:#1a1a1a;border:1px solid #333;border-left:4px solid #e8742a;border-radius:10px;padding:16px 20px;color:#fff;font-family:-apple-system,sans-serif;box-shadow:0 8px 32px rgba(0,0,0,0.5)"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px"><div><div style="font-weight:700;font-size:14px;margin-bottom:6px">Beta Notice</div><div style="font-size:12px;color:#ccc;line-height:1.5">My Daily Reports is actively being developed. You may occasionally experience brief interruptions during updates. If something looks off, close and reopen the app.</div></div><button onclick="this.closest('[id=betaToast]').remove()" style="background:none;border:none;color:#888;font-size:18px;cursor:pointer;padding:0;line-height:1">x</button></div></div>`
            document.body.appendChild(t)
            setTimeout(() => {
              const el = document.getElementById("betaToast")
              if (el) el.remove()
            }, 8000)
          } catch (e) { }
        }, 800)

        try {
          const p = await db.getProfile(u.id)
          setSetupDone(p?.setup_complete === true)
          if (p?.full_name) window._mdrUserName = p.full_name
        } catch (e) {
          setSetupDone(false)
        }
      }

      setBooting(false)
    })().catch(() => setBooting(false))
  }, [])

  // Keep auth token fresh — refresh every 20 min while user is logged in
  useEffect(() => {
    if (!user) return
    const interval = setInterval(() => {
      refreshAuthToken().catch(e => console.warn('Token refresh failed:', e))
    }, 20 * 60 * 1000)
    return () => clearInterval(interval)
  }, [user])

  // Non-blocking auth warning toast — user stays in the app
  const [authToast, setAuthToast] = useState(null)
  useEffect(() => {
    const onAuthWarn = (e) => {
      console.warn("[App] Auth warning:", e.detail?.message)
      setAuthToast(e.detail?.message || "Session issue — please log in again when ready.")
    }
    window.addEventListener("mdr-auth-warning", onAuthWarn)
    return () => window.removeEventListener("mdr-auth-warning", onAuthWarn)
  }, [])

  const handleAuth = async (u) => {
    setUser(u)
    if (u?.user_metadata?.full_name) window._mdrUserName = u.user_metadata.full_name
    try {
      const p = await db.getProfile(u.id)
      setSetupDone(p?.setup_complete === true)
      if (p?.full_name) window._mdrUserName = p.full_name
    } catch (e) {
      setSetupDone(false)
    }
  }

  const handleLogout = () => {
    authLogout()
    db._tplBytesCache = {}
    db._profileCache = {}
    db._reportIdCache = {}
    setUser(null)
    setSetupDone(null)
  }

  if (booting) {
    return (
      <div style={{
        minHeight: "100vh",
        background: C.bg,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16
      }}>
        <MDRLogo size={64} />
        <div style={{ color: C.mut, fontSize: 14 }}>Loading...</div>
      </div>
    )
  }

  if (!user) {
    return <LoginScreen onAuth={handleAuth} />
  }

  if (setupDone === false) {
    return <SetupWizard user={user} inviteCompany={inviteCompany} onComplete={() => setSetupDone(true)} />
  }

  return (
    <>
      <OfflineBanner />
      <main>
        <Dashboard user={user} onLogout={handleLogout} />
      </main>
      <InstallBanner />
      <ConfirmOverlay />
      {authToast && (
        <div style={{position:"fixed",bottom:20,left:"50%",transform:"translateX(-50%)",zIndex:9999,maxWidth:420,width:"90%"}}>
          <div style={{background:"#1a1a1a",border:"1px solid #333",borderLeft:"4px solid #e8742a",borderRadius:10,padding:"14px 18px",color:"#fff",fontFamily:"-apple-system,sans-serif",boxShadow:"0 8px 32px rgba(0,0,0,0.5)",display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12}}>
            <div style={{fontSize:13,color:"#ccc",lineHeight:1.5}}>{authToast}</div>
            <button onClick={()=>setAuthToast(null)} style={{background:"none",border:"none",color:"#888",fontSize:18,cursor:"pointer",padding:0,lineHeight:1}}>x</button>
          </div>
        </div>
      )}
    </>
  )
}

export default App
