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
 *  Drive it manually (Producer screen) OR with vMix (run the bridge,
 *  vmix-tally-bridge.js, on the vMix PC). When the bridge is pushing,
 *  the Producer screen auto-flips to a live monitor and every camera
 *  light follows its matching vMix input.
 *
 *  Colours:  RED = off · ORANGE = preview · GREEN = live
 *  Plus: light/dark theme, camera names, "I'm ready" + attention pings,
 *  and producer-to-camera messaging (great for a static gazebo screen).
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
const namesRef = (room) => ref(db, `rooms/${room}/names`);
const nameRef = (room, n) => ref(db, `rooms/${room}/names/${n}`);
const pingsRef = (room) => ref(db, `rooms/${room}/pings`);
const pingRef = (room, n) => ref(db, `rooms/${room}/pings/${n}`);
const msgsRef = (room) => ref(db, `rooms/${room}/msgs`);
const msgRef = (room, t) => ref(db, `rooms/${room}/msgs/${t}`);

/* Commentators live in their own tree so they never grab camera numbers.
   kind = "booth" | "pitch". n auto-assigned per kind, like cameras. */
const commRootRef = (room) => ref(db, `rooms/${room}/comm`);
const commGroupRef = (room, k) => ref(db, `rooms/${room}/comm/${k}`);
const commOneRef = (room, k, n) => ref(db, `rooms/${room}/comm/${k}/${n}`);
const commNamesRootRef = (room) => ref(db, `rooms/${room}/commNames`);
const commNameRef = (room, k, n) => ref(db, `rooms/${room}/commNames/${k}/${n}`);
const commReadyRootRef = (room) => ref(db, `rooms/${room}/commReady`);
const commReadyRef = (room, k, n) => ref(db, `rooms/${room}/commReady/${k}/${n}`);
const cueRootRef = (room) => ref(db, `rooms/${room}/cue`);
const cueOneRef = (room, k, n) => ref(db, `rooms/${room}/cue/${k}/${n}`);

const normKinds = (v) => ({ booth: (v && v.booth) || {}, pitch: (v && v.pitch) || {} });
const unionNums = (a, b) => {
  const s = new Set();
  Object.keys(a || {}).forEach((k) => s.add(Number(k)));
  Object.keys(b || {}).forEach((k) => s.add(Number(k)));
  return [...s].sort((x, y) => x - y);
};

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

function parseTally(s) {
  const live = [], pvw = [];
  if (typeof s === "string")
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "1") live.push(i + 1);
      if (s[i] === "2") pvw.push(i + 1);
    }
  return { live, pvw };
}

const camLabel = (n, names) => {
  const nm = names && names[n];
  return nm ? `Camera ${n} · ${nm}` : `Camera ${n}`;
};

/* ---- Commentator cues -------------------------------------------- *
 * One persistent directive per commentator. The producer sets it; the
 * commentator's iPad flashes hard on change, then holds the state so a
 * glance always shows the current instruction. Colours are fixed (like
 * the tally lights) so a cue is unmistakable regardless of theme.
 * flash: "hard" = urgent triple strobe · "soft" = single pulse.       */
