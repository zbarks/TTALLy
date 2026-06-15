import { useState, useEffect, useRef, useCallback } from "react";
import { initializeApp } from "firebase/app";
import {
  getDatabase,
  ref,
  set,
  get,
  remove,
  onValue,
  onDisconnect,
} from "firebase/database";

/* ================================================================== *
 *  TALLY — Firebase + vMix edition
 *
 *  Drive it manually (Producer screen) OR with vMix (run the bridge,
 *  vmix-tally-bridge.js, on the vMix PC). When the bridge is pushing,
 *  the Producer screen auto-flips to a live monitor and every camera
 *  light follows its matching vMix input.
 *
 *  Colours:  RED = off · ORANGE = preview · GREEN = live
 * ================================================================== */

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDQOL8jYsffIPdkyzrpmlv9Aq-Im887Deo",
  authDomain: "tachartastally.firebaseapp.com",
  databaseURL:
    "https://tachartastally-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "tachartastally",
  storageBucket: "tachartastally.firebasestorage.app",
  messagingSenderId: "740799640029",
  appId: "1:740799640029:web:00e871db12c66ebc058634",
  measurementId: "G-P5TEQ712XD",
};

let db = null;
try {
  db = getDatabase(initializeApp(FIREBASE_CONFIG));
} catch {}

const stateRef = (room) => ref(db, `rooms/${room}/state`);
const camsRef = (room) => ref(db, `rooms/${room}/cameras`);
const camRef = (room, n) => ref(db, `rooms/${room}/cameras/${n}`);

const C = {
  bg: "#0a0b0d", panel: "#15171b", panelHi: "#1d2025", line: "#2a2e35",
  text: "#e8eaed", dim: "#8a9099", faint: "#565c66",
  off: "#d11a1a", offDeep: "#7a0f0f",
  preview: "#ff8a00", previewDeep: "#8f4d00",
  live: "#16c43a", liveDeep: "#0a7320",
};
const mono = "ui-monospace, 'SF Mono', Menlo, monospace";

const row = { display: "flex", alignItems: "center" };
const rowBetween = { display: "flex", alignItems: "center", justifyContent: "space-between" };
const colCenter = { display: "flex", flexDirection: "column", alignItems: "center" };
const fill = { display: "flex", alignItems: "center", justifyContent: "center" };

function parseTally(s) {
  const live = [], pvw = [];
  if (typeof s === "string")
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "1") live.push(i + 1);
      if (s[i] === "2") pvw.push(i + 1);
    }
  return { live, pvw };
}

/* ================================================================== */
export default function App() {
  const [screen, setScreen] = useState("landing");
  const [room, setRoom] = useState("MAIN");
  const shell = {
    minHeight: "100vh", background: C.bg, color: C.text,
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  };
  return (
    <div style={shell}>
      {screen === "landing" && <Landing room={room} setRoom={setRoom} onPick={setScreen} />}
      {screen === "producer" && <Producer room={room} onExit={() => setScreen("landing")} />}
      {screen === "camera" && <Camera room={room} onExit={() => setScreen("landing")} />}
    </div>
  );
}

/* ---- Landing ------------------------------------------------------ */
function Landing({ room, setRoom, onPick }) {
  return (
    <div style={{ ...colCenter, justifyContent: "center", minHeight: "100vh", padding: "0 24px" }}>
      <div style={{ width: "100%", maxWidth: 460 }}>
        <div style={{ ...row, gap: 12, marginBottom: 4 }}>
          <Dot color={C.live} pulse />
          <span style={{ fontFamily: mono, letterSpacing: "0.45em", fontSize: 13, color: C.dim }}>TALLY</span>
        </div>
        <h1 style={{ fontSize: 44, lineHeight: 1.02, fontWeight: 800, letterSpacing: "-0.02em", margin: "10px 0 6px" }}>
          Studio tally control
        </h1>
        <p style={{ color: C.dim, fontSize: 15, lineHeight: 1.5, marginBottom: 28 }}>
          One screen runs the show, every camera gets a light. Drive it by hand,
          or let vMix drive it automatically.
        </p>
        <label style={{ display: "block", fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", color: C.faint, marginBottom: 8 }}>Room</label>
        <input
          value={room}
          onChange={(e) => setRoom(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12))}
          onBlur={() => !room && setRoom("MAIN")}
          placeholder="MAIN"
          style={{ width: "100%", background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, color: C.text, fontSize: 18, fontFamily: mono, letterSpacing: "0.18em", padding: "14px 16px", outline: "none", marginBottom: 26, boxSizing: "border-box" }}
        />
        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12 }}>
          <RolePick title="I'm the producer" sub="Dashboard / vMix monitor" accent={C.live} onClick={() => onPick("producer")} />
          <RolePick title="I'm a camera" sub="Get a tally light on this device" accent={C.preview} onClick={() => onPick("camera")} />
        </div>
        <p style={{ color: C.faint, fontSize: 12.5, lineHeight: 1.6, marginTop: 24 }}>Send everyone the deployed URL. Same room = same show.</p>
      </div>
    </div>
  );
}

