/**
 * Generate app icons from SVG source
 * Run: node scripts/generate-icons.cjs
 */

const sharp = require('sharp');
const fs = require('fs').promises;
const path = require('path');

const buildDir = path.join(__dirname, '..', 'build');
const iconsDir = path.join(buildDir, 'icons');
const svgPath = path.join(buildDir, 'icon.svg');

// Icon sizes for Linux
const sizes = [16, 32, 48, 64, 128, 256, 512];

async function generateIcons() {
  console.log('Generating icons from SVG...');
  console.log('SVG path:', svgPath);
  
  // Ensure icons directory exists
  await fs.mkdir(iconsDir, { recursive: true });
  
  // Read SVG
  const svgBuffer = await fs.readFile(svgPath);
  console.log('SVG loaded, size:', svgBuffer.length, 'bytes');
  
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
  
  // Generate Windows ICO
  console.log('Generating Windows ICO...');
  try {
    const pngToIco = require('png-to-ico');
    const pngBuffer = await fs.readFile(png256Path);
    const icoBuffer = await pngToIco([pngBuffer]);
    await fs.writeFile(path.join(buildDir, 'icon.ico'), icoBuffer);
    console.log('  Created icon.ico');
    
    // Clean up temp file
    await fs.unlink(png256Path);
  } catch (err) {
    console.log('  ICO generation error:', err.message);
    // Keep the 256 PNG as fallback
    try {
      await fs.rename(png256Path, path.join(buildDir, 'icon.png'));
      console.log('  Kept icon.png as fallback');
    } catch (e) {}
  }
  
  console.log('Done!');
}

generateIcons().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
