import React, { useState } from 'react'
import { C } from '../constants/theme'
import MDRLogo from './MDRLogo'
import { authSignInAndSave, authSignUpAndSave } from '../utils/auth'

function LoginScreen({ onAuth }) {
  const [mode, setMode] = useState("login")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [fullName, setFullName] = useState("")
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState("")
  const [checkEmail, setCheckEmail] = useState(false)

  const fs = {
    width: "100%",
    padding: "14px 16px",
    background: C.inp,
    border: `1px solid ${C.brd}`,
    borderRadius: 10,
    color: C.txt,
    fontSize: 15
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setErr("")
    setLoading(true)
    try {
      if (mode === "login") {
        const u = await authSignInAndSave(email.trim(), password)
        onAuth(u)
      } else {
        // ── Whitelist: only approved emails can register ──
        const WHITELIST = [
          "jessesbillz@gmail.com",
          "nshehata@tyrior.com",
          "ysobhi1@msn.com",
          "dsobhi@tyrior.com",
          "marktash@outlook.com"
        ];
        if (!WHITELIST.includes(email.trim().toLowerCase())) {
          setErr("Registration is currently invite-only. Contact support@mydailyreports.org for access.");
          setLoading(false);
          return;
        }
        if (!fullName.trim()) {
          setErr("Full name is required")
          setLoading(false)
          return
        }
        if (password.length < 6) {
          setErr("Password must be at least 6 characters")
          setLoading(false)
          return
        }
        const u = await authSignUpAndSave(email.trim(), password, fullName.trim())
        onAuth(u)
      }
    } catch (err) {
      if (err.message === "CHECK_EMAIL") {
        setCheckEmail(true)
      } else {
        setErr(err.message)
      }
    } finally {
      setLoading(false)
    }
  }

  if (checkEmail) {
    return (
      <div style={{
        minHeight: "100vh",
        background: C.bg,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 20
      }}>
        <div style={{ maxWidth: 380, width: "100%", textAlign: "center" }}>
          <MDRLogo size={72} />
          <div style={{
            fontSize: 22,
            fontWeight: 800,
            color: C.txt,
            marginTop: 16
          }}>
            Check Your Email
          </div>
          <div style={{
            color: C.mut,
            fontSize: 14,
            marginTop: 10,
            lineHeight: 1.5
          }}>
            We sent a confirmation link to <strong style={{ color: C.org }}>{email}</strong>. Tap the link in your email, then come back here and sign in.
          </div>
          <button onClick={() => { setCheckEmail(false); setMode("login"); setPassword("") }} className="btn-o" style={{
            marginTop: 24,
            width: "100%",
            padding: "14px 0",
            background: C.org,
            border: "none",
            borderRadius: 10,
            color: "#fff",
            fontSize: 15,
            fontWeight: 700,
            cursor: "pointer"
          }}>
            Back to Sign In
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={{
      minHeight: "100vh",
      background: C.bg,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      padding: 20
    }}>
      <div style={{ maxWidth: 380, width: "100%" }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <MDRLogo size={72} />
          <div style={{
            fontSize: 24,
            fontWeight: 800,
            color: C.txt,
            marginTop: 12
          }}>
            My Daily Reports
          </div>
          <div style={{
            color: C.mut,
            fontSize: 14,
            marginTop: 4
          }}>
            Daily reporting made simple
          </div>
        </div>

        <div style={{
          display: "flex",
          background: C.inp,
          borderRadius: 10,
          padding: 3,
          marginBottom: 24
        }}>
          <button onClick={() => { setMode("login"); setErr("") }} style={{
            flex: 1,
            padding: "10px 0",
            background: mode === "login" ? C.card : "transparent",
            border: "none",
            borderRadius: 8,
            color: mode === "login" ? C.txt : C.mut,
            fontSize: 14,
            fontWeight: 700,
            cursor: "pointer"
          }}>
            Sign In
          </button>
          <button onClick={() => { setMode("signup"); setErr("") }} style={{
            flex: 1,
            padding: "10px 0",
            background: mode === "signup" ? C.card : "transparent",
            border: "none",
            borderRadius: 8,
            color: mode === "signup" ? C.txt : C.mut,
            fontSize: 14,
            fontWeight: 700,
            cursor: "pointer"
          }}>
            Create Account
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{
          display: "flex",
          flexDirection: "column",
          gap: 14
        }}>
          {mode === "signup" && (
            <input type="text" placeholder="Full Name" value={fullName} onChange={e => setFullName(e.target.value)} style={fs} required />
          )}
          <input type="email" placeholder="Email Address" value={email} onChange={e => setEmail(e.target.value)} style={fs} required />
          <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} style={fs} required minLength={6} />

          {err && <div style={{ color: C.err, fontSize: 13, textAlign: "center" }}>{err}</div>}

          <button type="submit" disabled={loading} className="btn-o" style={{
            width: "100%",
            padding: "14px 0",
            background: C.org,
            border: "none",
            borderRadius: 10,
            color: "#fff",
            fontSize: 16,
            fontWeight: 700,
            cursor: loading ? "default" : "pointer",
            opacity: loading ? 0.7 : 1,
            marginTop: 4
          }}>
            {loading ? (mode === "login" ? "Signing In..." : "Creating Account...") : (mode === "login" ? "Sign In" : "Create Account")}
          </button>
        </form>

        <div style={{
          textAlign: "center",
          marginTop: 20,
          color: C.mut,
          fontSize: 13
        }}>
          {mode === "login" ? "Don't have an account? " : "Already have an account? "}
          <span onClick={() => { setMode(mode === "login" ? "signup" : "login"); setErr("") }} style={{
            color: C.org,
            cursor: "pointer",
            fontWeight: 600
          }}>
            {mode === "login" ? "Sign up free" : "Sign in"}
          </span>
        </div>

        <div style={{
          textAlign: "center",
          marginTop: 24,
          color: C.mut,
          fontSize: 11
        }}>
          Invite-only beta
        </div>

        <div style={{
          marginTop: 28,
          padding: "18px 16px",
          background: "rgba(232,116,42,0.06)",
          border: "1px solid rgba(232,116,42,0.2)",
          borderRadius: 12,
          textAlign: "center"
        }}>
          <div style={{
            fontSize: 14,
            fontWeight: 700,
            color: C.txt,
            marginBottom: 6
          }}>
            New to digital daily reports?
          </div>
          <div style={{
            fontSize: 13,
            color: C.lt,
            lineHeight: 1.6,
            marginBottom: 12
          }}>
            Send us your PDF or Word template and we'll set it up for you — configured, tested, and ready for your whole team.
          </div>
          <a href="mailto:support@mydailyreports.org?subject=Template%20Setup%20Request&body=Hi%2C%20I'd%20like%20help%20setting%20up%20my%20report%20template.%20I've%20attached%20it%20to%20this%20email." style={{
            display: "inline-block",
            padding: "10px 20px",
            background: C.org,
            color: "#fff",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 700,
            textDecoration: "none"
          }}>
            Send Us Your Template
          </a>
          <div style={{
            fontSize: 11,
            color: C.mut,
            marginTop: 8
          }}>
            support@mydailyreports.org
          </div>
        </div>
      </div>
    </div>
  )
}

export default LoginScreen
