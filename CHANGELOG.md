# Changelog

## v1.5.1 — 2025-08-14

### Major dependency upgrades

| Package | Before | After | Notes |
|---------|--------|-------|-------|
| Electron | 33.4.11 | 43.4.0 | `main.js` → `main.cjs` (CJS), Node 24.18.1 internal |
| React | 18.3.1 | 19.2.8 | |
| TypeScript | 5.6.3 | 7.0.2 | `vite-env.d.ts` added for CSS imports |
| Vite | 6.4.1 | 8.2.1 | Rolldown bundler, `@rolldown/binding-win32-x64-msvc` required |
| @vitejs/plugin-react | 4.3.3 | 6.0.5 | |
| Tailwind CSS | 3.4.15 | 4.3.3 | `@tailwindcss/postcss` plugin, `@import "tailwindcss"` syntax |
| lucide-react | 0.460.0 | 1.31.0 | |
| sdp-transform | 2.14.2 | 3.0.0 | |
| @dnd-kit/sortable | 8.0.0 | 10.0.0 | |
| sharp | 0.34.5 | 0.35.3 | |
| electron-builder | 25.1.8 | 26.15.3 | |
| @types/node | 22.0.0 | 26.2.0 | |
| @types/react | 18.3.12 | 19.2.18 | |
| @types/react-dom | 18.3.1 | 19.2.4 | |

**electron-store** remains at 8.x (CJS) — v11 is ESM-only and incompatible with `main.cjs`.

### New features

- **Auto-play**: Settings panel toggle to save SDP + channel mapping (ch1/ch2) + audio output device.
  On next startup, the manual stream is restored and playback starts automatically.
  Reconnects after 2s if playback drops unexpectedly (network glitch, interface change).
  Manual stop is respected — auto-play won't override a user-initiated stop.
- **Manual SDP modal**: "+" button in monitoring header opens a modal to paste SDP directly.
  Separate edit mode pre-fills with the stream's existing SDP. Works without SAP discovery.
- **Manual badge + edit/remove buttons**: Green "Manual" badge on StreamCard for manual streams.
  Pencil (edit) and trash (remove) buttons visible on all stream cards.
- **Manual streams in monitoring view**: SAP + manual streams shown together in left list,
  draggable to monitoring wall.
- **Persistence**: Manual streams saved via `store.set('manualStreams')` in main process,
  restored at startup with their raw SDP.

### Bug fixes

- **Audio stop/replay loop**: Auto-play logic moved from `useEffect` (which caused infinite
  stop/replay cycles when streams updated) to direct IPC event handlers (`onStreamsUpdate`,
  `onAudioStatus`). Uses refs (`playingStreamIdRef`, `streamsRef`, `settingsRef`) instead of
  state to avoid stale closures and race conditions.
- **Interface change audio hang**: When switching network interface (VLAN change), the audio
  process now receives a `stop` message. Previously it stayed bound to the old interface and
  couldn't be restarted.
- **UDP socket close timeout**: `stopThen()` in `audio.cjs` now has a 500ms fallback timeout
  on `socket.close()`. If the OS doesn't release the port, playback proceeds anyway instead
  of hanging forever.
- **Socket rebinding delay**: 100ms delay after stop before binding new socket, to let the
  OS release the UDP port and avoid ghost packets.
- **Manual stop flag**: `manualStopRef` prevents auto-play reconnection when the user
  intentionally stops playback. Reset to `false` on next manual play.

### Build & packaging

- **Windows release**: NSIS installer (`AES67 Visualizer Setup 1.5.1.exe`, 112 MB) +
  portable exe (`AES67 Visualizer 1.5.1.exe`, 112 MB). Both signed with signtool.
- **Build workaround**: `release/` directory in project root gets EPERM errors on Windows
  (antivirus/OneDrive lock). Build to `%TEMP%` and copy:
  ```bash
  npx electron-builder --win --config.directories.output="%TEMP%\aes67-release"
  ```
- **Node.js requirement**: Vite 8 requires Node.js 22.12+. Use nvm:
  ```bash
  nvm install 22.12.0
  nvm use 22.12.0
  ```
- **Electron 43 install workaround**: `@electron/get` v5 is ESM-only but `electron/install.js`
  uses `require()`. Manual binary download required:
  ```bash
  node _dl_electron.cjs   # downloads via @electron/get API, extracts to node_modules/electron/dist/
  ```

### Files changed

- `electron/main.js` → `electron/main.cjs` (CJS conversion for Electron 43 ESM compatibility)
- `electron/processes/audio.cjs` — stop/replay fixes, socket close timeout, rebinding delay
- `src/App.tsx` — auto-play via IPC handlers (no useEffect), `playingStreamIdRef`,
  `streamsRef`, `settingsRef`, `manualStopRef`
- `src/components/SettingsPanel.tsx` — auto-play toggle UI
- `src/components/MainPanel.tsx` — SDP modal, manual streams in list, edit/remove buttons
- `src/components/StreamCard.tsx` — manual badge, edit/remove buttons
- `src/components/NavRail.tsx` — SDP tab removed, `manualCount` prop removed
- `src/types/index.ts` — `AutoPlayConfig` type
- `src/vite-env.d.ts` — CSS module declaration (TS7 fix)
- `postcss.config.js` — `@tailwindcss/postcss` plugin (Tailwind 4)
- `src/index.css` — `@import "tailwindcss"` + `@config` (Tailwind 4)
- `tsconfig.json` — `noUnusedLocals`/`noUnusedParameters` set to `false` (TS7 strictness)
- `electron/preload.cjs` — auto-play IPC channels
