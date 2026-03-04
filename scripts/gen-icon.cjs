const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const buildDir = path.join(__dirname, '..', 'build');
const svgPath = path.join(buildDir, 'icon.svg');

console.log('Starting icon generation...');

const svg = fs.readFileSync(svgPath);
console.log('SVG loaded');

const sizes = [16, 32, 48, 64, 128, 256, 512];

async function run() {
  // Create icons dir
  const iconsDir = path.join(buildDir, 'icons');
  if (!fs.existsSync(iconsDir)) {
    fs.mkdirSync(iconsDir, { recursive: true });
  }

  // Generate PNGs
  for (const size of sizes) {
    const out = path.join(iconsDir, size + 'x' + size + '.png');
    await sharp(svg).resize(size, size).png().toFile(out);
    console.log('Created ' + out);
  }

  // Generate main icon.png for ICO
  const iconPng = path.join(buildDir, 'icon.png');
  await sharp(svg).resize(256, 256).png().toFile(iconPng);
  console.log('Created ' + iconPng);

  // Generate ICO
  try {
    const pngToIco = require('png-to-ico');
    const pngBuf = fs.readFileSync(iconPng);
    const ico = await pngToIco([pngBuf]);
    fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);
    console.log('Created icon.ico');
  } catch (e) {
    console.log('ICO error: ' + e.message);
  }

  console.log('Done!');
}

run().catch(e => console.error('Error:', e));
