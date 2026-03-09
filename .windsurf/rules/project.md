---
trigger: always_on
---

# AES67 Visualizer — Windsurf Project Rules

## Project Overview
Cross-platform AES67 / ST2110-30 / RAVENNA / Dante audio stream visualization and monitoring app.
Built with Electron 33 + React 18 + TypeScript + TailwindCSS.

## Architecture
- `electron/main.js` — Electron main process, IPC orchestration
- `electron/preload.cjs` — Context bridge API
- `electron/processes/` — Child processes: discovery, sdp, audio, meters, ptp
- `electron/protocols/` — Protocol implementations: arc, rtsp, mdns, sap, aes67, ravenna
- `src/components/` — React UI components
- `src/types/index.ts` — Shared TypeScript types

## Key Design Decisions
- Device registry keyed by IP address (not hostname) to avoid duplicates
- All discovery sources (mDNS, ARC, RTSP, SAP) merge into one device via `upsert()`/`mergeDevice()`
- SAP multicast socket binds on `0.0.0.0` on Linux, interface IP on Windows
- mDNS uses `dns-sd` on Windows/macOS, `avahi-browse` on Linux
- PTP ports 319/320 require `cap_net_bind_service` on Linux AppImage

## Reference Source Repositories

The following repositories were studied as protocol and architecture references.
No source code was copied. This project remains under MIT License.

### philhartung/aes67-monitor
- **URL**: https://github.com/philhartung/aes67-monitor
- **License**: MIT
- **Language**: JavaScript / Electron
- **Scope**: Cross-platform AES67/RAVENNA/ST2110-30 monitoring. Tested primarily on macOS, also Windows.
- **Key learnings**:
  - SAP socket bind on port 9875, multicast group `239.255.255.255`
  - SAP session ID derived from SDP `o=` line (MD5 hash)
  - SAP announcement format: `header(8B) + "application/sdp\0" + SDP body`
  - Stream timeout: 5 minutes for non-refreshed SAP sessions
  - `sdp-transform` npm library for SDP parsing
  - RTP audio playback via `audify` (RtAudio Node.js bindings)
  - Jitter buffer for RTP reassembly before audio output
  - Multicast RTP socket bind on `0.0.0.0:5004`
  - Supports: L16/L24, 48kHz/96kHz, up to 64 channels, all AES67 packet times
  - Stream filtering and sorting UI
  - Channel selection: stereo pairs + individual mono channels
  - Settings: network interface, audio device, RTP buffer, packet time

