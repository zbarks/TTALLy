/* ============================================================ *
 *  vMix → Firebase tally bridge
 *
 *  Run this on the vMix PC:   node vmix-tally-bridge.js
 *  It reads vMix's tally (TCP 8099) and mirrors it into Firebase,
 *  where the deployed tally site is already listening. No installs
 *  needed beyond Node itself — uses built-in net + https only.
 *
 *  Leave the window open during the show. Closing it stops the bridge.
 * ============================================================ */

const net = require("net");
const https = require("https");

/* ---- config ---- */
const VMIX_HOST = "127.0.0.1"; // vMix machine. Leave as-is if the bridge runs ON the vMix PC.
const VMIX_PORT = 8099; // fixed vMix TCP API port. Do not change.
const ROOM = "MAIN"; // must match the room your lights join.
const FIREBASE_DB_URL =
  "https://tachartastally-default-rtdb.europe-west1.firebasedatabase.app";

/* ---- push tally up to Firebase (Realtime DB REST PUT) ---- */
let lastSent = "";
function pushState(tally) {
  if (tally === lastSent) return; // only write on actual change
  lastSent = tally;

  const live = [];
  const preview = [];
  for (let i = 0; i < tally.length; i++) {
    if (tally[i] === "1") live.push(i + 1);
    if (tally[i] === "2") preview.push(i + 1);
  }

  const body = JSON.stringify({
    tally,
    program: live[0] ?? null,
    preview: preview[0] ?? null,
    live,
    src: "vmix",
    at: Date.now(),
  });

  const url = new URL(`${FIREBASE_DB_URL}/rooms/${ROOM}/state.json`);
  const req = https.request(
    url,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    (res) => {
      res.resume();
      if (res.statusCode >= 300) console.error(`  Firebase responded ${res.statusCode}`);
      else console.log(`  -> pushed tally ${tally}  (live: ${live.join(",") || "none"})`);
    }
  );
  req.on("error", (e) => console.error("  Firebase push failed:", e.message));
  req.write(body);
  req.end();
}

/* ---- vMix TCP connection with auto-reconnect ---- */
let backoff = 1000;
function connect() {
  const sock = new net.Socket();
  let buffer = "";
  sock.setEncoding("utf8");

  sock.connect(VMIX_PORT, VMIX_HOST, () => {
    console.log(`Connected to vMix at ${VMIX_HOST}:${VMIX_PORT}`);
    backoff = 1000;
    sock.write("SUBSCRIBE TALLY\r\n");
    sock.write("TALLY\r\n");
  });

  sock.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\r\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);
      if (line.startsWith("TALLY OK ")) {
        const digits = line.slice("TALLY OK ".length).trim();
        if (/^[0-9]*$/.test(digits)) pushState(digits);
      }
    }
  });

  const retry = (why) => {
    console.error(`vMix connection ${why}. Reconnecting in ${backoff / 1000}s...`);
    sock.destroy();
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  };

  sock.on("error", (e) => retry(`error: ${e.message}`));
  sock.on("close", () => retry("closed"));
}

console.log(`vMix -> Firebase tally bridge  ·  room ${ROOM}`);
connect();
