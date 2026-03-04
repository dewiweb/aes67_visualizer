/**
 * Generate app icons from SVG source
 * Run: node scripts/generate-icons.js
 * Requires: npm install sharp png-to-ico --save-dev
 */

import sharp from 'sharp';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.join(__dirname, '..', 'build');
const iconsDir = path.join(buildDir, 'icons');
const svgPath = path.join(buildDir, 'icon.svg');

// Icon sizes for Linux
const sizes = [16, 32, 48, 64, 128, 256, 512];

async function generateIcons() {
  console.log('Generating icons from SVG...');
  
  // Ensure icons directory exists
  await fs.mkdir(iconsDir, { recursive: true });
  
  // Read SVG
  const svgBuffer = await fs.readFile(svgPath);
  
  // Generate PNG icons for Linux
  console.log('Generating Linux PNG icons...');
  for (const size of sizes) {
    const outputPath = path.join(iconsDir, `${size}x${size}.png`);
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(outputPath);
    console.log(`  Created ${size}x${size}.png`);
  }
  
  // Generate 256x256 PNG for ICO conversion
  const png256Path = path.join(buildDir, 'icon-256.png');
  await sharp(svgBuffer)
    .resize(256, 256)
    .png()
    .toFile(png256Path);
  
  // Generate Windows ICO (requires png-to-ico)
  console.log('Generating Windows ICO...');
  try {
    const pngToIco = (await import('png-to-ico')).default;
    const icoBuffer = await pngToIco([png256Path]);
    await fs.writeFile(path.join(buildDir, 'icon.ico'), icoBuffer);
    console.log('  Created icon.ico');
    
    // Clean up temp file
    await fs.unlink(png256Path);
  } catch (err) {
    console.log('  Note: png-to-ico not installed, skipping ICO generation');
    console.log('  Run: npm install png-to-ico --save-dev');
    // Keep the 256 PNG as fallback
    await fs.rename(png256Path, path.join(buildDir, 'icon.png'));
  }
  
  console.log('Done!');
}

generateIcons().catch(console.error);