function RolePick({ title, sub, accent, onClick }) {
  const [hover, setHover] = useState(false);
  return (
    <button onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ textAlign: "left", background: hover ? C.panelHi : C.panel, border: `1px solid ${hover ? accent : C.line}`, borderRadius: 14, padding: "18px 20px", cursor: "pointer", transition: "background .15s, border-color .15s", display: "flex", alignItems: "center", gap: 16 }}>
      <span style={{ width: 12, height: 12, borderRadius: "50%", background: accent, boxShadow: `0 0 14px ${accent}`, flexShrink: 0 }} />
      <span style={{ flex: 1 }}>
        <span style={{ display: "block", fontSize: 18, fontWeight: 700 }}>{title}</span>
        <span style={{ display: "block", fontSize: 13.5, color: C.dim, marginTop: 2 }}>{sub}</span>
      </span>
      <span style={{ color: C.faint, fontSize: 22 }}>→</span>
    </button>
  );
}

/* ---- Producer ----------------------------------------------------- */
function Producer({ room, onExit }) {
  const [st, setSt] = useState({});
  const [cams, setCams] = useState({});
  const stRef = useRef({});

  useEffect(() => {
    const offState = onValue(stateRef(room), (snap) => {
      const s = snap.val() || {};
      stRef.current = s; setSt(s);
    });
    const offCams = onValue(camsRef(room), (snap) => setCams(snap.val() || {}));
    return () => { offState(); offCams(); };
  }, [room]);

  const vmix = st.src === "vmix" || typeof st.tally === "string";
  const { live: tLive, pvw: tPvw } = parseTally(st.tally);
  const program = vmix ? (tLive[0] ?? null) : (st.program ?? null);
  const preview = vmix ? (tPvw[0] ?? null) : (st.preview ?? null);
  const liveSet = vmix ? new Set(tLive) : new Set(program != null ? [program] : []);
  const pvwSet = vmix ? new Set(tPvw) : new Set(preview != null ? [preview] : []);

  const push = useCallback((next) => {
    if (vmix) return;
    const merged = { ...stRef.current, src: "manual", ...next };
    stRef.current = merged; setSt(merged);
    set(stateRef(room), merged);
  }, [room, vmix]);

  const take = useCallback(() => {
    if (vmix) return;
    const p = stRef.current.preview;
    if (p == null) return;
    push({ program: p, preview: null });
  }, [push, vmix]);

  useEffect(() => {
    if (vmix) return;
    const onKey = (e) => {
      if (e.target.tagName === "INPUT") return;
      if (e.key >= "1" && e.key <= "9") push({ program: parseInt(e.key, 10) });
      else if (e.code === "Space") { e.preventDefault(); take(); }
      else if (e.key === "Escape") push({ program: null });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [push, take, vmix]);

  const onlineNums = Object.keys(cams).map(Number);
  const highest = Math.max(8, program || 0, preview || 0, ...tLive, ...tPvw, ...onlineNums, 0);
  const pad = Array.from({ length: highest + 1 }, (_, i) => i + 1);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh", maxWidth: 1040, margin: "0 auto", padding: "16px 18px 32px" }}>
      <TopBar room={room} label="Producer" onExit={onExit} extra={`${onlineNums.length} connected`} />

      {vmix && (
        <div style={{ ...row, gap: 10, marginTop: 12, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: "9px 13px" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: C.live, boxShadow: `0 0 8px ${C.live}` }} />
          <span style={{ fontSize: 13, color: C.dim }}>Driven by vMix — live monitor</span>
        </div>
      )}

      <OnAirSlate program={program} preview={preview} extraLive={liveSet.size > 1 ? liveSet.size - 1 : 0} />

      {!vmix && (
        <button onClick={take} disabled={preview == null}
          style={{ width: "100%", marginTop: 14, padding: 16, borderRadius: 14, border: "none", cursor: preview == null ? "not-allowed" : "pointer", background: preview == null ? C.panel : C.live, color: preview == null ? C.faint : "#04140a", fontWeight: 800, fontSize: 18, letterSpacing: "0.16em", transition: "background .15s" }}>
          TAKE {preview != null ? `→ CAM ${preview} LIVE` : "(arm a preview first)"}
          <span style={{ display: "block", fontWeight: 500, fontSize: 11, letterSpacing: "0.08em", color: preview == null ? C.faint : "#0a3318", marginTop: 3 }}>or press space</span>
        </button>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 16, marginTop: 22 }}>
        <Pad title="Live" hint={vmix ? "From vMix" : "Cut a camera straight to air"} accent={C.live} nums={pad} activeSet={liveSet} onlineNums={onlineNums} disabled={vmix}
          onSelect={(n) => push({ program: liveSet.has(n) ? null : n })} />
        <Pad title="Preview" hint={vmix ? "From vMix" : "Arm the next shot — then take"} accent={C.preview} nums={pad} activeSet={pvwSet} onlineNums={onlineNums} disabled={vmix}
          onSelect={(n) => push({ preview: pvwSet.has(n) ? null : n })} />
      </div>

      <span style={{ fontSize: 12.5, color: C.faint, marginTop: 20 }}>
        Green dot = camera connected. Cameras drop off automatically when they close.
      </span>
    </div>
  );
}

function OnAirSlate({ program, preview, extraLive }) {
  const live = program != null;
  return (
    <div style={{ marginTop: 16, borderRadius: 18, overflow: "hidden", border: `1px solid ${live ? C.live : C.line}`,
      background: live ? `radial-gradient(120% 140% at 50% 0%, ${C.liveDeep} 0%, #06120a 70%)` : `radial-gradient(120% 140% at 50% 0%, ${C.offDeep} 0%, #120606 70%)`,
      boxShadow: live ? `0 0 40px ${C.live}33` : "none", transition: "all .2s" }}>
      <div style={{ ...rowBetween, padding: "12px 18px", borderBottom: `1px solid ${live ? "#13491f" : C.line}` }}>
        <span style={{ fontFamily: mono, letterSpacing: "0.3em", fontSize: 12, color: live ? C.live : C.off }}>{live ? "ON AIR" : "OFF AIR"}</span>
        <span style={{ ...row, gap: 8, fontSize: 12.5 }}>
          <span style={{ width: 9, height: 9, borderRadius: "50%", background: preview != null ? C.preview : C.faint, boxShadow: preview != null ? `0 0 10px ${C.preview}` : "none" }} />
          <span style={{ color: preview != null ? C.preview : C.faint, letterSpacing: "0.12em" }}>{preview != null ? `PREVIEW · CAM ${preview}` : "NO PREVIEW"}</span>
        </span>
      </div>
      <div style={{ ...fill, padding: "26px 18px 30px" }}>
        {live ? (
          <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
            <span style={{ color: C.dim, fontSize: 16, letterSpacing: "0.18em", textTransform: "uppercase" }}>Camera</span>
            <span style={{ fontFamily: mono, fontWeight: 800, fontSize: 96, lineHeight: 0.9, color: "#fff", textShadow: `0 0 26px ${C.live}` }}>{program}</span>
            {extraLive > 0 && <span style={{ color: C.live, fontSize: 15 }}>+{extraLive} more live</span>}
          </div>
        ) : (
          <span style={{ color: C.dim, fontSize: 22, letterSpacing: "0.1em" }}>Nothing live</span>
        )}
      </div>
    </div>
  );
}

function Pad({ title, hint, accent, nums, activeSet, onlineNums, onSelect, disabled }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 16, padding: 16 }}>
      <div style={{ ...rowBetween, marginBottom: 12 }}>
        <div style={{ ...row, gap: 10 }}>
          <span style={{ width: 11, height: 11, borderRadius: "50%", background: accent, boxShadow: `0 0 10px ${accent}` }} />
          <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: "0.04em" }}>{title}</span>
        </div>
        <span style={{ fontSize: 12, color: C.faint }}>{hint}</span>
      </div>
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fill, minmax(64px, 1fr))" }}>
        {nums.map((n) => {
          const on = activeSet.has(n);
          const online = onlineNums.includes(n);
          return (
            <button key={n} onClick={() => !disabled && onSelect(n)} disabled={disabled}
              style={{ position: "relative", aspectRatio: "1 / 1", borderRadius: 11, border: `1.5px solid ${on ? accent : C.line}`, background: on ? accent : C.panelHi, color: on ? "#0a0a0a" : online ? C.text : C.faint, fontFamily: mono, fontWeight: 800, fontSize: 26, cursor: disabled ? "default" : "pointer", transition: "all .12s", boxShadow: on ? `0 0 18px ${accent}88` : "none" }}>
              {n}
              {online && <span style={{ position: "absolute", top: 7, right: 7, width: 7, height: 7, borderRadius: "50%", background: on ? "#0a0a0a" : C.live, boxShadow: on ? "none" : `0 0 6px ${C.live}` }} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---- Camera ------------------------------------------------------- */
function Camera({ room, onExit }) {
  const [num, setNum] = useState(null);
  const numRef = useRef(null);
  const [st, setSt] = useState({});
  const [editing, setEditing] = useState(false);
  const wakeRef = useRef(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      let taken = new Set();
      try {
        const snap = await get(camsRef(room));
        taken = new Set(Object.keys(snap.val() || {}).map(Number));
      } catch {}
      let n = 1;
      while (taken.has(n)) n++;
      if (!alive) return;
      numRef.current = n; setNum(n);
      const r = camRef(room, n);
      set(r, { joined: Date.now() });
      onDisconnect(r).remove();
    })();
    return () => { alive = false; };
  }, [room]);

  useEffect(() => {
    const off = onValue(stateRef(room), (snap) => setSt(snap.val() || {}));
    return off;
  }, [room]);

  useEffect(() => {
    const requestWake = async () => { try { wakeRef.current = await navigator.wakeLock.request("screen"); } catch {} };
    requestWake();
    const onVis = () => document.visibilityState === "visible" && requestWake();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      try { wakeRef.current?.release(); } catch {}
      if (numRef.current != null) remove(camRef(room, numRef.current));
    };
  }, [room]);

  const digit = typeof st.tally === "string" ? st.tally[num - 1] : null;
  const mode = digit
    ? (digit === "1" ? "live" : digit === "2" ? "preview" : "off")
    : (num != null && st.program === num ? "live"
      : num != null && st.preview === num ? "preview"
      : "off");

  const view = {
    live: { label: "ON AIR", sub: "You are live", glow: C.live },
    preview: { label: "STAND BY", sub: "You're up next", glow: C.preview },
    off: { label: "STANDBY", sub: "Not selected", glow: "transparent" },
  }[mode];

  const changeNum = (n) => {
    if (n < 1) return;
    const prev = numRef.current;
    numRef.current = n; setNum(n);
    if (prev != null && prev !== n) remove(camRef(room, prev));
    const r = camRef(room, n);
    set(r, { joined: Date.now() });
    onDisconnect(r).remove();
    setEditing(false);
  };

  const goFullscreen = () => {
    try {
      if (document.fullscreenElement) document.exitFullscreen?.();
      else document.documentElement.requestFullscreen?.();
    } catch {}
  };

  const bg = mode === "off" ? `radial-gradient(130% 130% at 50% 40%, ${C.off} 0%, ${C.offDeep} 60%, #1a0606 100%)`
    : mode === "preview" ? `radial-gradient(130% 130% at 50% 40%, ${C.preview} 0%, ${C.previewDeep} 65%, #1a0f00 100%)`
    : `radial-gradient(130% 130% at 50% 40%, ${C.live} 0%, ${C.liveDeep} 60%, #04140a 100%)`;

  return (
    <div style={{ ...colCenter, justifyContent: "center", minHeight: "100vh", background: bg, transition: "background .18s", position: "relative", padding: 24 }}>
      <div style={{ ...rowBetween, position: "absolute", top: 16, left: 18, right: 18 }}>
        <span style={{ fontFamily: mono, letterSpacing: "0.2em", fontSize: 12, color: "rgba(0,0,0,0.55)" }}>ROOM {room}</span>
        <div style={{ display: "flex", gap: 8 }}>
          <ChromeBtn onClick={goFullscreen}>Fullscreen</ChromeBtn>
          <ChromeBtn onClick={onExit}>Leave</ChromeBtn>
        </div>
      </div>
      <div style={colCenter}>
        <span style={{ fontSize: 15, letterSpacing: "0.3em", color: "rgba(0,0,0,0.6)", textTransform: "uppercase", marginBottom: 4 }}>Camera</span>
        <span style={{ fontFamily: mono, fontWeight: 800, fontSize: "clamp(120px, 34vw, 300px)", lineHeight: 0.85, color: "#fff", textShadow: mode === "off" ? "0 4px 30px rgba(0,0,0,0.4)" : `0 0 50px ${view.glow}` }}>{num ?? "—"}</span>
        <span style={{ marginTop: 18, fontWeight: 800, fontSize: "clamp(34px, 9vw, 72px)", letterSpacing: "0.08em", color: "#fff", textShadow: "0 2px 18px rgba(0,0,0,0.35)" }}>{view.label}</span>
        <span style={{ marginTop: 6, fontSize: 16, color: "rgba(0,0,0,0.6)", letterSpacing: "0.05em" }}>{view.sub}</span>
      </div>
      <div style={{ position: "absolute", bottom: 22 }}>
        {editing ? (
          <div style={{ ...row, gap: 8 }}>
            <ChromeBtn onClick={() => changeNum((numRef.current || 1) - 1)}>–</ChromeBtn>
            <span style={{ fontFamily: mono, fontWeight: 800, fontSize: 22, color: "#fff", minWidth: 36, textAlign: "center" }}>{num}</span>
            <ChromeBtn onClick={() => changeNum((numRef.current || 0) + 1)}>+</ChromeBtn>
            <ChromeBtn onClick={() => setEditing(false)}>Done</ChromeBtn>
          </div>
        ) : (
          <ChromeBtn onClick={() => setEditing(true)}>Change camera number</ChromeBtn>
        )}
      </div>
    </div>
  );
}

function ChromeBtn({ children, onClick }) {
  return (
    <button onClick={onClick} style={{ background: "rgba(0,0,0,0.28)", border: "1px solid rgba(255,255,255,0.18)", color: "#fff", borderRadius: 9, padding: "8px 13px", fontSize: 13, fontWeight: 600, cursor: "pointer", backdropFilter: "blur(2px)" }}>
      {children}
    </button>
  );
}

function TopBar({ room, label, onExit, extra }) {
  return (
    <div style={rowBetween}>
      <div style={{ ...row, gap: 12 }}>
        <span style={{ fontWeight: 800, fontSize: 18, letterSpacing: "-0.01em" }}>{label}</span>
        <span style={{ fontFamily: mono, fontSize: 12.5, color: C.faint, letterSpacing: "0.14em", border: `1px solid ${C.line}`, borderRadius: 7, padding: "3px 8px" }}>{room}</span>
        {extra && <span style={{ fontSize: 12.5, color: C.dim }}>{extra}</span>}
      </div>
      <button onClick={onExit} style={{ background: "none", border: `1px solid ${C.line}`, color: C.dim, borderRadius: 9, padding: "7px 12px", fontSize: 13, cursor: "pointer" }}>Exit</button>
    </div>
  );
}

function Dot({ color, pulse }) {
  return (
    <span style={{ position: "relative", width: 9, height: 9 }}>
      <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: color, boxShadow: `0 0 10px ${color}` }} />
      {pulse && <span style={{ position: "absolute", inset: -4, borderRadius: "50%", border: `1.5px solid ${color}`, opacity: 0.4 }} />}
    </span>
  );
}
