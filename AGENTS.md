# AGENTS.md — AES67 Visualizer

## Build & Run Commands

```bash
# Development (Vite dev server + Electron)
npm run dev:app

# Production build (Vite + electron-builder)
npm run build:win      # Windows: NSIS installer + portable exe
npm run build:linux    # Linux: AppImage
npm run build:mac      # macOS: DMG

# Vite build only (no packaging)
npm run build

# Type check
npx tsc --noEmit
```

## Node.js Version

Vite 8 requires Node.js 22.12+. The system uses nvm (Windows):

```bash
nvm use 22.12.0
```

If the agent shell doesn't pick up the nvm change, use the direct path:
```powershell
$env:PATH = "$env:APPDATA\nvm\v22.12.0;$env:APPDATA\npm;$env:PATH"
```

## Windows Build Workaround

The `release/` directory in the project root gets EPERM errors during electron-builder
(antivirus/OneDrive file lock). Build to a temp directory instead:

```bash
npx electron-builder --win --config.directories.output="%TEMP%\aes67-release"
```

Then copy the output files back to `release/`.

## Key Architecture Notes

- `electron/main.cjs` is **CommonJS** (not ESM) — Electron 43 works with CJS.
- `electron-store` stays at v8 (CJS). v11 is ESM-only and breaks `require()`.
- `package.json` does NOT have `"type": "module"` — this is intentional for CJS compat.
- Tailwind 4 uses `@tailwindcss/postcss` plugin (not `tailwindcss` directly in postcss.config.js).
- Tailwind 4 CSS: `@import "tailwindcss"` + `@config "../tailwind.config.js"` (not `@tailwind` directives).
- `@rolldown/binding-win32-x64-msvc` must be installed explicitly (Vite 8 npm optional dep bug).

## Auto-play Implementation

Auto-play is handled via **IPC event handlers**, NOT useEffect:
- `onStreamsUpdate`: starts playback the first time the manual stream appears (guarded by `autoPlayStreamIdRef`)
- `onAudioStatus`: reconnects if playback stops unexpectedly (guarded by `playingStreamIdRef` and `manualStopRef`)
- `handlePlayStream`: sets `manualStopRef = true` on manual stop, `false` on manual play

Refs used to avoid stale closures: `playingStreamIdRef`, `streamsRef`, `settingsRef`, `autoPlayConfigRef`, `autoPlayStreamIdRef`, `manualStopRef`.

## Network Environment

- VLAN 10 (control): 192.168.10.x — PC at .115, Lawo MC² at .51
- VLAN 20 (audio): 192.168.20.x — PC at .67, devices at .15-.93
- SAP multicast 239.255.255.255:9875 does NOT cross VLANs
- mDNS 224.0.0.251 IS forwarded between VLANs by the router
- Active RTP stream: 230.20.10.20:5004 (TX-Rav3-ST-04, L24/48000/2)
