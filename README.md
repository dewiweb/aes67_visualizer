# AES67 Visualizer

A cross-platform AES67 / ST2110-30 / RAVENNA / Dante audio stream visualization and monitoring application.

## Features

- **SAP/mDNS Discovery**: Automatic detection of AES67, RAVENNA and Dante streams
- **Dante ARC**: Query Dante devices directly (name, model, TX/RX channels, channel names)
- **Device Panel**: Per-device view with expandable TX/RX channel list
- **Monitoring Wall**: Drag-and-drop streams to 8-slot monitoring wall
- **Real-time Meters**: dBFS level meters with peak hold
- **Audio Playback**: Listen to any stream with channel selection
- **PTP Monitoring**: Track IEEE 1588 grandmaster and lock status per stream
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
git clone https://github.com/dewiweb/aes67_visualizer.git
cd aes67_visualizer
npm install
npm run dev:app       # development
npm run build:electron  # production
```

## Architecture

```
electron/
├── main.js                  # Electron main process / IPC orchestration
├── preload.cjs              # Context bridge API
├── processes/
│   ├── discovery.cjs        # mDNS + ARC + RTSP discovery (child process)
│   ├── sdp.cjs              # SAP/SDP multicast listener (child process)
│   ├── audio.cjs            # RTP audio playback (child process)
│   ├── meters.cjs           # Level monitoring (child process)
│   └── ptp.cjs              # PTP IEEE 1588 monitoring (child process)
└── protocols/
    ├── arc.cjs              # Dante ARC binary UDP protocol (port 4440)
    ├── rtsp.cjs             # RAVENNA RTSP stream discovery (RFC 2326)
    ├── mdns.cjs             # mDNS/DNS-SD via dns-sd.exe (Windows)
    ├── sap.cjs              # SAP RFC 2974 multicast socket
    ├── aes67.cjs            # AES67 SDP validation & PTP parsing
    └── ravenna.cjs          # RAVENNA device helpers & RTSP path builder
