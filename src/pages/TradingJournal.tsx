import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { Calendar as CalendarIcon, ChevronDown, ChevronLeft, ChevronRight, ImagePlus, Minus, Plus, RotateCcw, StickyNote, Table2, TrendingDown, TrendingUp, Trash2, Upload, X } from 'lucide-react';
import { useStore, newRecord } from '../store';
import type { DailyLog, TradingScreenshot } from '../types';
import { formatCurrency, Modal } from '../components/UI';
import { DatePicker } from '../components/DatePicker';
import { MobileRecordList } from '../components/MobileRecordList';
import { useIsMobile } from '../hooks/useIsMobile';
import { useFabAction } from '../hooks/useFabAction';

const EMOTIONS: { value: string; emoji: string }[] = [
  { value: 'Greed', emoji: '🤑' },
  { value: 'Fear', emoji: '😨' },
  { value: 'Revenge', emoji: '😤' },
  { value: 'Anxiety', emoji: '😰' },
  { value: 'Hope', emoji: '🙏' },
  { value: 'Calm', emoji: '😌' }
];
const CAT_CLASSES = ['tj-cat-1', 'tj-cat-2', 'tj-cat-3', 'tj-cat-4'];

type Period = 'Week' | 'Month' | 'Year' | 'Total';
const PERIODS: Period[] = ['Week', 'Month', 'Year', 'Total'];

function netOf(log: DailyLog): number {
  return log.dailyPL - log.dailyFees;
}

function statusOf(net: number): 'GREEN' | 'RED' | 'FLAT' {
  return net > 0 ? 'GREEN' : net < 0 ? 'RED' : 'FLAT';
}

