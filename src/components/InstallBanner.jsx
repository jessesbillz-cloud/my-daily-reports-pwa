import React, { useState, useEffect } from 'react'
import { C } from '../constants/theme'
import MDRLogo from './MDRLogo'

function InstallBanner() {
  const [show, setShow] = useState(false)
  const [step, setStep] = useState(0)
  const [platform, setPlatform] = useState("unknown")

  useEffect(() => {
    if (window.matchMedia("(display-mode: standalone)").matches) return
    if (window.navigator.standalone === true) return
    if (localStorage.getItem("mdr_install_dismissed")) return

    const ua = navigator.userAgent || ""
    if (/iPhone|iPad|iPod/.test(ua)) setPlatform("ios")
    else if (/Android/.test(ua)) setPlatform("android")
    else setPlatform("desktop")

    const t = setTimeout(() => setShow(true), 2000)
    return () => clearTimeout(t)
  }, [])

  const dismiss = () => {
    localStorage.setItem("mdr_install_dismissed", "1")
    setShow(false)
  }

  if (!show) return null

  if (step === 1) {
    return (
      <div style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.85)",
        zIndex: 10000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20
      }}>
        <div style={{
          background: C.card,
          borderRadius: 16,
          padding: 28,
          maxWidth: 360,
          width: "100%",
          border: `1px solid ${C.brd}`
        }}>
          <div style={{ textAlign: "center", marginBottom: 20 }}>
            <MDRLogo size={48} />
            <div style={{
              fontSize: 18,
              fontWeight: 700,
              marginTop: 10
            }}>
              Add to Home Screen
            </div>
          </div>

          {platform === "ios" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {[
                { num: 1, text: "Tap the Share button at the bottom of Safari (the square with an arrow pointing up)" },
                { num: 2, text: "Scroll down and tap Add to Home Screen" },
                { num: 3, text: "Tap Add in the top right" }
              ].map((step, i) => (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                  <div style={{
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    background: C.org,
                    color: "#fff",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 700,
                    fontSize: 14,
                    flexShrink: 0
                  }}>
                    {step.num}
                  </div>
                  <div style={{
                    fontSize: 14,
                    color: C.lt,
                    lineHeight: 1.5
                  }}>
                    Tap the <strong style={{ color: "#fff" }}>Share</strong> button at the bottom of Safari (the square with an arrow pointing up)
                  </div>
                </div>
              ))}
              <div style={{
                fontSize: 12,
                color: C.mut,
                textAlign: "center",
                marginTop: 4
              }}>
                Must use Safari — Chrome on iPhone won't work
              </div>
            </div>
          )}

          {platform === "android" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {[
                { num: 1, text: "Tap the three dots menu in the top right of Chrome" },
                { num: 2, text: "Tap Add to Home screen" },
                { num: 3, text: "Tap Add" }
              ].map((step, i) => (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                  <div style={{
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    background: C.org,
                    color: "#fff",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 700,
                    fontSize: 14,
                    flexShrink: 0
                  }}>
                    {step.num}
                  </div>
                  <div style={{
                    fontSize: 14,
                    color: C.lt,
                    lineHeight: 1.5
                  }}>
                    {step.text}
                  </div>
                </div>
              ))}
            </div>
          )}

          {platform === "desktop" && (
            <div style={{
              fontSize: 14,
              color: C.lt,
              lineHeight: 1.6,
              textAlign: "center"
            }}>
              Open this page on your <strong style={{ color: "#fff" }}>iPhone</strong> or <strong style={{ color: "#fff" }}>Android</strong> phone to install it as an app on your home screen.
            </div>
          )}

          <button onClick={dismiss} style={{
            width: "100%",
            padding: "14px 0",
            background: C.org,
            border: "none",
            borderRadius: 10,
            color: "#fff",
            fontSize: 15,
            fontWeight: 700,
            cursor: "pointer",
            marginTop: 20
          }}>
            Got It
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={{
      position: "fixed",
      bottom: 0,
      left: 0,
      right: 0,
      background: C.card,
      borderTop: `1px solid ${C.brd}`,
      padding: "14px 16px",
      zIndex: 10000,
      display: "flex",
      alignItems: "center",
      gap: 12
    }}>
      <MDRLogo size={36} />
      <div style={{ flex: 1 }}>
        <div style={{
          fontSize: 14,
          fontWeight: 700,
          color: C.txt
        }}>
          Install the App
        </div>
        <div style={{
          fontSize: 12,
          color: C.mut
        }}>
          Add to your home screen for the full experience
        </div>
      </div>
      <button onClick={() => setStep(1)} style={{
        padding: "10px 16px",
        background: C.org,
        border: "none",
        borderRadius: 8,
        color: "#fff",
        fontSize: 13,
        fontWeight: 700,
        cursor: "pointer",
        whiteSpace: "nowrap"
      }}>
        Show Me
      </button>
      <button onClick={dismiss} style={{
        background: "none",
        border: "none",
        color: C.mut,
        fontSize: 20,
        cursor: "pointer",
        padding: "4px 8px",
        lineHeight: 1
      }}>
        ✕
      </button>
    </div>
  )
}

export default InstallBanner
