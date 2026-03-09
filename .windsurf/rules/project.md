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
- **Scope**: Unofficial open-source Dante protocol implementation for Linux — virtual ALSA soundcard + audio recorder. 100% reverse-engineered, not affiliated with Audinate.
- **Legal note**: Dante uses Audinate patents. Inferno makes no claim of approval by Audinate. Distribution of binaries may be restricted where software patents apply.
- **Architecture** (crates):
  - `inferno_aoip` — main library: Dante AoIP emulation (TX + RX)
  - `inferno2pipe` — audio recorder writing interleaved 32-bit PCM to Unix named pipe
  - `alsa_pcm_inferno` — virtual ALSA soundcard (works with PipeWire, planned: JACK)
  - `searchfire` — fork of Searchlight mDNS crate, modified for Dante mDNS compatibility
- **Key learnings — Dante device identity**:
  - Device ID = 8 bytes: `0000<IP_address_hex>0000`, e.g. `192.168.1.1` → `0000c0a801010000`
  - Dante devices use their MAC address padded with `fffe` bytes (EUI-64 style)
  - `PROCESS_ID`: 0–65535, must be unique per IP (multiple instances on same IP need different IDs)
  - Alternate port range: `ALT_PORT` to `ALT_PORT+3` (reserve ≥10 ports between instances)
- **Key learnings — Dante protocol ports** (for firewall config):
  - UDP `4455` — DBCP flow control
  - UDP `8700` — device settings (sample rate, encoding, gain)
  - UDP `4400` — (alternate port observed)
  - UDP `8800` — CMC clock domain management
  - UDP `5353` — mDNS
  - Incoming RTP: port allocated by OS (unknown in advance → open wide range or disable firewall)
- **Key learnings — PTP**:
  - Dante native = **PTPv1** only; requires the Statime PTPv1 fork (`inferno-dev` branch)
  - Can switch to **PTPv2** → Inferno becomes PTP master; at least one AES67-enabled Dante device needed for interop
  - Hardware timestamping: `CLOCK_PATH=/dev/ptp0`; check NIC with `ethtool -T`
  - NTP/chrony conflict: disable `chronyd` / `systemd-timesyncd` / `ntpd` when running PTP
  - CPU scaling causes jitter: `sysctl -w kernel.perf_cpu_time_max_percent=0`
  - `ptp4l` (linuxptp) works for PTPv2 with hardware timestamps
  - **Inferno2pipe clocked by media flow** — silence not generated when no channel connected (recording pauses)
- **Key learnings — Linux system integration**:
  - seccomp / SELinux can block clock syscalls — provide systemd override for PipeWire
  - PipeWire integration: copy `os_integration/systemd_allow_clock.conf` to PipeWire service override
  - Tested on: Arch, Ubuntu, Fedora, Raspberry Pi 5/4/Zero2W (ARM 64-bit)
- **Tested Dante devices**:
  - AVIO AES3, AVIO-DAI2, AVIO USBC, Ben&Fellows (UltimoX4), Brooklyn II (Klark Teknik DN32-DANTE)
  - Brooklyn III (Behringer Wing-Rack), Orban Optimod 5750 (Broadway), Soundcraft Vi2000/3000
  - Allen&Heath SQ-5/6, ESI planet 22c, Dante Via (macOS/Win11), Dante Virtual Soundcard (Win10)
- **Key learnings — other open-source Dante projects** (from inferno README):
  - `companion-module-audinate-dantecontroller` (Bitfocus Companion) — routing control via Companion
  - `dante-aes67-relay.js` (philhartung gist) — relay a Dante multicast stream to AES67
  - `wycliffe` (jsharkey) — earliest public Dante reverse engineering attempt
  - `inferno_runners` — scripts for PipeWire bridge + USB audio gadget

