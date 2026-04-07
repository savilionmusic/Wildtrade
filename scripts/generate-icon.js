// Generates a 1024x1024 PNG icon from a canvas
// Run: node scripts/generate-icon.js
const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

const size = 1024;
const canvas = createCanvas(size, size);
const ctx = canvas.getContext('2d');

// Background
const bgGrad = ctx.createLinearGradient(0, 0, size, size);
bgGrad.addColorStop(0, '#0d1117');
bgGrad.addColorStop(1, '#161b22');
roundRect(ctx, 0, 0, size, size, 220);
ctx.fillStyle = bgGrad;
ctx.fill();

// Border
roundRect(ctx, 0, 0, size, size, 220);
ctx.strokeStyle = '#30363d';
ctx.lineWidth = 4;
ctx.stroke();

// Chart line
const points = [[200,700],[340,580],[440,620],[540,420],[640,480],[740,280],[840,180]];
const lineGrad = ctx.createLinearGradient(200, 700, 840, 180);
lineGrad.addColorStop(0, '#10b981');
lineGrad.addColorStop(1, '#34d399');

ctx.beginPath();
ctx.moveTo(points[0][0], points[0][1]);
for (let i = 1; i < points.length; i++) {
  ctx.lineTo(points[i][0], points[i][1]);
}
ctx.strokeStyle = lineGrad;
ctx.lineWidth = 48;
ctx.lineCap = 'round';
ctx.lineJoin = 'round';
ctx.stroke();

// Glow dot
ctx.beginPath();
ctx.arc(840, 180, 56, 0, Math.PI * 2);
ctx.fillStyle = 'rgba(16, 185, 129, 0.25)';
ctx.fill();
ctx.beginPath();
ctx.arc(840, 180, 36, 0, Math.PI * 2);
ctx.fillStyle = '#10b981';
ctx.fill();

// Text
ctx.font = '800 140px sans-serif';
ctx.textAlign = 'center';
ctx.fillStyle = 'rgba(230, 237, 243, 0.6)';
ctx.fillText('WILDTRADE', 512, 900);

const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.writeFileSync(out, canvas.toBuffer('image/png'));
console.log(`Icon written to ${out}`);

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
