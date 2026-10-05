import {useEffect, useRef} from 'react';

type Kind = 'delete' | 'redact' | 'retain';
type Point = {x: number; y: number; z: number; kind: Kind; seed: number};
export type SphereCounts = {delete: number; redact: number; retain: number};

const COLORS: Record<Kind, [number, number, number]> = {delete: [255, 107, 94], redact: [245, 196, 81], retain: [111, 168, 255]};
const UV: [number, number, number] = [155, 123, 255];
const POINTS = 900;
const CYCLE = 9000;

/** Fibonacci sphere with classifications shuffled in proportion to the real record counts. */
function buildPoints(counts: SphereCounts): Point[] {
  const total = Math.max(1, counts.delete + counts.redact + counts.retain);
  const kinds: Kind[] = [];
  const quota = (n: number) => Math.round((n / total) * POINTS);
  for (let i = 0; i < quota(counts.delete); i++) kinds.push('delete');
  for (let i = 0; i < quota(counts.redact); i++) kinds.push('redact');
  while (kinds.length < POINTS) kinds.push('retain');
  let state = 7;
  const random = () => (state = (state * 16807) % 2147483647) / 2147483647;
  for (let i = kinds.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [kinds[i], kinds[j]] = [kinds[j], kinds[i]]; }
  const golden = Math.PI * (3 - Math.sqrt(5));
  return kinds.slice(0, POINTS).map((kind, i) => {
    const y = 1 - (i / (POINTS - 1)) * 2;
    const radius = Math.sqrt(1 - y * y);
    return {x: Math.cos(golden * i) * radius, y, z: Math.sin(golden * i) * radius, kind, seed: random()};
  });
}

const smooth = (t: number) => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);

export function RecordSphere({counts, label}: {counts: SphereCounts; label: string}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tilt = useRef({x: 0, y: 0, tx: 0, ty: 0});

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const points = buildPoints(counts);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let width = 0, height = 0, frame = 0, visible = true;
    const start = performance.now();

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width; height = rect.height;
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const draw = (now: number) => {
      const elapsed = reduced ? CYCLE * 0.62 : now - start;
      const cycle = (elapsed % CYCLE) / CYCLE;
      // 0–0.15 rest, 0.15–0.55 scan plane sweeps down, 0.55–0.8 hold, 0.8–1 records reform.
      const sweep = -1.35 + smooth((cycle - 0.15) / 0.4) * 2.7;
      const reform = smooth((cycle - 0.8) / 0.2);
      const t = tilt.current;
      t.x += (t.tx - t.x) * 0.06; t.y += (t.ty - t.y) * 0.06;
      const spin = reduced ? 0.6 : elapsed * 0.00018;
      const rotY = spin + t.x * 0.6, rotX = -0.32 + t.y * 0.4;
      const cosY = Math.cos(rotY), sinY = Math.sin(rotY), cosX = Math.cos(rotX), sinX = Math.sin(rotX);
      const cx = width / 2, cy = height / 2, radius = Math.min(width, height) * 0.36;

      context.clearRect(0, 0, width, height);
      const halo = context.createRadialGradient(cx, cy, radius * 0.1, cx, cy, radius * 1.45);
      halo.addColorStop(0, 'rgba(155,123,255,0.20)');
      halo.addColorStop(0.55, 'rgba(155,123,255,0.06)');
      halo.addColorStop(1, 'rgba(155,123,255,0)');
      context.fillStyle = halo;
      context.fillRect(0, 0, width, height);

      const projected = points.map(point => {
        const x1 = point.x * cosY - point.z * sinY;
        const z1 = point.x * sinY + point.z * cosY;
        const y1 = point.y * cosX - z1 * sinX;
        const z2 = point.y * sinX + z1 * cosX;
        // Swept = the scan plane (in screen space) has passed this point.
        const passed = smooth((sweep - y1) / 0.35) * (1 - reform);
        return {point, x1, y1, z2, passed};
      }).sort((a, b) => a.z2 - b.z2);

      for (const {point, x1, y1, z2, passed} of projected) {
        const depth = (z2 + 1) / 2;
        let scale = 1, alpha = 0.25 + depth * 0.75, size = 0.8 + depth * 1.9;
        const base = passed > 0 ? COLORS[point.kind] : UV;
        const [r, g, b] = passed > 0 ? base.map((channel, i) => Math.round(UV[i] + (channel - UV[i]) * Math.min(1, passed * 1.6))) as [number, number, number] : UV;
        if (point.kind === 'delete' && passed > 0) { scale = 1 + passed * (0.35 + point.seed * 0.6); alpha *= 1 - passed; }
        const px = cx + x1 * radius * scale, py = cy + y1 * radius * scale + (point.kind === 'delete' ? passed * passed * 26 * point.seed : 0);
        if (alpha <= 0.01) continue;
        context.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
        if (point.kind === 'redact' && passed > 0.5) {
          const w = size * (2.2 + passed * 2.4);
          context.fillRect(px - w / 2, py - size * 0.55, w, size * 1.1);
        } else {
          context.beginPath();
          context.arc(px, py, size * (point.kind === 'retain' && passed > 0 ? 1.15 : 1), 0, Math.PI * 2);
          context.fill();
        }
      }

      if (cycle > 0.15 && cycle < 0.6) {
        const sy = cy + sweep * radius;
        const line = context.createLinearGradient(cx - radius * 1.3, 0, cx + radius * 1.3, 0);
        line.addColorStop(0, 'rgba(185,163,255,0)');
        line.addColorStop(0.5, 'rgba(185,163,255,0.85)');
        line.addColorStop(1, 'rgba(185,163,255,0)');
        context.fillStyle = line;
        context.fillRect(cx - radius * 1.3, sy, radius * 2.6, 1.5);
        const wash = context.createLinearGradient(0, sy - 40, 0, sy);
        wash.addColorStop(0, 'rgba(155,123,255,0)');
        wash.addColorStop(1, 'rgba(155,123,255,0.10)');
        context.fillStyle = wash;
        context.fillRect(cx - radius * 1.3, sy - 40, radius * 2.6, 40);
      }
      if (!reduced && visible) frame = requestAnimationFrame(draw);
    };

    const observer = new ResizeObserver(() => { resize(); if (reduced) draw(performance.now()); });
    observer.observe(canvas);
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      cancelAnimationFrame(frame);
      if (visible && !reduced) frame = requestAnimationFrame(draw);
    });
    intersection.observe(canvas);
    resize();
    frame = requestAnimationFrame(draw);
    const onMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      tilt.current.tx = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
      tilt.current.ty = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
    };
    const onLeave = () => { tilt.current.tx = 0; tilt.current.ty = 0; };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); intersection.disconnect(); canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerleave', onLeave); };
  }, [counts.delete, counts.redact, counts.retain]);

  return <canvas ref={canvasRef} className="record-sphere" role="img" aria-label={label} />;
}
