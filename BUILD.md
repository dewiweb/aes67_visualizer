# Building AES67 Visualizer

## Prerequisites

### All Platforms
- Node.js 18+ 
- npm 9+

### Windows
- Visual Studio Build Tools (for native modules)
- Python 3.x

### Linux
- Build essentials: `sudo apt install build-essential libasound2-dev`
- For AppImage: `sudo apt install libfuse2`

## Build Commands

```bash
# Install dependencies
npm install

# Build for current platform
npm run build:electron

# Build for Windows (exe + portable)
npm run build:win

# Build for Linux (AppImage)
npm run build:linux

# Build for macOS (dmg)
npm run build:mac

# Build for Windows + Linux
npm run build:all
```

## Output

Built packages are placed in the `release/` directory:

- **Windows**: `AES67 Visualizer Setup x.x.x.exe` (installer) + `AES67 Visualizer x.x.x.exe` (portable)
- **Linux**: `AES67-Visualizer-x.x.x.AppImage`
- **macOS**: `AES67 Visualizer-x.x.x.dmg`

## Native Modules

This app uses `audify` for audio playback, which is a native Node.js module.
It must be compiled for each target platform. electron-builder handles this automatically
when building on the target platform.

**Note**: Cross-compilation of native modules is not supported. Build on Windows for Windows,
build on Linux for Linux.

## Icons

Place your icons in the `build/` directory:
- `build/icon.ico` - Windows icon (256x256)
- `build/icons/` - Linux icons (PNG files: 16x16, 32x32, 48x48, 64x64, 128x128, 256x256, 512x512)
- `build/icon.icns` - macOS icon

## Troubleshooting

### audify build fails
Make sure you have the required build tools:
- Windows: `npm install --global windows-build-tools`
- Linux: `sudo apt install build-essential libasound2-dev`

### AppImage won't run on Linux
Install FUSE: `sudo apt install libfuse2`
