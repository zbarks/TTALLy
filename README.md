# Tally

Browser-based tally lights for a multi-camera shoot. One producer screen
picks what's live; every camera device shows a full-screen light. Drive it
by hand, or let **vMix** drive it automatically.

Colours: **red = off · orange = preview · green = live**

Firebase is already wired in (project `tachartastally`). Nothing to configure.

---

## Deploy the site (one time)

```bash
npm install
git init && git add -A && git commit -m "tally"
# create a repo on GitHub, then:
git remote add origin <your-repo-url>
git push -u origin main
```

Import the repo at vercel.com → New Project. It auto-detects Vite, no
settings to change. You'll get a URL like `https://tally-xxxx.vercel.app`.

Run locally first if you want: `npm run dev`.

## Use it

- Producer: open the URL on a laptop → **I'm the producer**.
- Cameras / commentary: open the URL on each device → **I'm a camera**, then
  pick what the screen is:
  - **Camera operator** — full-screen tally light. Buttons: *I'm ready*,
    *Good shot*, *Message* (free text to the producer).
  - **Booth commentary** — the screen shows your live status automatically
    (it goes green the instant your vMix input is cut to air). The producer
    drops messages on top: *Replay incoming*, *Wrap*, *Transfer to ground*,
    *Stand by*. No buttons to press — set which vMix input is pointed at you
    once, and it follows.
  - **Pitch commentary** — same auto live status, plus a big **WE'RE READY**
    button and a *Message* button. The producer cues you with *Coming to you*
    and *Wrap up*. When your input drops off air it returns to stand by on its
    own.
- Everyone must be on the same **room** (default `MAIN`).

The producer suite **does not control vMix** — vMix drives the real tally.
The producer can click extra cameras into live/preview as their own flags
(shown with a dot), send messages, and cue commentators, all layered on top
of whatever vMix is doing. Everyone sees the union.

### Sticky sessions & end-of-day reset

Each device remembers what it was in that room. If Camera 1 (Xander) closes
the tab or his phone sleeps, reopening the URL shows a **Resume as Camera 1**
button — and even if he goes the long way round (I'm a camera → Camera
operator), he reclaims **1**, not the next free number. Same for commentary
screens (slot + vMix input are remembered).

At the end of the day the producer hits **↻ Reset day** (top-right). That
wipes every camera, name, message, flag and commentator setup for the room and
bumps a hidden "epoch", which invalidates everyone's saved session at once —
connected devices re-join with fresh numbers automatically. Sticky sessions
are per-browser, so a device only resumes on the same phone/laptop it was set
up on.

### Shortcuts (Stream Deck)

Single keys, listed under **Keyboard / Stream Deck shortcuts** in the producer.
`1–9` cut a camera live, `Shift+1–9` arm preview, `Space` takes, `0`/`Esc`
clears your live flags. Letters `Z X C V B` drive the first booth commentator
(replay / wrap / transfer / stand by / clear) and `N M ,` drive the first pitch
commentator (coming to you / wrap / clear).

Tap a number on the Live pad and that camera flashes green. Arm one on
Preview (orange), then **Take** (or spacebar) to cut it live.

## Drive it with vMix

1. In vMix: **Settings → Web Controller → tick Enabled** (turns on the TCP
   API on port 8099). If the bridge runs on a *different* PC, also untick
   "Enable enhanced security on Web and TCP API" and allow port 8099
   through Windows Firewall.
2. On the vMix PC, run the bridge (Node required, no installs):

   ```bash
   node vmix-tally-bridge.js
   ```

   You'll see "Connected to vMix" and tally lines as you switch. Leave the
   window open. The producer screen flips to a live monitor automatically,
   and Camera N follows vMix input N.

## Important: Firebase rules

Test mode expires after 30 days. In the Firebase console →
Realtime Database → Rules, paste this so it doesn't lock mid-show:

```json
{ "rules": { "rooms": { ".read": true, ".write": true } } }
```

(This is a private studio tool, so open rules on the `rooms` tree are fine.
Lock it down further later if you ever expose it publicly.)