### soundondigital/ravennakit
- **URL**: https://github.com/soundondigital/ravennakit (SDK at ravennakit.com)
- **License**: AGPLv3 (protocol/spec reference only — no code included). Commercial license available for closed-source products.
- **Language**: C++
- **Scope**: Full software AoIP stack — no special NIC or PTP hardware required. Uses **virtual PTP** implementation (IEEE1588-2019 follower). Ideal for cloud-native / software-only workflows.
- **Modules included in the SDK**:
  - **RAVENNA**: full protocol implementation per RAVENNA spec
  - **AES67**: full AES67-2023 compliance
  - **ST2110-30**: full SMPTE ST2110-30:2017 support
  - **NMOS**: IS-04 (discovery) + IS-05 (connection management)
  - **RTP + RTCP**: transport + control
  - **DNS-SD**: currently macOS + Windows; Linux planned
  - **PTPv2**: virtual follower (IEEE1588-2019); hardware timestamping on Linux planned
  - **RTSP**: client + server for RAVENNA connection management
  - **SDP**: parsing + generation
  - **Core utils**: audio buffers, audio formats, containers, streams, lock-free programming, URI, integer wraparound
- **Key learnings — RAVENNA RTSP**:
  - RTSP URL paths: `/by-name/<stream>`, `/by-id/<n>`
  - Both client (DESCRIBE) and server (ANNOUNCE) implemented
  - RTSP ANNOUNCE: remote device pushes SDP updates to the server
- **Key learnings — PTPv2 profiles**:
  - AES67 profile: domain 0 (default)
  - SMPTE ST2059-2 profile: domain 127
  - Virtual PTP: no hardware timestamping required — software-only implementation
- **Key learnings — DNS-SD service types** (confirmed by SDK):
  - `_ravenna._tcp` — RAVENNA device
  - `_ravenna-session._tcp` — RAVENNA stream session
  - `_aes67._udp` — AES67 device
- **Key learnings — SDP attributes** used by RAVENNA/AES67:
  - `a=ts-refclk:ptp=IEEE1588-2008:<clock-id>:<domain>` — PTP reference clock
  - `a=ts-refclk:ptp=IEEE1588-2019:<clock-id>:<domain>` — PTPv2.1 variant
  - `a=clock-domain:PTPv2 <domain>` — RAVENNA clock domain extension
  - `a=mediaclk:direct=<offset>` — media clock offset from PTP epoch
  - `a=recvonly` / `a=sendonly` / `a=sendrecv` — stream direction
- **Key learnings — demo application**:
  - JUCE-based demo: https://github.com/soundondigital/ravennakit_juce_demo
  - Shows how to integrate the SDK with a C++ audio application
- **What ravennakit confirms for our project**:
  - RTSP ANNOUNCE is a real part of RAVENNA — worth implementing as receiver
  - IS-04/IS-05 (NMOS) is the ST2110-30 control path — future feature
  - DNS-SD Linux support gap confirms why `avahi-browse` workaround was needed


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

## OS Permissions Audit

### Permission Matrix by Port

| Port | Protocol | Usage | Windows | Linux | macOS |
|------|----------|-------|---------|-------|-------|
| 9875 UDP | SAP multicast | Stream discovery `239.255.255.255` | ✅ | ✅ (bind 0.0.0.0) | ✅ |
| 5353 UDP | mDNS multicast | Device discovery `224.0.0.251` | ✅ (Bonjour) | ⚠️ (avahi-daemon) | ✅ (built-in) |
| 319 UDP | PTPv2 event | PTP sync packets | ✅ | ❌ port <1024 | ✅ |
| 320 UDP | PTPv2 general | PTP announce/follow-up | ✅ | ❌ port <1024 | ✅ |
| 4440 UDP | ARC unicast | Dante device control | ✅ | ✅ | ✅ |
| 5004+ UDP | RTP multicast | Audio metering | ✅ | ✅ (bind 0.0.0.0) | ✅ |
| 554 TCP | RTSP | RAVENNA stream SDP | ✅ | ✅ | ✅ |

### Linux — PTP Ports 319/320

Ports below 1024 require elevated privilege on Linux. Three options:

```bash
# Option 1: kernel parameter (temporary)
sudo sysctl -w net.ipv4.ip_unprivileged_port_start=319

# Option 2: kernel parameter (persistent across reboots)
echo "net.ipv4.ip_unprivileged_port_start=319" | sudo tee /etc/sysctl.d/99-ptp.conf
sudo sysctl -p /etc/sysctl.d/99-ptp.conf

# Option 3: setcap on extracted binary (AppImage cannot be setcap'd directly)
./aes67-visualizer.AppImage --appimage-extract
sudo setcap cap_net_bind_service=+eip squashfs-root/aes67-visualizer
```