function blankLog(): Pick<DailyLog, 'date' | 'totalTrades' | 'dailyPL' | 'dailyFees'> {
  return { date: new Date().toISOString().slice(0, 10), totalTrades: 0, dailyPL: 0, dailyFees: 0 };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function startOfWeek(d: Date): Date {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
  s.setDate(s.getDate() - s.getDay());
  return s;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function periodRangeFor(period: Period, anchor: Date): { start: string; end: string } | null {
  if (period === 'Week') {
    const start = startOfWeek(anchor);
    return { start: toIsoDate(start), end: toIsoDate(addDays(start, 6)) };
  }
  if (period === 'Month') {
    const ym = `${anchor.getFullYear()}-${pad2(anchor.getMonth() + 1)}`;
    return { start: `${ym}-01`, end: `${ym}-31` };
  }
  if (period === 'Year') {
    const y = anchor.getFullYear();
    return { start: `${y}-01-01`, end: `${y}-12-31` };
  }
  return null;
}

function isCurrentPeriod(period: Period, anchor: Date): boolean {
  const a = periodRangeFor(period, anchor);
  const b = periodRangeFor(period, new Date());
  if (!a || !b) return true;
  return a.start === b.start && a.end === b.end;
}

function formatPeriodLabel(period: Period, anchor: Date): string {
  if (period === 'Week') {
    const start = startOfWeek(anchor);
    const end = addDays(start, 6);
    const sameMonth = start.getMonth() === end.getMonth();
    const startLabel = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const endLabel = end.toLocaleDateString('en-US', sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' });
    return `${startLabel} – ${endLabel}, ${end.getFullYear()}`;
  }
  if (period === 'Month') return anchor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  if (period === 'Year') return String(anchor.getFullYear());
  return 'All Time';
}

function fmt(n: number, digits = 2): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

function formatCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1000) return `${n < 0 ? '-' : ''}$${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1)}K`;
  return formatCurrency(n);
}

function niceAxisValues(min: number, max: number): number[] {
  if (min === max) return [min];
  return [max, (min + max) / 2, min];
}

interface AxisTick { index: number; text: string; }

// Ticks adapt to the active period tab: Week -> days, Month -> weeks, Year -> months, Total -> years.
function buildAxisTicks(points: { label: string; value: number }[], period: Period): AxisTick[] {
  if (!points.length) return [];
  if (period === 'Week') {
    return points.map((p, i) => ({ index: i, text: new Date(`${p.label}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short' }) }));
  }
  if (period === 'Year') {
    const seen = new Set<string>();
    const ticks: AxisTick[] = [];
    points.forEach((p, i) => {
      const d = new Date(`${p.label}T12:00:00`);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (!seen.has(key)) { seen.add(key); ticks.push({ index: i, text: d.toLocaleDateString('en-US', { month: 'short' }) }); }
    });
    return ticks;
  }
  if (period === 'Total') {
    const seen = new Set<string>();
    const ticks: AxisTick[] = [];
    points.forEach((p, i) => {
      const d = new Date(`${p.label}T12:00:00`);
      const key = String(d.getFullYear());
      if (!seen.has(key)) { seen.add(key); ticks.push({ index: i, text: key }); }
    });
    return ticks;
  }
  // Month period -> roughly weekly ticks.
  const maxTicks = 5;
  const step = Math.max(1, Math.ceil(points.length / maxTicks));
  const ticks: AxisTick[] = [];
  for (let i = 0; i < points.length; i += step) {
    const d = new Date(`${points[i].label}T12:00:00`);
    ticks.push({ index: i, text: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) });
  }
  return ticks;
}

function formatFullDate(dateStr: string): string {
  return new Date(`${dateStr}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Downscales + re-encodes to JPEG so screenshots don't blow past localStorage's size limits.
function fileToCompressedDataUrl(file: File, maxDim = 1600, quality = 0.82): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      img.onerror = () => reject(new Error('Could not read image'));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(reader.result as string); return; }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

// A number input that lets the field go blank while editing instead of snapping back to "0",
// and only re-commits to 0 once the user leaves the field empty.
function NumberField({
  value, onChange, className, min, decimals
}: { value: number; onChange: (n: number) => void; className?: string; min?: number; decimals?: number }) {
  const [text, setText] = useState(String(value));

  useEffect(() => { setText(String(value)); }, [value]);

  return (
    <input
      type="number"
      className={className}
      value={text}
      min={min}
      onFocus={e => {
        // The .00 formatting from the last blur is a display-only nicety — editing should
        // start from the plain number, not force the user to delete trailing zeros first.
        if (decimals != null && text !== '' && text !== '-') {
          const n = Number(text);
          if (!Number.isNaN(n)) setText(String(n));
        }
        // Deferred so the select happens after React commits the un-formatted text above —
        // selecting immediately would still grab the old ".00" value pre-render.
        const input = e.target;
        setTimeout(() => input.select(), 0);
      }}
      onChange={e => {
        const raw = e.target.value;
        // Reject (rather than round) keystrokes that would exceed the decimal limit, so typing
        // a 3rd fractional digit is simply a no-op instead of reformatting mid-keystroke and
        // fighting the cursor.
        if (decimals != null && raw !== '' && raw !== '-') {
          const re = new RegExp(`^-?\\d*\\.?\\d{0,${decimals}}$`);
          if (!re.test(raw)) return;
        }
        setText(raw);
        if (raw === '' || raw === '-' || raw.endsWith('.')) return;
        const n = Number(raw);
        if (Number.isNaN(n)) return;
        if (min != null && n < min) {
          setText(String(min));
          onChange(min);
          return;
        }
        onChange(n);
      }}
      onBlur={() => {
        if (text === '' || text === '-' || Number.isNaN(Number(text))) {
          setText(decimals != null ? (0).toFixed(decimals) : '0');
          onChange(0);
          return;
        }
        if (decimals != null) setText(Number(text).toFixed(decimals));
      }}
    />
  );
}

// Single line at rest; grows to a wrapped, multi-line box while focused so a full note is easy to read/write.
function NotesField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <textarea
      className={`tj-cell-input tj-notes-input ${expanded ? 'expanded' : ''}`}
      rows={expanded ? 4 : 1}
      placeholder="Add a note…"
      value={value}
      onFocus={() => setExpanded(true)}
      onBlur={() => setExpanded(false)}
      onChange={e => onChange(e.target.value)}
    />
  );
}

function LineChart({ points, period }: { points: { label: string; value: number }[]; period: Period }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);

  if (points.length < 2) return <p className="muted tj-empty">Log at least two days in this period to see the curve.</p>;

  const values = points.map(p => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const n = points.length;
  const trendPos = values[values.length - 1] >= values[0];
  const coords = points.map((p, i) => ({
    x: (i / (n - 1)) * 100,
    y: 36 - ((p.value - min) / range) * 32 - 2,
    ...p
  }));
  const pathD = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x} ${c.y}`).join(' ');
  const areaD = `${pathD} L 100 40 L 0 40 Z`;
  const ticks = buildAxisTicks(points, period);
  const yTicks = niceAxisValues(min, max);

  const handleMove = (clientX: number) => {
    const el = plotRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    setHoverIndex(Math.round(fraction * (n - 1)));
  };

  const hovered = hoverIndex !== null ? coords[hoverIndex] : null;
  const prevValue = hoverIndex !== null && hoverIndex > 0 ? points[hoverIndex - 1].value : null;
  const diff = hovered && prevValue !== null ? hovered.value - prevValue : null;
  const tooltipAlign = hovered ? (hovered.x < 18 ? 'start' : hovered.x > 82 ? 'end' : 'center') : 'center';

  return (
    <div className="tj-linechart-wrap">
      <div className="tj-linechart-yaxis">
        {yTicks.map((v, i) => <span key={i}>{formatCompact(v)}</span>)}
      </div>
      <div
        className="tj-linechart-plot"
        ref={plotRef}
        onMouseMove={e => handleMove(e.clientX)}
        onMouseLeave={() => setHoverIndex(null)}
      >
        <svg viewBox="0 0 100 40" className="tj-svg-line" preserveAspectRatio="none">
          <path d={areaD} className={trendPos ? 'tj-area-pos' : 'tj-area-neg'} />
          <path d={pathD} fill="none" className={trendPos ? 'tj-line-pos' : 'tj-line-neg'} />
          {hovered && <line x1={hovered.x} y1="0" x2={hovered.x} y2="40" className="tj-crosshair" vectorEffect="non-scaling-stroke" />}
          {hovered && (
            <circle
              cx={hovered.x}
              cy={hovered.y}
              r="1.8"
              className={trendPos ? 'tj-fill-pos' : 'tj-fill-neg'}
              stroke="var(--surface)"
              strokeWidth="0.7"
            />
          )}
        </svg>
        {hovered && (
          <div className={`tj-chart-tooltip align-${tooltipAlign}`} style={{ left: `${hovered.x}%` }}>
            <b>{formatFullDate(hovered.label)}</b>
            <span>{formatCurrency(hovered.value)}</span>
            {diff !== null && (
              <small className={diff >= 0 ? 'tj-text-green' : 'tj-text-neg'}>
                {diff >= 0 ? '+' : ''}{formatCurrency(diff)} vs. previous
              </small>
            )}
          </div>
        )}
        <div className="tj-linechart-xaxis">
          {ticks.map((t, ti) => {
            const align = ti === 0 ? 'start' : ti === ticks.length - 1 ? 'end' : 'center';
            return (
              <span key={t.index} className={`tj-axis-tick align-${align}`} style={{ left: `${(t.index / (n - 1)) * 100}%` }}>
                {t.text}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function EquityTable({ points }: { points: { label: string; value: number }[] }) {
  if (!points.length) return <p className="muted tj-empty">No data yet.</p>;
  return (
    <div className="tj-equity-table-wrap scroll-list">
      <table className="tj-equity-table">
        <thead><tr><th>Date</th><th>Balance</th><th>Change</th></tr></thead>
        <tbody>
          {points.slice().reverse().map((p, i) => {
            const idx = points.length - 1 - i;
            const prev = idx > 0 ? points[idx - 1].value : null;
            const diff = prev !== null ? p.value - prev : null;
            return (
              <tr key={p.label}>
                <td>{formatFullDate(p.label)}</td>
                <td>{formatCurrency(p.value)}</td>
                <td className={diff === null ? 'muted' : diff >= 0 ? 'tj-text-green' : 'tj-text-neg'}>
                  {diff === null ? '—' : `${diff >= 0 ? '+' : ''}${formatCurrency(diff)}`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function VBars({ data }: { data: { label: string; value: number }[] }) {
  if (!data.length) return <p className="muted tj-empty">No data yet.</p>;
  const max = Math.max(1, ...data.map(d => Math.abs(d.value)));
  const n = data.length;
  const bw = 100 / n;
  return (
    <div className="tj-chart">
      <svg viewBox="0 0 100 60" className="tj-svg" preserveAspectRatio="none">
        <line x1="0" y1="30" x2="100" y2="30" className="tj-zero" />
        {data.map((d, i) => {
          const h = (Math.abs(d.value) / max) * 26;
          const x = i * bw + bw * 0.22;
          const w = bw * 0.56;
          const y = d.value >= 0 ? 30 - h : 30;
          return (
            <rect key={d.label} x={x} y={y} width={w} height={Math.max(h, 0.6)} rx={0.8} className={d.value >= 0 ? 'tj-fill-pos' : 'tj-fill-neg'}>
              <title>{`${d.label}: ${fmt(d.value)}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="tj-chart-labels">{data.map(d => <span key={d.label}>{d.label}</span>)}</div>
    </div>
  );
}

function CatBars({ data }: { data: { label: string; value: number; cls: string }[] }) {
  if (!data.length) return <p className="muted tj-empty">No data yet.</p>;
  const max = Math.max(1, ...data.map(d => d.value));
  return (
    <div className="tj-catbars">
      {data.map(d => (
        <div className="tj-catbar-col" key={d.label}>
          <div className="tj-catbar-track">
            <div className={`tj-catbar-fill ${d.cls}`} style={{ height: `${(d.value / max) * 100}%` }} title={`${d.label}: ${d.value}`} />
          </div>
          <span>{d.label}</span>
        </div>
      ))}
    </div>
  );
}

function trendIcon(value: number) {
  if (value > 0) return <TrendingUp size={14} />;
  if (value < 0) return <TrendingDown size={14} />;
  return <Minus size={14} />;
}

function trendClass(value: number) {
  if (value > 0) return 'tj-text-green';
  if (value < 0) return 'tj-text-neg';
  return '';
}

function StatTiles({ tiles }: { tiles: { label: string; value: number }[] }) {
  return (
    <div className="tj-stat-tiles">
      {tiles.map(t => (
        <div className="tj-stat-tile" key={t.label}>
          <span className={`tj-gr-icon ${trendClass(t.value)}`}>{trendIcon(t.value)}</span>
          <div className="tj-stat-tile-text">
            <small>{t.label}</small>
            <b className={trendClass(t.value)}>{formatCurrency(t.value)}</b>
          </div>
        </div>
      ))}
    </div>
  );
}

function GreenRedDaysPanel({ green, red, flat }: { green: number; red: number; flat: number }) {
  const total = green + red + flat;
  const greenPct = total ? (green / total) * 100 : 0;
  const redPct = total ? (red / total) * 100 : 0;
  const flatPct = total ? (flat / total) * 100 : 0;
  const winRate = green + red ? (green / (green + red)) * 100 : 0;
  const leadingRed = red > green;

  return (
    <div className="tj-gr-panel">
      <div className={`tj-headline tj-headline-icon ${leadingRed ? 'tj-text-neg' : 'tj-text-green'}`}>
        {leadingRed ? <TrendingDown size={18} /> : <TrendingUp size={18} />}
        {fmt(winRate)}% Green
      </div>
      {total > 0 ? (
        <div className="tj-splitbar">
          {green > 0 && <div className="tj-splitbar-seg tj-gr-fill-green" style={{ width: `${greenPct}%` }} title={`Green: ${green} day${green === 1 ? '' : 's'} (${fmt(greenPct)}%)`} />}
          {red > 0 && <div className="tj-splitbar-seg tj-gr-fill-red" style={{ width: `${redPct}%` }} title={`Red: ${red} day${red === 1 ? '' : 's'} (${fmt(redPct)}%)`} />}
          {flat > 0 && <div className="tj-splitbar-seg tj-gr-fill-flat" style={{ width: `${flatPct}%` }} title={`Flat: ${flat} day${flat === 1 ? '' : 's'} (${fmt(flatPct)}%)`} />}
        </div>
      ) : <div className="tj-splitbar tj-splitbar-empty" />}
      <div className="tj-gr-rows">
        <div className="tj-gr-row">
          <span className="tj-gr-icon tj-text-green"><TrendingUp size={14} /></span>
          <span className="tj-gr-label">Green Days</span>
          <b>{green}</b>
        </div>
        <div className="tj-gr-row">
          <span className="tj-gr-icon tj-text-neg"><TrendingDown size={14} /></span>
          <span className="tj-gr-label">Red Days</span>
          <b>{red}</b>
        </div>
        {flat > 0 && (
          <div className="tj-gr-row tj-gr-row-muted">
            <span className="tj-gr-icon"><Minus size={14} /></span>
            <span className="tj-gr-label">Flat Days</span>
            <b>{flat}</b>
          </div>
        )}
      </div>
    </div>
  );
}

// Free-text label input with a dropdown of saved presets (chevron) and a way to save new ones (+).
function LabelPicker({
  value, presets, onChange, onAddPreset, onRemovePreset
}: {
  value: string;
  presets: string[];
  onChange: (v: string) => void;
  onAddPreset: (v: string) => void;
  onRemovePreset: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const addNew = () => {
    const trimmed = newLabel.trim();
    if (!trimmed) return;
    onAddPreset(trimmed);
    onChange(trimmed);
    setNewLabel('');
  };

  return (
    <div className="tj-label-picker" ref={wrapRef} onClick={e => e.stopPropagation()}>
      <div className="tj-label-picker-row">
        <input
          type="text"
          className="tj-screenshot-label-input"
          placeholder="Add label…"
          value={value}
          onChange={e => onChange(e.target.value)}
        />
        <button type="button" className="tj-label-picker-toggle" onClick={() => setOpen(o => !o)} aria-label="Choose a saved label">
          <ChevronDown size={12} />
        </button>
      </div>
      {open && (
        <div className="tj-label-picker-dropdown">
          {presets.length ? (
            <div className="tj-label-picker-list">
              {presets.map(p => (
                <div className="tj-label-picker-item" key={p}>
                  <button type="button" className="tj-label-picker-option" onClick={() => { onChange(p); setOpen(false); }}>{p}</button>
                  <button type="button" className="tj-label-picker-remove" onClick={() => onRemovePreset(p)} aria-label={`Remove preset ${p}`}><X size={10} /></button>
                </div>
              ))}
            </div>
          ) : <p className="tj-label-picker-empty">No saved labels yet.</p>}
          <div className="tj-label-picker-add">
            <input
              type="text"
              placeholder="New preset…"
              value={newLabel}
              onChange={e => setNewLabel(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addNew(); } }}
            />
            <button type="button" className="tj-label-picker-add-btn" onClick={addNew} aria-label="Save new preset label"><Plus size={12} /></button>
          </div>
        </div>
      )}
    </div>
  );
}

function ScreenshotsModal({
  log, onClose, onAdd, onRemove, onReorder, onRelabel, presetLabels, onAddPreset, onRemovePreset
}: {
  log: DailyLog;
  onClose: () => void;
  onAdd: (files: FileList) => void;
  onRemove: (index: number) => void;
  onReorder: (from: number, to: number) => void;
  onRelabel: (index: number, label: string) => void;
  presetLabels: string[];
  onAddPreset: (label: string) => void;
  onRemovePreset: (label: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const shots = log.screenshots ?? [];
  const [preview, setPreview] = useState<number | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  return (
    <Modal eyebrow="Life OS" title={`Screenshots — ${formatFullDate(log.date)}`} onClose={onClose}>
      <div className="tj-screenshots">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={e => { if (e.target.files?.length) onAdd(e.target.files); e.target.value = ''; }}
        />
        <button type="button" className="tj-screenshot-upload" onClick={() => fileRef.current?.click()}>
          <Upload size={16} /> Upload screenshots
        </button>
        {shots.length ? (
          <>
            <p className="tj-screenshot-hint">
              {shots.length > 1 ? 'Drag a screenshot to reorder it. ' : ''}
              Label each one — ticker, strategy, or option leg. Use the arrow for saved labels, or + to save a new one.
            </p>
            <div className="tj-screenshot-grid">
              {shots.map((shot, i) => (
                <div
                  className={`tj-screenshot-thumb ${dragIndex === i ? 'dragging' : ''} ${overIndex === i && dragIndex !== null && dragIndex !== i ? 'drag-over' : ''}`}
                  key={i}
                  draggable
                  onDragStart={() => setDragIndex(i)}
                  onDragEnter={() => setOverIndex(i)}
                  onDragOver={e => e.preventDefault()}
                  onDrop={() => {
                    if (dragIndex !== null && dragIndex !== i) onReorder(dragIndex, i);
                    setDragIndex(null);
                    setOverIndex(null);
                  }}
                  onDragEnd={() => { setDragIndex(null); setOverIndex(null); }}
                >
                  <div className="tj-screenshot-frame">
                    <span className="tj-screenshot-index">{i + 1}</span>
                    <img src={shot.src} alt={`Screenshot ${i + 1}`} onClick={() => setPreview(i)} />
                    <button type="button" className="tj-screenshot-remove" onClick={() => onRemove(i)} aria-label="Remove screenshot"><Trash2 size={12} /></button>
                  </div>
                  <LabelPicker
                    value={shot.label ?? ''}
                    presets={presetLabels}
                    onChange={v => onRelabel(i, v)}
                    onAddPreset={onAddPreset}
                    onRemovePreset={onRemovePreset}
                  />
                </div>
              ))}
            </div>
          </>
        ) : <p className="muted tj-empty">No screenshots for this day yet.</p>}
      </div>
      {preview !== null && shots[preview] && (
        <ScreenshotLightbox
          key={preview}
          src={shots[preview].src}
          label={shots[preview].label}
          index={preview}
          onClose={() => setPreview(null)}
        />
      )}
    </Modal>
  );
}

const ZOOM_MIN = 1;
const ZOOM_MAX = 4;
const ZOOM_CLICK_STEP = 2.5;

function ScreenshotLightbox({
  src, label, index, onClose
}: {
  src: string;
  label: string | undefined;
  index: number;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  // A pointerup always fires a click right after it — including at the end of a drag, not just a
  // tap. dragRef is already cleared by then (pointerup needs it to distinguish itself from a
  // stray move), so the click handler needs its own record of whether real movement happened,
  // one that survives past pointerup into the click that follows it.
  const didDragRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  const resetZoom = () => { setZoom(1); setPan({ x: 0, y: 0 }); };

  // Click toggles between fit and a fixed zoom level — the common "tap to zoom" pattern. Wheel
  // gives finer, continuous control for anyone who wants a specific zoom level instead.
  const onImageClick = (e: ReactMouseEvent) => {
    e.stopPropagation();
    if (didDragRef.current) { didDragRef.current = false; return; } // this click is the tail end of a drag
    if (zoom > 1) resetZoom();
    else setZoom(ZOOM_CLICK_STEP);
  };

  // React's synthetic onWheel is registered as a passive listener, so e.preventDefault() there
  // silently fails (and logs a console error) — a native listener is the only way to actually
  // stop the page/trackpad from scrolling or pinch-zooming while the cursor is over the image.
  useEffect(() => {
    const el = imgRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setZoom(z => {
        const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z - e.deltaY * 0.0025));
        if (next === ZOOM_MIN) setPan({ x: 0, y: 0 });
        return next;
      });
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (zoom <= 1) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
    didDragRef.current = false;
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!dragRef.current) return;
    e.stopPropagation();
    const { startX, startY, panX, panY } = dragRef.current;
    // A few pixels of jitter shouldn't count as "dragged" — only real movement should suppress
    // the click-to-zoom-out that follows.
    if (Math.abs(e.clientX - startX) > 3 || Math.abs(e.clientY - startY) > 3) didDragRef.current = true;
    setPan({ x: panX + (e.clientX - startX), y: panY + (e.clientY - startY) });
  };
  const endDrag = (e: ReactPointerEvent) => {
    if (!dragRef.current) return;
    e.stopPropagation();
    dragRef.current = null;
    setDragging(false);
  };

  return (
    <div className="tj-screenshot-lightbox" onClick={onClose}>
      <button type="button" className="tj-screenshot-lightbox-close" onClick={onClose} aria-label="Close preview"><X size={18} /></button>
      {label && <span className="tj-screenshot-lightbox-label">{label}</span>}
      <img
        ref={imgRef}
        src={src}
        alt={`Screenshot ${index + 1}`}
        className="tj-screenshot-lightbox-img"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transition: dragging ? 'none' : 'transform 0.15s ease-out',
          cursor: zoom > 1 ? (dragging ? 'grabbing' : 'grab') : 'zoom-in'
        }}
        onClick={onImageClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        draggable={false}
      />
      {zoom > 1 && (
        <span className="tj-screenshot-lightbox-zoom">{Math.round(zoom * 100)}%</span>
      )}
    </div>
  );
}

function DayEditModal({
  log, onClose, onSave, onDelete, onManageScreenshots
}: {
  log: DailyLog;
  onClose: () => void;
  onSave: (log: DailyLog) => void;
  onDelete: () => void;
  onManageScreenshots: () => void;
}) {
  const [form, setForm] = useState<DailyLog>(log);
  const net = netOf(form);
  const status = statusOf(net);
  const setField = <K extends keyof DailyLog>(key: K, value: DailyLog[K]) => setForm(prev => ({ ...prev, [key]: value }));

  return (
    <Modal
      eyebrow="Life OS"
      title={`Edit Day — ${formatFullDate(log.date)}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn ghost tj-day-edit-delete" onClick={onDelete}>Delete day</button>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn teal" onClick={() => onSave(form)}>Save</button>
        </>
      }
    >
      <div className="form-grid">
        <label><span>Total Trades</span><NumberField value={form.totalTrades} onChange={n => setField('totalTrades', n)} min={0} /></label>
        <label><span>Daily P/L</span><NumberField value={form.dailyPL} onChange={n => setField('dailyPL', n)} decimals={2} /></label>
        <label><span>Daily Fees</span><NumberField value={form.dailyFees} onChange={n => setField('dailyFees', n)} /></label>
        <label>
          <span>Primary Emotion</span>
          <select value={form.emotion ?? ''} onChange={e => setField('emotion', e.target.value || undefined)}>
            <option value="">—</option>
            {EMOTIONS.map(e => <option key={e.value} value={e.value}>{e.emoji} {e.value}</option>)}
          </select>
        </label>
        <label className="field-full"><span>Notes</span><textarea value={form.notes ?? ''} onChange={e => setField('notes', e.target.value)} /></label>
      </div>
      <div className="tj-day-edit-summary">
        <span>Net P/L</span>
        <b className={net >= 0 ? 'tj-text-green' : 'tj-text-neg'}>{formatCurrency(net)}</b>
        <span className={`tj-status tj-status-${status.toLowerCase()}`}>{status}</span>
      </div>
      <button type="button" className="text-btn tj-day-edit-shots" onClick={onManageScreenshots}>
        <ImagePlus size={14} /> Manage screenshots ({(log.screenshots ?? []).length})
      </button>
    </Modal>
  );
}

function MonthlyCalendarView({
  logs, initialMonth, onClose, onSaveLog, onCreateLog, onDeleteLog,
  onAddScreenshots, onRemoveScreenshot, onReorderScreenshots, onRelabelScreenshot,
  presetLabels, onAddPreset, onRemovePreset
}: {
  logs: DailyLog[];
  initialMonth: Date;
  onClose: () => void;
  onSaveLog: (log: DailyLog) => void;
  onCreateLog: (date: string) => DailyLog;
  onDeleteLog: (id: string) => void;
  onAddScreenshots: (id: string, files: FileList) => void;
  onRemoveScreenshot: (id: string, index: number) => void;
  onReorderScreenshots: (id: string, from: number, to: number) => void;
  onRelabelScreenshot: (id: string, index: number, label: string) => void;
  presetLabels: string[];
  onAddPreset: (label: string) => void;
  onRemovePreset: (label: string) => void;
}) {
  const [anchor, setAnchor] = useState(() => new Date(initialMonth.getFullYear(), initialMonth.getMonth(), 1));
  const [editingLogId, setEditingLogId] = useState<string | null>(null);
  const [screenshotLogId, setScreenshotLogId] = useState<string | null>(null);
  const today = new Date();
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const isCurrentMonth = year === today.getFullYear() && month === today.getMonth();

  const logByDate = useMemo(() => {
    const map = new Map<string, DailyLog>();
    logs.forEach(l => map.set(l.date, l));
    return map;
  }, [logs]);

  const firstOfMonth = new Date(year, month, 1);
  const lastOfMonth = new Date(year, month + 1, 0);
  const gridStart = addDays(firstOfMonth, -firstOfMonth.getDay());
  const gridEnd = addDays(lastOfMonth, 6 - lastOfMonth.getDay());
  const totalCells = Math.round((gridEnd.getTime() - gridStart.getTime()) / 86400000) + 1;
  const cells: Date[] = [];
  for (let i = 0; i < totalCells; i++) cells.push(addDays(gridStart, i));
  const weeks: Date[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  const monthStartIso = toIsoDate(firstOfMonth);
  const monthEndIso = toIsoDate(lastOfMonth);
  const monthLogs = logs.filter(l => l.date >= monthStartIso && l.date <= monthEndIso);
  const monthNet = monthLogs.reduce((s, l) => s + netOf(l), 0);
  const monthDays = monthLogs.length;

  const editingLog = editingLogId ? logs.find(l => l.id === editingLogId) ?? null : null;
  const screenshotLog = screenshotLogId ? logs.find(l => l.id === screenshotLogId) ?? null : null;

  const handleDayClick = (iso: string, log: DailyLog | undefined) => {
    if (log) { setEditingLogId(log.id); return; }
    const created = onCreateLog(iso);
    setEditingLogId(created.id);
  };

  return (
    <div className="tj-cal-page">
      <div className="tj-cal-header">
        <div className="tj-cal-nav">
          <button type="button" className="icon-btn" onClick={() => setAnchor(new Date(year, month - 1, 1))} aria-label="Previous month"><ChevronLeft size={18} /></button>
          <h2>{anchor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</h2>
          <button type="button" className="icon-btn" onClick={() => setAnchor(new Date(year, month + 1, 1))} aria-label="Next month"><ChevronRight size={18} /></button>
          <button type="button" className="btn ghost tj-cal-today" disabled={isCurrentMonth} onClick={() => setAnchor(new Date())}>This month</button>
        </div>
        <div className="tj-cal-stats">
          <span className="tj-cal-stats-label">Monthly stats</span>
          <span className={`tj-cal-badge ${monthNet >= 0 ? 'pos' : 'neg'}`}>{formatCompact(monthNet)}</span>
          <span className="tj-cal-badge neutral">{monthDays} day{monthDays === 1 ? '' : 's'}</span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close calendar view"><X size={18} /></button>
        </div>
      </div>

      <div className="tj-cal-grid">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => <div className="tj-cal-weekday" key={d}>{d}</div>)}
        <div className="tj-cal-weekday tj-cal-weekday-summary" />
        {weeks.map((week, wi) => {
          const weekLogs = week
            .map(d => logByDate.get(toIsoDate(d)))
            .filter((l): l is DailyLog => Boolean(l));
          const weekNet = weekLogs.reduce((s, l) => s + netOf(l), 0);
          return (
            <Fragment key={wi}>
              {week.map(day => {
                const inMonth = day.getMonth() === month;
                const iso = toIsoDate(day);
                const log = logByDate.get(iso);
                const net = log ? netOf(log) : null;
                const cellClass = net === null ? '' : net > 0 ? 'tj-cal-cell-pos' : net < 0 ? 'tj-cal-cell-neg' : 'tj-cal-cell-flat';
                return (
                  <button
                    type="button"
                    key={iso}
                    className={`tj-cal-cell ${!inMonth ? 'tj-cal-cell-out' : ''} ${cellClass}`}
                    onClick={() => handleDayClick(iso, log)}
                  >
                    <div className="tj-cal-cell-top">
                      {log && <StickyNote size={12} />}
                      <span className="tj-cal-daynum">{day.getDate()}</span>
                    </div>
                    {log && (
                      <div className="tj-cal-cell-body">
                        <b>{formatCurrency(netOf(log))}</b>
                        <small>{log.totalTrades} trade{log.totalTrades === 1 ? '' : 's'}</small>
                        <small className="muted">{formatCurrency(log.totalTrades ? netOf(log) / log.totalTrades : 0)} avg/trade</small>
                      </div>
                    )}
                  </button>
                );
              })}
              <div className="tj-cal-week-card">
                <span className="tj-cal-week-label">Week {wi + 1}</span>
                <b className={weekNet >= 0 ? 'tj-text-green' : 'tj-text-neg'}>{formatCompact(weekNet)}</b>
                <span className="tj-cal-week-days">{weekLogs.length} day{weekLogs.length === 1 ? '' : 's'}</span>
              </div>
            </Fragment>
          );
        })}
      </div>
      {editingLog && (
        <DayEditModal
          log={editingLog}
          onClose={() => setEditingLogId(null)}
          onSave={updated => { onSaveLog(updated); setEditingLogId(null); }}
          onDelete={() => { onDeleteLog(editingLog.id); setEditingLogId(null); }}
          onManageScreenshots={() => setScreenshotLogId(editingLog.id)}
        />
      )}
      {screenshotLog && (
        <ScreenshotsModal
          log={screenshotLog}
          onClose={() => setScreenshotLogId(null)}
          onAdd={files => onAddScreenshots(screenshotLog.id, files)}
          onRemove={index => onRemoveScreenshot(screenshotLog.id, index)}
          onReorder={(from, to) => onReorderScreenshots(screenshotLog.id, from, to)}
          onRelabel={(index, label) => onRelabelScreenshot(screenshotLog.id, index, label)}
          presetLabels={presetLabels}
          onAddPreset={onAddPreset}
          onRemovePreset={onRemovePreset}
        />
      )}
    </div>
  );
}

function ChartCard({
  title, children, wide, action
}: { title: string; children: ReactNode; wide?: boolean; action?: ReactNode }) {
  return (
    <div className={`tj-card ${wide ? 'tj-card-wide' : ''}`}>
      <div className="tj-card-header"><h3>{title}</h3>{action}</div>
      {children}
    </div>
  );
}

// Four cards stacked at full height cost ~1,034px of scroll before the last one is even
// visible. Swiping trades that depth for width — one card's height, plus a dot row — which the
// desktop grid doesn't need since it has the width to spare already.
function ChartCarousel({ slides }: { slides: { key: string; node: ReactNode; wide?: boolean }[] }) {
  const [active, setActive] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);

  // Slides aren't a uniform width — landscape pairs the two narrow charts side by side while
  // the two `wide` ones keep the full row, so "index * one slide's width" can't locate a slide
  // (that math assumes every step is the same size, which is only true in portrait). Finding
  // whichever slide's own left edge is closest to the track's left edge works unchanged
  // regardless of how many slides fit per view or how wide each one is.
  const onScroll = () => {
    const el = trackRef.current;
    if (!el) return;
    const items = el.querySelectorAll<HTMLElement>('.tj-carousel-slide');
    const trackLeft = el.getBoundingClientRect().left;
    let closestIdx = 0;
    let closestDist = Infinity;
    items.forEach((item, i) => {
      const dist = Math.abs(item.getBoundingClientRect().left - trackLeft);
      if (dist < closestDist) { closestDist = dist; closestIdx = i; }
    });
    setActive(closestIdx);
  };
  const scrollToSlide = (i: number) => {
    const el = trackRef.current;
    const target = el?.querySelectorAll<HTMLElement>('.tj-carousel-slide')[i];
    if (!el || !target) return;
    el.scrollTo({ left: target.offsetLeft, behavior: 'smooth' });
  };

  return (
    <div className="tj-carousel">
      <div className="tj-carousel-track" ref={trackRef} onScroll={onScroll}>
        {slides.map(s => <div className={`tj-carousel-slide ${s.wide ? 'wide' : ''}`} key={s.key}>{s.node}</div>)}
      </div>
      {slides.length > 1 && (
        <div className="tj-carousel-dots" role="tablist" aria-label="Charts">
          {slides.map((s, i) => (
            <button
              type="button"
              key={s.key}
              className={`tj-carousel-dot ${i === active ? 'on' : ''}`}
              onClick={() => scrollToSlide(i)}
              role="tab"
              aria-selected={i === active}
              aria-label={s.key}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function TradingJournal() {
  const { data, upsert, remove, updateSettings } = useStore();
  const logs = data.dailyLogs;
  const isMobile = useIsMobile();
  const [editingLogId, setEditingLogId] = useState<string | null>(null);
  const startBalance = data.settings.tradingStartBalance ?? 50000;
  const setStartBalance = (n: number) => void updateSettings({ tradingStartBalance: n });
  const presetLabels = data.settings.tradingPresetLabels ?? [];
  const setPresetLabels = (next: string[]) => void updateSettings({ tradingPresetLabels: next });
  const [period, setPeriod] = useState<Period>('Total');
  const [anchorDate, setAnchorDate] = useState(() => new Date());

  const range = useMemo(() => periodRangeFor(period, anchorDate), [period, anchorDate]);
  const filteredLogs = useMemo(
    () => (range ? logs.filter(l => l.date >= range.start && l.date <= range.end) : logs),
    [logs, range]
  );
  const sortedDesc = useMemo(() => filteredLogs.slice().sort((a, b) => b.date.localeCompare(a.date)), [filteredLogs]);

  const LOG_PAGE_SIZE = 50;
  const [logPage, setLogPage] = useState(1);
  const totalLogPages = Math.max(1, Math.ceil(sortedDesc.length / LOG_PAGE_SIZE));
  useEffect(() => { setLogPage(1); }, [period, anchorDate]);
  useEffect(() => { setLogPage(p => Math.min(p, totalLogPages)); }, [totalLogPages]);
  const pagedLogs = useMemo(
    () => sortedDesc.slice((logPage - 1) * LOG_PAGE_SIZE, logPage * LOG_PAGE_SIZE),
    [sortedDesc, logPage]
  );

  // Current balance is always the real, all-time balance regardless of the period filter.
  const allTimeNet = logs.reduce((s, l) => s + netOf(l), 0);
  const currentBalance = startBalance + allTimeNet;

  // Everything else below reflects only the selected period.
  const totalTradesSum = filteredLogs.reduce((s, l) => s + (l.totalTrades || 0), 0);
  const totalPL = filteredLogs.reduce((s, l) => s + l.dailyPL, 0);
  const totalFees = filteredLogs.reduce((s, l) => s + l.dailyFees, 0);
  // Display-only: $0.65/trade commission estimate. Not folded into Net Total or any other stat.
  const totalFeesDisplay = totalTradesSum * 0.65;
  const netTotal = totalPL - totalFees;
  const daysLogged = filteredLogs.length;
  const greenDays = filteredLogs.filter(l => netOf(l) > 0);
  const redDays = filteredLogs.filter(l => netOf(l) < 0);
  const flatDays = filteredLogs.filter(l => netOf(l) === 0);
  const winRate = daysLogged ? (greenDays.length / daysLogged) * 100 : 0;
  const avgPLPerDay = daysLogged ? netTotal / daysLogged : 0;
  const avgTradesPerDay = daysLogged ? totalTradesSum / daysLogged : 0;
  const bestDay = filteredLogs.length ? Math.max(...filteredLogs.map(netOf)) : 0;
  const worstDay = filteredLogs.length ? Math.min(...filteredLogs.map(netOf)) : 0;
  const avgGreenDay = greenDays.length ? greenDays.reduce((s, l) => s + netOf(l), 0) / greenDays.length : 0;
  const avgRedDay = redDays.length ? redDays.reduce((s, l) => s + netOf(l), 0) / redDays.length : 0;

  // Equity curve: real cumulative balance across ALL history, sliced to the selected period's window,
  // so a Week/Month/Year view shows the actual balance trajectory (not a curve reset to zero).
  const equityCurve = useMemo(() => {
    const ascAll = logs.slice().sort((a, b) => a.date.localeCompare(b.date));
    let running = startBalance;
    const full = ascAll.map(l => {
      running += netOf(l);
      return { label: l.date, value: running };
    });
    if (!range) return full;
    return full.filter(p => p.label >= range.start && p.label <= range.end);
  }, [logs, startBalance, range]);

  const emotionCounts = useMemo(
    () => EMOTIONS.map((e, i) => ({ label: e.value, value: filteredLogs.filter(l => l.emotion === e.value).length, cls: CAT_CLASSES[i % CAT_CLASSES.length] })),
    [filteredLogs]
  );
  const emotionPerf = useMemo(
    () => EMOTIONS.map(e => ({ label: e.value, value: filteredLogs.filter(l => l.emotion === e.value).reduce((s, l) => s + netOf(l), 0) })),
    [filteredLogs]
  );

  const removeLog = (id: string) => void remove('dailyLogs', id);
  const addLog = () => void upsert('dailyLogs', newRecord<DailyLog>(blankLog()));
  useFabAction('Trading Journal', 'Add day', addLog);
  const createLogForDate = (date: string): DailyLog => {
    const created = newRecord<DailyLog>({ ...blankLog(), date });
    void upsert('dailyLogs', created);
    return created;
  };
  const patch = (id: string, p: Partial<DailyLog>) => {
    const l = logs.find(x => x.id === id);
    if (!l) return;
    void upsert('dailyLogs', { ...l, ...p });
  };

  const shiftPeriod = (delta: number) => {
    setAnchorDate(prev => {
      const d = new Date(prev);
      if (period === 'Week') d.setDate(d.getDate() + delta * 7);
      else if (period === 'Month') d.setMonth(d.getMonth() + delta);
      else if (period === 'Year') d.setFullYear(d.getFullYear() + delta);
      return d;
    });
  };

  const returnToCurrentPeriod = () => setAnchorDate(new Date());
  const [equityView, setEquityView] = useState<'chart' | 'table'>('chart');
  const [screenshotLogId, setScreenshotLogId] = useState<string | null>(null);
  const [showCalendar, setShowCalendar] = useState(false);
  const screenshotLog = screenshotLogId ? logs.find(l => l.id === screenshotLogId) ?? null : null;
  const editingLog = editingLogId ? logs.find(l => l.id === editingLogId) ?? null : null;

  const addScreenshots = async (id: string, files: FileList) => {
    const encoded: TradingScreenshot[] = await Promise.all(Array.from(files).map(async f => ({ src: await fileToCompressedDataUrl(f) })));
    const l = logs.find(x => x.id === id);
    if (!l) return;
    void upsert('dailyLogs', { ...l, screenshots: [...(l.screenshots ?? []), ...encoded] });
  };
  const removeScreenshot = (id: string, index: number) => {
    const l = logs.find(x => x.id === id);
    if (!l) return;
    void upsert('dailyLogs', { ...l, screenshots: (l.screenshots ?? []).filter((_, i) => i !== index) });
  };
  const relabelScreenshot = (id: string, index: number, label: string) => {
    const l = logs.find(x => x.id === id);
    if (!l) return;
    const shots = [...(l.screenshots ?? [])];
    shots[index] = { ...shots[index], label };
    void upsert('dailyLogs', { ...l, screenshots: shots });
  };
  const reorderScreenshots = (id: string, from: number, to: number) => {
    const l = logs.find(x => x.id === id);
    if (!l) return;
    const shots = [...(l.screenshots ?? [])];
    const [moved] = shots.splice(from, 1);
    shots.splice(to, 0, moved);
    void upsert('dailyLogs', { ...l, screenshots: shots });
  };

  const addPresetLabel = (label: string) => {
    const next = presetLabels.some(p => p.toLowerCase() === label.toLowerCase())
      ? presetLabels
      : [...presetLabels, label].sort((a, b) => a.localeCompare(b));
    setPresetLabels(next);
  };
  const removePresetLabel = (label: string) => {
    setPresetLabels(presetLabels.filter(p => p !== label));
  };

  if (showCalendar) {
    return (
      <MonthlyCalendarView
        logs={logs}
        initialMonth={anchorDate}
        onClose={() => setShowCalendar(false)}
        onSaveLog={l => void upsert('dailyLogs', l)}
        onCreateLog={createLogForDate}
        onDeleteLog={removeLog}
        onAddScreenshots={(id, files) => void addScreenshots(id, files)}
        onRemoveScreenshot={removeScreenshot}
        onReorderScreenshots={reorderScreenshots}
        onRelabelScreenshot={relabelScreenshot}
        presetLabels={presetLabels}
        onAddPreset={addPresetLabel}
        onRemovePreset={removePresetLabel}
      />
    );
  }

  // Shared by the desktop rail and the mobile "Full breakdown" disclosure — same numbers, two
  // presentations, defined once.
  const statRows = (
    <>
      <div className="tj-stat-row"><span>Start Balance</span><input type="number" className="tj-inline-input" value={startBalance} onChange={e => setStartBalance(Number(e.target.value))} /></div>
      <div className="tj-stat-row"><span>Current Balance</span><b>{formatCurrency(currentBalance)}</b></div>
      <div className="tj-stat-row"><span>Total Trades</span><b>{totalTradesSum}</b></div>
      <div className="tj-stat-row"><span>Days Logged</span><b>{daysLogged}</b></div>
      <div className="tj-stat-row"><span>Green Days</span><b>{greenDays.length}</b></div>
      <div className="tj-stat-row"><span>Red Days</span><b>{redDays.length}</b></div>
      <div className="tj-stat-row"><span>Flat Days</span><b>{flatDays.length}</b></div>
      <div className="tj-stat-row"><span>Win Rate (days)</span><b>{fmt(winRate)}%</b></div>
      <div className="tj-stat-divider" />
      <div className="tj-stat-row"><span>Avg Green Day</span><b className="positive">{formatCurrency(avgGreenDay)}</b></div>
      <div className="tj-stat-row"><span>Avg Red Day</span><b className="negative">{formatCurrency(avgRedDay)}</b></div>
      <div className="tj-stat-row"><span>Best Day</span><b className="positive">{formatCurrency(bestDay)}</b></div>
      <div className="tj-stat-row"><span>Worst Day</span><b className="negative">{formatCurrency(worstDay)}</b></div>
      <div className="tj-stat-row"><span>Avg Trades / Day</span><b>{fmt(avgTradesPerDay, 1)}</b></div>
      <div className="tj-stat-divider" />
      <div className="tj-stat-row"><span>Total P/L</span><b className={totalPL >= 0 ? 'positive' : 'negative'}>{formatCurrency(totalPL)}</b></div>
      <div className="tj-stat-row"><span>Total Fees</span><b className="negative">{formatCurrency(totalFeesDisplay)}</b></div>
      <div className="tj-stat-row"><span>Net Total</span><b className={netTotal >= 0 ? 'positive' : 'negative'}>{formatCurrency(netTotal)}</b></div>
      <div className="tj-stat-row"><span>Avg P/L per Day</span><b className={avgPLPerDay >= 0 ? 'positive' : 'negative'}>{formatCurrency(avgPLPerDay)}</b></div>
    </>
  );

  return (
    <>
      <div className="habits-header">
        <div>
          <h1>Trade Summary</h1>
          <p>Daily aggregate view — built for high-frequency scalpers.</p>
        </div>
      </div>

      <div className="tj-period-row">
        <div className="filter-row">
          {PERIODS.map(p => (
            <button key={p} type="button" className={`chip ${period === p ? 'active' : ''}`} onClick={() => setPeriod(p)}>{p}</button>
          ))}
          <button type="button" className="icon-btn tj-cal-open" onClick={() => setShowCalendar(true)} aria-label="Open calendar view" title="Calendar view">
            <CalendarIcon size={16} />
          </button>
        </div>
        {period !== 'Total' && (
          <div className="tj-period-nav">
            {!isCurrentPeriod(period, anchorDate) && (
              <button
                type="button"
                className="icon-btn"
                onClick={returnToCurrentPeriod}
                aria-label={`Return to current ${period.toLowerCase()}`}
                title={`Return to current ${period.toLowerCase()}`}
              >
                <RotateCcw size={15} />
              </button>
            )}
            <button type="button" className="icon-btn" onClick={() => shiftPeriod(-1)} aria-label={`Previous ${period.toLowerCase()}`}><ChevronLeft size={16} /></button>
            <DatePicker
              value={toIsoDate(anchorDate)}
              onChange={v => setAnchorDate(new Date(`${v}T12:00:00`))}
              displayLabel={formatPeriodLabel(period, anchorDate)}
            />
            <button type="button" className="icon-btn" onClick={() => shiftPeriod(1)} aria-label={`Next ${period.toLowerCase()}`}><ChevronRight size={16} /></button>
          </div>
        )}
      </div>

      <div className="tj-layout">
        <div className="tj-stats-panel">
          {/* On a phone these 18 rows fill the whole first screen at equal visual weight, so
              nothing reads first and the equity curve never gets seen. Three metrics answer
              "how am I doing"; the rest stay one tap away. */}
          {isMobile && (
            <>
              <div className="tj-hero-tiles">
                <div className="tj-hero-tile">
                  <span>Net Total</span>
                  <b className={netTotal >= 0 ? 'positive' : 'negative'}>{formatCurrency(netTotal)}</b>
                </div>
                <div className="tj-hero-tile">
                  <span>Win Rate</span>
                  <b>{fmt(winRate)}%</b>
                </div>
                <div className="tj-hero-tile">
                  <span>Days Logged</span>
                  <b>{daysLogged}</b>
                </div>
              </div>
              <details className="tj-breakdown">
                <summary>Full breakdown <ChevronDown size={14} /></summary>
                <div className="tj-breakdown-body">
                  {statRows}
                </div>
              </details>
            </>
          )}
          {!isMobile && statRows}
        </div>

        {isMobile ? (
          <ChartCarousel
            slides={[
              {
                key: 'Account Growth',
                wide: true,
                node: (
                  <ChartCard
                    title="Account Growth (Cumulative)"
                    wide
                    action={
                      <button type="button" className="text-btn tj-table-toggle" onClick={() => setEquityView(v => (v === 'chart' ? 'table' : 'chart'))}>
                        <Table2 size={13} /> {equityView === 'chart' ? 'Table View' : 'Chart View'}
                      </button>
                    }
                  >
                    <div className={`tj-headline ${netTotal >= 0 ? 'positive' : 'negative'}`}>{netTotal >= 0 ? '▲' : '▼'} {formatCurrency(Math.abs(netTotal))}</div>
                    {equityView === 'chart' ? <LineChart points={equityCurve} period={period} /> : <EquityTable points={equityCurve} />}
                  </ChartCard>
                )
              },
              {
                key: 'Green vs Red Days',
                node: (
                  <ChartCard title="Green vs Red Days">
                    <GreenRedDaysPanel green={greenDays.length} red={redDays.length} flat={flatDays.length} />
                  </ChartCard>
                )
              },
              {
                key: 'Daily P/L Stats',
                node: (
                  <ChartCard title="Daily P/L Stats">
                    <StatTiles tiles={[
                      { label: 'Avg Green', value: avgGreenDay },
                      { label: 'Avg Red', value: avgRedDay },
                      { label: 'Best Day', value: bestDay },
                      { label: 'Worst Day', value: worstDay }
                    ]} />
                  </ChartCard>
                )
              },
              {
                key: 'Emotions',
                wide: true,
                node: (
                  <ChartCard title="Emotions" wide>
                    <div className="tj-split">
                      <CatBars data={emotionCounts} />
                      <VBars data={emotionPerf} />
                    </div>
                  </ChartCard>
                )
              }
            ]}
          />
        ) : (
        <div className="tj-charts-grid tj-charts-grid-simple">
          <ChartCard
            title="Account Growth (Cumulative)"
            wide
            action={
              <button type="button" className="text-btn tj-table-toggle" onClick={() => setEquityView(v => (v === 'chart' ? 'table' : 'chart'))}>
                <Table2 size={13} /> {equityView === 'chart' ? 'Table View' : 'Chart View'}
              </button>
            }
          >
            <div className={`tj-headline ${netTotal >= 0 ? 'positive' : 'negative'}`}>{netTotal >= 0 ? '▲' : '▼'} {formatCurrency(Math.abs(netTotal))}</div>
            {equityView === 'chart' ? <LineChart points={equityCurve} period={period} /> : <EquityTable points={equityCurve} />}
          </ChartCard>

          <ChartCard title="Green vs Red Days">
            <GreenRedDaysPanel green={greenDays.length} red={redDays.length} flat={flatDays.length} />
          </ChartCard>

          <ChartCard title="Daily P/L Stats">
            <StatTiles tiles={[
              { label: 'Avg Green', value: avgGreenDay },
              { label: 'Avg Red', value: avgRedDay },
              { label: 'Best Day', value: bestDay },
              { label: 'Worst Day', value: worstDay }
            ]} />
          </ChartCard>

          <ChartCard title="Emotions" wide>
            <div className="tj-split">
              <CatBars data={emotionCounts} />
              <VBars data={emotionPerf} />
            </div>
          </ChartCard>
        </div>
        )}
      </div>

      {isMobile ? (
        <div className="tj-mobile-log">
          <MobileRecordList
            items={pagedLogs}
            primary={l => formatFullDate(l.date)}
            secondary={l => `${l.totalTrades} trade${l.totalTrades === 1 ? '' : 's'}${l.emotion ? ` · ${l.emotion}` : ''}`}
            trailing={l => formatCurrency(netOf(l))}
            trailingTone={l => (netOf(l) >= 0 ? 'positive' : 'negative')}
            fields={[
              { label: 'Status', value: l => statusOf(netOf(l)) },
              { label: 'Screenshots', value: l => l.screenshots?.length || '—' }
            ]}
            onOpen={l => setEditingLogId(l.id)}
            onDelete={l => removeLog(l.id)}
            deleteLabel={l => `Delete ${formatFullDate(l.date)}`}
            empty="No days logged in this period."
          />
        </div>
      ) : (
      <div className="tj-table-wrap tj-table-scroll">
        <table className="tj-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Trades</th>
              <th>Daily P/L</th>
              <th>Notes</th>
              <th>Net P/L<br /><small>Computed</small></th>
              <th>Status<br /><small>Computed</small></th>
              <th>Primary Emotion</th>
              <th>Screenshots</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {pagedLogs.map(l => {
              const net = netOf(l);
              const status = statusOf(net);
              const shotCount = l.screenshots?.length ?? 0;
              return (
                <tr key={l.id}>
                  <td><DatePicker value={l.date} onChange={v => patch(l.id, { date: v })} /></td>
                  <td className="tj-td-compact"><NumberField className="tj-cell-input tj-num tj-num-trades" value={l.totalTrades} onChange={n => patch(l.id, { totalTrades: n })} min={0} /></td>
                  <td className="tj-td-compact"><NumberField className="tj-cell-input tj-num tj-num-pl" value={l.dailyPL} onChange={n => patch(l.id, { dailyPL: n })} decimals={2} /></td>
                  <td>
                    <NotesField value={l.notes ?? ''} onChange={v => patch(l.id, { notes: v })} />
                  </td>
                  <td className={`tj-computed-cell ${net >= 0 ? 'tj-text-pos' : 'tj-text-neg'}`}>{formatCurrency(net)}</td>
                  <td><span className={`tj-status tj-status-${status.toLowerCase()}`}>{status}</span></td>
                  <td>
                    <select className="tj-cell-select" value={l.emotion ?? ''} onChange={e => patch(l.id, { emotion: e.target.value || undefined })}>
                      <option value="">—</option>
                      {EMOTIONS.map(e => <option key={e.value} value={e.value}>{e.emoji} {e.value}</option>)}
                    </select>
                  </td>
                  <td>
                    <button type="button" className={`tj-screenshot-cell-btn ${shotCount ? 'has-shots' : ''}`} onClick={() => setScreenshotLogId(l.id)}>
                      <ImagePlus size={14} /> {shotCount || ''}
                    </button>
                  </td>
                  <td><button type="button" className="icon-btn danger" onClick={() => removeLog(l.id)} aria-label="Delete day"><Trash2 size={14} /></button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!sortedDesc.length && <p className="muted tj-empty">No days logged in this period.</p>}
      </div>
      )}
      {sortedDesc.length > LOG_PAGE_SIZE && (
        <div className="tj-log-pager">
          <button type="button" className="icon-btn" onClick={() => setLogPage(p => Math.max(1, p - 1))} disabled={logPage === 1} aria-label="Previous page">
            <ChevronLeft size={16} />
          </button>
          <span className="tj-log-pager-label">Page {logPage} of {totalLogPages}</span>
          <button type="button" className="icon-btn" onClick={() => setLogPage(p => Math.min(totalLogPages, p + 1))} disabled={logPage === totalLogPages} aria-label="Next page">
            <ChevronRight size={16} />
          </button>
        </div>
      )}
      <button type="button" className="btn teal tj-add-row" onClick={addLog}><Plus size={16} /> Add day</button>
      {/* On mobile the 9-column grid is replaced by cards, so this modal is where the day's
          full field set gets edited — the same one the calendar view already uses. */}
      {editingLog && (
        <DayEditModal
          log={editingLog}
          onClose={() => setEditingLogId(null)}
          onSave={updated => { void upsert('dailyLogs', updated); setEditingLogId(null); }}
          onDelete={() => { removeLog(editingLog.id); setEditingLogId(null); }}
          onManageScreenshots={() => { setScreenshotLogId(editingLog.id); setEditingLogId(null); }}
        />
      )}
      {screenshotLog && (
        <ScreenshotsModal
          log={screenshotLog}
          onClose={() => setScreenshotLogId(null)}
          onAdd={files => void addScreenshots(screenshotLog.id, files)}
          onRemove={index => removeScreenshot(screenshotLog.id, index)}
          onReorder={(from, to) => reorderScreenshots(screenshotLog.id, from, to)}
          onRelabel={(index, label) => relabelScreenshot(screenshotLog.id, index, label)}
          presetLabels={presetLabels}
          onAddPreset={addPresetLabel}
          onRemovePreset={removePresetLabel}
        />
      )}
    </>
  );
}
