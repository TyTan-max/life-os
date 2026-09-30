import type { SleepEntry } from '../types';
import { formatHours, nightsOf, sleepConsistency } from '../lib/sleep';
import type { SleepNight } from '../lib/sleep';

// "22:45" → "10:45 pm"
function to12h(time: string): string {
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

function isoOffset(endIso: string, deltaDays: number): string {
  const d = new Date(`${endIso}T12:00:00`);
  d.setDate(d.getDate() + deltaDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Quality colours bars: good (8–10) green, middling (5–7) amber, poor (1–4) red, not rated neutral.
function qualityTone(q: number | undefined): string {
  if (q == null) return 'unrated';
  if (q >= 8) return 'good';
  if (q >= 5) return 'ok';
  return 'poor';
}

// One bar per night for the last `days` nights ending `endDate`, a dashed line at the target,
// and bars coloured by quality. Nights with nothing logged leave a gap so missing nights show.
export function SleepTrendChart({ entries, target, days, endDate }: {
  entries: SleepEntry[];
  target: number;
  days: number;
  endDate: string;
}) {
  const dates = Array.from({ length: days }, (_, i) => isoOffset(endDate, i - (days - 1)));
  // One bar per night: a night logged in pieces is added up; naps aren't part of it.
  const byDate = new Map<string, SleepNight>();
  for (const n of nightsOf(entries.filter(e => dates.includes(e.date)))) byDate.set(n.date, n);
  const logged = dates.map(d => byDate.get(d)).filter((n): n is SleepNight => !!n);
  if (!logged.length) return <p className="muted empty-state">No nights logged in the last {days} days.</p>;

  const hours = logged.map(n => n.hours);
  const consistency = sleepConsistency(logged);
  const scaleMax = Math.ceil(Math.max(target + 1, 9, ...hours));
  const H = 60; // chart height in viewBox units; bars grow up from y = H
  const slot = 100 / days;
  const gap = Math.min(slot * 0.18, 1.2);
  const targetY = H - (target / scaleMax) * H;
  const avg = hours.reduce((s, h) => s + h, 0) / hours.length;
  const atOrAbove = hours.filter(h => h >= target).length;
  const labelEvery = days <= 7 ? 1 : days <= 14 ? 2 : 5;
  const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', opts);

  return (
    <div className="sleep-trend">
      <div className="sleep-trend-plot">
        <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" className="sleep-trend-svg" role="img"
          aria-label={`Sleep over the last ${days} nights: average ${avg.toFixed(1)} hours, ${atOrAbove} of ${logged.length} logged nights at or above the ${target}-hour target`}>
          {dates.map((d, i) => {
            const e = byDate.get(d);
            if (!e) return null;
            const h = e.hours;
            const barH = Math.max(0.8, (h / scaleMax) * H);
            return (
              <rect key={d} x={i * slot + gap} y={H - barH} width={slot - gap * 2} height={barH} rx={Math.min(1, slot / 6)}
                className={`sleep-trend-bar ${qualityTone(e.quality)}`}>
                <title>{`${fmt(d, { weekday: 'short', month: 'short', day: 'numeric' })} — ${h}h${e.awakeHours ? ` · awake ${formatHours(e.awakeHours)} in the middle` : ''}${e.naps ? ` · + ${formatHours(e.napHours)} nap` : ''}${e.quality != null ? ` · quality ${e.quality}/10` : ''}`}</title>
              </rect>
            );
          })}
          <line x1="0" x2="100" y1={targetY} y2={targetY} className="sleep-trend-target" />
        </svg>
        <span className="sleep-trend-target-label" style={{ top: `${(targetY / H) * 100}%` }}>{target}h</span>
      </div>
      <div className="sleep-trend-axis" style={{ gridTemplateColumns: `repeat(${days}, minmax(0, 1fr))` }}>
        {dates.map((d, i) => (
          <span key={d}>{(days - 1 - i) % labelEvery === 0 ? (days <= 7 ? fmt(d, { weekday: 'narrow' }) : fmt(d, { month: 'numeric', day: 'numeric' })) : ''}</span>
        ))}
      </div>
      <div className="sleep-trend-summary">
        <span><b>{avg.toFixed(1)}h</b> average</span>
        <span><b>{atOrAbove}/{logged.length}</b> nights at target</span>
        {/* Schedule consistency — a steady bed/wake time matters as much as total hours. */}
        {consistency && (
          <span title={`Average over ${consistency.nights} nights with bed and wake times; ± is how far nights typically vary`}>
            Bed <b>{to12h(consistency.bedTime)}</b> ± {consistency.bedSpreadMin} min · Up <b>{to12h(consistency.wakeTime)}</b> ± {consistency.wakeSpreadMin} min
          </span>
        )}
        <span className="sleep-trend-legend">
          <i className="good" />8–10 <i className="ok" />5–7 <i className="poor" />1–4 <i className="unrated" />unrated
        </span>
      </div>
    </div>
  );
}
