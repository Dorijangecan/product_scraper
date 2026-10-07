const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
(async () => {
  const dir = 'benchmarks/output/20260923104415/images';
  const files = fs.readdirSync(dir).filter(x => /\.(png|jpe?g|webp)$/i.test(x)).sort();
  const tiles = [];
  for (let i = 0; i < files.length; i++) {
    const img = await sharp(path.join(dir, files[i])).resize(170, 132, { fit: 'contain', background: '#fff' }).png().toBuffer();
    const safe = files[i].replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const label = Buffer.from(`<svg width="190" height="28" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><text x="4" y="19" font-family="Arial" font-size="11">${safe}</text></svg>`);
    tiles.push({ input: img, left: (i % 5) * 190 + 10, top: Math.floor(i / 5) * 170 + 3 });
    tiles.push({ input: label, left: (i % 5) * 190, top: Math.floor(i / 5) * 170 + 138 });
  }
  await sharp({ create: { width: 950, height: 510, channels: 3, background: '#ddd' } }).composite(tiles).png().toFile('benchmarks/schneider-image-audit-current.png');
  console.log('image_count=' + files.length);
})();
