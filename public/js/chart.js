// A small time-series chart on canvas with real pinch-zoom.
//
// Written by hand rather than pulled from a library because the requirement was
// touch-first: two-finger pinch scales the time axis about the midpoint between
// the fingers, one finger pans, wheel/trackpad zooms about the cursor, and a
// double tap returns to the full range. Vertical scale always auto-fits whatever
// slice of time is on screen, which is what you actually want when reading a
// wind or wave forecast.

const DPR = () => Math.min(window.devicePixelRatio || 1, 3);

// Canvas cannot resolve `var(--wind)`; assigning one silently keeps the previous
// colour. Resolve tokens against the document once per draw and cache them.
const colorCache = new Map();

function resolveColor(value) {
  if (typeof value !== 'string' || !value.startsWith('var(')) return value;
  if (colorCache.has(value)) return colorCache.get(value);
  const name = value.slice(4, -1).split(',')[0].trim();
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#8ab4f8';
  colorCache.set(value, resolved);
  return resolved;
}

// Theme flips invalidate every resolved token.
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => colorCache.clear());

/** Add an alpha channel to a hex or rgb colour. */
function withAlpha(color, alpha) {
  const c = resolveColor(color);
  if (c.startsWith('#')) {
    const hex = c.length === 4 ? c.replace(/#(.)(.)(.)/, '#$1$1$2$2$3$3') : c;
    const n = parseInt(hex.slice(1, 7), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  if (c.startsWith('rgb(')) return c.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`);
  return c;
}

function niceTicks(min, max, count) {
  const span = max - min || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const first = Math.ceil(min / step) * step;
  const out = [];
  for (let v = first; v <= max + step * 0.001; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

function timeTicks(minMs, maxMs, width) {
  const span = maxMs - minMs;
  const target = Math.max(2, Math.floor(width / 90));
  const steps = [
    36e5, 2 * 36e5, 3 * 36e5, 6 * 36e5, 12 * 36e5, 24 * 36e5, 2 * 24 * 36e5,
  ];
  let step = steps.find((s) => span / s <= target) || steps[steps.length - 1];
  const out = [];
  const start = new Date(minMs);
  start.setMinutes(0, 0, 0);
  for (let t = start.getTime(); t <= maxMs; t += step) {
    if (t >= minMs) out.push(t);
  }
  return out;
}

export class TimeChart {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts
   *   series: [{ key, label, color, fill?, type?: 'line'|'area'|'bar', dashed?, axis?: 'left'|'right' }]
   *   yLabel, y2Label, formatY, formatY2, formatTooltip
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = { padding: { top: 16, right: 14, bottom: 26, left: 44 }, ...opts };
    this.series = [];
    this.domain = null; // [minMs, maxMs] currently displayed
    this.fullDomain = null;
    this.pointers = new Map();
    this.hover = null;
    this.markers = opts.markers || [];
    this.bands = opts.bands || [];

    this._bind();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas.parentElement || canvas);
  }

  destroy() {
    this._ro.disconnect();
  }

  setData(series, { markers = [], bands = [], resetZoom = true } = {}) {
    this.series = series.filter((s) => s.points?.length);
    this.markers = markers;
    this.bands = bands;
    const xs = this.series.flatMap((s) => [s.points[0].x, s.points[s.points.length - 1].x]);
    if (!xs.length) {
      this.fullDomain = null;
      this.domain = null;
      this.draw();
      return;
    }
    this.fullDomain = [Math.min(...xs), Math.max(...xs)];
    if (resetZoom || !this.domain) this.domain = [...(this.opts.initialDomain || this.fullDomain)];
    this._clampDomain();
    this.resize();
  }

  resize() {
    const parent = this.canvas.parentElement;
    const w = Math.max(240, parent.clientWidth);
    const h = Math.max(140, parent.clientHeight || this.opts.height || 220);
    const dpr = DPR();
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.w = w;
    this.h = h;
    this.draw();
  }

  /* ------------------------------------------------------------ geometry -- */

  get plot() {
    const p = this.opts.padding;
    const right = p.right + (this.opts.y2Label || this.series.some((s) => s.axis === 'right') ? 36 : 0);
    return { x: p.left, y: p.top, w: this.w - p.left - right, h: this.h - p.top - p.bottom, right };
  }

  xToPx(x) {
    const [a, b] = this.domain;
    const pl = this.plot;
    return pl.x + ((x - a) / (b - a)) * pl.w;
  }

  pxToX(px) {
    const [a, b] = this.domain;
    const pl = this.plot;
    return a + ((px - pl.x) / pl.w) * (b - a);
  }

  _visible(s) {
    const [a, b] = this.domain;
    const pts = s.points;
    let i0 = 0;
    let i1 = pts.length - 1;
    while (i0 < pts.length - 1 && pts[i0 + 1].x < a) i0++;
    while (i1 > 0 && pts[i1 - 1].x > b) i1--;
    return pts.slice(i0, i1 + 1);
  }

  _yRange(axis) {
    let min = Infinity;
    let max = -Infinity;
    for (const s of this.series) {
      if ((s.axis || 'left') !== axis) continue;
      for (const p of this._visible(s)) {
        if (p.y == null || !Number.isFinite(p.y)) continue;
        if (p.y < min) min = p.y;
        if (p.y > max) max = p.y;
      }
    }
    if (!Number.isFinite(min)) return null;
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const pad = (max - min) * 0.12;
    const forceZero = axis === 'left' ? this.opts.zeroBased : this.opts.zeroBasedRight;
    return [forceZero ? Math.min(0, min) : min - pad, max + pad];
  }

  _clampDomain() {
    if (!this.fullDomain) return;
    const [fa, fb] = this.fullDomain;
    let [a, b] = this.domain;
    const minSpan = Math.max(36e5, (fb - fa) / 400); // never zoom past one hour
    if (b - a < minSpan) {
      const mid = (a + b) / 2;
      a = mid - minSpan / 2;
      b = mid + minSpan / 2;
    }
    if (b - a > fb - fa) {
      a = fa;
      b = fb;
    }
    if (a < fa) {
      b += fa - a;
      a = fa;
    }
    if (b > fb) {
      a -= b - fb;
      b = fb;
    }
    this.domain = [Math.max(fa, a), Math.min(fb, b)];
  }

  /* --------------------------------------------------------------- draw --- */

  draw() {
    const ctx = this.ctx;
    if (!ctx || !this.w) return;
    const dpr = DPR();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);

    const css = getComputedStyle(document.documentElement);
    const grid = css.getPropertyValue('--chart-grid').trim() || 'rgba(255,255,255,.08)';
    const text = css.getPropertyValue('--chart-text').trim() || 'rgba(255,255,255,.55)';

    if (!this.series.length || !this.domain) {
      ctx.fillStyle = text;
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No data', this.w / 2, this.h / 2);
      return;
    }

    const pl = this.plot;
    const left = this._yRange('left');
    const right = this._yRange('right');
    const yToPx = (v, axis) => {
      const r = axis === 'right' ? right : left;
      if (!r) return pl.y + pl.h;
      return pl.y + pl.h - ((v - r[0]) / (r[1] - r[0])) * pl.h;
    };
    this._yToPx = yToPx;

    // Shaded time bands (night, for instance).
    for (const band of this.bands) {
      const x0 = Math.max(pl.x, this.xToPx(band.from));
      const x1 = Math.min(pl.x + pl.w, this.xToPx(band.to));
      if (x1 <= x0) continue;
      ctx.fillStyle = band.color || 'rgba(120,140,200,.07)';
      ctx.fillRect(x0, pl.y, x1 - x0, pl.h);
    }

    // Horizontal grid + left axis labels.
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    if (left) {
      ctx.strokeStyle = grid;
      ctx.fillStyle = text;
      ctx.lineWidth = 1;
      ctx.textAlign = 'right';
      for (const v of niceTicks(left[0], left[1], 4)) {
        const y = Math.round(yToPx(v, 'left')) + 0.5;
        if (y < pl.y - 1 || y > pl.y + pl.h + 1) continue;
        ctx.beginPath();
        ctx.moveTo(pl.x, y);
        ctx.lineTo(pl.x + pl.w, y);
        ctx.stroke();
        ctx.fillText(this.opts.formatY ? this.opts.formatY(v) : String(v), pl.x - 6, y);
      }
    }
    if (right) {
      ctx.fillStyle = text;
      ctx.textAlign = 'left';
      for (const v of niceTicks(right[0], right[1], 4)) {
        const y = Math.round(yToPx(v, 'right'));
        if (y < pl.y - 1 || y > pl.y + pl.h + 1) continue;
        ctx.fillText(this.opts.formatY2 ? this.opts.formatY2(v) : String(v), pl.x + pl.w + 6, y);
      }
    }

    // Time axis.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = text;
    ctx.strokeStyle = grid;
    for (const t of timeTicks(this.domain[0], this.domain[1], pl.w)) {
      const x = Math.round(this.xToPx(t)) + 0.5;
      if (x < pl.x || x > pl.x + pl.w) continue;
      ctx.beginPath();
      ctx.moveTo(x, pl.y);
      ctx.lineTo(x, pl.y + pl.h);
      ctx.stroke();
      ctx.fillText(this.opts.formatX ? this.opts.formatX(t) : new Date(t).getHours() + 'h', x, pl.y + pl.h + 6);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(pl.x, pl.y - 4, pl.w, pl.h + 8);
    ctx.clip();

    for (const s of this.series) {
      const pts = this._visible(s).filter((p) => p.y != null && Number.isFinite(p.y));
      if (!pts.length) continue;
      const axis = s.axis || 'left';

      const color = resolveColor(s.color);

      if (s.type === 'bar') {
        const bw = Math.max(2, (pl.w / Math.max(1, pts.length)) * 0.55);
        ctx.fillStyle = color;
        for (const p of pts) {
          const y = yToPx(p.y, axis);
          const base = yToPx((axis === 'right' ? right : left)[0], axis);
          ctx.fillRect(this.xToPx(p.x) - bw / 2, Math.min(y, base), bw, Math.abs(base - y));
        }
        continue;
      }

      if (s.type === 'area' || s.fill) {
        const grad = ctx.createLinearGradient(0, pl.y, 0, pl.y + pl.h);
        grad.addColorStop(0, s.fill ? resolveColor(s.fill) : withAlpha(s.color, 0.33));
        grad.addColorStop(1, 'transparent');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(this.xToPx(pts[0].x), pl.y + pl.h);
        for (const p of pts) ctx.lineTo(this.xToPx(p.x), yToPx(p.y, axis));
        ctx.lineTo(this.xToPx(pts[pts.length - 1].x), pl.y + pl.h);
        ctx.closePath();
        ctx.fill();
      }

      ctx.strokeStyle = color;
      ctx.lineWidth = s.width || 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.setLineDash(s.dashed ? [5, 4] : []);
      ctx.beginPath();
      pts.forEach((p, i) => {
        const x = this.xToPx(p.x);
        const y = yToPx(p.y, axis);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);

      if (s.dots && pts.length <= 60) {
        ctx.fillStyle = color;
        for (const p of pts) {
          ctx.beginPath();
          ctx.arc(this.xToPx(p.x), yToPx(p.y, axis), 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Vertical markers, e.g. "now".
    for (const m of this.markers) {
      const x = Math.round(this.xToPx(m.x)) + 0.5;
      if (x < pl.x || x > pl.x + pl.w) continue;
      ctx.strokeStyle = m.color || '#ffd166';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, pl.y);
      ctx.lineTo(x, pl.y + pl.h);
      ctx.stroke();
      ctx.setLineDash([]);
      if (m.label) {
        ctx.fillStyle = m.color || '#ffd166';
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(m.label, x + 4, pl.y + 2);
      }
    }

    ctx.restore();
    if (this.hover) this._drawHover();
  }

  _drawHover() {
    const ctx = this.ctx;
    const pl = this.plot;
    const x = this.hover.px;
    if (x < pl.x || x > pl.x + pl.w) return;
    const xVal = this.pxToX(x);

    const rows = [];
    for (const s of this.series) {
      const pts = s.points;
      let best = null;
      for (const p of pts) {
        if (p.y == null) continue;
        if (!best || Math.abs(p.x - xVal) < Math.abs(best.x - xVal)) best = p;
      }
      if (best && Math.abs(this.xToPx(best.x) - x) < 60) rows.push({ s, p: best });
    }
    if (!rows.length) return;

    const snapX = this.xToPx(rows[0].p.x);
    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(snapX, pl.y);
    ctx.lineTo(snapX, pl.y + pl.h);
    ctx.stroke();

    for (const r of rows) {
      ctx.fillStyle = resolveColor(r.s.color);
      ctx.beginPath();
      ctx.arc(snapX, this._yToPx(r.p.y, r.s.axis || 'left'), 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    const title = this.opts.formatTooltipTitle
      ? this.opts.formatTooltipTitle(rows[0].p.x)
      : new Date(rows[0].p.x).toLocaleString([], { weekday: 'short', hour: 'numeric' });
    const lines = [title, ...rows.map((r) => `${r.s.label}: ${r.s.format ? r.s.format(r.p.y) : Math.round(r.p.y)}`)];

    ctx.font = '11px system-ui, sans-serif';
    const wBox = Math.max(...lines.map((l, i) => ctx.measureText(l).width + (i === 0 ? 0 : 0))) + 16;
    const hBox = lines.length * 15 + 10;
    let bx = snapX + 10;
    if (bx + wBox > pl.x + pl.w) bx = snapX - wBox - 10;
    const by = Math.min(pl.y + 6, pl.y + pl.h - hBox - 4);

    ctx.fillStyle = 'rgba(14,18,28,.94)';
    ctx.strokeStyle = 'rgba(255,255,255,.14)';
    ctx.beginPath();
    ctx.roundRect(bx, by, wBox, hBox, 8);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => {
      ctx.fillStyle = i === 0 ? 'rgba(255,255,255,.65)' : resolveColor(rows[i - 1].s.color);
      ctx.font = i === 0 ? '10px system-ui, sans-serif' : '11px system-ui, sans-serif';
      ctx.fillText(line, bx + 8, by + 6 + i * 15);
    });
  }

  /* ------------------------------------------------------------ gestures -- */

  _bind() {
    const el = this.canvas;
    el.style.touchAction = 'none';

    const local = (e) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    el.addEventListener('pointerdown', (e) => {
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // Capture is a nicety — a pointer the browser no longer owns still pans.
      }
      this.pointers.set(e.pointerId, local(e));
      this._gesture = null;
      const now = Date.now();
      if (now - (this._lastTap || 0) < 300 && this.pointers.size === 1) this.resetZoom();
      this._lastTap = now;
    });

    el.addEventListener('pointermove', (e) => {
      const pos = local(e);
      if (!this.pointers.has(e.pointerId)) {
        if (e.pointerType === 'mouse') {
          this.hover = { px: pos.x };
          this.draw();
        }
        return;
      }
      const prev = this.pointers.get(e.pointerId);
      this.pointers.set(e.pointerId, pos);

      if (this.pointers.size === 2) {
        const [p1, p2] = [...this.pointers.values()];
        const dist = Math.abs(p1.x - p2.x) || 1;
        const mid = (p1.x + p2.x) / 2;
        if (this._pinch) {
          this._zoomAbout(mid, this._pinch.dist / dist);
          // Panning the pinch midpoint drags the axis along with the fingers.
          this._panPx(mid - this._pinch.mid);
        }
        this._pinch = { dist, mid };
        this.hover = null;
        this.draw();
      } else if (this.pointers.size === 1) {
        this._pinch = null;
        this._panPx(pos.x - prev.x);
        this.hover = { px: pos.x };
        this.draw();
      }
    });

    const release = (e) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this._pinch = null;
      if (this.pointers.size === 0 && e.pointerType !== 'mouse') {
        this.hover = null;
        this.draw();
      }
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !this.pointers.size) {
        this.hover = null;
        this.draw();
      }
    });

    el.addEventListener(
      'wheel',
      (e) => {
        if (!this.domain) return;
        e.preventDefault();
        const pos = local(e);
        if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          this._zoomAbout(pos.x, Math.exp(e.deltaY * 0.002));
        } else {
          this._panPx(-e.deltaX);
        }
        this.hover = { px: pos.x };
        this.draw();
      },
      { passive: false },
    );
  }

  _zoomAbout(px, factor) {
    if (!this.domain) return;
    const anchor = this.pxToX(px);
    const [a, b] = this.domain;
    this.domain = [anchor - (anchor - a) * factor, anchor + (b - anchor) * factor];
    this._clampDomain();
  }

  _panPx(dx) {
    if (!this.domain || !dx) return;
    const [a, b] = this.domain;
    const perPx = (b - a) / this.plot.w;
    this.domain = [a - dx * perPx, b - dx * perPx];
    this._clampDomain();
  }

  resetZoom() {
    if (!this.fullDomain) return;
    this.domain = [...(this.opts.initialDomain || this.fullDomain)];
    this._clampDomain();
    this.draw();
  }
}
