import * as fs from 'node:fs';
import * as path from 'node:path';

// Exophase refreshes dilute rates when players grow faster than earners.
// Model these counts separately, then divide: this is independent of the starter.
const EPOCH = Date.parse('2026-11-19T00:00:00Z');
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const OFFSETS = [-1.645, -0.674, 0, 0.674, 1.645];
type Reading = { at: string; players_tracked: number; rates: (number | null)[] };
type Input = {
  id: string; target: string; horizon_minutes: number; levels: number[];
  trophies: { id: number }[]; history: Reading[];
};
type Point = { x: number; y: number };
type Line = { slope: number; meanX: number; meanY: number; xx: number; xy: number };

function limit(v: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, v));
}
function logOdds(percent: number): number {
  const r = limit(percent, 0.01, 99.99);
  return Math.log(r / (100 - r));
}
function toPercent(value: number): number {
  return 100 / (1 + Math.exp(-value));
}
function age(timestamp: string): number {
  // Initial reads precede midnight: clamp their age to zero.
  return Math.log1p(Math.max(0, (Date.parse(timestamp) - EPOCH) / 3_600_000));
}
function regress(points: Point[]): Line | null {
  if (points.length < 2 || points.some(p => !Number.isFinite(p.x + p.y))) return null;
  const meanX = points.reduce((s, p) => s + p.x, 0) / points.length;
  const meanY = points.reduce((s, p) => s + p.y, 0) / points.length;
  let xx = 0, xy = 0;
  for (const p of points) {
    xx += (p.x - meanX) ** 2;
    xy += (p.x - meanX) * (p.y - meanY);
  }
  if (xx < 1e-12) return null;
  const slope = xy / xx;
  return Number.isFinite(slope) ? { slope, meanX, meanY, xx, xy } : null;
}
function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

function forecast(data: Input) {
  if (JSON.stringify(data.levels) !== JSON.stringify(LEVELS)) throw new Error('Unsupported levels');
  if (!data.history.length) throw new Error('Empty history');
  const history = data.history;
  const finalRead = history[history.length - 1];
  const targetX = age(data.target);
  const xs = history.map(r => age(r.at));
  const playersChanged = history.some(r => r.players_tracked !== history[0].players_tracked);
  const playerLine = regress(history.map((r, j) => ({ x: xs[j], y: Math.log(r.players_tracked) })));
  let futurePlayers = finalRead.players_tracked;
  if (playersChanged && playerLine) {
    const p = Math.exp(playerLine.meanY + limit(playerLine.slope, 0, 1.5) * (targetX - playerLine.meanX));
    if (Number.isFinite(p)) futurePlayers = Math.max(futurePlayers, p);
  }

  const series = data.trophies.map((_, index) => {
    let previous: number | null = null;
    let observed = 0;
    const rates: (number | null)[] = [];
    const counts: number[] = [];
    const points: Point[] = [];
    for (let j = 0; j < history.length; j++) {
      const raw = history[j].rates[index];
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        previous = limit(raw, 0, 100);
        observed++;
      }
      rates.push(previous);
      // Forward fill only: leading nulls have no earlier value to impute.
      if (previous !== null) {
        const earners = previous * history[j].players_tracked / 100;
        counts.push(earners);
        points.push({ x: xs[j], y: Math.log(earners + 0.5) });
      }
    }
    return { rates, counts, observed, line: regress(points), lastRate: previous ?? 0 };
  });

  // Pool within-trophy centered regressions, allowing separate intercepts.
  // This prevents common trophies from dominating just through their size.
  let pooledXX = 0, pooledXY = 0;
  for (const s of series) {
    if (s.observed >= 3 && s.line && s.counts.some(e => e > 0)) {
      pooledXX += s.line.xx;
      pooledXY += s.line.xy;
    }
  }
  const pooledSlope = pooledXX > 1e-12 ? limit(pooledXY / pooledXX, -0.5, 3) : 0;
  const increments: number[] = [];
  for (const s of series) {
    for (let j = 1; j < history.length; j++) {
      const days = (Date.parse(history[j].at) - Date.parse(history[j - 1].at)) / 86_400_000;
      const a = s.rates[j - 1], b = s.rates[j];
      if (days > 0 && a !== null && b !== null) increments.push((logOdds(b) - logOdds(a)) / Math.sqrt(days));
    }
  }
  // Stale reads can make MAD zero; the floor retains unseen-refresh risk.
  const center = median(increments);
  const robustSigma = 1.4826 * median(increments.map(v => Math.abs(v - center)));
  // Practice histories are entirely stale across a known unseen refresh.
  // A 0.60 floor acknowledges that uncertainty without inventing median drift.
  const walkSigma = limit(robustSigma, playersChanged ? 0.40 : 0.60, 1.20);
  const horizonDays = Math.max(0, data.horizon_minutes / 1440);

  return { trophies: data.trophies.map((trophy, index) => {
    const s = series[index];
    let middle = limit(s.lastRate, 0.01, 99.99);
    const allZero = s.counts.length > 0 && s.counts.every(e => e === 0);
    const allFull = s.observed > 0 && s.rates.every(r => r === null || r === 100);
    if (allZero) middle = 0.02;
    else if (allFull) middle = 99.99;
    else if (s.observed >= 3 && s.line) {
      const weight = s.observed / (s.observed + 4);
      const slope = limit(weight * s.line.slope + (1 - weight) * pooledSlope, -0.5, 3);
      // Recenter the intercept after shrinkage to preserve the fitted mean.
      const futureEarners = Math.max(0, Math.exp(s.line.meanY + slope * (targetX - s.line.meanX)) - 0.5);
      const proposed = 100 * futureEarners / futurePlayers;
      if (Number.isFinite(proposed)) {
        const reference = logOdds(s.lastRate);
        middle = toPercent(reference + limit(logOdds(proposed) - reference, -2.5, 2.5));
      }
    }
    const lastEarners = s.counts[s.counts.length - 1] ?? 0;
    const localWalk = allZero ? Math.max(0.9, walkSigma) : walkSigma;
    const spread = Math.sqrt(localWalk ** 2 * horizonDays + 0.25 ** 2 + 1 / Math.max(lastEarners, 1));
    let preceding = 0;
    const q = OFFSETS.map(z => {
      const rounded = Math.round(toPercent(logOdds(middle) + z * spread) * 10_000) / 10_000;
      preceding = Math.max(preceding, limit(rounded, 0, 100));
      return preceding;
    });
    return { id: trophy.id, q };
  }) };
}

function run(): void {
  const source = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const destination = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  fs.mkdirSync(destination, { recursive: true });
  for (const filename of fs.readdirSync(source).filter(n => n.endsWith('.in')).sort()) {
    const data: Input = JSON.parse(fs.readFileSync(path.join(source, filename), 'utf8'));
    const serialized = JSON.stringify(forecast(data)) + '\n';
    if (Buffer.byteLength(serialized) > 65_536) throw new Error('Forecast exceeds size limit');
    fs.writeFileSync(path.join(destination, `${data.id}.out`), serialized);
  }
}
run();
