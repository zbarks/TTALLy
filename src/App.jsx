import {
  useState, useEffect, useRef, useCallback, createContext, useContext,
} from "react";
import { initializeApp } from "firebase/app";
import {
  getDatabase, ref, set, get, remove, onValue, onDisconnect,
} from "firebase/database";

/* ================================================================== *
 *  TACHARTAS TALLY — Firebase + vMix edition
 *
 *  vMix DRIVES the real tally (run vmix-tally-bridge.js on the vMix PC).
 *  The producer suite does NOT control vMix. It keeps its own additive
 *  "overlay" of extra live / preview flags and messaging, stored apart
 *  from vMix's state so the bridge never overwrites it. Everyone sees
 *  the UNION of vMix's tally and the overlay.
 *
 *  Roles: Producer · Camera (operator | booth commentary | pitch
 *  commentary). Commentary screens auto-go-live from the tally when
 *  their vMix input is cut to air, with producer message overlays on
 *  top (replay / wrap / transfer / standby).
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

/* ---- Firebase refs ----------------------------------------------- */
const stateRef = (room) => ref(db, `rooms/${room}/state`);
const overlaySideRef = (room, side) => ref(db, `rooms/${room}/overlay/${side}`);
const overlayCellRef = (room, side, n) => ref(db, `rooms/${room}/overlay/${side}/${n}`);
const overlayRootRef = (room) => ref(db, `rooms/${room}/overlay`);
const camsRef = (room) => ref(db, `rooms/${room}/cameras`);
const camRef = (room, n) => ref(db, `rooms/${room}/cameras/${n}`);
const namesRef = (room) => ref(db, `rooms/${room}/names`);
const nameRef = (room, n) => ref(db, `rooms/${room}/names/${n}`);
const pingsRef = (room) => ref(db, `rooms/${room}/pings`);
const pingRef = (room, n) => ref(db, `rooms/${room}/pings/${n}`);
const msgsRef = (room) => ref(db, `rooms/${room}/msgs`);
const msgRef = (room, t) => ref(db, `rooms/${room}/msgs/${t}`);
const inboxRef = (room) => ref(db, `rooms/${room}/inbox`);
const inboxOneRef = (room, k) => ref(db, `rooms/${room}/inbox/${k}`);

/* Commentators keyed by kind ("booth"|"pitch") then a slot id. Each
   stores the vMix input ("cam") that is pointed at them, so the portal
   can follow that input's tally automatically. */
const commRootRef = (room) => ref(db, `rooms/${room}/comm`);
const commGroupRef = (room, k) => ref(db, `rooms/${room}/comm/${k}`);
const commOneRef = (room, k, s) => ref(db, `rooms/${room}/comm/${k}/${s}`);
const commNamesRootRef = (room) => ref(db, `rooms/${room}/commNames`);
const commNameRef = (room, k, s) => ref(db, `rooms/${room}/commNames/${k}/${s}`);
const commReadyRootRef = (room) => ref(db, `rooms/${room}/commReady`);
const commReadyRef = (room, k, s) => ref(db, `rooms/${room}/commReady/${k}/${s}`);
const cueRootRef = (room) => ref(db, `rooms/${room}/cue`);
const cueOneRef = (room, k, s) => ref(db, `rooms/${room}/cue/${k}/${s}`);
const sessionEpochRef = (room) => ref(db, `rooms/${room}/session/epoch`);

/* ---- Per-device sticky sessions ---------------------------------- *
 * A device remembers what it was (camera N, booth, pitch) in this room
 * and reclaims the SAME slot when it comes back — instead of grabbing
 * the next free number. The producer's "Reset day" bumps the room epoch,
 * which invalidates every saved session at once. */
const SESS_KEY = (room) => `tally-sess-${room}`;
function loadSession(room) {
  try { return JSON.parse(localStorage.getItem(SESS_KEY(room)) || "null"); } catch { return null; }
}
function saveSession(room, s) {
  try { localStorage.setItem(SESS_KEY(room), JSON.stringify(s)); } catch {}
}
function clearSession(room) {
  try { localStorage.removeItem(SESS_KEY(room)); } catch {}
}

/* ---- Theme -------------------------------------------------------- */
const ACCENT = {
  off: "#d11a1a", offDeep: "#7a0f0f",
  preview: "#ff8a00", previewDeep: "#8f4d00",
  live: "#16c43a", liveDeep: "#0a7320",
  ping: "#3b7bff",
};

const THEMES = {
  dark: {
    name: "dark",
    bg: "#0a0b0d", panel: "#15171b", panelHi: "#1d2025", line: "#2a2e35",
    text: "#e8eaed", dim: "#8a9099", faint: "#565c66",
    logo: "/logo.png", onAccent: "#0a0a0a",
    ...ACCENT,
  },
  light: {
    name: "light",
    bg: "#eef0f3", panel: "#ffffff", panelHi: "#f4f6f8", line: "#d6dae0",
    text: "#13151a", dim: "#566069", faint: "#9aa3ad",
    logo: "/logo-dark.png", onAccent: "#0a0a0a",
    ...ACCENT,
  },
};

const ThemeCtx = createContext(THEMES.dark);
const useC = () => useContext(ThemeCtx);

const mono = "ui-monospace, 'SF Mono', Menlo, monospace";
const row = { display: "flex", alignItems: "center" };
const rowBetween = { display: "flex", alignItems: "center", justifyContent: "space-between" };
const colCenter = { display: "flex", flexDirection: "column", alignItems: "center" };
const fill = { display: "flex", alignItems: "center", justifyContent: "center" };

const COMMENTARY_PURPLE = "#8a5cf6";
const COMM_LABEL = { booth: "Booth", pitch: "Pitch" };

function parseTally(s) {
  const live = [], pvw = [];
  if (typeof s === "string")
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "1") live.push(i + 1);
      if (s[i] === "2") pvw.push(i + 1);
    }
  return { live, pvw };
}

/* Effective live / preview = vMix tally UNION the producer's overlay. */
function derive(st, overlay) {
  const vmix = st.src === "vmix" || typeof st.tally === "string";
  const { live: tL, pvw: tP } = parseTally(st.tally);
  const live = new Set(tL);
  const pvw = new Set(tP);
  if (overlay) {
    for (const n of Object.keys(overlay.live || {})) live.add(Number(n));
    for (const n of Object.keys(overlay.pvw || {})) pvw.add(Number(n));
  }
  for (const n of [...pvw]) if (live.has(n)) pvw.delete(n);
  return { vmix, live, pvw };
}

const camLabel = (n, names) => {
  const nm = names && names[n];
  return nm ? `Cam ${n} · ${nm}` : `Cam ${n}`;
};

const normKinds = (v) => ({ booth: (v && v.booth) || {}, pitch: (v && v.pitch) || {} });
const sortedKeys = (o) => Object.keys(o || {}).map(Number).sort((a, b) => a - b);

/* ---- Commentator message overlays (producer -> commentator) ------- */
const CUE = {
  booth: {
    replay:   { label: "REPLAY INCOMING",     sub: "Cover it on the replay mic", color: COMMENTARY_PURPLE, flash: "soft" },
    wrap:     { label: "WRAP",                sub: "Wind it down",               color: ACCENT.off,        flash: "hard" },
    transfer: { label: "TRANSFER TO GROUND",  sub: "Hand to the pitch team",     color: ACCENT.preview,    flash: "hard" },
    standby:  { label: "STAND BY",            sub: "Hold — not coming to you",   color: ACCENT.ping,       flash: "soft" },
  },
  pitch: {
    soon:     { label: "COMING TO YOU",       sub: "Get ready — on air soon",    color: ACCENT.preview,    flash: "soft" },
    wrap:     { label: "WRAP UP",             sub: "Wind down & hand back",      color: ACCENT.off,        flash: "hard" },
  },
};
const CUE_SET = { booth: ["replay", "wrap", "transfer", "standby"], pitch: ["soon", "wrap"] };

/* Auto status, derived from the tally for a commentator's vMix input. */
const STATUS = {
  live: { label: "YOU'RE ON",  sub: "Mic live — start speaking", color: ACCENT.live },
  pvw:  { label: "STAND BY",   sub: "You're next — get ready",   color: ACCENT.preview },
  off:  { label: "STAND BY",   sub: "Not live yet",              color: "#5b6472" },
};

const getInitialTheme = () => {
  try {
    const s = localStorage.getItem("tally-theme");
    if (s === "light" || s === "dark") return s;
  } catch {}
  try {
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches)
      return "light";
  } catch {}
  return "dark";
};

/* ================================================================== */
export default function App() {
  const [screen, setScreen] = useState("landing");
  const [room, setRoom] = useState("MAIN");
  const [resumeMode, setResumeMode] = useState(null);
  const [themeName, setThemeName] = useState(getInitialTheme);
  const C = THEMES[themeName] || THEMES.dark;

  useEffect(() => {
    try { localStorage.setItem("tally-theme", themeName); } catch {}
    document.body.style.background = C.bg;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", C.bg);
  }, [themeName, C.bg]);

  const toggleTheme = () => setThemeName((t) => (t === "dark" ? "light" : "dark"));

  const pick = (s) => { if (s === "camera") setResumeMode(null); setScreen(s); };
  const handleResume = (sess) => {
    if (!sess) return;
    if (sess.role === "producer") setScreen("producer");
    else { setResumeMode(sess.role); setScreen("camera"); }
  };

  const shell = {
    minHeight: "100vh", background: C.bg, color: C.text,
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
    transition: "background .2s, color .2s",
  };

  return (
    <ThemeCtx.Provider value={C}>
      <div style={shell}>
        {screen === "landing" && (
          <Landing room={room} setRoom={setRoom} onPick={pick} onResume={handleResume}
            theme={themeName} toggleTheme={toggleTheme} />
        )}
        {screen === "producer" && (
          <Producer room={room} onExit={() => setScreen("landing")}
            theme={themeName} toggleTheme={toggleTheme} />
        )}
        {screen === "camera" && (
          <CameraEntry room={room} initialMode={resumeMode} onExit={() => setScreen("landing")} />
        )}
      </div>
    </ThemeCtx.Provider>
  );
}