const CUE = {
  standby: { label: "STAND BY",        sub: "Hold — wait for your cue",      color: "#3b7bff", deep: "#0e2a66", flash: "soft" },
  soon:    { label: "COMING TO YOU",   sub: "Get ready — on air soon",       color: "#ff8a00", deep: "#7a3f00", flash: "soft" },
  oncam:   { label: "YOU'RE ON",       sub: "Mic live — start talking",      color: "#16c43a", deep: "#0a7320", flash: "hard" },
  back:    { label: "BACK TO YOU",     sub: "You're on — pick it up",        color: "#16c43a", deep: "#0a7320", flash: "hard" },
  replay:  { label: "REPLAY INCOMING", sub: "Cover it on the replay mic",    color: "#8a5cf6", deep: "#3a2080", flash: "soft" },
  wrap:    { label: "WRAP UP",         sub: "Wind it down & hand back",      color: "#d11a1a", deep: "#7a0f0f", flash: "hard" },
};
/* Which cues each kind of commentator gets, in button order. */
const CUE_SET = {
  booth: ["replay", "wrap", "back", "standby"],
  pitch: ["soon", "oncam", "wrap", "standby"],
};
const COMM_LABEL = { booth: "Booth", pitch: "Pitch" };

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
  const [themeName, setThemeName] = useState(getInitialTheme);
  const C = THEMES[themeName] || THEMES.dark;

  useEffect(() => {
    try { localStorage.setItem("tally-theme", themeName); } catch {}
    document.body.style.background = C.bg;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", C.bg);
  }, [themeName, C.bg]);

  const toggleTheme = () => setThemeName((t) => (t === "dark" ? "light" : "dark"));

  const shell = {
    minHeight: "100vh", background: C.bg, color: C.text,
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
    transition: "background .2s, color .2s",
  };

  return (
    <ThemeCtx.Provider value={C}>
      <div style={shell}>
        {screen === "landing" && (
          <Landing room={room} setRoom={setRoom} onPick={setScreen}
            theme={themeName} toggleTheme={toggleTheme} />
        )}
        {screen === "producer" && (
          <Producer room={room} onExit={() => setScreen("landing")}
            theme={themeName} toggleTheme={toggleTheme} />
        )}
        {screen === "camera" && (
          <Camera room={room} onExit={() => setScreen("landing")} />
        )}
        {screen === "commentator" && (
          <Commentator room={room} onExit={() => setScreen("landing")} />
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

/* ---- Landing ------------------------------------------------------ */
function Landing({ room, setRoom, onPick, theme, toggleTheme }) {
  const C = useC();
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
          <RolePick title="I'm a commentator" sub="Booth or pitch — cue flashes on this screen" accent="#8a5cf6" onClick={() => onPick("commentator")} />
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

/* ---- Producer ----------------------------------------------------- */
function Producer({ room, onExit, theme, toggleTheme }) {
  const C = useC();
  const [st, setSt] = useState({});
  const [cams, setCams] = useState({});
  const [names, setNames] = useState({});
  const [pings, setPings] = useState({});
  const [msgs, setMsgs] = useState({});
  const [comm, setComm] = useState({ booth: {}, pitch: {} });
  const [commNames, setCommNames] = useState({ booth: {}, pitch: {} });
  const [commReady, setCommReady] = useState({ booth: {}, pitch: {} });
  const [cues, setCues] = useState({ booth: {}, pitch: {} });
  const [flash, setFlash] = useState(null);
  const stRef = useRef({});
  const seenPings = useRef({});
  const pingReady = useRef(false);
  const seenReady = useRef({});
  const readyInit = useRef(false);

  useEffect(() => {
    const offState = onValue(stateRef(room), (snap) => {
      const s = snap.val() || {};
      stRef.current = s; setSt(s);
    });
    const offCams = onValue(camsRef(room), (snap) => setCams(snap.val() || {}));
    const offNames = onValue(namesRef(room), (snap) => setNames(snap.val() || {}));
    const offPings = onValue(pingsRef(room), (snap) => setPings(snap.val() || {}));
    const offMsgs = onValue(msgsRef(room), (snap) => setMsgs(snap.val() || {}));
    const offComm = onValue(commRootRef(room), (snap) => setComm(normKinds(snap.val())));
    const offCN = onValue(commNamesRootRef(room), (snap) => setCommNames(normKinds(snap.val())));
    const offCR = onValue(commReadyRootRef(room), (snap) => setCommReady(normKinds(snap.val())));
    const offCue = onValue(cueRootRef(room), (snap) => setCues(normKinds(snap.val())));
    return () => { offState(); offCams(); offNames(); offPings(); offMsgs(); offComm(); offCN(); offCR(); offCue(); };
  }, [room]);

  // Detect a brand-new ping → toast stays (below) + a brief screen flash.
  useEffect(() => {
    if (!pingReady.current) {
      for (const [n, p] of Object.entries(pings)) if (p && p.at) seenPings.current[n] = p.at;
      pingReady.current = true;
      return;
    }
    let newest = null;
    for (const [n, p] of Object.entries(pings)) {
      if (!p || !p.at) continue;
      const prev = seenPings.current[n] || 0;
      if (p.at > prev) {
        seenPings.current[n] = p.at;
        if (!newest || p.at > newest.at) newest = { ...p, n };
      }
    }
    if (newest) {
      setFlash({ type: newest.type, n: newest.n, at: newest.at });
      const t = setTimeout(() => setFlash(null), newest.type === "attn" ? 1700 : 1100);
      return () => clearTimeout(t);
    }
  }, [pings]);

  // A pitch commentator tapping "ready" should grab the producer too.
  useEffect(() => {
    const flat = {};
    for (const k of ["booth", "pitch"])
      for (const [n, r] of Object.entries(commReady[k] || {}))
        if (r && r.at) flat[`${k}:${n}`] = r.at;
    if (!readyInit.current) { seenReady.current = flat; readyInit.current = true; return; }
    let fired = false;
    for (const [key, at] of Object.entries(flat))
      if (at > (seenReady.current[key] || 0)) { seenReady.current[key] = at; fired = true; }
    if (fired) {
      setFlash({ color: C.live, hard: false, at: Date.now() });
      const t = setTimeout(() => setFlash(null), 1200);
      return () => clearTimeout(t);
    }
  }, [commReady, C.live]);

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
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.key >= "1" && e.key <= "9") push({ program: parseInt(e.key, 10) });
      else if (e.code === "Space") { e.preventDefault(); take(); }
      else if (e.key === "Escape") push({ program: null });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [push, take, vmix]);

  const saveName = (n, value) => {
    const v = (value || "").trim().slice(0, 18);
    if (v) set(nameRef(room, n), v);
    else remove(nameRef(room, n));
  };
  const clearPing = (n) => remove(pingRef(room, n));
  const sendMsg = (target, text) => {
    const t = (text || "").trim().slice(0, 240);
    if (!t) return;
    set(msgRef(room, target), { text: t, at: Date.now() });
  };
  const clearMsg = (target) => remove(msgRef(room, target));
  const sendCue = (kind, n, type) => set(cueOneRef(room, kind, n), { type, at: Date.now() });
  const clearCommReady = (kind, n) => remove(commReadyRef(room, kind, n));

  const onlineNums = Object.keys(cams).map(Number);
  const namedNums = Object.keys(names).map(Number);
  const highest = Math.max(8, program || 0, preview || 0, ...tLive, ...tPvw, ...onlineNums, ...namedNums, 0);
  const pad = Array.from({ length: highest }, (_, i) => i + 1);

  const activePings = Object.entries(pings)
    .filter(([, p]) => p && p.at)
    .sort((a, b) => b[1].at - a[1].at);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh", maxWidth: 1040, margin: "0 auto", padding: "16px 18px 40px", position: "relative" }}>
      <FlashOverlay flash={flash} />

      <div style={{ ...rowBetween, marginBottom: 14 }}>
        <Logo height={24} />
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
      </div>

      <TopBar room={room} label="Producer" onExit={onExit} extra={`${onlineNums.length} connected`} />

      {/* Ping notifications */}
      {activePings.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
          {activePings.map(([n, p]) => {
            const ready = p.type === "ready";
            const ac = ready ? C.live : C.off;
            return (
              <div key={n} style={{ ...rowBetween, background: C.panel, border: `1px solid ${ac}`, borderRadius: 11, padding: "10px 14px", boxShadow: `0 0 16px ${ac}33` }}>
                <div style={{ ...row, gap: 11 }}>
                  <span style={{ width: 9, height: 9, borderRadius: "50%", background: ac, boxShadow: `0 0 10px ${ac}` }} />
                  <span style={{ fontSize: 14.5, color: C.text }}>
                    <b>{camLabel(Number(n), names)}</b>{" "}
                    <span style={{ color: ac, fontWeight: 700 }}>
                      {ready ? "is ready" : "needs you"}
                    </span>
                  </span>
                </div>
                <button onClick={() => clearPing(n)}
                  style={{ background: "none", border: `1px solid ${C.line}`, color: C.dim, borderRadius: 8, padding: "5px 11px", fontSize: 12.5, cursor: "pointer" }}>
                  Dismiss
                </button>
              </div>
            );
          })}
        </div>
      )}

      {vmix && (
        <div style={{ ...row, gap: 10, marginTop: 12, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: "9px 13px" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: C.live, boxShadow: `0 0 8px ${C.live}` }} />
          <span style={{ fontSize: 13, color: C.dim }}>Driven by vMix — live monitor</span>
        </div>
      )}

      <OnAirSlate program={program} preview={preview} names={names} extraLive={liveSet.size > 1 ? liveSet.size - 1 : 0} />

      {!vmix && (
        <button onClick={take} disabled={preview == null}
          style={{ width: "100%", marginTop: 14, padding: 16, borderRadius: 14, border: "none", cursor: preview == null ? "not-allowed" : "pointer", background: preview == null ? C.panel : C.live, color: preview == null ? C.faint : "#04140a", fontWeight: 800, fontSize: 18, letterSpacing: "0.16em", transition: "background .15s" }}>
          TAKE {preview != null ? `→ CAM ${preview} LIVE` : "(arm a preview first)"}
          <span style={{ display: "block", fontWeight: 500, fontSize: 11, letterSpacing: "0.08em", color: preview == null ? C.faint : "#0a3318", marginTop: 3 }}>or press space</span>
        </button>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 16, marginTop: 22 }}>
        <Pad title="Live" hint={vmix ? "From vMix" : "Cut a camera straight to air"} accent={C.live} nums={pad} activeSet={liveSet} onlineNums={onlineNums} names={names} pings={pings} disabled={vmix}
          onSelect={(n) => push({ program: liveSet.has(n) ? null : n })} />
        <Pad title="Preview" hint={vmix ? "From vMix" : "Arm the next shot — then take"} accent={C.preview} nums={pad} activeSet={pvwSet} onlineNums={onlineNums} names={names} pings={pings} disabled={vmix}
          onSelect={(n) => push({ preview: pvwSet.has(n) ? null : n })} />
      </div>

      <MessagePanel room={room} msgs={msgs} names={names} pad={pad}
        onSend={sendMsg} onClear={clearMsg} />

      <CommentatorPanel comm={comm} commNames={commNames} commReady={commReady}
        cues={cues} onCue={sendCue} onClearReady={clearCommReady} />

      <Roster nums={pad} onlineNums={onlineNums} names={names} pings={pings}
        liveSet={liveSet} pvwSet={pvwSet} onName={saveName} onClearPing={clearPing} />

      <span style={{ fontSize: 12.5, color: C.faint, marginTop: 20 }}>
        Green dot = camera connected. Cameras drop off automatically when they close.
      </span>
    </div>
  );
}