### Linux — mDNS (Avahi)

mDNS discovery requires `avahi-daemon` to be running. Our `mdns.cjs` uses `avahi-browse` as external process.
```bash
sudo apt install avahi-daemon avahi-utils   # Debian/Ubuntu/Mint
sudo pacman -S avahi                         # Arch
sudo dnf install avahi avahi-tools           # Fedora
sudo systemctl enable --now avahi-daemon
```

### Linux — AppImage setcap note

`setcap` cannot be applied to an AppImage directly (it's a compressed filesystem).
Workaround: extract with `--appimage-extract`, apply `setcap` to the extracted ELF binary,
or use the `ip_unprivileged_port_start` sysctl approach instead.

### Windows

No special permissions needed for any port. Requirements:
- **Bonjour Service** must be installed for mDNS (comes with iTunes, or download standalone)
- **Windows Firewall**: allow inbound UDP 9875, 5353, 319, 320, 5004 for the app

### macOS

- mDNS via built-in `mDNSResponder` — no setup needed
- PTP ports 319/320: macOS allows non-root UDP bind below 1024 — no setup needed
- Firewall: System Settings → Network → Firewall → allow inbound for AES67 Visualizer

### Error Handling in Code

| Module | Port | EACCES handled | Sent to UI |
|--------|------|----------------|------------|
| `ptp.cjs` | 319, 320 | ✅ | ✅ via `port-conflict` IPC |
| `sdp.cjs` / `sap.cjs` | 9875 | ✅ | ✅ via `port-conflict` IPC |
| `meters.cjs` | RTP ports | ✅ | ✅ via `port-conflict` IPC |
| `mdns.cjs` | 5353 | N/A (uses avahi-browse subprocess) | N/A |
| `arc.cjs` | 4440 | N/A (ephemeral source port) | N/A |

UI: `PermissionsPanel` (NavRail: shield icon) displays active conflicts + per-OS fix instructions.

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
| `0x1001` | Set device name | ✅ implemented |
| `0x1002` | Device name (read) | ✅ implemented |
| `0x1003` | Device info | ✅ implemented |
| `0x2000` | TX channel list (paginated) | ✅ implemented |
| `0x2010` | TX channel friendly names | ✅ implemented |
| `0x3000` | RX channel list + subscription status | ✅ implemented |
| `0x3010` | Set RX subscription (routing write) | ✅ implemented — `setSubscription(ip, port, rxChannelId, txChannelName, txDeviceName)` |
| `0x2201` | Create multicast TX flow | ❌ not yet |
| `0x3200` | Query RX flows | ❌ not yet |

### Routing Matrix — UI
- **DevicePanel** RX channels: hover → `Link` icon → TX picker dropdown (all TX channels from other Dante devices)
- Unsubscribe: hover → `Unlink` icon on subscribed channels
- Feedback: channel name flashes green (ok) / red (err) for 3s
- IPC: `arc-set-subscription` / `arc-unsubscribe-rx` → `arc.setSubscription()` / `arc.unsubscribeRx()`

### RAVENNA Routing — Alternative Analysis
RAVENNA has no equivalent to ARC's `0x3010` subscription command. Options:

| Method | Protocol | Feasibility |
|--------|----------|-------------|
| RTSP `SETUP` + `PLAY` | RTSP RFC 2326 | Possible but creates a full media session, not just a subscription |
| SAP/SDP ANNOUNCE | RFC 2974 | TX-side only — no RX subscription mechanism |
| HTTP REST | Vendor-specific | Non-standardized, device-dependent |
| Netlink/ioctl | Linux kernel | Merging Tech driver only, out of scope |

**Decision**: RAVENNA routing not implemented. RAVENNA devices can be subscribed to Dante TX sources
via Dante Controller (which uses ARC). For RAVENNA-to-RAVENNA routing, the device's own web UI must be used.