/* ---- Shared bits -------------------------------------------------- */
function Logo({ height = 26 }) {
  const C = useC();
  return (
    <img src={C.logo} alt="Tachartas Sports Streaming"
      style={{ height, width: "auto", display: "block" }} />
  );
}

function ThemeToggle({ theme, onToggle }) {
  const C = useC();
  return (
    <button onClick={onToggle} title="Toggle light / dark mode"
      style={{ background: C.panel, border: `1px solid ${C.line}`, color: C.dim, borderRadius: 9, padding: "7px 11px", fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 7 }}>
      <span style={{ fontSize: 14, lineHeight: 1 }}>{theme === "dark" ? "☀" : "☾"}</span>
      <span style={{ fontWeight: 600 }}>{theme === "dark" ? "Light" : "Dark"}</span>
    </button>
  );
}

function ChromeBtn({ children, onClick }) {
  return (
    <button onClick={onClick} style={{ background: "rgba(0,0,0,0.28)", border: "1px solid rgba(255,255,255,0.2)", color: "#fff", borderRadius: 9, padding: "9px 14px", fontSize: 13.5, fontWeight: 600, cursor: "pointer", backdropFilter: "blur(2px)" }}>
      {children}
    </button>
  );
}

function TopBar({ room, label, onExit, extra }) {
  const C = useC();
  return (
    <div style={rowBetween}>
      <div style={{ ...row, gap: 12 }}>
        <span style={{ fontWeight: 800, fontSize: 18, letterSpacing: "-0.01em", color: C.text }}>{label}</span>
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

/* ---- Landing ------------------------------------------------------ */
function Landing({ room, setRoom, onPick, onResume, theme, toggleTheme }) {
  const C = useC();
  const saved = loadSession(room);
  const resumeLabel = saved && (
    saved.role === "op" ? `Resume as Camera ${saved.num}${saved.name ? " · " + saved.name : ""}`
      : saved.role === "booth" ? "Resume as Booth commentary"
      : saved.role === "pitch" ? "Resume as Pitch commentary"
      : saved.role === "producer" ? "Resume as Producer" : null);
  return (
    <div style={{ ...colCenter, justifyContent: "center", minHeight: "100vh", padding: "0 24px" }}>
      <div style={{ width: "100%", maxWidth: 460 }}>
        <div style={{ ...rowBetween, marginBottom: 22 }}>
          <Logo height={30} />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
        <div style={{ ...row, gap: 10, marginBottom: 4 }}>
          <Dot color={C.live} pulse />
          <span style={{ fontFamily: mono, letterSpacing: "0.4em", fontSize: 12, color: C.dim }}>TALLY CONTROL</span>
        </div>
        <h1 style={{ fontSize: 42, lineHeight: 1.04, fontWeight: 800, letterSpacing: "-0.02em", margin: "8px 0 6px", color: C.text }}>
          Studio tally control
        </h1>
        <p style={{ color: C.dim, fontSize: 15, lineHeight: 1.5, marginBottom: 26 }}>
          One screen runs the show, every camera gets a light. vMix drives the
          tally — the producer suite rides alongside it.
        </p>
        <label style={{ display: "block", fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", color: C.faint, marginBottom: 8 }}>Room</label>
        <input
          value={room}
          onChange={(e) => setRoom(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12))}
          onBlur={() => !room && setRoom("MAIN")}
          placeholder="MAIN"
          style={{ width: "100%", background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, color: C.text, fontSize: 18, fontFamily: mono, letterSpacing: "0.18em", padding: "14px 16px", outline: "none", marginBottom: 18, boxSizing: "border-box" }}
        />
        {resumeLabel && (
          <button onClick={() => onResume(saved)}
            style={{ width: "100%", boxSizing: "border-box", textAlign: "left", background: C.panelHi, border: `1px solid ${C.live}`, borderRadius: 14, padding: "15px 18px", cursor: "pointer", display: "flex", alignItems: "center", gap: 14, marginBottom: 18, boxShadow: `0 0 16px ${C.live}22` }}>
            <span style={{ fontSize: 18 }}>↻</span>
            <span style={{ flex: 1 }}>
              <span style={{ display: "block", fontSize: 16, fontWeight: 800, color: C.text }}>{resumeLabel}</span>
              <span style={{ display: "block", fontSize: 12.5, color: C.dim, marginTop: 2 }}>Pick up where you left off</span>
            </span>
            <span style={{ color: C.live, fontSize: 22 }}>→</span>
          </button>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12 }}>
          <RolePick title="I'm the producer" sub="Dashboard / vMix monitor" accent={C.live} onClick={() => onPick("producer")} />
          <RolePick title="I'm a camera" sub="Tally light, or a commentary screen" accent={C.preview} onClick={() => onPick("camera")} />
        </div>
        <p style={{ color: C.faint, fontSize: 12.5, lineHeight: 1.6, marginTop: 24 }}>Send everyone the deployed URL. Same room = same show.</p>
      </div>
    </div>
  );
}

function RolePick({ title, sub, accent, onClick }) {
  const C = useC();
  const [hover, setHover] = useState(false);
  return (
    <button onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ textAlign: "left", background: hover ? C.panelHi : C.panel, border: `1px solid ${hover ? accent : C.line}`, borderRadius: 14, padding: "18px 20px", cursor: "pointer", transition: "background .15s, border-color .15s", display: "flex", alignItems: "center", gap: 16 }}>
      <span style={{ width: 12, height: 12, borderRadius: "50%", background: accent, boxShadow: `0 0 14px ${accent}`, flexShrink: 0 }} />
      <span style={{ flex: 1 }}>
        <span style={{ display: "block", fontSize: 18, fontWeight: 700, color: C.text }}>{title}</span>
        <span style={{ display: "block", fontSize: 13.5, color: C.dim, marginTop: 2 }}>{sub}</span>
      </span>
      <span style={{ color: C.faint, fontSize: 22 }}>→</span>
    </button>
  );
}

/* ================================================================== *
 *  PRODUCER
 * ================================================================== */
function Producer({ room, onExit, theme, toggleTheme }) {
  const C = useC();
  const [st, setSt] = useState({});
  const [overlay, setOverlay] = useState({});
  const [cams, setCams] = useState({});
  const [names, setNames] = useState({});
  const [pings, setPings] = useState({});
  const [msgs, setMsgs] = useState({});
  const [inbox, setInbox] = useState({});
  const [comm, setComm] = useState({ booth: {}, pitch: {} });
  const [commNames, setCommNames] = useState({ booth: {}, pitch: {} });
  const [commReady, setCommReady] = useState({ booth: {}, pitch: {} });
  const [cues, setCues] = useState({ booth: {}, pitch: {} });
  const [flash, setFlash] = useState(null);

  const overlayRef2 = useRef({});
  const seenPings = useRef({});
  const pingInit = useRef(false);
  const seenReady = useRef({});
  const readyInit = useRef(false);

  useEffect(() => {
    const offState = onValue(stateRef(room), (snap) => setSt(snap.val() || {}));
    const offOv = onValue(overlayRootRef(room), (snap) => { const v = snap.val() || {}; overlayRef2.current = v; setOverlay(v); });
    const offCams = onValue(camsRef(room), (snap) => setCams(snap.val() || {}));
    const offNames = onValue(namesRef(room), (snap) => setNames(snap.val() || {}));
    const offPings = onValue(pingsRef(room), (snap) => setPings(snap.val() || {}));
    const offMsgs = onValue(msgsRef(room), (snap) => setMsgs(snap.val() || {}));
    const offInbox = onValue(inboxRef(room), (snap) => setInbox(snap.val() || {}));
    const offComm = onValue(commRootRef(room), (snap) => setComm(normKinds(snap.val())));
    const offCN = onValue(commNamesRootRef(room), (snap) => setCommNames(normKinds(snap.val())));
    const offCR = onValue(commReadyRootRef(room), (snap) => setCommReady(normKinds(snap.val())));
    const offCue = onValue(cueRootRef(room), (snap) => setCues(normKinds(snap.val())));
    return () => { offState(); offOv(); offCams(); offNames(); offPings(); offMsgs(); offInbox(); offComm(); offCN(); offCR(); offCue(); };
  }, [room]);

  // Brief screen flash on any genuinely new ping (persistent banners do the rest).
  useEffect(() => {
    if (!pingInit.current) {
      for (const [n, p] of Object.entries(pings)) if (p && p.at) seenPings.current[n] = p.at;
      pingInit.current = true;
      return;
    }
    let fired = null;
    for (const [n, p] of Object.entries(pings)) {
      if (!p || !p.at) continue;
      if (p.at > (seenPings.current[n] || 0)) { seenPings.current[n] = p.at; fired = p; }
    }
    if (fired) {
      setFlash({ color: C.live, hard: false });
      const t = setTimeout(() => setFlash(null), 1100);
      return () => clearTimeout(t);
    }
  }, [pings, C.live]);

  useEffect(() => {
    const flat = {};
    for (const k of ["booth", "pitch"])
      for (const [s, r] of Object.entries(commReady[k] || {}))
        if (r && r.at) flat[`${k}:${s}`] = r.at;
    if (!readyInit.current) { seenReady.current = flat; readyInit.current = true; return; }
    let fired = false;
    for (const [key, at] of Object.entries(flat))
      if (at > (seenReady.current[key] || 0)) { seenReady.current[key] = at; fired = true; }
    if (fired) {
      setFlash({ color: C.live, hard: false });
      const t = setTimeout(() => setFlash(null), 1100);
      return () => clearTimeout(t);
    }
  }, [commReady, C.live]);

  const { vmix, live, pvw } = derive(st, overlay);

  /* --- overlay editing (never touches vMix) --- */
  const toggleLive = useCallback((n) => {
    const has = (overlayRef2.current.live || {})[n];
    if (has) remove(overlayCellRef(room, "live", n));
    else { set(overlayCellRef(room, "live", n), true); remove(overlayCellRef(room, "pvw", n)); }
  }, [room]);
  const togglePvw = useCallback((n) => {
    const has = (overlayRef2.current.pvw || {})[n];
    if (has) remove(overlayCellRef(room, "pvw", n));
    else set(overlayCellRef(room, "pvw", n), true);
  }, [room]);
  const take = useCallback(() => {
    const pv = Object.keys(overlayRef2.current.pvw || {});
    if (!pv.length) return;
    remove(overlaySideRef(room, "live"));
    pv.forEach((n) => set(overlayCellRef(room, "live", n), true));
    remove(overlaySideRef(room, "pvw"));
  }, [room]);
  const clearLive = useCallback(() => remove(overlaySideRef(room, "live")), [room]);

  const boothSlots = sortedKeys(comm.booth);
  const pitchSlots = sortedKeys(comm.pitch);
  const sendCue = useCallback((kind, slot, type) => {
    if (slot == null) return;
    set(cueOneRef(room, kind, slot), { type, at: Date.now() });
  }, [room]);
  const clearCue = useCallback((kind, slot) => { if (slot != null) remove(cueOneRef(room, kind, slot)); }, [room]);

  /* --- keyboard shortcuts (Stream Deck friendly) --- */
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      const d = e.code && e.code.startsWith("Digit") ? parseInt(e.code.slice(5), 10) : null;
      if (d != null && d >= 1 && d <= 9) {
        e.preventDefault();
        if (e.shiftKey) togglePvw(d); else toggleLive(d);
        return;
      }
      if (e.code === "Space") { e.preventDefault(); take(); return; }
      if (e.key === "Escape" || e.code === "Digit0") { clearLive(); return; }
      const k = e.key.toLowerCase();
      const b = boothSlots[0], p = pitchSlots[0];
      if (k === "z") sendCue("booth", b, "replay");
      else if (k === "x") sendCue("booth", b, "wrap");
      else if (k === "c") sendCue("booth", b, "transfer");
      else if (k === "v") sendCue("booth", b, "standby");
      else if (k === "b") clearCue("booth", b);
      else if (k === "n") sendCue("pitch", p, "soon");
      else if (k === "m") sendCue("pitch", p, "wrap");
      else if (k === ",") clearCue("pitch", p);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleLive, togglePvw, take, clearLive, sendCue, clearCue, boothSlots, pitchSlots]);

  const saveName = (n, value) => {
    const v = (value || "").trim().slice(0, 18);
    if (v) set(nameRef(room, n), v); else remove(nameRef(room, n));
  };
  const clearPing = (n) => remove(pingRef(room, n));
  const clearReady = (kind, slot) => remove(commReadyRef(room, kind, slot));
  const clearInbox = (k) => remove(inboxOneRef(room, k));
  const sendMsg = (target, text) => {
    const t = (text || "").trim().slice(0, 240);
    if (!t) return;
    set(msgRef(room, target), { text: t, at: Date.now() });
  };
  const clearMsg = (target) => remove(msgRef(room, target));

  useEffect(() => { saveSession(room, { role: "producer", epoch: 0 }); }, [room]);

  const resetDay = () => {
    const ok = typeof window === "undefined" || window.confirm(
      "Reset the whole room for everyone?\n\nThis clears all cameras, names, messages, live/preview flags and commentator setups. Connected devices re-join with fresh numbers. Use this at the end of the day."
    );
    if (!ok) return;
    set(sessionEpochRef(room), Date.now());
    remove(camsRef(room)); remove(namesRef(room)); remove(pingsRef(room));
    remove(msgsRef(room)); remove(inboxRef(room)); remove(overlayRootRef(room));
    remove(commRootRef(room)); remove(commNamesRootRef(room));
    remove(commReadyRootRef(room)); remove(cueRootRef(room));
    clearSession(room);
  };

  const onlineNums = Object.keys(cams).map(Number);
  const namedNums = Object.keys(names).map(Number);
  const commCams = [...boothSlots.map((s) => comm.booth[s]?.cam), ...pitchSlots.map((s) => comm.pitch[s]?.cam)].filter(Boolean).map(Number);
  const highest = Math.max(8, ...live, ...pvw, ...onlineNums, ...namedNums, ...commCams, 0);
  const pad = Array.from({ length: highest }, (_, i) => i + 1);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh", maxWidth: 1120, margin: "0 auto", padding: "14px 16px 40px", position: "relative" }}>
      <FlashOverlay flash={flash} />

      <div style={{ ...rowBetween, marginBottom: 10 }}>
        <Logo height={22} />
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={resetDay} title="End of day — reset everyone"
            style={{ background: C.panel, border: `1px solid ${C.line}`, color: C.dim, borderRadius: 9, padding: "7px 11px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            ↻ Reset day
          </button>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </div>
      <TopBar room={room} label="Producer" onExit={onExit}
        extra={`${onlineNums.length} cam · ${boothSlots.length + pitchSlots.length} comm${vmix ? " · vMix live" : ""}`} />

      <Notifications
        pings={pings} names={names} inbox={inbox}
        commReady={commReady} commNames={commNames}
        onClearPing={clearPing} onClearInbox={clearInbox} onClearReady={clearReady} />

      {/* Compact dashboard band — everything visible at a glance */}
      <Dashboard live={live} pvw={pvw} names={names} vmix={vmix}
        comm={comm} commNames={commNames} cues={cues}
        boothSlots={boothSlots} pitchSlots={pitchSlots}
        st={st} overlay={overlay} msgs={msgs} />

      <div style={{ ...row, gap: 10, marginTop: 12 }}>
        <button onClick={take} disabled={pvw.size === 0}
          style={{ flex: 1, padding: "12px 14px", borderRadius: 12, border: "none", cursor: pvw.size === 0 ? "not-allowed" : "pointer", background: pvw.size === 0 ? C.panel : C.live, color: pvw.size === 0 ? C.faint : "#04140a", fontWeight: 800, fontSize: 15, letterSpacing: "0.1em" }}>
          TAKE {pvw.size ? `→ ${[...pvw].join(", ")} LIVE` : "(arm a preview)"} · space
        </button>
        <button onClick={clearLive}
          style={{ padding: "12px 16px", borderRadius: 12, border: `1px solid ${C.line}`, cursor: "pointer", background: C.panel, color: C.dim, fontWeight: 700, fontSize: 13.5 }}>
          Clear live · 0
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14, marginTop: 14 }}>
        <Pad title="Live" hint={vmix ? "vMix + your flags · click to add" : "Cut to air"} accent={C.live} nums={pad} activeSet={live} fromVmix={vmix ? new Set(parseTally(st.tally).live) : new Set()} onlineNums={onlineNums} names={names} pings={pings} onSelect={toggleLive} />
        <Pad title="Preview" hint={vmix ? "vMix + your flags · click to add" : "Arm the next shot"} accent={C.preview} nums={pad} activeSet={pvw} fromVmix={vmix ? new Set(parseTally(st.tally).pvw) : new Set()} onlineNums={onlineNums} names={names} pings={pings} onSelect={togglePvw} />
      </div>

      <CommentatorPanel comm={comm} commNames={commNames} commReady={commReady}
        cues={cues} live={live} pvw={pvw}
        onCue={sendCue} onClearCue={clearCue} onClearReady={clearReady} />

      <MessagePanel msgs={msgs} names={names} pad={pad} onSend={sendMsg} onClear={clearMsg} />

      <Roster nums={pad} onlineNums={onlineNums} names={names} pings={pings}
        liveSet={live} pvwSet={pvw} comm={comm} commNames={commNames}
        onName={saveName} onClearPing={clearPing} />

      <ShortcutsLegend />
    </div>
  );
}

