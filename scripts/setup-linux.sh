#!/usr/bin/env bash
# =============================================================================
# AES67 Visualizer — Linux Setup Script
# =============================================================================
# Configures the system for full functionality:
#   - Avahi mDNS daemon (Dante/RAVENNA device discovery)
#   - PTP privileged ports 319/320 (IEEE 1588 clock monitoring)
#   - Optional: setcap on extracted AppImage binary
#
# Usage:
#   chmod +x setup-linux.sh
#   sudo ./setup-linux.sh [--appimage /path/to/aes67-visualizer.AppImage]
#
# Supported distros: Debian/Ubuntu/Mint, Arch/Manjaro, Fedora/RHEL/CentOS
# =============================================================================

set -euo pipefail

APPIMAGE_PATH=""
SKIP_AVAHI=false
SKIP_PTP=false

# ── Parse arguments ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --appimage) APPIMAGE_PATH="$2"; shift 2 ;;
    --skip-avahi) SKIP_AVAHI=true; shift ;;
    --skip-ptp) SKIP_PTP=true; shift ;;
    -h|--help)
      echo "Usage: sudo $0 [--appimage /path/to/aes67-visualizer.AppImage]"
      echo "       [--skip-avahi] [--skip-ptp]"
      exit 0
      ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

# ── Check root ───────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  echo "❌  This script must be run as root: sudo $0 $*"
  exit 1
fi

# ── Detect distro ────────────────────────────────────────────────────────────
if   command -v apt-get  &>/dev/null; then DISTRO="debian"
elif command -v pacman   &>/dev/null; then DISTRO="arch"
elif command -v dnf      &>/dev/null; then DISTRO="fedora"
elif command -v yum      &>/dev/null; then DISTRO="rhel"
else
  echo "⚠️  Unknown distro — skipping package install. Apply manually."
  DISTRO="unknown"
fi

echo ""
echo "════════════════════════════════════════════════════════"
echo "  AES67 Visualizer — Linux Setup"
echo "  Distro: $DISTRO"
echo "════════════════════════════════════════════════════════"
echo ""

# ── 1. Install Avahi ─────────────────────────────────────────────────────────
if [[ "$SKIP_AVAHI" == false ]]; then
  echo "▶ [1/3] Installing Avahi (mDNS daemon + tools)..."
  case "$DISTRO" in
    debian)
      apt-get update -qq
      apt-get install -y avahi-daemon avahi-utils libnss-mdns
      ;;
    arch)
      pacman -Sy --noconfirm avahi nss-mdns
      # Enable nss-mdns in nsswitch.conf
      if ! grep -q 'mdns4_minimal' /etc/nsswitch.conf; then
        sed -i 's/^hosts:.*$/& mdns4_minimal [NOTFOUND=return]/' /etc/nsswitch.conf
        echo "  ✔ Added mdns4_minimal to /etc/nsswitch.conf"
      fi
      ;;
    fedora)
      dnf install -y avahi avahi-tools nss-mdns
      ;;
    rhel)
      yum install -y avahi avahi-tools nss-mdns
      ;;
    *)
      echo "  ⚠️  Manual install needed: avahi-daemon, avahi-utils, libnss-mdns"
      ;;
  esac

  echo "  ✔ Enabling avahi-daemon service..."
  systemctl enable avahi-daemon
  systemctl start  avahi-daemon
  echo "  ✔ avahi-daemon running: $(systemctl is-active avahi-daemon)"

  # Verify avahi-browse is available
  if command -v avahi-browse &>/dev/null; then
    echo "  ✔ avahi-browse found: $(command -v avahi-browse)"
  else
    echo "  ⚠️  avahi-browse not found after install — check package name for your distro"
  fi
fi

# ── 2. PTP privileged ports (319/320) ────────────────────────────────────────
if [[ "$SKIP_PTP" == false ]]; then
  echo ""
  echo "▶ [2/3] Configuring PTP privileged ports (319/320)..."

  SYSCTL_CONF="/etc/sysctl.d/99-aes67-ptp.conf"
  SYSCTL_KEY="net.ipv4.ip_unprivileged_port_start"
  SYSCTL_VAL=319

  if [[ -f "$SYSCTL_CONF" ]]; then
    echo "  ℹ  $SYSCTL_CONF already exists — updating..."
  fi

  echo "${SYSCTL_KEY}=${SYSCTL_VAL}" > "$SYSCTL_CONF"
  sysctl -p "$SYSCTL_CONF" >/dev/null
  echo "  ✔ $SYSCTL_KEY set to $SYSCTL_VAL (persistent across reboots)"
  echo "  ✔ Current value: $(sysctl -n $SYSCTL_KEY)"
fi

# ── 3. Optional setcap on AppImage binary ────────────────────────────────────
echo ""
echo "▶ [3/3] AppImage setcap (optional)..."

if [[ -n "$APPIMAGE_PATH" ]]; then
  if [[ ! -f "$APPIMAGE_PATH" ]]; then
    echo "  ❌  AppImage not found: $APPIMAGE_PATH"
    exit 1
  fi

  EXTRACT_DIR="$(dirname "$APPIMAGE_PATH")/squashfs-root"
  echo "  ℹ  Extracting AppImage to $EXTRACT_DIR..."

  # Run as the calling user, not root
  REAL_USER="${SUDO_USER:-$USER}"
  sudo -u "$REAL_USER" "$APPIMAGE_PATH" --appimage-extract \
    --appimage-extract-and-run 2>/dev/null \
    || "$APPIMAGE_PATH" --appimage-extract

  # Find the main ELF binary
  ELF_BINARY="$EXTRACT_DIR/aes67-visualizer"
  if [[ ! -f "$ELF_BINARY" ]]; then
    # Try to find it
    ELF_BINARY=$(find "$EXTRACT_DIR" -maxdepth 2 -type f -name "aes67*" | head -1)
  fi

  if [[ -n "$ELF_BINARY" && -f "$ELF_BINARY" ]]; then
    setcap cap_net_bind_service=+eip "$ELF_BINARY"
    echo "  ✔ setcap applied to: $ELF_BINARY"
    echo "  ℹ  Note: sysctl approach is simpler and survives AppImage updates."
    echo "         setcap must be reapplied after each AppImage update."
  else
    echo "  ⚠️  Could not find ELF binary in $EXTRACT_DIR"
    echo "       Apply manually: sudo setcap cap_net_bind_service=+eip <binary>"
  fi
else
  echo "  ℹ  Skipped (pass --appimage /path/to/aes67-visualizer.AppImage to apply setcap)"
  echo "  ℹ  sysctl method (step 2) is sufficient for PTP ports — setcap is optional."
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════"
echo "  Setup complete. Verification:"
echo ""

# Avahi
if command -v avahi-browse &>/dev/null && systemctl is-active --quiet avahi-daemon 2>/dev/null; then
  echo "  ✅  mDNS (Avahi)      — avahi-daemon running, avahi-browse available"
else
  echo "  ⚠️  mDNS (Avahi)      — check: systemctl status avahi-daemon"
fi

# PTP
PTP_PORT_START=$(sysctl -n net.ipv4.ip_unprivileged_port_start 2>/dev/null || echo 1024)
if [[ $PTP_PORT_START -le 319 ]]; then
  echo "  ✅  PTP ports 319/320 — accessible (ip_unprivileged_port_start=$PTP_PORT_START)"
else
  echo "  ❌  PTP ports 319/320 — still restricted (ip_unprivileged_port_start=$PTP_PORT_START)"
fi

echo ""
echo "  You can now launch: ./aes67-visualizer.AppImage"
echo "════════════════════════════════════════════════════════"
echo ""
