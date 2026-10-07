export type GlassLensProfile = 'regular' | 'prominent';

const rimWidths: Record<GlassLensProfile, number> = { regular: 18, prominent: 32 };

/** Rounded-rectangle lens: the middle is neutral; only the rim bends the backdrop. */
export function glassDisplacement(x: number, y: number, width: number, height: number, radius: number,
  profile: GlassLensProfile = 'regular') {
  return displacementAt(x, y, width, height, radius, rimWidths[profile]);
}

function displacementAt(x: number, y: number, width: number, height: number, radius: number, rimWidth: number) {
  const r = Math.min(radius, width / 2, height / 2);
  const px = x - width / 2;
  const py = y - height / 2;
  const qx = Math.abs(px) - width / 2 + r;
  const qy = Math.abs(py) - height / 2 + r;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  const cornerDistance = Math.hypot(ox, oy);
  const distance = Math.min(Math.max(qx, qy), 0) + cornerDistance - r;
  const rim = Math.min(rimWidth, Math.min(width, height) / 3);
  if (distance > 1 || distance < -rim) return { x: 0, y: 0 };
  const depth = Math.max(0, Math.min(1, -distance / rim));
  const strength = Math.sin(depth * Math.PI) * (1 - depth) * 0.85;
  const nx = cornerDistance > 0 ? ox / cornerDistance : qx > qy ? 1 : 0;
  const ny = cornerDistance > 0 ? oy / cornerDistance : qx > qy ? 0 : 1;
  return { x: Math.sign(px) * nx * strength, y: Math.sign(py) * ny * strength };
}

const maps = new Map<string, string>();

/** Small, cached lens textures are generated on resize, never on pointer movement. */
export function glassDisplacementMap(width: number, height: number, radius: number,
  profile: GlassLensProfile = 'regular'): string | undefined {
  const key = `${width}:${height}:${radius}:${profile}`;
  if (maps.has(key)) return maps.get(key);
  const scale = Math.min(1, 384 / width, 384 / height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(width * scale));
  canvas.height = Math.max(2, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  // Long media panels still need several rim samples in their bounded texture.
  const rimWidth = profile === 'prominent'
    ? Math.max(rimWidths[profile], 3 * Math.max(width / canvas.width, height / canvas.height))
    : rimWidths[profile];
  const pixels = context.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const sampleX = profile === 'prominent' ? (x + 0.5) * width / canvas.width : (x + 0.5) / scale;
      const sampleY = profile === 'prominent' ? (y + 0.5) * height / canvas.height : (y + 0.5) / scale;
      const vector = displacementAt(sampleX, sampleY, width, height, radius, rimWidth);
      const index = (y * canvas.width + x) * 4;
      pixels.data[index] = Math.round(127.5 + vector.x * 127.5);
      pixels.data[index + 1] = Math.round(127.5 + vector.y * 127.5);
      pixels.data[index + 2] = 128;
      pixels.data[index + 3] = 255;
    }
  }
  context.putImageData(pixels, 0, 0);
  const url = canvas.toDataURL();
  if (maps.size >= 16) maps.delete(maps.keys().next().value!);
  maps.set(key, url);
  return url;
}