function FlashOverlay({ flash }) {
  const C = useC();
  if (!flash) return null;
  const color = flash.color || C.live;
  const hard = flash.hard;
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 60, pointerEvents: "none",
      background: `radial-gradient(120% 120% at 50% 50%, ${color}55 0%, ${color}1c 55%, transparent 80%)`,
      animation: hard ? "tallyStrobe .42s steps(1) 3" : "tallyFlash 1s ease-out",
    }} />
  );
}

/* ---- Producer: persistent notifications (top, until dismissed) ---- */
function Notifications({ pings, names, inbox, commReady, commNames, onClearPing, onClearInbox, onClearReady }) {
  const C = useC();
  const items = [];
  for (const [s, r] of Object.entries(commReady.pitch || {}))
    if (r && r.at) items.push({ key: `pr-${s}`, at: r.at, color: C.live, strong: true, text: `${commNames.pitch?.[s] ? commNames.pitch[s] : "Pitch " + s} (pitch) is ready`, onClear: () => onClearReady("pitch", s) });
  for (const [s, r] of Object.entries(commReady.booth || {}))
    if (r && r.at) items.push({ key: `br-${s}`, at: r.at, color: C.live, strong: true, text: `${commNames.booth?.[s] ? commNames.booth[s] : "Booth " + s} (booth) is ready`, onClear: () => onClearReady("booth", s) });
  for (const [n, p] of Object.entries(pings || {})) {
    if (!p || !p.at) continue;
    const good = p.type === "shot";
    items.push({ key: `pg-${n}`, at: p.at, color: good ? C.preview : C.live, text: `${camLabel(Number(n), names)} — ${good ? "good shot ready" : "ready to go"}`, onClear: () => onClearPing(n) });
  }
  for (const [k, m] of Object.entries(inbox || {})) {
    if (!m || !m.text) continue;
    items.push({ key: `ib-${k}`, at: m.at || 0, color: C.ping, msg: true, text: `${m.label || k}: ${m.text}`, onClear: () => onClearInbox(k) });
  }
  items.sort((a, b) => b.at - a.at);
  if (!items.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 12 }}>
      {items.map((it) => (
        <div key={it.key} style={{ ...rowBetween, gap: 10, background: C.panel, border: `1px solid ${it.color}`, borderRadius: 11, padding: "9px 13px", boxShadow: `0 0 16px ${it.color}22` }}>
          <div style={{ ...row, gap: 10, minWidth: 0 }}>
            <span style={{ width: 9, height: 9, borderRadius: "50%", flexShrink: 0, background: it.color, boxShadow: `0 0 10px ${it.color}` }} />
            <span style={{ fontSize: 14, color: C.text, fontWeight: it.strong ? 700 : 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: it.msg ? "normal" : "nowrap" }}>{it.text}</span>
          </div>
          <button onClick={it.onClear}
            style={{ flexShrink: 0, background: "none", border: `1px solid ${C.line}`, color: C.dim, borderRadius: 8, padding: "5px 11px", fontSize: 12.5, cursor: "pointer" }}>
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}

/* ---- Producer: compact dashboard band ---------------------------- */
function Dashboard({ live, pvw, names, vmix, comm, commNames, cues, boothSlots, pitchSlots, st, overlay, msgs }) {
  const C = useC();
  const liveArr = [...live].sort((a, b) => a - b);
  const pvwArr = [...pvw].sort((a, b) => a - b);
  const ovLive = new Set(Object.keys(overlay.live || {}).map(Number));
  const ovPvw = new Set(Object.keys(overlay.pvw || {}).map(Number));

  const chip = (n, accent, fromOverlay) => (
    <span key={n} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: `${accent}22`, border: `1px solid ${accent}`, color: C.text, borderRadius: 8, padding: "4px 9px", fontSize: 13, fontWeight: 700 }}>
      <span style={{ fontFamily: mono }}>{n}</span>
      {names[n] && <span style={{ fontWeight: 600, color: C.dim }}>{names[n]}</span>}
      {fromOverlay && <span title="your flag (not in vMix)" style={{ fontSize: 9.5, color: accent, fontWeight: 800 }}>●</span>}
    </span>
  );

  const commChips = [];
  for (const kind of ["booth", "pitch"])
    for (const s of (kind === "booth" ? boothSlots : pitchSlots)) {
      const cam = comm[kind][s]?.cam;
      const onAir = cam != null && live.has(Number(cam));
      const next = cam != null && pvw.has(Number(cam));
      const cue = cues[kind][s];
      const cur = cue?.type ? CUE[kind][cue.type] : null;
      const ac = cur ? cur.color : onAir ? C.live : next ? C.preview : "#5b6472";
      commChips.push(
        <span key={`${kind}-${s}`} style={{ display: "inline-flex", alignItems: "center", gap: 7, background: `${ac}1c`, border: `1px solid ${ac}`, borderRadius: 9, padding: "5px 10px", fontSize: 12.5 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: ac, boxShadow: `0 0 8px ${ac}` }} />
          <span style={{ fontWeight: 700, color: C.text }}>{COMM_LABEL[kind]}{commNames[kind][s] ? ` · ${commNames[kind][s]}` : ` ${s}`}</span>
          <span style={{ color: C.dim, fontFamily: mono, fontSize: 11 }}>{cam ? `in${cam}` : "in?"}</span>
          <span style={{ color: ac, fontWeight: 800, letterSpacing: "0.04em" }}>{cur ? cur.label : onAir ? "ON" : next ? "NEXT" : "STBY"}</span>
        </span>
      );
    }

  const activeMsgs = Object.entries(msgs || {}).filter(([, m]) => m && m.text);

  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: "12px 14px", marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ ...row, gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: mono, fontSize: 11, letterSpacing: "0.16em", color: C.live, fontWeight: 800, minWidth: 56 }}>LIVE</span>
        {liveArr.length ? liveArr.map((n) => chip(n, C.live, ovLive.has(n) && !parseTally(st.tally).live.includes(n))) : <span style={{ color: C.faint, fontSize: 13 }}>nothing live</span>}
      </div>
      <div style={{ ...row, gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: mono, fontSize: 11, letterSpacing: "0.16em", color: C.preview, fontWeight: 800, minWidth: 56 }}>PREVIEW</span>
        {pvwArr.length ? pvwArr.map((n) => chip(n, C.preview, ovPvw.has(n) && !parseTally(st.tally).pvw.includes(n))) : <span style={{ color: C.faint, fontSize: 13 }}>nothing armed</span>}
      </div>
      {commChips.length > 0 && (
        <div style={{ ...row, gap: 8, flexWrap: "wrap", paddingTop: 8, borderTop: `1px solid ${C.line}` }}>
          <span style={{ fontFamily: mono, fontSize: 11, letterSpacing: "0.16em", color: COMMENTARY_PURPLE, fontWeight: 800, minWidth: 56 }}>COMM</span>
          {commChips}
        </div>
      )}
      {activeMsgs.length > 0 && (
        <div style={{ ...row, gap: 8, flexWrap: "wrap", paddingTop: 8, borderTop: `1px solid ${C.line}` }}>
          <span style={{ fontFamily: mono, fontSize: 11, letterSpacing: "0.16em", color: C.ping, fontWeight: 800, minWidth: 56 }}>MSG</span>
          {activeMsgs.map(([t, m]) => (
            <span key={t} style={{ fontSize: 12.5, color: C.dim, background: C.panelHi, border: `1px solid ${C.line}`, borderRadius: 8, padding: "4px 9px" }}>
              <b style={{ color: C.ping }}>{t === "all" ? "All" : `Cam ${t}`}:</b> {m.text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Pad({ title, hint, accent, nums, activeSet, fromVmix, onlineNums, names, pings, onSelect }) {
  const C = useC();
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 16, padding: 14 }}>
      <div style={{ ...rowBetween, marginBottom: 10 }}>
        <div style={{ ...row, gap: 10 }}>
          <span style={{ width: 11, height: 11, borderRadius: "50%", background: accent, boxShadow: `0 0 10px ${accent}` }} />
          <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: "0.04em", color: C.text }}>{title}</span>
        </div>
        <span style={{ fontSize: 11.5, color: C.faint }}>{hint}</span>
      </div>
      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fill, minmax(56px, 1fr))" }}>
        {nums.map((n) => {
          const on = activeSet.has(n);
          const viaVmix = fromVmix && fromVmix.has(n);
          const online = onlineNums.includes(n);
          const nm = names && names[n];
          const ping = pings && pings[n];
          return (
            <button key={n} onClick={() => onSelect(n)}
              style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", aspectRatio: "1 / 1", borderRadius: 10, border: `1.5px solid ${on ? accent : C.line}`, background: on ? accent : C.panelHi, color: on ? C.onAccent : online ? C.text : C.faint, cursor: "pointer", transition: "all .1s", boxShadow: on ? `0 0 16px ${accent}88` : "none", overflow: "hidden", padding: 4 }}>
              <span style={{ fontFamily: mono, fontWeight: 800, fontSize: nm ? 19 : 23, lineHeight: 1 }}>{n}</span>
              {nm && <span style={{ fontSize: 9, fontWeight: 600, marginTop: 2, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: on ? 0.85 : 0.95 }}>{nm}</span>}
              {online && <span style={{ position: "absolute", top: 6, left: 6, width: 6, height: 6, borderRadius: "50%", background: on ? C.onAccent : C.live, boxShadow: on ? "none" : `0 0 6px ${C.live}` }} />}
              {on && !viaVmix && <span title="your flag" style={{ position: "absolute", bottom: 5, right: 6, fontSize: 9, fontWeight: 900, color: C.onAccent }}>●</span>}
              {ping && <span style={{ position: "absolute", top: 4, right: 6, fontSize: 11, fontWeight: 800, color: on ? C.onAccent : (ping.type === "ready" ? C.live : C.preview) }}>{ping.type === "ready" ? "✓" : "★"}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---- Producer: commentators -------------------------------------- */
function CommentatorPanel({ comm, commNames, commReady, cues, live, pvw, onCue, onClearCue, onClearReady }) {
  const C = useC();
  const groups = [
    { key: "booth", title: "Booth", hint: "message overlays only — no comms" },
    { key: "pitch", title: "Pitch / ground", hint: "they tap ready; cue them on & off" },
  ];
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 16, padding: 16, marginTop: 14 }}>
      <div style={{ ...row, gap: 10, marginBottom: 12 }}>
        <span style={{ width: 11, height: 11, borderRadius: "50%", background: COMMENTARY_PURPLE, boxShadow: `0 0 10px ${COMMENTARY_PURPLE}` }} />
        <span style={{ fontWeight: 700, fontSize: 15, color: C.text }}>Commentators</span>
        <span style={{ fontSize: 12, color: C.faint }}>live status is automatic from vMix — these are messages on top</span>
      </div>
      {groups.map((g) => {
        const slots = sortedKeys(comm[g.key]);
        return (
          <div key={g.key} style={{ marginBottom: 12 }}>
            <div style={{ ...rowBetween, marginBottom: 8 }}>
              <span style={{ fontSize: 12.5, fontWeight: 800, letterSpacing: "0.08em", color: C.dim, textTransform: "uppercase" }}>{g.title}</span>
              <span style={{ fontSize: 11.5, color: C.faint }}>{g.hint}</span>
            </div>
            {slots.length === 0 ? (
              <div style={{ fontSize: 13, color: C.faint, padding: "4px 2px" }}>None connected.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {slots.map((s) => {
                  const cam = comm[g.key][s]?.cam;
                  const onAir = cam != null && live.has(Number(cam));
                  const next = cam != null && pvw.has(Number(cam));
                  return (
                    <CommentatorRow key={s} kind={g.key} slot={s}
                      name={commNames[g.key][s]} cam={cam} onAir={onAir} next={next}
                      ready={commReady[g.key][s] && commReady[g.key][s].at}
                      cue={cues[g.key][s]}
                      onCue={(type) => onCue(g.key, s, type)}
                      onClearCue={() => onClearCue(g.key, s)}
                      onClearReady={() => onClearReady(g.key, s)} />
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CommentatorRow({ kind, slot, name, cam, onAir, next, ready, cue, onCue, onClearCue, onClearReady }) {
  const C = useC();
  const cur = cue && cue.type ? CUE[kind][cue.type] : null;
  const statusColor = onAir ? C.live : next ? C.preview : "#5b6472";
  const statusText = onAir ? "ON AIR" : next ? "NEXT" : "STBY";
  return (
    <div style={{ background: C.panelHi, border: `1px solid ${ready ? C.live : C.line}`, borderRadius: 12, padding: "10px 12px", boxShadow: ready ? `0 0 16px ${C.live}33` : "none" }}>
      <div style={{ ...rowBetween, gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <div style={{ ...row, gap: 9, minWidth: 0 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: statusColor, boxShadow: `0 0 8px ${statusColor}` }} />
          <span style={{ fontWeight: 700, fontSize: 14.5, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {COMM_LABEL[kind]} {slot}{name ? ` · ${name}` : ""}
          </span>
          <span style={{ fontSize: 11, fontFamily: mono, color: C.faint }}>{cam ? `in${cam}` : "no input"}</span>
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.05em", color: statusColor }}>{statusText}</span>
          {cur && <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: "0.04em", color: cur.color }}>▸ {cur.label}</span>}
        </div>
        {ready && (
          <button onClick={onClearReady}
            style={{ flexShrink: 0, background: "none", border: `1px solid ${C.live}`, color: C.live, borderRadius: 7, padding: "4px 10px", fontSize: 11.5, fontWeight: 800, cursor: "pointer" }}>
            ✓ ready — clear
          </button>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {CUE_SET[kind].map((type) => {
          const c = CUE[kind][type];
          const activeNow = cue && cue.type === type;
          return (
            <button key={type} onClick={() => onCue(type)}
              style={{ background: activeNow ? c.color : "transparent", border: `1.5px solid ${c.color}`, color: activeNow ? "#fff" : c.color, borderRadius: 9, padding: "8px 12px", fontSize: 12.5, fontWeight: 800, letterSpacing: "0.02em", cursor: "pointer", transition: "all .12s" }}>
              {c.label}
            </button>
          );
        })}
        <button onClick={onClearCue}
          style={{ background: "transparent", border: `1px solid ${C.line}`, color: C.dim, borderRadius: 9, padding: "8px 12px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>
          Clear msg
        </button>
      </div>
    </div>
  );
}

/* ---- Producer: messaging to cameras ------------------------------ */
function MessagePanel({ msgs, names, pad, onSend, onClear }) {
  const C = useC();
  const [target, setTarget] = useState("all");
  const [text, setText] = useState("");
  const active = Object.entries(msgs || {}).filter(([, m]) => m && m.text);
  const send = () => { if (!text.trim()) return; onSend(target, text); setText(""); };
  const targetLabel = (t) => (t === "all" ? "All cameras" : camLabel(Number(t), names));
  const selectSty = { background: C.panelHi, border: `1px solid ${C.line}`, color: C.text, borderRadius: 9, padding: "10px 11px", fontSize: 14, outline: "none" };
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 16, padding: 16, marginTop: 14 }}>
      <div style={{ ...row, gap: 10, marginBottom: 12 }}>
        <span style={{ width: 11, height: 11, borderRadius: "50%", background: C.ping, boxShadow: `0 0 10px ${C.ping}` }} />
        <span style={{ fontWeight: 700, fontSize: 15, color: C.text }}>Message to cameras</span>
        <span style={{ fontSize: 12, color: C.faint }}>full-screen on the camera display</span>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        <select value={target} onChange={(e) => setTarget(e.target.value)} style={{ ...selectSty, minWidth: 150 }}>
          <option value="all">All cameras</option>
          {pad.map((n) => <option key={n} value={String(n)}>{camLabel(n, names)}</option>)}
        </select>
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value.slice(0, 240))}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }}
        placeholder="e.g. Going live in 2 mins — get to position" rows={2}
        style={{ width: "100%", background: C.panelHi, border: `1px solid ${C.line}`, color: C.text, borderRadius: 10, padding: "11px 13px", fontSize: 15, resize: "vertical", outline: "none", boxSizing: "border-box", fontFamily: "inherit" }} />
      <div style={{ ...rowBetween, marginTop: 10 }}>
        <span style={{ fontSize: 12, color: C.faint }}>⌘/Ctrl + Enter to send</span>
        <button onClick={send} disabled={!text.trim()}
          style={{ background: text.trim() ? C.ping : C.panelHi, border: "none", color: text.trim() ? "#fff" : C.faint, borderRadius: 9, padding: "9px 18px", fontSize: 14, fontWeight: 700, cursor: text.trim() ? "pointer" : "default" }}>
          Send to {target === "all" ? "all" : `Cam ${target}`}
        </button>
      </div>
      {active.length > 0 && (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", color: C.faint }}>Showing now</span>
          {active.map(([t, m]) => (
            <div key={t} style={{ ...rowBetween, gap: 10, background: C.panelHi, border: `1px solid ${C.line}`, borderRadius: 10, padding: "9px 12px" }}>
              <div style={{ minWidth: 0 }}>
                <span style={{ fontSize: 11.5, color: C.ping, fontWeight: 700 }}>{targetLabel(t)}</span>
                <div style={{ fontSize: 14, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.text}</div>
              </div>
              <button onClick={() => onClear(t)}
                style={{ background: "none", border: `1px solid ${C.line}`, color: C.dim, borderRadius: 8, padding: "5px 11px", fontSize: 12.5, cursor: "pointer", flexShrink: 0 }}>Clear</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---- Producer: roster -------------------------------------------- */
function Roster({ nums, onlineNums, names, pings, liveSet, pvwSet, comm, commNames, onName, onClearPing }) {
  const C = useC();
  const [draft, setDraft] = useState({});
  const [addNum, setAddNum] = useState("");
  const [addName, setAddName] = useState("");

  const commCamMap = {};
  for (const kind of ["booth", "pitch"])
    for (const s of Object.keys(comm[kind] || {})) {
      const cam = comm[kind][s]?.cam;
      if (cam != null) commCamMap[Number(cam)] = `${COMM_LABEL[kind]}${commNames[kind][s] ? " · " + commNames[kind][s] : ""}`;
    }

  const valueFor = (n) => (draft[n] !== undefined ? draft[n] : (names[n] || ""));
  const commit = (n) => {
    if (draft[n] !== undefined) { onName(n, draft[n]); setDraft((d) => { const c = { ...d }; delete c[n]; return c; }); }
  };
  const addStatic = () => {
    const n = parseInt(addNum, 10);
    if (!n || n < 1) return;
    onName(n, addName); setAddNum(""); setAddName("");
  };
  const tagFor = (n) => {
    if (liveSet.has(n)) return { t: "LIVE", c: C.live };
    if (pvwSet.has(n)) return { t: "PVW", c: C.preview };
    return null;
  };
  const inputSty = { flex: 1, minWidth: 0, background: C.panelHi, border: `1px solid ${C.line}`, color: C.text, borderRadius: 8, padding: "8px 11px", fontSize: 14, outline: "none" };

  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 16, padding: 16, marginTop: 14 }}>
      <div style={{ ...row, gap: 10, marginBottom: 12 }}>
        <span style={{ fontWeight: 700, fontSize: 15, color: C.text }}>Cameras &amp; inputs</span>
        <span style={{ fontSize: 12, color: C.faint }}>name any input — even a static one</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {nums.map((n) => {
          const online = onlineNums.includes(n);
          const ping = pings && pings[n];
          const tag = tagFor(n);
          const commTag = commCamMap[n];
          return (
            <div key={n} style={{ ...row, gap: 10 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: online ? C.live : C.faint, boxShadow: online ? `0 0 8px ${C.live}` : "none" }} />
              <span style={{ fontFamily: mono, fontWeight: 800, fontSize: 15, width: 26, color: online ? C.text : C.faint, flexShrink: 0 }}>{n}</span>
              <input value={valueFor(n)} placeholder={commTag ? commTag : (online ? "name this camera" : "static / not connected")}
                onChange={(e) => setDraft((d) => ({ ...d, [n]: e.target.value.slice(0, 18) }))}
                onBlur={() => commit(n)}
                onKeyDown={(e) => { if (e.key === "Enter") { commit(n); e.target.blur(); } }}
                style={inputSty} />
              {commTag && <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: "0.04em", color: COMMENTARY_PURPLE, flexShrink: 0 }}>COMM</span>}
              {tag && <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.06em", color: tag.c, flexShrink: 0 }}>{tag.t}</span>}
              {ping && (
                <button onClick={() => onClearPing(n)} title="Clear ping"
                  style={{ flexShrink: 0, background: "none", border: `1px solid ${ping.type === "ready" ? C.live : C.preview}`, color: ping.type === "ready" ? C.live : C.preview, borderRadius: 7, padding: "4px 9px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>
                  {ping.type === "ready" ? "✓ ready" : "★ shot"}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ ...row, gap: 8, marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.line}`, flexWrap: "wrap" }}>
        <input value={addNum} onChange={(e) => setAddNum(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
          placeholder="#" inputMode="numeric"
          style={{ width: 56, background: C.panelHi, border: `1px solid ${C.line}`, color: C.text, borderRadius: 8, padding: "8px 10px", fontSize: 14, fontFamily: mono, textAlign: "center", outline: "none" }} />
        <input value={addName} onChange={(e) => setAddName(e.target.value.slice(0, 18))}
          onKeyDown={(e) => { if (e.key === "Enter") addStatic(); }}
          placeholder="name a static camera (e.g. WIDE)"
          style={{ flex: 1, minWidth: 140, background: C.panelHi, border: `1px solid ${C.line}`, color: C.text, borderRadius: 8, padding: "8px 11px", fontSize: 14, outline: "none" }} />
        <button onClick={addStatic} disabled={!addNum}
          style={{ background: addNum ? C.panelHi : C.panel, border: `1px solid ${C.line}`, color: addNum ? C.text : C.faint, borderRadius: 8, padding: "8px 14px", fontSize: 13.5, fontWeight: 600, cursor: addNum ? "pointer" : "default" }}>Add</button>
      </div>
    </div>
  );
}

/* ---- Producer: Stream Deck shortcut map -------------------------- */
function ShortcutsLegend() {
  const C = useC();
  const [open, setOpen] = useState(false);
  const rowsLeft = [
    ["1 – 9", "Cut camera N live (toggle)"],
    ["Shift + 1–9", "Arm camera N to preview"],
    ["Space", "Take preview → live"],
    ["0 / Esc", "Clear your live flags"],
  ];
  const rowsRight = [
    ["Z", "Booth · Replay incoming"],
    ["X", "Booth · Wrap"],
    ["C", "Booth · Transfer to ground"],
    ["V", "Booth · Stand by"],
    ["B", "Booth · Clear message"],
    ["N", "Pitch · Coming to you"],
    ["M", "Pitch · Wrap up"],
    [", (comma)", "Pitch · Clear message"],
  ];
  const Cell = ({ k, v }) => (
    <div style={{ ...rowBetween, gap: 12, padding: "5px 0" }}>
      <span style={{ fontSize: 13, color: C.dim }}>{v}</span>
      <kbd style={{ fontFamily: mono, fontSize: 12, color: C.text, background: C.panelHi, border: `1px solid ${C.line}`, borderRadius: 6, padding: "2px 8px", whiteSpace: "nowrap" }}>{k}</kbd>
    </div>
  );
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 16, padding: 16, marginTop: 14 }}>
      <button onClick={() => setOpen((o) => !o)} style={{ ...rowBetween, width: "100%", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
        <div style={{ ...row, gap: 10 }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: C.text }}>Keyboard / Stream Deck shortcuts</span>
          <span style={{ fontSize: 12, color: C.faint }}>map these single keys to your deck</span>
        </div>
        <span style={{ color: C.dim, fontSize: 18 }}>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "2px 28px", marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.line}` }}>
          <div>{rowsLeft.map(([k, v]) => <Cell key={k} k={k} v={v} />)}</div>
          <div>{rowsRight.map(([k, v]) => <Cell key={k} k={k} v={v} />)}</div>
        </div>
      )}
      <p style={{ fontSize: 12, color: C.faint, marginTop: 10, marginBottom: 0, lineHeight: 1.5 }}>
        Cue keys target the first booth and first pitch commentator. Live/preview
        flags ride on top of vMix — they never change vMix itself.
      </p>
    </div>
  );
}

/* ================================================================== *
 *  CAMERA ENTRY — operator vs commentary
 * ================================================================== */
function CameraEntry({ room, onExit, initialMode }) {
  const [mode, setMode] = useState(initialMode || null); // null | "op" | "booth" | "pitch"
  if (!mode) return <CameraPick onPick={setMode} onExit={onExit} />;
  if (mode === "op") return <Camera room={room} onExit={onExit} />;
  return <Commentator room={room} kind={mode} onExit={onExit} />;
}

function CameraPick({ onPick, onExit }) {
  const C = useC();
  return (
    <div style={{ ...colCenter, justifyContent: "center", minHeight: "100vh", padding: "0 24px" }}>
      <div style={{ width: "100%", maxWidth: 460 }}>
        <div style={{ ...row, gap: 10, marginBottom: 6 }}>
          <Dot color={C.preview} pulse />
          <span style={{ fontFamily: mono, letterSpacing: "0.4em", fontSize: 12, color: C.dim }}>THIS DEVICE</span>
        </div>
        <h1 style={{ fontSize: 32, lineHeight: 1.1, fontWeight: 800, letterSpacing: "-0.02em", margin: "6px 0 6px", color: C.text }}>What is this screen?</h1>
        <p style={{ color: C.dim, fontSize: 15, lineHeight: 1.5, marginBottom: 24 }}>
          A camera operator gets a tally light. A commentary screen goes live
          automatically when its vMix input is cut to air.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12 }}>
          <RolePick title="Camera operator" sub="Full-screen tally light · ready & message back to the producer" accent={C.preview} onClick={() => onPick("op")} />
          <RolePick title="Booth commentary" sub="Auto live status · replay / wrap / transfer overlays" accent={COMMENTARY_PURPLE} onClick={() => onPick("booth")} />
          <RolePick title="Pitch commentary" sub="Big 'we're ready' · message back · coming-to-you & wrap cues" accent={C.live} onClick={() => onPick("pitch")} />
        </div>
        <button onClick={onExit} style={{ marginTop: 22, background: "none", border: `1px solid ${C.line}`, color: C.dim, borderRadius: 9, padding: "8px 14px", fontSize: 13, cursor: "pointer" }}>← Back</button>
      </div>
    </div>
  );
}

/* ---- Camera operator (tally light) ------------------------------- */
function Camera({ room, onExit }) {
  const [num, setNum] = useState(null);
  const numRef = useRef(null);
  const [st, setSt] = useState({});
  const [overlay, setOverlay] = useState({});
  const [names, setNames] = useState({});
  const [msgs, setMsgs] = useState({});
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [pingFx, setPingFx] = useState(null);
  const [composing, setComposing] = useState(false);
  const [msgDraft, setMsgDraft] = useState("");
  const [msgSent, setMsgSent] = useState(false);
  const wakeRef = useRef(null);
  const epochRef = useRef(undefined);
  const inited = useRef(false);

  const claim = useCallback((n) => {
    numRef.current = n; setNum(n);
    const r = camRef(room, n); set(r, { joined: Date.now() }); onDisconnect(r).remove();
  }, [room]);

  // Claim a number: reuse the saved one if this device had it (and the
  // room hasn't been reset since), otherwise grab the next free one.
  useEffect(() => {
    let alive = true;
    const freshGrab = async (e) => {
      let taken = new Set();
      try { const snap = await get(camsRef(room)); taken = new Set(Object.keys(snap.val() || {}).map(Number)); } catch {}
      let n = 1; while (taken.has(n)) n++;
      if (!alive) return;
      claim(n);
      saveSession(room, { role: "op", num: n, name: null, epoch: e });
    };
    const off = onValue(sessionEpochRef(room), async (snap) => {
      const e = snap.val() || 0;
      const prev = epochRef.current; epochRef.current = e;
      if (!inited.current) {
        inited.current = true;
        const saved = loadSession(room);
        if (saved && saved.role === "op" && saved.epoch === e && saved.num) {
          if (!alive) return;
          claim(saved.num);
          saveSession(room, { role: "op", num: saved.num, name: saved.name || null, epoch: e });
        } else {
          await freshGrab(e);
        }
      } else if (prev !== undefined && e !== prev) {
        clearSession(room);
        if (numRef.current != null) remove(camRef(room, numRef.current));
        await freshGrab(e);
      }
    });
    return () => { alive = false; off(); };
  }, [room, claim]);

  useEffect(() => {
    const offState = onValue(stateRef(room), (snap) => setSt(snap.val() || {}));
    const offOv = onValue(overlayRootRef(room), (snap) => setOverlay(snap.val() || {}));
    const offNames = onValue(namesRef(room), (snap) => setNames(snap.val() || {}));
    const offMsgs = onValue(msgsRef(room), (snap) => setMsgs(snap.val() || {}));
    return () => { offState(); offOv(); offNames(); offMsgs(); };
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

  const myName = num != null ? names[num] : null;
  const { live, pvw } = derive(st, overlay);
  const mode = num == null ? "off" : live.has(num) ? "live" : pvw.has(num) ? "preview" : "off";
  const view = {
    live: { label: "ON AIR", sub: "You are live", glow: ACCENT.live },
    preview: { label: "STAND BY", sub: "You're up next", glow: ACCENT.preview },
    off: { label: "STANDBY", sub: "Not selected", glow: "transparent" },
  }[mode];

  const changeNum = (n) => {
    if (n < 1) return;
    const prev = numRef.current; numRef.current = n; setNum(n);
    if (prev != null && prev !== n) remove(camRef(room, prev));
    const r = camRef(room, n); set(r, { joined: Date.now() }); onDisconnect(r).remove();
    const saved = loadSession(room) || {};
    saveSession(room, { ...saved, role: "op", num: n, epoch: epochRef.current || 0 });
  };
  const saveName = (v) => {
    const val = (v || "").trim().slice(0, 18);
    if (num == null) return;
    if (val) set(nameRef(room, num), val); else remove(nameRef(room, num));
    const saved = loadSession(room) || {};
    saveSession(room, { ...saved, role: "op", num, name: val || null, epoch: epochRef.current || 0 });
  };
  const sendPing = (type) => {
    if (num == null) return;
    set(pingRef(room, num), { type, at: Date.now() });
    setPingFx(type); setTimeout(() => setPingFx(null), 1600);
  };
  const sendMsg = () => {
    const t = msgDraft.trim().slice(0, 240);
    if (!t || num == null) return;
    set(inboxOneRef(room, `cam-${num}`), { label: camLabel(num, names), text: t, at: Date.now() });
    setMsgDraft(""); setComposing(false); setMsgSent(true); setTimeout(() => setMsgSent(false), 1800);
  };
  const goFullscreen = () => {
    try { if (document.fullscreenElement) document.exitFullscreen?.(); else document.documentElement.requestFullscreen?.(); } catch {}
  };

  const bg = mode === "off" ? `radial-gradient(130% 130% at 50% 40%, ${ACCENT.off} 0%, ${ACCENT.offDeep} 60%, #1a0606 100%)`
    : mode === "preview" ? `radial-gradient(130% 130% at 50% 40%, ${ACCENT.preview} 0%, ${ACCENT.previewDeep} 65%, #1a0f00 100%)`
    : `radial-gradient(130% 130% at 50% 40%, ${ACCENT.live} 0%, ${ACCENT.liveDeep} 60%, #04140a 100%)`;

  const broadcast = msgs.all && msgs.all.text ? msgs.all.text : null;
  const mineMsg = num != null && msgs[num] && msgs[num].text ? msgs[num].text : null;

  return (
    <div style={{ ...colCenter, justifyContent: "center", minHeight: "100vh", background: bg, transition: "background .18s", position: "relative", padding: 24 }}>
      <div style={{ ...rowBetween, position: "absolute", top: 16, left: 18, right: 18 }}>
        <span style={{ fontFamily: mono, letterSpacing: "0.2em", fontSize: 12, color: "rgba(0,0,0,0.6)" }}>ROOM {room}</span>
        <div style={{ display: "flex", gap: 8 }}>
          <ChromeBtn onClick={goFullscreen}>Fullscreen</ChromeBtn>
          <ChromeBtn onClick={onExit}>Leave</ChromeBtn>
        </div>
      </div>

      {(mineMsg || broadcast) && (
        <div style={{ position: "absolute", top: 58, left: 18, right: 18, display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
          {mineMsg && <MsgBanner text={mineMsg} tagged />}
          {broadcast && <MsgBanner text={broadcast} />}
        </div>
      )}

      <div style={colCenter}>
        <span style={{ fontSize: 15, letterSpacing: "0.3em", color: "rgba(0,0,0,0.62)", textTransform: "uppercase", marginBottom: 4 }}>Camera</span>
        <span style={{ fontFamily: mono, fontWeight: 800, fontSize: "clamp(120px, 32vw, 280px)", lineHeight: 0.85, color: "#fff", textShadow: mode === "off" ? "0 4px 30px rgba(0,0,0,0.4)" : `0 0 50px ${view.glow}` }}>{num ?? "—"}</span>
        {myName && <span style={{ marginTop: 10, fontWeight: 800, fontSize: "clamp(22px, 6vw, 40px)", letterSpacing: "0.02em", color: "#fff", textShadow: "0 2px 16px rgba(0,0,0,0.4)" }}>{myName}</span>}
        <span style={{ marginTop: 16, fontWeight: 800, fontSize: "clamp(30px, 8vw, 64px)", letterSpacing: "0.08em", color: "#fff", textShadow: "0 2px 18px rgba(0,0,0,0.35)" }}>{view.label}</span>
        <span style={{ marginTop: 6, fontSize: 16, color: "rgba(0,0,0,0.62)", letterSpacing: "0.05em" }}>{view.sub}</span>
      </div>

      <div style={{ position: "absolute", bottom: 22, width: "100%", display: "flex", justifyContent: "center", padding: "0 16px", boxSizing: "border-box" }}>
        {editing ? (
          <div style={{ ...colCenter, gap: 10, background: "rgba(0,0,0,0.32)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 14, padding: 14, backdropFilter: "blur(3px)", maxWidth: 340, width: "100%" }}>
            <div style={{ ...row, gap: 8 }}>
              <ChromeBtn onClick={() => changeNum((numRef.current || 1) - 1)}>–</ChromeBtn>
              <span style={{ fontFamily: mono, fontWeight: 800, fontSize: 22, color: "#fff", minWidth: 36, textAlign: "center" }}>{num}</span>
              <ChromeBtn onClick={() => changeNum((numRef.current || 0) + 1)}>+</ChromeBtn>
            </div>
            <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value.slice(0, 18))} placeholder="name this camera (e.g. Xander)"
              style={{ width: "100%", boxSizing: "border-box", background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.25)", color: "#fff", borderRadius: 9, padding: "10px 12px", fontSize: 15, outline: "none", textAlign: "center" }} />
            <div style={{ ...row, gap: 8 }}>
              <ChromeBtn onClick={() => { saveName(nameDraft); setEditing(false); }}>Save</ChromeBtn>
              <ChromeBtn onClick={() => setEditing(false)}>Cancel</ChromeBtn>
            </div>
          </div>
        ) : composing ? (
          <div style={{ ...colCenter, gap: 10, background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 14, padding: 14, backdropFilter: "blur(3px)", maxWidth: 380, width: "100%" }}>
            <textarea value={msgDraft} autoFocus onChange={(e) => setMsgDraft(e.target.value.slice(0, 240))}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMsg(); } }}
              placeholder="message the producer…" rows={2}
              style={{ width: "100%", boxSizing: "border-box", background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.25)", color: "#fff", borderRadius: 9, padding: "10px 12px", fontSize: 15, outline: "none", resize: "none", fontFamily: "inherit" }} />
            <div style={{ ...row, gap: 8 }}>
              <ChromeBtn onClick={sendMsg}>Send</ChromeBtn>
              <ChromeBtn onClick={() => { setComposing(false); setMsgDraft(""); }}>Cancel</ChromeBtn>
            </div>
          </div>
        ) : (
          <div style={{ ...row, gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
            <BlurBtn onClick={() => sendPing("ready")} fx={pingFx === "ready"} fxColor={ACCENT.live}>{pingFx === "ready" ? "✓ Sent" : "I'm ready"}</BlurBtn>
            <BlurBtn onClick={() => sendPing("shot")} fx={pingFx === "shot"} fxColor={ACCENT.preview}>{pingFx === "shot" ? "✓ Sent" : "Good shot"}</BlurBtn>
            <BlurBtn onClick={() => setComposing(true)} fx={msgSent} fxColor={ACCENT.ping}>{msgSent ? "✓ Sent" : "Message"}</BlurBtn>
            <ChromeBtn onClick={() => { setNameDraft(myName || ""); setEditing(true); }}>{myName ? "Edit" : "Name"}</ChromeBtn>
          </div>
        )}
      </div>
    </div>
  );
}

function BlurBtn({ onClick, fx, fxColor, children }) {
  return (
    <button onClick={onClick}
      style={{ background: fx ? fxColor : "rgba(0,0,0,0.3)", border: `1px solid ${fx ? fxColor : "rgba(255,255,255,0.35)"}`, color: "#fff", borderRadius: 9, padding: "9px 16px", fontSize: 14, fontWeight: 800, letterSpacing: "0.03em", cursor: "pointer", backdropFilter: "blur(2px)", transition: "all .15s" }}>
      {children}
    </button>
  );
}

function MsgBanner({ text, tagged }) {
  return (
    <div style={{ width: "100%", maxWidth: 900, background: "rgba(0,0,0,0.72)", border: `1px solid ${tagged ? "rgba(123,167,255,0.7)" : "rgba(255,255,255,0.28)"}`, borderRadius: 14, padding: "14px 20px", boxShadow: "0 6px 30px rgba(0,0,0,0.4)", backdropFilter: "blur(3px)", textAlign: "center" }}>
      {tagged && <div style={{ fontSize: 11.5, letterSpacing: "0.18em", color: "#9cc0ff", fontWeight: 700, marginBottom: 4 }}>FOR YOU</div>}
      <div style={{ color: "#fff", fontWeight: 700, fontSize: "clamp(20px, 4.4vw, 38px)", lineHeight: 1.2 }}>{text}</div>
    </div>
  );
}

/* ================================================================== *
 *  COMMENTARY SCREEN (booth / pitch)
 * ================================================================== */
function Commentator({ room, kind, onExit }) {
  const [slot, setSlot] = useState(null);
  const slotRef = useRef(null);
  const camRef2 = useRef(null);
  const [cam, setCam] = useState(null);
  const [st, setSt] = useState({});
  const [overlay, setOverlay] = useState({});
  const [camNames, setCamNames] = useState({});
  const [commNames, setCommNames] = useState({ booth: {}, pitch: {} });
  const [cues, setCues] = useState({ booth: {}, pitch: {} });
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [readyFx, setReadyFx] = useState(false);
  const [composing, setComposing] = useState(false);
  const [msgDraft, setMsgDraft] = useState("");
  const [msgSent, setMsgSent] = useState(false);
  const [fx, setFx] = useState(null);
  const lastCueAt = useRef(0);
  const cueInit = useRef(false);
  const wasLive = useRef(false);
  const wakeRef = useRef(null);
  const epochRef = useRef(undefined);
  const inited = useRef(false);

  const claimComm = useCallback((s, c) => {
    slotRef.current = s; camRef2.current = c; setSlot(s); setCam(c);
    const r = commOneRef(room, kind, s); set(r, { joined: Date.now(), cam: c }); onDisconnect(r).remove();
  }, [room, kind]);

  // Reclaim the saved slot + input if this device had one (and the room
  // hasn't been reset), otherwise grab a fresh slot and free input.
  useEffect(() => {
    let alive = true;
    const freshGrab = async (e) => {
      let takenSlots = new Set(), usedCams = new Set();
      try { const v = (await get(commGroupRef(room, kind))).val() || {}; takenSlots = new Set(Object.keys(v).map(Number)); Object.values(v).forEach((c) => c && c.cam && usedCams.add(Number(c.cam))); } catch {}
      try { Object.keys((await get(camsRef(room))).val() || {}).forEach((n) => usedCams.add(Number(n))); } catch {}
      let s = 1; while (takenSlots.has(s)) s++;
      let c = 1; while (usedCams.has(c)) c++;
      if (!alive) return;
      claimComm(s, c);
      saveSession(room, { role: kind, slot: s, cam: c, name: null, epoch: e });
    };
    const off = onValue(sessionEpochRef(room), async (snap) => {
      const e = snap.val() || 0;
      const prev = epochRef.current; epochRef.current = e;
      if (!inited.current) {
        inited.current = true;
        const saved = loadSession(room);
        if (saved && saved.role === kind && saved.epoch === e && saved.slot != null) {
          if (!alive) return;
          claimComm(saved.slot, saved.cam || 1);
          saveSession(room, { role: kind, slot: saved.slot, cam: saved.cam || 1, name: saved.name || null, epoch: e });
        } else {
          await freshGrab(e);
        }
      } else if (prev !== undefined && e !== prev) {
        clearSession(room);
        if (slotRef.current != null) remove(commOneRef(room, kind, slotRef.current));
        await freshGrab(e);
      }
    });
    return () => { alive = false; off(); };
  }, [room, kind, claimComm]);

  useEffect(() => {
    const offState = onValue(stateRef(room), (snap) => setSt(snap.val() || {}));
    const offOv = onValue(overlayRootRef(room), (snap) => setOverlay(snap.val() || {}));
    const offCam = onValue(namesRef(room), (snap) => setCamNames(snap.val() || {}));
    const offCN = onValue(commNamesRootRef(room), (snap) => setCommNames(normKinds(snap.val())));
    const offCue = onValue(cueRootRef(room), (snap) => setCues(normKinds(snap.val())));
    return () => { offState(); offOv(); offCam(); offCN(); offCue(); };
  }, [room]);

  useEffect(() => {
    const requestWake = async () => { try { wakeRef.current = await navigator.wakeLock.request("screen"); } catch {} };
    requestWake();
    const onVis = () => document.visibilityState === "visible" && requestWake();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      try { wakeRef.current?.release(); } catch {}
      if (slotRef.current != null) remove(commOneRef(room, kind, slotRef.current));
    };
  }, [room, kind]);

  const { live, pvw } = derive(st, overlay);
  const onAir = cam != null && live.has(Number(cam));
  const next = cam != null && pvw.has(Number(cam));
  const cue = slot != null ? cues[kind][slot] : null;

  // Flash on a NEW message overlay.
  useEffect(() => {
    const at = cue && cue.at ? cue.at : 0;
    if (!cueInit.current) { lastCueAt.current = at; cueInit.current = true; return; }
    if (at > lastCueAt.current && cue && CUE[kind][cue.type]) {
      lastCueAt.current = at;
      const c = CUE[kind][cue.type];
      setFx({ color: c.color, flash: c.flash });
      const t = setTimeout(() => setFx(null), 1700);
      return () => clearTimeout(t);
    }
  }, [cue, kind]);

  // Flash green the instant the input is cut to air.
  useEffect(() => {
    if (onAir && !wasLive.current) {
      wasLive.current = true;
      setFx({ color: ACCENT.live, flash: "hard" });
      const t = setTimeout(() => setFx(null), 1700);
      return () => clearTimeout(t);
    }
    if (!onAir) wasLive.current = false;
  }, [onAir]);

  const myName = slot != null ? commNames[kind][slot] : null;

  const changeCam = (n) => {
    if (n < 1 || slot == null) return;
    camRef2.current = n; setCam(n);
    set(commOneRef(room, kind, slot), { joined: Date.now(), cam: n });
    onDisconnect(commOneRef(room, kind, slot)).remove();
    const saved = loadSession(room) || {};
    saveSession(room, { ...saved, role: kind, slot, cam: n, epoch: epochRef.current || 0 });
  };
  const saveName = (v) => {
    const val = (v || "").trim().slice(0, 18);
    if (slot == null) return;
    if (val) set(commNameRef(room, kind, slot), val); else remove(commNameRef(room, kind, slot));
    const saved = loadSession(room) || {};
    saveSession(room, { ...saved, role: kind, slot, cam: camRef2.current || cam || 1, name: val || null, epoch: epochRef.current || 0 });
  };
  const sendReady = () => {
    if (slot == null) return;
    set(commReadyRef(room, kind, slot), { at: Date.now() });
    setReadyFx(true); setTimeout(() => setReadyFx(false), 1800);
  };
  const sendMsg = () => {
    const t = msgDraft.trim().slice(0, 240);
    if (!t || slot == null) return;
    set(inboxOneRef(room, `${kind}-${slot}`), { label: `${COMM_LABEL[kind]}${myName ? " · " + myName : " " + slot}`, text: t, at: Date.now() });
    setMsgDraft(""); setComposing(false); setMsgSent(true); setTimeout(() => setMsgSent(false), 1800);
  };
  const goFullscreen = () => {
    try { if (document.fullscreenElement) document.exitFullscreen?.(); else document.documentElement.requestFullscreen?.(); } catch {}
  };

  const status = onAir ? STATUS.live : next ? STATUS.pvw : STATUS.off;
  const cur = cue && cue.type ? CUE[kind][cue.type] : null;
  const main = cur || status;            // overlay takes the spotlight when present
  const accent = main.color;
  const wrapPulse = cur && cue.type === "wrap";

  const programNum = [...live].sort((a, b) => a - b)[0] ?? null;

  return (
    <div style={{ ...colCenter, justifyContent: "center", minHeight: "100vh", background: `radial-gradient(135% 135% at 50% 38%, ${onAir ? "#0a2414" : "#101319"} 0%, #06070a 78%)`, transition: "background .2s", position: "relative", padding: 24, boxSizing: "border-box" }}>
      <CueFlash fx={fx} />
      <div style={{ position: "fixed", inset: 0, pointerEvents: "none", border: `7px solid ${accent}`, boxShadow: `inset 0 0 60px ${accent}44`, animation: wrapPulse ? "commWrapPulse 0.7s ease-in-out infinite" : "none", zIndex: 2 }} />

      <div style={{ ...rowBetween, position: "absolute", top: 16, left: 18, right: 18, zIndex: 5 }}>
        <span style={{ fontFamily: mono, letterSpacing: "0.18em", fontSize: 12, color: "rgba(255,255,255,0.55)" }}>
          {COMM_LABEL[kind].toUpperCase()} · INPUT {cam ?? "—"} · ROOM {room}
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <ChromeBtn onClick={goFullscreen}>Fullscreen</ChromeBtn>
          <ChromeBtn onClick={onExit}>Leave</ChromeBtn>
        </div>
      </div>

      {/* Persistent status badge — always shows whether you're on, even under a message */}
      <div style={{ position: "absolute", top: 52, left: 0, right: 0, display: "flex", justifyContent: "center", zIndex: 5 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 9, background: "rgba(0,0,0,0.4)", border: `1px solid ${status.color}`, borderRadius: 999, padding: "7px 16px", backdropFilter: "blur(3px)" }}>
          <span style={{ width: 9, height: 9, borderRadius: "50%", background: status.color, boxShadow: `0 0 10px ${status.color}` }} />
          <span style={{ fontWeight: 800, fontSize: 14, letterSpacing: "0.08em", color: "#fff" }}>{onAir ? "ON AIR" : next ? "NEXT" : "STAND BY"}</span>
        </span>
      </div>

      <div style={{ ...colCenter, zIndex: 5, textAlign: "center" }}>
        {myName && <span style={{ fontSize: "clamp(18px, 4vw, 26px)", fontWeight: 700, color: "rgba(255,255,255,0.8)", marginBottom: 14 }}>{myName}</span>}
        <span style={{ fontWeight: 800, fontSize: "clamp(50px, 12vw, 140px)", lineHeight: 0.95, letterSpacing: "-0.01em", color: accent, textShadow: `0 0 55px ${accent}99` }}>{main.label}</span>
        <span style={{ marginTop: 16, fontSize: "clamp(18px, 4.2vw, 32px)", fontWeight: 600, color: "#fff" }}>{main.sub}</span>
      </div>

      {/* Booth situational awareness: what's on air overall */}
      {kind === "booth" && (
        <div style={{ position: "absolute", bottom: 24, left: 18, right: 18, display: "flex", justifyContent: "center", zIndex: 5 }}>
          <AnglePill tag="PROGRAM" color={programNum != null ? ACCENT.live : "#565c66"} n={programNum} name={camNames[programNum]} dim={programNum == null} />
        </div>
      )}

      {/* Controls */}
      <div style={{ position: "absolute", bottom: kind === "booth" ? 84 : 24, width: "100%", display: "flex", justifyContent: "center", padding: "0 16px", boxSizing: "border-box", zIndex: 5 }}>
        {editing ? (
          <div style={{ ...colCenter, gap: 10, background: "rgba(0,0,0,0.45)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 14, padding: 14, backdropFilter: "blur(3px)", maxWidth: 360, width: "100%" }}>
            <span style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", letterSpacing: "0.04em" }}>vMix input pointed at you</span>
            <div style={{ ...row, gap: 8 }}>
              <ChromeBtn onClick={() => changeCam((camRef2.current || 1) - 1)}>–</ChromeBtn>
              <span style={{ fontFamily: mono, fontWeight: 800, fontSize: 22, color: "#fff", minWidth: 36, textAlign: "center" }}>{cam}</span>
              <ChromeBtn onClick={() => changeCam((camRef2.current || 0) + 1)}>+</ChromeBtn>
            </div>
            <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value.slice(0, 18))} placeholder="your name (e.g. Jonny)"
              style={{ width: "100%", boxSizing: "border-box", background: "rgba(0,0,0,0.35)", border: "1px solid rgba(255,255,255,0.25)", color: "#fff", borderRadius: 9, padding: "10px 12px", fontSize: 15, outline: "none", textAlign: "center" }} />
            <div style={{ ...row, gap: 8 }}>
              <ChromeBtn onClick={() => { saveName(nameDraft); setEditing(false); }}>Save</ChromeBtn>
              <ChromeBtn onClick={() => setEditing(false)}>Cancel</ChromeBtn>
            </div>
          </div>
        ) : composing ? (
          <div style={{ ...colCenter, gap: 10, background: "rgba(0,0,0,0.45)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 14, padding: 14, backdropFilter: "blur(3px)", maxWidth: 380, width: "100%" }}>
            <textarea value={msgDraft} autoFocus onChange={(e) => setMsgDraft(e.target.value.slice(0, 240))}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMsg(); } }}
              placeholder="message the producer…" rows={2}
              style={{ width: "100%", boxSizing: "border-box", background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.25)", color: "#fff", borderRadius: 9, padding: "10px 12px", fontSize: 15, outline: "none", resize: "none", fontFamily: "inherit" }} />
            <div style={{ ...row, gap: 8 }}>
              <ChromeBtn onClick={sendMsg}>Send</ChromeBtn>
              <ChromeBtn onClick={() => { setComposing(false); setMsgDraft(""); }}>Cancel</ChromeBtn>
            </div>
          </div>
        ) : (
          <div style={{ ...colCenter, gap: 10 }}>
            {kind === "pitch" && (
              <button onClick={sendReady}
                style={{ background: readyFx ? ACCENT.live : "rgba(0,0,0,0.4)", border: `2px solid ${readyFx ? ACCENT.live : "rgba(255,255,255,0.5)"}`, color: "#fff", borderRadius: 16, padding: "20px 46px", fontSize: "clamp(20px, 5vw, 30px)", fontWeight: 900, letterSpacing: "0.04em", cursor: "pointer", backdropFilter: "blur(2px)", transition: "all .15s", boxShadow: readyFx ? `0 0 30px ${ACCENT.live}` : "none" }}>
                {readyFx ? "✓ PRODUCER NOTIFIED" : "WE'RE READY"}
              </button>
            )}
            <div style={{ ...row, gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
              {kind === "pitch" && (
                <BlurBtn onClick={() => setComposing(true)} fx={msgSent} fxColor={ACCENT.ping}>{msgSent ? "✓ Sent" : "Message"}</BlurBtn>
              )}
              <ChromeBtn onClick={() => { setNameDraft(myName || ""); setEditing(true); }}>{myName ? "Edit · input" : "Set name · input"}</ChromeBtn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AnglePill({ tag, color, n, name, dim }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, background: "rgba(0,0,0,0.45)", border: `1px solid ${color}`, borderRadius: 12, padding: "8px 14px", backdropFilter: "blur(3px)" }}>
      <span style={{ fontFamily: mono, fontSize: 11, letterSpacing: "0.16em", color, fontWeight: 800 }}>{tag}</span>
      <span style={{ fontWeight: 800, fontSize: 17, color: dim ? "rgba(255,255,255,0.4)" : "#fff" }}>{dim ? "—" : `Cam ${n}${name ? ` · ${name}` : ""}`}</span>
    </div>
  );
}

function CueFlash({ fx }) {
  if (!fx) return null;
  const anim = fx.flash === "hard" ? "commFlashHard 1.6s steps(1, end)" : "commFlashSoft 1.6s ease-out";
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 80, pointerEvents: "none",
      background: `radial-gradient(120% 120% at 50% 45%, ${fx.color}cc 0%, ${fx.color}55 50%, transparent 82%)`, animation: anim }} />
  );
}
