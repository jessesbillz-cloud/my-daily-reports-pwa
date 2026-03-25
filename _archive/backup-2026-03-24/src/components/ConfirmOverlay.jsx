import React, { useState, useEffect } from 'react'
import { C } from '../constants/theme'

let _cfmResolve = null
let _cfmSet = null

export function askConfirm(msg) {
  return new Promise(res => {
    _cfmResolve = res
    if (_cfmSet) _cfmSet(msg)
  })
}

function ConfirmOverlay() {
  const [msg, setMsg] = useState("")

  useEffect(() => {
    _cfmSet = setMsg
  }, [])

  const handle = (v) => {
    setMsg("")
    if (_cfmResolve) {
      _cfmResolve(v)
      _cfmResolve = null
    }
  }

  if (!msg) return null

  return (
    <div onClick={() => handle(false)} style={{
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.5)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 99999,
      padding: 20
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: C.card,
        border: `1px solid ${C.brd}`,
        borderRadius: 14,
        padding: "24px 20px",
        maxWidth: 340,
        width: "100%",
        textAlign: "center"
      }}>
        <div style={{
          fontSize: 15,
          color: C.txt,
          lineHeight: 1.5,
          marginBottom: 20
        }}>
          {msg}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={() => handle(false)} style={{
            flex: 1,
            padding: "12px 0",
            background: C.inp,
            border: `1px solid ${C.brd}`,
            borderRadius: 8,
            color: C.lt,
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer"
          }}>
            Cancel
          </button>
          <button onClick={() => handle(true)} style={{
            flex: 1,
            padding: "12px 0",
            background: C.err,
            border: "none",
            borderRadius: 8,
            color: "#fff",
            fontSize: 14,
            fontWeight: 700,
            cursor: "pointer"
          }}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  )
}

export default ConfirmOverlay
