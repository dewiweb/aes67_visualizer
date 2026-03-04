# AES67 Visualizer

A cross-platform AES67/ST2110-30/RAVENNA audio stream visualization and monitoring application combining the best features from:
- [aes67-stream-monitor](https://github.com/Digisynthetic/aes67-stream-monitor) - Monitoring Wall & i18n
- [aes67-monitor](https://github.com/philhartung/aes67-monitor) - Audio playback & robust SDP parsing

## Features

- **SAP Discovery**: Automatic stream detection via Session Announcement Protocol
- **Manual SDP**: Add streams by pasting SDP data
- **Monitoring Wall**: Drag-and-drop streams to 8-slot monitoring wall
- **Real-time Meters**: dBFS level meters with peak hold
- **Audio Playback**: Listen to any stream with channel selection
- **Multi-language**: 8 languages (EN, FR, DE, ZH, JA, KO, ES, IT)
- **Cross-platform**: Windows, macOS, Linux

## Tech Stack

- **Frontend**: React 18 + TypeScript + Vite + TailwindCSS
- **Desktop**: Electron 33
- **Audio**: Audify (RtAudio bindings)
- **SDP Parsing**: sdp-transform
- **Drag & Drop**: @dnd-kit/core

## Installation

```bash
# Clone the repository
git clone https://github.com/dewiweb/aes67_visualizer.git
cd aes67_visualizer

# Install dependencies
npm install

# Run in development mode
npm run dev:app

# Build for production
npm run build:electron
```

## Architecture

```
├── electron/
│   ├── main.js              # Electron main process
│   ├── preload.js           # Context bridge API
│   └── processes/
│       ├── sdp.js           # SAP/SDP discovery (child process)
│       ├── audio.js         # Audio playback (child process)
│       └── meters.js        # Level monitoring (child process)
├── src/
│   ├── main.tsx             # React entry point
│   ├── App.tsx              # Main application component
│   ├── components/
│   │   ├── Header.tsx       # Top bar with settings
│   │   ├── Sidebar.tsx      # Stream list & manual input
│   │   ├── StreamCard.tsx   # Draggable stream card
│   │   ├── MonitoringWall.tsx  # 8-slot meter wall
│   │   ├── LevelMeter.tsx   # VU meter component
│   │   └── SettingsPanel.tsx   # Settings modal
│   ├── types/
│   │   └── index.ts         # TypeScript definitions
│   └── i18n/
│       └── translations.ts  # Multi-language strings
```

## Protocol Support

| Standard | Support |
|----------|---------|
| AES67 | ✅ Full |
| ST2110-30 | ✅ Full |
| RAVENNA | ✅ Full |
| Dante (via AES67) | ✅ Compatible |

| Format | Support |
|--------|---------|
| L24 (24-bit PCM) | ✅ |
| L16 (16-bit PCM) | ✅ |
| 1-64 channels | ✅ |
| 44.1-192 kHz | ✅ |

## License

MIT License - See LICENSE file for details.

## Credits

- [philhartung/aes67-monitor](https://github.com/philhartung/aes67-monitor) - Audio engine architecture
- [Digisynthetic/aes67-stream-monitor](https://github.com/Digisynthetic/aes67-stream-monitor) - UI/UX inspiration
- [nicolassturmel/aes67-web-monitor](https://github.com/nicolassturmel/aes67-web-monitor) - Original concept
