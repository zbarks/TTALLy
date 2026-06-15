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
- Cameras: open the same URL on each phone/tablet → **I'm a camera**.
  Each device auto-grabs the next free number (Camera 1, 2, 3...).
- Everyone must be on the same **room** (default `MAIN`).

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