src/
├── components/
│   ├── DevicePanel.tsx      # Per-device view with ARC channel names
│   ├── MonitoringWall.tsx   # 8-slot monitoring wall
│   └── ...
└── types/index.ts           # TypeScript definitions incl. DanteDevice
```

## Protocol Support

### Audio Formats

| Format | Support |
|--------|---------|
| L24 (24-bit PCM) | ✅ |
| L16 (16-bit PCM) | ✅ |
| 1–64 channels | ✅ |
| 44.1 / 48 / 88.2 / 96 / 192 kHz | ✅ |

### Protocol Matrix

| Standard | Discovery | Audio Transport | Control | PTP |
|----------|-----------|-----------------|---------|-----|
| **AES67** | SAP `239.255.255.255:9875` | RTP multicast `239.x.x.x` | — | PTPv2 IEEE 1588-2008 |
| **RAVENNA** | mDNS `_ravenna._tcp` + SAP | RTP multicast `239.x.x.x:5004` | RTSP `:554` | PTPv2 IEEE 1588-2008 |
| **Dante native** | mDNS `_netaudio-arc._udp` | RTP unicast/multicast `239.x.x.x:4321` | ARC UDP `:4440` | **PTPv1** IEEE 1588-2002 |
| **Dante AES67** | SAP `239.255.255.255:9875` | RTP multicast `239.x.x.x` | ARC UDP `:4440` | PTPv2 IEEE 1588-2008 |
| **ST2110-30** | SDP out-of-band | RTP multicast | NMOS IS-05 | PTPv2 IEEE 1588-2008 |

---

## Network Port Reference

### AES67 / RAVENNA

| Port | Protocol | Direction | Usage |
|------|----------|-----------|-------|
| `9875` UDP | SAP RFC 2974 | multicast `239.255.255.255` | Stream announcements (SDP) |
| `5353` UDP | mDNS | multicast `224.0.0.251` | Device discovery DNS-SD |
| `554` TCP | RTSP RFC 2326 | unicast | SDP retrieval (`/by-name/<stream>`, `/by-id/<n>`) |
| `5004` UDP | RTP RFC 3550 | multicast `239.x.x.x` | Audio transport (default RAVENNA port) |
| `319` UDP | PTPv2 event | multicast `224.0.1.129` | PTP sync, delay-req messages |
| `320` UDP | PTPv2 general | multicast `224.0.1.129` | PTP announce, follow-up messages |

### Dante Native

| Port | Protocol | Direction | Usage |
|------|----------|-----------|-------|
| `5353` UDP | mDNS | multicast `224.0.0.251` | Device discovery (`_netaudio-arc._udp`, `_netaudio-chan._udp`, etc.) |
| `4440` UDP | ARC (binary) | unicast | Device control: name, channels, subscriptions |
| `4455` UDP | DBCP flows | unicast | RTP flow creation/deletion (`start_code=0x1102`) |
| `8700` UDP | Settings | unicast | Device settings (sample rate, latency…) |
| `8702` UDP | Device info | multicast `224.0.0.231` | Device info, routing state |
| `8708` UDP | Heartbeat | multicast `224.0.0.233` | Keep-alive |
| `8751` UDP | Metering | multicast `224.0.0.231` | VU-meter data |
| `8800` UDP | CMC clock | unicast | Clock domain management |
| `4321` UDP | RTP | multicast `239.x.x.x` | Audio transport (native Dante multicast) |
| `319/320` UDP | **PTPv1** | multicast `224.0.1.129` | IEEE 1588-**2002** — **incompatible with PTPv2** |

### Dante AES67 mode (differences vs native)

| Aspect | Dante native | Dante AES67 |
|--------|-------------|-------------|
| Stream announcement | mDNS only | + SAP `239.255.255.255:9875` (keyword `k=Dante`) |
| Audio transport | unicast + multicast | multicast **only** |
| Audio port | `4321` (fixed) | dynamic (from SDP) |
| PTP version | **PTPv1** (1588-2002) | **PTPv2** (1588-2008) |
| Codec | proprietary | L16/L24, 48kHz only |
| Activation | — | `MESSAGE_TYPE_AES67_CONTROL` via ARC `:4440` |

> ⚠️ **PTP conflict risk**: Dante native (PTPv1) and RAVENNA/AES67 (PTPv2) cannot share a PTP grandmaster. Running both on the same network segment without VLAN isolation can destabilize clock sync for all devices.

---

## Dante ARC Protocol

The ARC (Audio Routing Control) protocol uses a binary UDP format on port 4440.

**Packet header (10 bytes, big-endian):**
```
start_code(2=0x27FF) + total_length(2) + seqnum(2) + opcode(2) + result_code(2) + content[]
```

**Key opcodes:**

| Opcode | Description |
|--------|-------------|
| `0x1000` | Channel count (TX + RX) |
| `0x1002` | Device name |
| `0x1003` | Device info (board, revision, hostname) |
| `0x2000` | TX channel list (paginated) |
| `0x2010` | TX channel friendly names |
| `0x3000` | RX channel list + subscription status |
| `0x3010` | Set channel subscriptions (routing) |
| `0x2201` | Create multicast TX flow |
| `0x3200` | Query RX flows |

**Result codes:** `0x0001` = OK, `0x8112` = OK (more pages), `0x0022` = error

---

## Sources & References

### Open Source Projects Studied

| Project | Language | What it provided |
|---------|----------|-----------------|
| [philhartung/aes67-monitor](https://github.com/philhartung/aes67-monitor) | JS | SAP/SDP parsing architecture, audio engine |
| [Digisynthetic/aes67-stream-monitor](https://github.com/Digisynthetic/aes67-stream-monitor) | JS | UI/UX inspiration, i18n |
| [chris-ritsen/network-audio-controller](https://github.com/chris-ritsen/network-audio-controller) | Python | Dante ARC protocol opcodes, packet format, const.py |
| [teodly/inferno](https://github.com/teodly/inferno) (mirror of [lumifaza/inferno](https://gitlab.com/lumifaza/inferno)) | Rust | ARC packet header layout, pagination (`0x8112`), flows control port 4455, mDNS service types `_netaudio-chan`, `_netaudio-bund` |
| [soundondigital/ravennakit](https://github.com/soundondigital/ravennakit) | C++ | RAVENNA RTSP paths (`/by-name/`, `/by-id/`), RTP port 5004, PTPv2 profiles, DNS-SD service types |
| [bondagit/aes67-linux-daemon](https://github.com/bondagit/aes67-linux-daemon) | C++ | AES67 reference implementation |

### Standards & Specifications

| Standard | Description |
|----------|-------------|
| AES67-2023 | Audio over IP interoperability standard (L16/L24, PTPv2, SAP/SDP) |
| IEEE 1588-2008 (PTPv2) | Precision Time Protocol v2 — used by AES67, RAVENNA, Dante AES67 |
| IEEE 1588-2002 (PTPv1) | Precision Time Protocol v1 — used by Dante native |
| RFC 2974 | Session Announcement Protocol (SAP) — multicast `239.255.255.255:9875` |
| RFC 2326 | Real Time Streaming Protocol (RTSP) — used by RAVENNA |
| RFC 3550 | RTP: A Transport Protocol for Real-Time Applications |
| SMPTE ST 2110-30 | Professional Media over Managed IP Networks — Audio |

### Test Devices (local network)

| Device | Protocol | IP | Notes |
|--------|----------|----|-------|
| Lawo MADI4 | RAVENNA/AES67 | `192.168.100.228` | 64ch MADI, announces via SAP |
| Lawo MC²36 | RAVENNA/AES67 | `192.168.100.229` | Console, multiple SAP streams |
| Shure AD4Q-I | Dante (AES67) | `192.168.100.213` | 64TX/1RX, ARC responds with channel names (HF1–HF64) |
| Shure AD4Q-II | Dante (AES67) | `192.168.100.214` | 64TX/1RX, ARC responds with channel names (HF5–HF8…) |

---

## License

MIT License — See LICENSE file for details.