### Digisynthetic/aes67-stream-monitor
- **URL**: https://github.com/Digisynthetic/aes67-stream-monitor
- **License**: Proprietary (architecture reference only — no code used)
- **Language**: JavaScript / Electron
- **Key learnings**:
  - `SapDiscovery` class as Node.js EventEmitter pattern
  - Monitoring Wall UI concept (drag-and-drop stream slots)
  - i18n multi-language architecture
  - Level polling via UDP JSON on port 8999 (`getVolumeDbBatchIn`)
  - RMS level calculation over L24 PCM samples
  - Stream timeout 120s (shorter than philhartung's 5min)

### chris-ritsen/network-audio-controller
- **URL**: https://github.com/chris-ritsen/network-audio-controller
- **License**: MIT
- **Language**: Python (`netaudio` pip package)
- **Scope**: Full CLI Dante device controller — routing, naming, gain, latency, encoding.
- **Key learnings — ARC protocol**:
  - Binary format (big-endian): `start_code(0x27FF) + total_length(2) + seqnum(2) + opcode(2) + result_code(2) + content[]`
  - ARC UDP port: `4440` (from `_netaudio-arc._udp` mDNS service)
  - Reset device name: `27ff000affff10010000` → response `27ff000affff10010001`
  - Set device name "a": `27ff000bffff100100004100` (ASCII + null terminator, max 31 chars)
  - Set latency 1ms: starts with `27ff0028ffff11010000...`
  - Set latency 5ms: starts with `27ff0028ffff11010000...004c4b40004c4b40`
  - Sample rate change on port **8700** (not mDNS-advertised), no response expected
    - 48kHz packet: `ffff002803d4...0000bb80`
    - 192kHz packet: `ffff002803d4...0002ee00`
  - Encoding set: 16, 24, 32-bit via `_netaudio-arc._udp` port
- **Key learnings — mDNS TXT fields** (from JSON device dump):
  - `arcp_vers`: ARC protocol version (e.g. `"2.7.41"`)
  - `arcp_min`: minimum ARC version (e.g. `"0.2.4"`)
  - `router_vers`: firmware version (e.g. `"4.0.2"`)
  - `router_info`: model string (e.g. `"DAO2"`)
  - `mf`: manufacturer (e.g. `"Audinate"`)
  - `model`: model ID (e.g. `"DAO2"`)
  - `id`: MAC address (from `_netaudio-cmc._udp`, e.g. `"001dc1fffe506217"`)
  - `cmcp_vers` / `cmcp_min`: CMC protocol version
  - `server_vers`: server version
  - `channels`: bitmask (e.g. `"0x6000004d"`)
- **Key learnings — subscription model**:
  - Subscription status text: `"Subscription unresolved"`, `"Subscribed"`, `"Dangling"`, etc.
  - Subscription has: `rx_channel`, `rx_device`, `tx_channel`, `tx_device`, `status_text`
  - RX channel max name length: implied from ARC opcode responses
- **Key learnings — AVIO gain control** (port 8700):
  - AVIO Input levels: `1=+24dBu`, `2=+4dBu`, `3=+0dBu`, `4=0dBV`, `5=-10dBV`
  - AVIO Output levels: `1=+18dBu`, `2=+4dBu`, `3=+0dBu`, `4=0dBV`, `5=-10dBV`
- **Other ports** observed: `24440`, `24455` (Dante Via alternate ports)

### teodly/inferno (mirror of lumifaza/inferno)
- **URL**: https://github.com/teodly/inferno
- **License**: GPL-3.0 (protocol reference only — no code included)
- **Language**: Rust
- **Scope**: Unofficial Linux Dante protocol implementation (virtual soundcard for ALSA).
- **Key learnings — Dante device identity**:
  - Device ID format: `0000<IP_address_hex>0000` (8 bytes, MAC-style), e.g. for 192.168.1.1 → `0000c0a801010000`
  - `PROCESS_ID`: integer 0–65535, must be unique per IP when running multiple instances
  - Alternate ports: `ALT_PORT` to `ALT_PORT+3` (min 4 ports, best to reserve 10)
- **Key learnings — PTP**:
  - Dante native uses **PTPv1** — requires a PTPv1 daemon (Statime fork)
  - Can switch to **PTPv2** in config → allows Inferno to act as PTP master
  - AES67 mode on Dante device required for PTPv2 interop between Inferno and Dante
  - Hardware timestamping: set `CLOCK_PATH=/dev/ptp0`; check NIC support with `ethtool -T`
  - Disable `chronyd`/`systemd-timesyncd`/`ntpd` for stable PTP
  - CPU scaling governor can cause jitter — disable with `sysctl -w kernel.perf_cpu_time_max_percent=0`
- **Key learnings — latency parameters**:
  - `RX_LATENCY_NS`: receive buffer in ns (default 10ms)
  - `TX_LATENCY_NS`: transmit latency demand in ns (default 10ms)
- **Key learnings — mDNS / protocol**:
  - ARC packet header layout and field offsets
  - Pagination via result code `0x8112`
  - Flow creation via port `4455` (DBCP): `start_code=0x1102`
  - `_netaudio-chan._udp`: per-TX-channel, not present on all hardware
  - `_netaudio-bund._udp`: multicast bundle flows
  - Full list: `_netaudio-arc._udp`, `_netaudio-cmc._udp`, `_netaudio-dbc._udp`
  - Tested with: AVIO AES3, AVIO-DAI2, Brooklyn II/III, Broadway, Orban, Allen&Heath SQ, Soundcraft Vi
- **Key learnings — other open-source Dante projects** (found via inferno README):
  - `companion-module-audinate-dantecontroller` (Bitfocus Companion) — routing control
  - `dante-aes67-relay.js` (philhartung gist) — relay Dante multicast to AES67
  - `wycliffe` (jsharkey) — earliest public Dante reverse engineering

### soundondigital/ravennakit
- **URL**: https://github.com/soundondigital/ravennakit (SDK at ravennakit.com)
- **License**: AGPLv3 (protocol/spec reference only — no code included)
- **Language**: C++
- **Scope**: Full RAVENNA/AES67/ST2110/PTPv2/NMOS SDK
- **Key learnings**:
  - RAVENNA RTSP URL paths: `/by-name/<stream>`, `/by-id/<n>`
  - RTSP sequence: OPTIONS → DESCRIBE (returns SDP), supports ANNOUNCE method too
  - RTP default port: `5004` for RAVENNA streams
  - PTPv2 profiles: AES67 profile (domain 0), SMPTE profile (domain 127)
  - mDNS DNS-SD: `_ravenna._tcp`, `_ravenna-session._tcp`, `_aes67._udp`
  - Also supports NMOS IS-04 (discovery) / IS-05 (connection management)
  - Cross-platform: macOS, Windows, Linux, Android

### martim01/pam
- **URL**: https://github.com/martim01/pam
- **License**: MIT
- **Language**: C++ (Raspberry Pi / touchscreen audio monitor)
- **Scope**: Full-featured audio monitor: meters, spectrum, R128, scope, test tools, AES67+NMOS source.
- **Key learnings — audio monitoring types**:
  - Meter types: BBC PPM, EBU, Nordic, VU, Moving Coil (analogue style)
  - Lissajou (phase scope), Spectrum Analyser, R128 Loudness
  - Oscilloscope, Channel delay measurement, Distortion measurement
  - Peak Sample Count, LTC detection/generation, Recording to file
- **Key learnings — AES67/RAVENNA**:
  - DNS-SD and SAP discovery, NMOS IS-04/IS-05 compliant version
  - RTP port `5004`, RTSP port `554`
  - PTP domain from `a=ts-refclk:ptp=IEEE1588-2008:<clock-id>:<domain>` SDP attribute
  - `a=clock-domain:PTPv2 0` (RAVENNA extension for clock domain)
  - `a=mediaclk:direct=<offset>` SDP attribute for media clock
  - PTP hybrid mode: multicast + unicast negotiation
  - AM824 codec (AES3-over-IP / SMPTE ST2110-31) — different from L16/L24
  - Livewire (Axia) device discovery alongside SAP
- **Future features to consider for our project**:
  - R128 loudness meter (EBU R128 / ITU-R BS.1770)
  - Phase/Lissajou display
  - Channel delay measurement tool
  - LTC timecode detection from stream

### bondagit/aes67-linux-daemon
- **URL**: https://github.com/bondagit/aes67-linux-daemon
- **License**: **GPL-3.0** ⚠️ (NOT LGPL as previously noted — protocol reference only, no code included)
- **Language**: C++
- **Scope**: Complete AES67 daemon with WebUI (React), REST API, SAP+mDNS, RTSP server/client.
- **Key learnings — daemon REST API** (exploitable for our UI):
  - `GET /api/sources` — list all RTP sources (TX streams)
  - `GET /api/sinks` — list all RTP sinks (RX streams) with status
  - `GET /api/ptp/status` — PTP slave clock status (offset, freq, path delay)
  - `GET /api/ptp/config` — PTP configuration (domain, DSCP, etc.)
  - `GET /api/config` — daemon configuration
  - `POST /api/sources` — create a new RTP source (TX stream)
  - `POST /api/sinks` — subscribe to a remote RTP stream
  - `DELETE /api/sources/:id` / `DELETE /api/sinks/:id`
  - HTTP Streamer: `GET /api/streamer/stream/:sinkId` — AAC LC live HTTP stream
- **Key learnings — RTSP**:
  - Daemon implements both RTSP client (DESCRIBE) and server (ANNOUNCE)
  - RTSP ANNOUNCE used by remote devices to push SDP updates to the daemon
  - IGMP handling for SAP, PTP, and RTP sessions (multicast join/leave)
- **Key learnings — Linux specifics**:
  - Uses Merging Technologies ALSA RAVENNA/AES67 kernel driver
  - Communicates with driver via **netlink sockets** (not ioctl)
  - PulseAudio must be disabled/uninstalled (conflicts with RAVENNA ALSA device)
  - Linux kernel ≥ 5.10: `sysctl -w kernel.sched_rt_runtime_us=1000000` required
  - CPU scaling can cause stream distortion: disable with `sysctl -w kernel.perf_cpu_time_max_percent=0`
  - Uses **Avahi** (not dns-sd) for mDNS on Linux — confirms our `avahi-browse` approach
- **License correction**: This repo is **GPL-3.0**, not LGPL-2.1 as noted before. Still protocol reference only.

## Protocol Quick Reference

### Ports
| Port | Protocol | Usage |
|------|----------|-------|
| 9875 UDP | SAP RFC 2974 | Stream announcements, multicast `239.255.255.255` |
| 5353 UDP | mDNS | Device discovery DNS-SD, multicast `224.0.0.251` |
| 554 TCP | RTSP RFC 2326 | RAVENNA SDP retrieval |
| 5004 UDP | RTP | RAVENNA/AES67 audio transport |
| 319 UDP | PTPv2 event | Sync, Delay_Req, multicast `224.0.1.129` |
| 320 UDP | PTPv2 general | Announce, Follow_Up, multicast `224.0.1.129` |
| 4440 UDP | Dante ARC | Device control: name, channels, routing |
| 4455 UDP | Dante DBCP | RTP flow creation/deletion |
| 4321 UDP | Dante RTP | Native Dante audio transport |

### mDNS Service Types
| Type | Protocol | Role |
|------|----------|------|
| `_netaudio-arc._udp` | Dante | Device control (ARC) |
| `_netaudio-cmc._udp` | Dante | Clock domain management |
| `_netaudio-dbc._udp` | Dante | Broadway control |
| `_netaudio-chan._udp` | Dante | Per-TX-channel announcement |
| `_netaudio-bund._udp` | Dante | Multicast bundle flows |
| `_ravenna._tcp` | RAVENNA | Device discovery |
| `_ravenna-session._tcp` | RAVENNA | Stream session |
| `_aes67._udp` | AES67 | Device discovery |

### ARC Opcodes
| Opcode | Description | Status |
|--------|-------------|--------|
| `0x1000` | Channel count (TX + RX) | ✅ implemented |
| `0x1002` | Device name | ✅ implemented |
| `0x1003` | Device info | ✅ implemented |
| `0x2000` | TX channel list (paginated) | ✅ implemented |
| `0x2010` | TX channel friendly names | ✅ implemented |
| `0x3000` | RX channel list + subscription status | ✅ implemented |
| `0x3010` | Set channel subscriptions (routing) | ❌ not yet |
| `0x2201` | Create multicast TX flow | ❌ not yet |
| `0x3200` | Query RX flows | ❌ not yet |