function FlashOverlay({ flash }) {
  const C = useC();
  if (!flash) return null;
  const color = flash.color || (flash.type === "attn" ? C.off : C.live);
  const hard = flash.hard ?? (flash.type === "attn");
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 60, pointerEvents: "none",
      background: `radial-gradient(120% 120% at 50% 50%, ${color}66 0%, ${color}22 55%, transparent 80%)`,
      animation: hard ? "tallyStrobe .42s steps(1) 3" : "tallyFlash 1s ease-out",
    }} />
  );
}

function OnAirSlate({ program, preview, names, extraLive }) {
  const C = useC();
  const live = program != null;
  return (
    <div style={{ marginTop: 16, borderRadius: 18, overflow: "hidden", border: `1px solid ${live ? C.live : C.line}`,
      background: live ? `radial-gradient(120% 140% at 50% 0%, ${C.liveDeep} 0%, #06120a 70%)` : `radial-gradient(120% 140% at 50% 0%, ${C.offDeep} 0%, #120606 70%)`,
      boxShadow: live ? `0 0 40px ${C.live}33` : "none", transition: "all .2s" }}>
      <div style={{ ...rowBetween, padding: "12px 18px", borderBottom: `1px solid ${live ? "#13491f" : "#3a1414"}` }}>
        <span style={{ fontFamily: mono, letterSpacing: "0.3em", fontSize: 12, color: live ? C.live : C.off }}>{live ? "ON AIR" : "OFF AIR"}</span>
        <span style={{ ...row, gap: 8, fontSize: 12.5 }}>
          <span style={{ width: 9, height: 9, borderRadius: "50%", background: preview != null ? C.preview : "#565c66", boxShadow: preview != null ? `0 0 10px ${C.preview}` : "none" }} />
          <span style={{ color: preview != null ? C.preview : "#7d828b", letterSpacing: "0.12em" }}>{preview != null ? `PREVIEW · ${camLabel(preview, names)}` : "NO PREVIEW"}</span>
        </span>
      </div>
      <div style={{ ...fill, padding: "26px 18px 30px", flexDirection: "column" }}>
        {live ? (
          <>
            <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
              <span style={{ color: "#9aa1ab", fontSize: 16, letterSpacing: "0.18em", textTransform: "uppercase" }}>Camera</span>
              <span style={{ fontFamily: mono, fontWeight: 800, fontSize: 96, lineHeight: 0.9, color: "#fff", textShadow: `0 0 26px ${C.live}` }}>{program}</span>
              {extraLive > 0 && <span style={{ color: C.live, fontSize: 15 }}>+{extraLive} more live</span>}
            </div>
            {names && names[program] && (
              <span style={{ marginTop: 8, color: "#fff", fontSize: 18, fontWeight: 600, letterSpacing: "0.04em" }}>{names[program]}</span>
            )}
          </>
        ) : (
          <span style={{ color: "#8a9099", fontSize: 22, letterSpacing: "0.1em" }}>Nothing live</span>
        )}
      </div>
    </div>
  );
}

