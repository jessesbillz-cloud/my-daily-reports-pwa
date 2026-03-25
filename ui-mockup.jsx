import { useState } from "react";

const C = {
  bg: "#1a1a2e",
  card: "#222244",
  inp: "#2a2a4a",
  brd: "#333366",
  txt: "#e8e8f0",
  mut: "#8888aa",
  lt: "#aaaacc",
  org: "#e8742a",
  blu: "#4a90d9",
  ok: "#4caf50",
};

// Current UI style
function CurrentUI() {
  return (
    <div style={{ background: C.bg, minHeight: "100%", padding: "0 0 80px" }}>
      {/* Header */}
      <div style={{ borderBottom: `1px solid ${C.brd}`, background: C.card, padding: "14px 16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button style={{ background: C.inp, border: `1px solid ${C.brd}`, borderRadius: 12, color: "#fff", fontSize: 26, width: 46, height: 46, display: "flex", alignItems: "center", justifyContent: "center" }}>←</button>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 17, color: C.txt }}>Today's Report</div>
            <div style={{ fontSize: 12, color: C.mut }}>Oceanside District Office</div>
          </div>
        </div>
      </div>

      <div style={{ padding: "12px 16px" }}>
        {/* Locked fields */}
        <div style={{ fontSize: 11, color: C.mut, fontWeight: 600, marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>Auto-filled</div>
        {[
          { label: "Date", val: "3/22/2026" },
          { label: "Report #", val: "1" },
          { label: "Inspector", val: "Jesse Saltzman" },
        ].map((f, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", padding: "10px 12px", background: C.inp, borderRadius: 8, marginBottom: 6, border: `1px solid ${C.brd}`, opacity: 0.7 }}>
            <span style={{ fontSize: 13, color: C.mut, width: 100 }}>{f.label}</span>
            <span style={{ fontSize: 13, color: C.lt }}>{f.val}</span>
          </div>
        ))}

        {/* Contractor bubbles */}
        <div style={{ fontSize: 11, color: C.mut, fontWeight: 600, marginTop: 16, marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>Contractors</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {["Jones (4)", "Hank (2)", "ABC Corp (1)"].map((c, i) => (
            <span key={i} style={{ background: C.inp, border: `1px solid ${C.brd}`, borderRadius: 16, padding: "6px 12px", fontSize: 12, color: C.lt }}>
              {c} ✕
            </span>
          ))}
        </div>

        {/* Editable fields */}
        <div style={{ fontSize: 11, color: C.mut, fontWeight: 600, marginTop: 16, marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>Report Fields</div>
        {[
          { label: "District Name", val: "Oceanside" },
          { label: "General Statement", val: "", multi: true },
          { label: "Daily Activities", val: "", multi: true },
          { label: "Notes and Comments", val: "", multi: true },
        ].map((f, i) => (
          <div key={i} style={{ marginBottom: 6 }}>
            <div style={{ fontSize: 12, color: C.mut, marginBottom: 3 }}>{f.label}</div>
            {f.multi ? (
              <textarea style={{ width: "100%", background: C.inp, border: `1px solid ${C.brd}`, borderRadius: 8, color: C.txt, padding: "10px 12px", fontSize: 14, resize: "vertical", minHeight: 60, boxSizing: "border-box" }} placeholder={`Enter ${f.label.toLowerCase()}...`} defaultValue={f.val} />
            ) : (
              <input style={{ width: "100%", background: C.inp, border: `1px solid ${C.brd}`, borderRadius: 8, color: C.txt, padding: "10px 12px", fontSize: 14, boxSizing: "border-box" }} defaultValue={f.val} placeholder={`Enter ${f.label.toLowerCase()}...`} />
            )}
          </div>
        ))}

        {/* Photos */}
        <div style={{ fontSize: 11, color: C.mut, fontWeight: 600, marginTop: 16, marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>Photos</div>
        <button style={{ width: "100%", padding: "14px", background: C.inp, border: `1px dashed ${C.brd}`, borderRadius: 8, color: C.mut, fontSize: 14, cursor: "pointer" }}>
          + Add Photos
        </button>
      </div>

      {/* Bottom bar */}
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "12px 16px", borderTop: `1px solid ${C.brd}`, background: C.card, display: "flex", gap: 10 }}>
        <button style={{ flex: 1, padding: "14px 0", background: C.blu, border: "none", borderRadius: 10, color: "#fff", fontSize: 14, fontWeight: 700 }}>Save Draft</button>
        <button style={{ flex: 1, padding: "14px 0", background: "transparent", border: `1px solid ${C.brd}`, borderRadius: 10, color: C.lt, fontSize: 14, fontWeight: 700 }}>View Report</button>
        <button style={{ flex: 1, padding: "14px 0", background: C.org, border: "none", borderRadius: 10, color: "#fff", fontSize: 14, fontWeight: 700 }}>Submit</button>
      </div>
    </div>
  );
}

// Improved UI style
function ImprovedUI() {
  const [expanded, setExpanded] = useState({ contractors: true, fields: true, photos: false });

  return (
    <div style={{ background: "#111122", minHeight: "100%", padding: "0 0 90px" }}>
      {/* Header - larger, bolder */}
      <div style={{ background: "linear-gradient(135deg, #1e1e3a 0%, #252548 100%)", padding: "18px 20px", borderBottom: "2px solid #e8742a33" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <button style={{ background: "#2a2a50", border: "none", borderRadius: 14, color: "#fff", fontSize: 28, width: 54, height: 54, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 8px rgba(0,0,0,0.3)" }}>←</button>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: 20, color: "#f0f0f8", letterSpacing: "-0.3px" }}>Today's Report</div>
            <div style={{ fontSize: 14, color: "#9999bb", marginTop: 2 }}>Oceanside District Office</div>
          </div>
          <div style={{ background: "#4caf5022", border: "1px solid #4caf5044", borderRadius: 20, padding: "6px 14px", fontSize: 12, color: "#4caf50", fontWeight: 700 }}>Draft</div>
        </div>
      </div>

      <div style={{ padding: "16px 20px" }}>
        {/* Auto-filled - card style */}
        <div style={{ background: "#1e1e3a", borderRadius: 16, padding: "16px 18px", marginBottom: 16, border: "1px solid #2a2a55", boxShadow: "0 2px 12px rgba(0,0,0,0.2)" }}>
          <div style={{ fontSize: 13, color: "#7777aa", fontWeight: 700, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>🔒</span> AUTO-FILLED
          </div>
          {[
            { label: "Date", val: "3/22/2026" },
            { label: "Report #", val: "1" },
            { label: "Inspector", val: "Jesse Saltzman" },
          ].map((f, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", padding: "12px 0", borderBottom: i < 2 ? "1px solid #2a2a50" : "none" }}>
              <span style={{ fontSize: 15, color: "#8888aa", width: 110, fontWeight: 600 }}>{f.label}</span>
              <span style={{ fontSize: 16, color: "#d0d0e8", fontWeight: 600 }}>{f.val}</span>
            </div>
          ))}
        </div>

        {/* Contractors - expandable card */}
        <div style={{ background: "#1e1e3a", borderRadius: 16, padding: "16px 18px", marginBottom: 16, border: "1px solid #2a2a55", boxShadow: "0 2px 12px rgba(0,0,0,0.2)" }}>
          <button onClick={() => setExpanded(p => ({ ...p, contractors: !p.contractors }))} style={{ width: "100%", background: "none", border: "none", display: "flex", alignItems: "center", gap: 8, cursor: "pointer", padding: 0, marginBottom: expanded.contractors ? 14 : 0 }}>
            <span style={{ fontSize: 16 }}>👷</span>
            <span style={{ fontSize: 13, color: "#7777aa", fontWeight: 700, flex: 1, textAlign: "left", letterSpacing: 1 }}>CONTRACTORS</span>
            <span style={{ fontSize: 14, color: "#e8742a", fontWeight: 700, background: "#e8742a18", borderRadius: 12, padding: "3px 10px" }}>3</span>
            <span style={{ color: "#7777aa", fontSize: 18, transform: expanded.contractors ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>▾</span>
          </button>
          {expanded.contractors && (
            <>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
                {[
                  { name: "Jones", mp: 4 },
                  { name: "Hank", mp: 2 },
                  { name: "ABC Corp", mp: 1 },
                ].map((c, i) => (
                  <div key={i} style={{ background: "#252550", border: "1px solid #3a3a66", borderRadius: 12, padding: "10px 16px", display: "flex", alignItems: "center", gap: 10 }}>
                    <div>
                      <div style={{ fontSize: 15, color: "#d0d0e8", fontWeight: 700 }}>{c.name}</div>
                      <div style={{ fontSize: 12, color: "#8888aa" }}>MP: {c.mp}</div>
                    </div>
                    <button style={{ background: "#ff444422", border: "none", borderRadius: 8, color: "#ff6666", fontSize: 16, width: 28, height: 28, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
                  </div>
                ))}
              </div>
              <button style={{ width: "100%", padding: "12px", background: "#252550", border: "1px dashed #4a4a77", borderRadius: 12, color: "#9999bb", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>
                + Add Contractor
              </button>
            </>
          )}
        </div>

        {/* Report Fields - card style */}
        <div style={{ background: "#1e1e3a", borderRadius: 16, padding: "16px 18px", marginBottom: 16, border: "1px solid #2a2a55", boxShadow: "0 2px 12px rgba(0,0,0,0.2)" }}>
          <div style={{ fontSize: 13, color: "#7777aa", fontWeight: 700, marginBottom: 14, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>📋</span> REPORT FIELDS
          </div>
          {[
            { label: "District Name", val: "Oceanside", multi: false },
            { label: "General Statement", val: "", multi: true, placeholder: "General site conditions, work overview..." },
            { label: "Daily Activities", val: "", multi: true, placeholder: "Describe today's activities..." },
            { label: "Notes and Comments", val: "", multi: true, placeholder: "Additional notes..." },
          ].map((f, i) => (
            <div key={i} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 14, color: "#9999bb", marginBottom: 6, fontWeight: 700 }}>{f.label}</div>
              {f.multi ? (
                <textarea
                  style={{
                    width: "100%", background: "#252550", border: "2px solid #3a3a66",
                    borderRadius: 12, color: "#e0e0f0", padding: "14px 16px",
                    fontSize: 16, resize: "vertical", minHeight: 70, boxSizing: "border-box",
                    lineHeight: 1.5, fontFamily: "inherit",
                  }}
                  placeholder={f.placeholder}
                  defaultValue={f.val}
                />
              ) : (
                <input
                  style={{
                    width: "100%", background: "#252550", border: "2px solid #3a3a66",
                    borderRadius: 12, color: "#e0e0f0", padding: "14px 16px",
                    fontSize: 16, boxSizing: "border-box", fontFamily: "inherit",
                  }}
                  defaultValue={f.val}
                  placeholder={f.placeholder || `Enter ${f.label.toLowerCase()}...`}
                />
              )}
            </div>
          ))}
        </div>

        {/* Photos - card style */}
        <div style={{ background: "#1e1e3a", borderRadius: 16, padding: "16px 18px", marginBottom: 16, border: "1px solid #2a2a55", boxShadow: "0 2px 12px rgba(0,0,0,0.2)" }}>
          <div style={{ fontSize: 13, color: "#7777aa", fontWeight: 700, marginBottom: 14, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>📷</span> PHOTOS
          </div>
          <button style={{
            width: "100%", padding: "20px", background: "#252550",
            border: "2px dashed #4a4a77", borderRadius: 14, color: "#9999bb",
            fontSize: 16, fontWeight: 700, cursor: "pointer",
            display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
          }}>
            <span style={{ fontSize: 28 }}>📸</span>
            <span>Tap to Add Photos</span>
            <span style={{ fontSize: 12, color: "#666688" }}>Take a photo or choose from gallery</span>
          </button>
        </div>
      </div>

      {/* Bottom bar - larger, clearer */}
      <div style={{
        position: "absolute", bottom: 0, left: 0, right: 0,
        padding: "14px 20px 20px", borderTop: "2px solid #2a2a55",
        background: "linear-gradient(0deg, #1a1a30 0%, #1e1e3a 100%)",
        boxShadow: "0 -4px 20px rgba(0,0,0,0.4)",
      }}>
        <div style={{ display: "flex", gap: 12 }}>
          <button style={{
            flex: 1, padding: "16px 0", background: "#2a2a55", border: "1px solid #3a3a66",
            borderRadius: 14, color: "#aaaacc", fontSize: 16, fontWeight: 700,
          }}>Save Draft</button>
          <button style={{
            flex: 1.5, padding: "16px 0", background: "linear-gradient(135deg, #e8742a 0%, #d4631f 100%)",
            border: "none", borderRadius: 14, color: "#fff", fontSize: 17, fontWeight: 800,
            boxShadow: "0 3px 12px rgba(232,116,42,0.4)", letterSpacing: "0.3px",
          }}>Submit Report</button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState("improved");

  return (
    <div style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", height: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Toggle */}
      <div style={{ display: "flex", background: "#111122", borderBottom: "2px solid #333", padding: "12px 20px", gap: 8 }}>
        <button
          onClick={() => setView("current")}
          style={{
            flex: 1, padding: "10px", border: "none", borderRadius: 10,
            background: view === "current" ? "#e8742a" : "#2a2a4a",
            color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer",
          }}
        >
          Current UI
        </button>
        <button
          onClick={() => setView("improved")}
          style={{
            flex: 1, padding: "10px", border: "none", borderRadius: 10,
            background: view === "improved" ? "#e8742a" : "#2a2a4a",
            color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer",
          }}
        >
          Improved UI
        </button>
      </div>
      <div style={{ flex: 1, overflow: "auto", position: "relative" }}>
        {view === "current" ? <CurrentUI /> : <ImprovedUI />}
      </div>
    </div>
  );
}