function Pad({ title, hint, accent, nums, activeSet, onlineNums, names, pings, onSelect, disabled }) {
  const C = useC();
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 16, padding: 16 }}>
      <div style={{ ...rowBetween, marginBottom: 12 }}>
        <div style={{ ...row, gap: 10 }}>
          <span style={{ width: 11, height: 11, borderRadius: "50%", background: accent, boxShadow: `0 0 10px ${accent}` }} />
          <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: "0.04em", color: C.text }}>{title}</span>
        </div>
        <span style={{ fontSize: 12, color: C.faint }}>{hint}</span>
      </div>
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fill, minmax(64px, 1fr))" }}>
        {nums.map((n) => {
          const on = activeSet.has(n);
          const online = onlineNums.includes(n);
          const nm = names && names[n];
          const ping = pings && pings[n];
          return (
            <button key={n} onClick={() => !disabled && onSelect(n)} disabled={disabled}
              style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", aspectRatio: "1 / 1", borderRadius: 11, border: `1.5px solid ${on ? accent : C.line}`, background: on ? accent : C.panelHi, color: on ? C.onAccent : online ? C.text : C.faint, cursor: disabled ? "default" : "pointer", transition: "all .12s", boxShadow: on ? `0 0 18px ${accent}88` : "none", overflow: "hidden", padding: 4 }}>
              <span style={{ fontFamily: mono, fontWeight: 800, fontSize: nm ? 22 : 26, lineHeight: 1 }}>{n}</span>
              {nm && (
                <span style={{ fontSize: 9.5, fontWeight: 600, marginTop: 2, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: on ? 0.85 : 0.95 }}>{nm}</span>
              )}
              {online && <span style={{ position: "absolute", top: 7, left: 7, width: 7, height: 7, borderRadius: "50%", background: on ? C.onAccent : C.live, boxShadow: on ? "none" : `0 0 6px ${C.live}` }} />}
              {ping && (
                <span style={{ position: "absolute", top: 5, right: 6, fontSize: 11, fontWeight: 800, color: on ? C.onAccent : (ping.type === "ready" ? C.live : C.off) }}>
                  {ping.type === "ready" ? "✓" : "!"}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---- Producer: messaging ----------------------------------------- */
function MessagePanel({ room, msgs, names, pad, onSend, onClear }) {
  const C = useC();
  const [target, setTarget] = useState("all");
  const [text, setText] = useState("");

  const active = Object.entries(msgs || {}).filter(([, m]) => m && m.text);

  const send = () => {
    if (!text.trim()) return;
    onSend(target, text);
    setText("");
  };

  const targetLabel = (t) => (t === "all" ? "All cameras" : camLabel(Number(t), names));

  const selectSty = { background: C.panelHi, border: `1px solid ${C.line}`, color: C.text, borderRadius: 9, padding: "10px 11px", fontSize: 14, outline: "none" };

  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 16, padding: 16, marginTop: 22 }}>
      <div style={{ ...row, gap: 10, marginBottom: 12 }}>
        <span style={{ width: 11, height: 11, borderRadius: "50%", background: C.ping, boxShadow: `0 0 10px ${C.ping}` }} />
        <span style={{ fontWeight: 700, fontSize: 15, color: C.text }}>Message to cameras</span>
        <span style={{ fontSize: 12, color: C.faint }}>shows full-screen on the camera display</span>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        <select value={target} onChange={(e) => setTarget(e.target.value)} style={{ ...selectSty, minWidth: 150 }}>
          <option value="all">All cameras</option>
          {pad.map((n) => (
            <option key={n} value={String(n)}>{camLabel(n, names)}</option>
          ))}
        </select>
      </div>

      <textarea value={text} onChange={(e) => setText(e.target.value.slice(0, 240))}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }}
        placeholder="e.g. Going live in 2 mins — get to position"
        rows={2}
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
                <span style={{ fontSize: 11.5, color: C.ping, fontWeight: 700, letterSpacing: "0.04em" }}>{targetLabel(t)}</span>
                <div style={{ fontSize: 14, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.text}</div>
              </div>
              <button onClick={() => onClear(t)}
                style={{ background: "none", border: `1px solid ${C.line}`, color: C.dim, borderRadius: 8, padding: "5px 11px", fontSize: 12.5, cursor: "pointer", flexShrink: 0 }}>
                Clear
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---- Producer: camera roster / naming ---------------------------- */
function Roster({ nums, onlineNums, names, pings, liveSet, pvwSet, onName, onClearPing }) {
  const C = useC();
  const [draft, setDraft] = useState({});
  const [addNum, setAddNum] = useState("");
  const [addName, setAddName] = useState("");

  const valueFor = (n) => (draft[n] !== undefined ? draft[n] : (names[n] || ""));
  const commit = (n) => {
    if (draft[n] !== undefined) {
      onName(n, draft[n]);
      setDraft((d) => { const c = { ...d }; delete c[n]; return c; });
    }
  };

  const addStatic = () => {
    const n = parseInt(addNum, 10);
    if (!n || n < 1) return;
    onName(n, addName);
    setAddNum(""); setAddName("");
  };

  const tagFor = (n) => {
    if (liveSet.has(n)) return { t: "LIVE", c: C.live };
    if (pvwSet.has(n)) return { t: "PVW", c: C.preview };
    return null;
  };

  const inputSty = { flex: 1, minWidth: 0, background: C.panelHi, border: `1px solid ${C.line}`, color: C.text, borderRadius: 8, padding: "8px 11px", fontSize: 14, outline: "none" };

  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 16, padding: 16, marginTop: 16 }}>
      <div style={{ ...row, gap: 10, marginBottom: 12 }}>
        <span style={{ fontWeight: 700, fontSize: 15, color: C.text }}>Cameras</span>
        <span style={{ fontSize: 12, color: C.faint }}>name any camera — even a static one nobody's holding</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {nums.map((n) => {
          const online = onlineNums.includes(n);
          const ping = pings && pings[n];
          const tag = tagFor(n);
          return (
            <div key={n} style={{ ...row, gap: 10 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: online ? C.live : C.faint, boxShadow: online ? `0 0 8px ${C.live}` : "none" }} />
              <span style={{ fontFamily: mono, fontWeight: 800, fontSize: 15, width: 26, color: online ? C.text : C.faint, flexShrink: 0 }}>{n}</span>
              <input
                value={valueFor(n)}
                placeholder={online ? "name this camera" : "static / not connected"}
                onChange={(e) => setDraft((d) => ({ ...d, [n]: e.target.value.slice(0, 18) }))}
                onBlur={() => commit(n)}
                onKeyDown={(e) => { if (e.key === "Enter") { commit(n); e.target.blur(); } }}
                style={inputSty}
              />
              {tag && (
                <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.06em", color: tag.c, flexShrink: 0 }}>{tag.t}</span>
              )}
              {ping && (
                <button onClick={() => onClearPing(n)} title="Clear ping"
                  style={{ flexShrink: 0, background: "none", border: `1px solid ${ping.type === "ready" ? C.live : C.off}`, color: ping.type === "ready" ? C.live : C.off, borderRadius: 7, padding: "4px 9px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>
                  {ping.type === "ready" ? "✓ ready" : "! needs you"}
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
          style={{ background: addNum ? C.panelHi : C.panel, border: `1px solid ${C.line}`, color: addNum ? C.text : C.faint, borderRadius: 8, padding: "8px 14px", fontSize: 13.5, fontWeight: 600, cursor: addNum ? "pointer" : "default" }}>
          Add
        </button>
      </div>
    </div>
  );
}

/* ---- Camera ------------------------------------------------------- */
function Camera({ room, onExit }) {
  const [num, setNum] = useState(null);
  const numRef = useRef(null);
  const [st, setSt] = useState({});
  const [names, setNames] = useState({});
  const [msgs, setMsgs] = useState({});
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [pingFx, setPingFx] = useState(null);
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
    const offState = onValue(stateRef(room), (snap) => setSt(snap.val() || {}));
    const offNames = onValue(namesRef(room), (snap) => setNames(snap.val() || {}));
    const offMsgs = onValue(msgsRef(room), (snap) => setMsgs(snap.val() || {}));
    return () => { offState(); offNames(); offMsgs(); };
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

  const digit = typeof st.tally === "string" ? st.tally[num - 1] : null;
  const mode = digit
    ? (digit === "1" ? "live" : digit === "2" ? "preview" : "off")
    : (num != null && st.program === num ? "live"
      : num != null && st.preview === num ? "preview"
      : "off");

  const view = {
    live: { label: "ON AIR", sub: "You are live", glow: C_live },
    preview: { label: "STAND BY", sub: "You're up next", glow: C_preview },
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
  };

  const saveName = (v) => {
    const val = (v || "").trim().slice(0, 18);
    if (num == null) return;
    if (val) set(nameRef(room, num), val);
    else remove(nameRef(room, num));
  };

  const sendPing = (type) => {
    if (num == null) return;
    set(pingRef(room, num), { type, at: Date.now() });
    setPingFx(type);
    setTimeout(() => setPingFx(null), 1600);
  };

  const goFullscreen = () => {
    try {
      if (document.fullscreenElement) document.exitFullscreen?.();
      else document.documentElement.requestFullscreen?.();
    } catch {}
  };

  const bg = mode === "off" ? `radial-gradient(130% 130% at 50% 40%, ${C_off} 0%, ${C_offDeep} 60%, #1a0606 100%)`
    : mode === "preview" ? `radial-gradient(130% 130% at 50% 40%, ${C_preview} 0%, ${C_previewDeep} 65%, #1a0f00 100%)`
    : `radial-gradient(130% 130% at 50% 40%, ${C_live} 0%, ${C_liveDeep} 60%, #04140a 100%)`;

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

      {/* Producer messages — large for a static gazebo screen */}
      {(mineMsg || broadcast) && (
        <div style={{ position: "absolute", top: 58, left: 18, right: 18, display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
          {mineMsg && <MsgBanner text={mineMsg} tagged />}
          {broadcast && <MsgBanner text={broadcast} />}
        </div>
      )}

      <div style={colCenter}>
        <span style={{ fontSize: 15, letterSpacing: "0.3em", color: "rgba(0,0,0,0.62)", textTransform: "uppercase", marginBottom: 4 }}>Camera</span>
        <span style={{ fontFamily: mono, fontWeight: 800, fontSize: "clamp(120px, 32vw, 280px)", lineHeight: 0.85, color: "#fff", textShadow: mode === "off" ? "0 4px 30px rgba(0,0,0,0.4)" : `0 0 50px ${view.glow}` }}>{num ?? "—"}</span>
        {myName && (
          <span style={{ marginTop: 10, fontWeight: 800, fontSize: "clamp(22px, 6vw, 40px)", letterSpacing: "0.02em", color: "#fff", textShadow: "0 2px 16px rgba(0,0,0,0.4)" }}>{myName}</span>
        )}
        <span style={{ marginTop: 16, fontWeight: 800, fontSize: "clamp(30px, 8vw, 64px)", letterSpacing: "0.08em", color: "#fff", textShadow: "0 2px 18px rgba(0,0,0,0.35)" }}>{view.label}</span>
        <span style={{ marginTop: 6, fontSize: 16, color: "rgba(0,0,0,0.62)", letterSpacing: "0.05em" }}>{view.sub}</span>
      </div>

      {/* Controls */}
      <div style={{ position: "absolute", bottom: 22, width: "100%", display: "flex", justifyContent: "center", padding: "0 16px", boxSizing: "border-box" }}>
        {editing ? (
          <div style={{ ...colCenter, gap: 10, background: "rgba(0,0,0,0.32)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 14, padding: 14, backdropFilter: "blur(3px)", maxWidth: 340, width: "100%" }}>
            <div style={{ ...row, gap: 8 }}>
              <ChromeBtn onClick={() => changeNum((numRef.current || 1) - 1)}>–</ChromeBtn>
              <span style={{ fontFamily: mono, fontWeight: 800, fontSize: 22, color: "#fff", minWidth: 36, textAlign: "center" }}>{num}</span>
              <ChromeBtn onClick={() => changeNum((numRef.current || 0) + 1)}>+</ChromeBtn>
            </div>
            <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value.slice(0, 18))}
              placeholder="name this camera (e.g. Xander)"
              style={{ width: "100%", boxSizing: "border-box", background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.25)", color: "#fff", borderRadius: 9, padding: "10px 12px", fontSize: 15, outline: "none", textAlign: "center" }} />
            <div style={{ ...row, gap: 8 }}>
              <ChromeBtn onClick={() => { saveName(nameDraft); setEditing(false); }}>Save</ChromeBtn>
              <ChromeBtn onClick={() => setEditing(false)}>Cancel</ChromeBtn>
            </div>
          </div>
        ) : (
          <div style={{ ...row, gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
            <ReadyBtn onClick={() => sendPing("ready")} fx={pingFx === "ready"} />
            <PingBtn onClick={() => sendPing("attn")} fx={pingFx === "attn"} />
            <ChromeBtn onClick={() => { setNameDraft(myName || ""); setEditing(true); }}>
              {myName ? "Edit camera" : "Name / number"}
            </ChromeBtn>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---- Producer: commentators -------------------------------------- */
function CommentatorPanel({ comm, commNames, commReady, cues, onCue, onClearReady }) {
  const C = useC();
  const groups = [
    { key: "booth", title: "Booth", hint: "cue flashes only — no comms" },
    { key: "pitch", title: "Pitch / ground", hint: "they tap ready, you cue them on & off" },
  ];
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 16, padding: 16, marginTop: 16 }}>
      <div style={{ ...row, gap: 10, marginBottom: 14 }}>
        <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#8a5cf6", boxShadow: "0 0 10px #8a5cf6" }} />
        <span style={{ fontWeight: 700, fontSize: 15, color: C.text }}>Commentators</span>
        <span style={{ fontSize: 12, color: C.faint }}>flash cues to the booth & pitch iPads</span>
      </div>

      {groups.map((g) => {
        const slots = unionNums(comm[g.key], commNames[g.key]);
        return (
          <div key={g.key} style={{ marginBottom: 14 }}>
            <div style={{ ...rowBetween, marginBottom: 9 }}>
              <span style={{ fontSize: 12.5, fontWeight: 800, letterSpacing: "0.08em", color: C.dim, textTransform: "uppercase" }}>{g.title}</span>
              <span style={{ fontSize: 11.5, color: C.faint }}>{g.hint}</span>
            </div>
            {slots.length === 0 ? (
              <div style={{ fontSize: 13, color: C.faint, padding: "6px 2px 2px" }}>None connected yet.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {slots.map((n) => (
                  <CommentatorRow key={n} kind={g.key} n={n}
                    name={commNames[g.key][n]}
                    online={comm[g.key][n] != null}
                    ready={commReady[g.key][n] && commReady[g.key][n].at ? commReady[g.key][n] : null}
                    cue={cues[g.key][n]}
                    onCue={(type) => onCue(g.key, n, type)}
                    onClearReady={() => onClearReady(g.key, n)} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CommentatorRow({ kind, n, name, online, ready, cue, onCue, onClearReady }) {
  const C = useC();
  const cur = cue && cue.type ? CUE[cue.type] : null;
  return (
    <div style={{ background: C.panelHi, border: `1px solid ${ready ? C.live : C.line}`, borderRadius: 12, padding: "10px 12px", boxShadow: ready ? `0 0 16px ${C.live}33` : "none" }}>
      <div style={{ ...rowBetween, gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <div style={{ ...row, gap: 10, minWidth: 0 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: online ? C.live : C.faint, boxShadow: online ? `0 0 8px ${C.live}` : "none" }} />
          <span style={{ fontWeight: 700, fontSize: 14.5, color: online ? C.text : C.dim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {COMM_LABEL[kind]} {n}{name ? ` · ${name}` : ""}
          </span>
          {cur && <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: "0.05em", color: cur.color, flexShrink: 0 }}>▸ {cur.label}</span>}
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
          const c = CUE[type];
          const activeNow = cue && cue.type === type;
          return (
            <button key={type} onClick={() => onCue(type)}
              style={{ background: activeNow ? c.color : "transparent", border: `1.5px solid ${c.color}`, color: activeNow ? "#fff" : c.color, borderRadius: 9, padding: "8px 13px", fontSize: 13, fontWeight: 800, letterSpacing: "0.02em", cursor: "pointer", transition: "all .12s" }}>
              {c.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---- Commentator device ------------------------------------------ */
function Commentator({ room, onExit }) {
  const [kind, setKind] = useState(null);
  if (!kind) return <CommentatorPick onPick={setKind} onExit={onExit} />;
  return <CommentatorBoard room={room} kind={kind} onExit={onExit} />;
}

function CommentatorPick({ onPick, onExit }) {
  const C = useC();
  return (
    <div style={{ ...colCenter, justifyContent: "center", minHeight: "100vh", padding: "0 24px" }}>
      <div style={{ width: "100%", maxWidth: 460 }}>
        <div style={{ ...row, gap: 10, marginBottom: 6 }}>
          <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#8a5cf6", boxShadow: "0 0 12px #8a5cf6" }} />
          <span style={{ fontFamily: mono, letterSpacing: "0.4em", fontSize: 12, color: C.dim }}>COMMENTATOR</span>
        </div>
        <h1 style={{ fontSize: 34, lineHeight: 1.08, fontWeight: 800, letterSpacing: "-0.02em", margin: "6px 0 6px", color: C.text }}>Where are you?</h1>
        <p style={{ color: C.dim, fontSize: 15, lineHeight: 1.5, marginBottom: 24 }}>
          Pick your position. This screen becomes your cue light.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12 }}>
          <RolePick title="In the booth" sub="Cue flashes: replay, wrap, back to you — plus the live camera" accent="#8a5cf6" onClick={() => onPick("booth")} />
          <RolePick title="On the pitch" sub="Tap ready; get coming-soon, you're-on & wrap-up cues" accent={C.preview} onClick={() => onPick("pitch")} />
        </div>
        <button onClick={onExit} style={{ marginTop: 22, background: "none", border: `1px solid ${C.line}`, color: C.dim, borderRadius: 9, padding: "8px 14px", fontSize: 13, cursor: "pointer" }}>← Back</button>
      </div>
    </div>
  );
}

function CommentatorBoard({ room, kind, onExit }) {
  const [num, setNum] = useState(null);
  const numRef = useRef(null);
  const [st, setSt] = useState({});
  const [camNames, setCamNames] = useState({});
  const [commNames, setCommNames] = useState({ booth: {}, pitch: {} });
  const [cues, setCues] = useState({ booth: {}, pitch: {} });
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [readyFx, setReadyFx] = useState(false);
  const [fx, setFx] = useState(null);
  const lastCueAt = useRef(0);
  const cueReady = useRef(false);
  const wakeRef = useRef(null);

  // Claim the next free slot for this kind.
  useEffect(() => {
    let alive = true;
    (async () => {
      let taken = new Set();
      try {
        const snap = await get(commGroupRef(room, kind));
        taken = new Set(Object.keys(snap.val() || {}).map(Number));
      } catch {}
      let n = 1;
      while (taken.has(n)) n++;
      if (!alive) return;
      numRef.current = n; setNum(n);
      const r = commOneRef(room, kind, n);
      set(r, { joined: Date.now() });
      onDisconnect(r).remove();
    })();
    return () => { alive = false; };
  }, [room, kind]);

  useEffect(() => {
    const offState = onValue(stateRef(room), (snap) => setSt(snap.val() || {}));
    const offCam = onValue(namesRef(room), (snap) => setCamNames(snap.val() || {}));
    const offCN = onValue(commNamesRootRef(room), (snap) => setCommNames(normKinds(snap.val())));
    const offCue = onValue(cueRootRef(room), (snap) => setCues(normKinds(snap.val())));
    return () => { offState(); offCam(); offCN(); offCue(); };
  }, [room]);

  // Keep the iPad awake and clean up presence on leave.
  useEffect(() => {
    const requestWake = async () => { try { wakeRef.current = await navigator.wakeLock.request("screen"); } catch {} };
    requestWake();
    const onVis = () => document.visibilityState === "visible" && requestWake();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      try { wakeRef.current?.release(); } catch {}
      if (numRef.current != null) remove(commOneRef(room, kind, numRef.current));
    };
  }, [room, kind]);

  const cue = num != null ? cues[kind][num] : null;

  // Flash hard on a NEW cue (not on the stale one we load in with).
  useEffect(() => {
    const at = cue && cue.at ? cue.at : 0;
    if (!cueReady.current) { lastCueAt.current = at; cueReady.current = true; return; }
    if (at > lastCueAt.current && cue && CUE[cue.type]) {
      lastCueAt.current = at;
      const c = CUE[cue.type];
      setFx(c);
      const t = setTimeout(() => setFx(null), 1700);
      return () => clearTimeout(t);
    }
  }, [cue]);

  const myName = num != null ? commNames[kind][num] : null;

  const saveName = (v) => {
    const val = (v || "").trim().slice(0, 18);
    if (num == null) return;
    if (val) set(commNameRef(room, kind, num), val);
    else remove(commNameRef(room, kind, num));
  };

  const sendReady = () => {
    if (num == null) return;
    set(commReadyRef(room, kind, num), { at: Date.now() });
    setReadyFx(true);
    setTimeout(() => setReadyFx(false), 1600);
  };

  const goFullscreen = () => {
    try {
      if (document.fullscreenElement) document.exitFullscreen?.();
      else document.documentElement.requestFullscreen?.();
    } catch {}
  };

  const cur = cue && cue.type ? CUE[cue.type] : null;
  const accent = cur ? cur.color : "#5b6472";
  const deep = cur ? cur.deep : "#1a1f27";
  const label = cur ? cur.label : "STANDING BY";
  const sub = cur ? cur.sub : "Waiting for your first cue";
  const wrapPulse = cur && cue.type === "wrap";

  const bg = `radial-gradient(135% 135% at 50% 38%, ${deep} 0%, #06070a 76%)`;

  // Booth sees which camera angle is live (the app drives tally, not video).
  const vmix = st.src === "vmix" || typeof st.tally === "string";
  const { live: tLive, pvw: tPvw } = parseTally(st.tally);
  const program = vmix ? (tLive[0] ?? null) : (st.program ?? null);
  const preview = vmix ? (tPvw[0] ?? null) : (st.preview ?? null);

  return (
    <div style={{ ...colCenter, justifyContent: "center", minHeight: "100vh", background: bg, transition: "background .2s", position: "relative", padding: 24, boxSizing: "border-box" }}>
      <CueFlash fx={fx} />

      {/* Accent border to colour-code the whole screen at a glance */}
      <div style={{ position: "fixed", inset: 0, pointerEvents: "none", border: `7px solid ${accent}`, boxShadow: `inset 0 0 60px ${accent}55`, animation: wrapPulse ? "commWrapPulse 0.7s ease-in-out infinite" : "none", zIndex: 2 }} />

      <div style={{ ...rowBetween, position: "absolute", top: 16, left: 18, right: 18, zIndex: 5 }}>
        <span style={{ fontFamily: mono, letterSpacing: "0.2em", fontSize: 12, color: "rgba(255,255,255,0.55)" }}>
          {COMM_LABEL[kind].toUpperCase()} {num ?? "—"} · ROOM {room}
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <ChromeBtn onClick={goFullscreen}>Fullscreen</ChromeBtn>
          <ChromeBtn onClick={onExit}>Leave</ChromeBtn>
        </div>
      </div>

      <div style={{ ...colCenter, zIndex: 5, textAlign: "center" }}>
        {myName && (
          <span style={{ fontSize: "clamp(18px, 4vw, 26px)", fontWeight: 700, color: "rgba(255,255,255,0.8)", letterSpacing: "0.02em", marginBottom: 14 }}>{myName}</span>
        )}
        <span style={{ fontWeight: 800, fontSize: "clamp(54px, 13vw, 150px)", lineHeight: 0.95, letterSpacing: "-0.01em", color: accent, textShadow: `0 0 55px ${accent}99` }}>{label}</span>
        <span style={{ marginTop: 18, fontSize: "clamp(18px, 4.4vw, 34px)", fontWeight: 600, color: "#fff", letterSpacing: "0.02em" }}>{sub}</span>
      </div>

      {/* Booth: live camera angle readout */}
      {kind === "booth" && (
        <div style={{ position: "absolute", bottom: 24, left: 18, right: 18, display: "flex", justifyContent: "center", gap: 14, flexWrap: "wrap", zIndex: 5 }}>
          <AnglePill tag="ON AIR" color={program != null ? C_live : "#565c66"} n={program} name={camNames[program]} dim={program == null} />
          <AnglePill tag="NEXT" color={preview != null ? C_preview : "#565c66"} n={preview} name={camNames[preview]} dim={preview == null} />
        </div>
      )}

      {/* Controls */}
      <div style={{ position: "absolute", bottom: kind === "booth" ? 86 : 24, width: "100%", display: "flex", justifyContent: "center", padding: "0 16px", boxSizing: "border-box", zIndex: 5 }}>
        {editing ? (
          <div style={{ ...colCenter, gap: 10, background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 14, padding: 14, backdropFilter: "blur(3px)", maxWidth: 340, width: "100%" }}>
            <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value.slice(0, 18))}
              placeholder="your name (e.g. Jonny)"
              style={{ width: "100%", boxSizing: "border-box", background: "rgba(0,0,0,0.35)", border: "1px solid rgba(255,255,255,0.25)", color: "#fff", borderRadius: 9, padding: "10px 12px", fontSize: 15, outline: "none", textAlign: "center" }} />
            <div style={{ ...row, gap: 8 }}>
              <ChromeBtn onClick={() => { saveName(nameDraft); setEditing(false); }}>Save</ChromeBtn>
              <ChromeBtn onClick={() => setEditing(false)}>Cancel</ChromeBtn>
            </div>
          </div>
        ) : (
          <div style={{ ...row, gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
            {kind === "pitch" && (
              <button onClick={sendReady}
                style={{ background: readyFx ? C_live : "rgba(0,0,0,0.35)", border: `1px solid ${readyFx ? C_live : "rgba(255,255,255,0.4)"}`, color: "#fff", borderRadius: 10, padding: "12px 22px", fontSize: 16, fontWeight: 800, letterSpacing: "0.03em", cursor: "pointer", backdropFilter: "blur(2px)", transition: "all .15s" }}>
                {readyFx ? "✓ Producer notified" : "We're ready"}
              </button>
            )}
            <ChromeBtn onClick={() => { setNameDraft(myName || ""); setEditing(true); }}>
              {myName ? "Edit name" : "Add name"}
            </ChromeBtn>
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
      <span style={{ fontWeight: 800, fontSize: 17, color: dim ? "rgba(255,255,255,0.4)" : "#fff" }}>
        {dim ? "—" : `Cam ${n}${name ? ` · ${name}` : ""}`}
      </span>
    </div>
  );
}

function CueFlash({ fx }) {
  if (!fx) return null;
  const anim = fx.flash === "hard" ? "commFlashHard 1.6s steps(1, end)" : "commFlashSoft 1.6s ease-out";
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 80, pointerEvents: "none",
      background: `radial-gradient(120% 120% at 50% 45%, ${fx.color}cc 0%, ${fx.color}55 50%, transparent 82%)`,
      animation: anim }} />
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

function ReadyBtn({ onClick, fx }) {
  return (
    <button onClick={onClick}
      style={{ background: fx ? C_live : "rgba(0,0,0,0.3)", border: `1px solid ${fx ? C_live : "rgba(255,255,255,0.35)"}`, color: "#fff", borderRadius: 9, padding: "9px 16px", fontSize: 14, fontWeight: 800, letterSpacing: "0.03em", cursor: "pointer", backdropFilter: "blur(2px)", transition: "all .15s" }}>
      {fx ? "✓ Sent" : "I'm ready"}
    </button>
  );
}

function PingBtn({ onClick, fx }) {
  return (
    <button onClick={onClick}
      style={{ background: fx ? "#fff" : "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.45)", color: fx ? "#111" : "#fff", borderRadius: 9, padding: "9px 16px", fontSize: 14, fontWeight: 800, letterSpacing: "0.03em", cursor: "pointer", backdropFilter: "blur(2px)", transition: "all .12s", animation: fx ? "tallyBtnFlash .3s steps(1) 3" : "none" }}>
      {fx ? "Pinged!" : "Ping producer"}
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

/* Tally light colours are fixed (red/orange/green) regardless of theme. */
const C_off = ACCENT.off, C_offDeep = ACCENT.offDeep;
const C_preview = ACCENT.preview, C_previewDeep = ACCENT.previewDeep;
const C_live = ACCENT.live, C_liveDeep = ACCENT.liveDeep;
