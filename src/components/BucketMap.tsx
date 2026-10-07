import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Maximize2, MapPin, Minus, Plus, X } from 'lucide-react';
import type { BucketListItem } from '../types';
import { LAND_PATH, MAP_H, MAP_W, project, unproject } from '../lib/worldMap';

export interface MapEntry {
  item: BucketListItem;
  lon: number;
  lat: number;
  /** Placed by hand (a dropped pin) rather than recognised from the goal's location. */
  manual: boolean;
}

const ZOOMS = [1, 1.8, 3, 5];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * The bucket-list world map: a pin per goal, coloured by status. Tap a pin to open the goal, drag
 * it to move it, zoom and pan to pull apart a crowded region. A goal the app couldn't place can
 * be dropped on by hand ("Place on map", then click where it belongs).
 */
export function BucketMap({
  entries, unplaced, stat, onOpen, onPlace, onClearPin
}: {
  entries: MapEntry[];
  unplaced: BucketListItem[];
  stat?: string;
  onOpen: (id: string) => void;
  onPlace: (id: string, lon: number, lat: number) => void;
  onClearPin: (id: string) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [zoomIndex, setZoomIndex] = useState(0);
  const [center, setCenter] = useState<[number, number]>([MAP_W / 2, MAP_H / 2]);
  const [placingId, setPlacingId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  // A pin being dragged: where it currently is, in map units.
  const [dragPin, setDragPin] = useState<{ id: string; x: number; y: number; sx: number; sy: number; moved: boolean } | null>(null);
  const gesture = useRef<{ x: number; y: number; center: [number, number]; moved: boolean } | null>(null);

  // On a narrow screen the whole map is drawn small, so pins and labels are scaled back up to stay
  // a readable, tappable size.
  const [fit, setFit] = useState(1);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => setFit(clamp(MAP_W / (svg.getBoundingClientRect().width || MAP_W), 1, 3.2));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  const zoom = ZOOMS[zoomIndex];
  const vw = MAP_W / zoom;
  const vh = MAP_H / zoom;
  const x0 = clamp(center[0] - vw / 2, 0, MAP_W - vw);
  const y0 = clamp(center[1] - vh / 2, 0, MAP_H - vh);

  const toMap = (e: { clientX: number; clientY: number }): [number, number] => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return [clamp(p.x, 0, MAP_W), clamp(p.y, 0, MAP_H)];
  };

  // Pins that land on the same spot (two goals in one country) are fanned out in a small ring.
  const pins = useMemo(() => {
    const groups = new Map<string, MapEntry[]>();
    const cell = (9 * fit) / zoom;
    for (const entry of entries) {
      const [x, y] = project(entry.lon, entry.lat);
      const key = `${Math.round(x / cell)}:${Math.round(y / cell)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(entry);
    }
    const out: { entry: MapEntry; x: number; y: number }[] = [];
    for (const group of groups.values()) {
      group.forEach((entry, i) => {
        const [x, y] = project(entry.lon, entry.lat);
        if (group.length === 1) { out.push({ entry, x, y }); return; }
        const angle = (i / group.length) * Math.PI * 2 - Math.PI / 2;
        const radius = ((8 + group.length) * fit) / zoom;
        out.push({ entry, x: x + Math.cos(angle) * radius, y: y + Math.sin(angle) * radius });
      });
    }
    return out;
  }, [entries, zoom, fit]);
  const showAllLabels = zoom >= 3 || pins.length <= 6;

  const onMapDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    gesture.current = { x: e.clientX, y: e.clientY, center: [x0 + vw / 2, y0 + vh / 2], moved: false };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* fine without it */ }
  };
  const onMapMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (dragPin) {
      const [x, y] = toMap(e);
      setDragPin({ ...dragPin, x, y, moved: dragPin.moved || Math.hypot(x - dragPin.sx, y - dragPin.sy) > 5 / zoom });
      return;
    }
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (Math.abs(dx) + Math.abs(dy) > 5) g.moved = true;
    if (!g.moved || zoom === 1 || placingId) return;
    const scale = vw / (svgRef.current?.getBoundingClientRect().width || MAP_W);
    setCenter([g.center[0] - dx * scale, g.center[1] - dy * scale]);
  };
  const onMapUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (dragPin) {
      if (dragPin.moved) { const [lon, lat] = unproject(dragPin.x, dragPin.y); onPlace(dragPin.id, lon, lat); }
      else onOpen(dragPin.id);
      setDragPin(null);
      gesture.current = null;
      return;
    }
    const g = gesture.current;
    gesture.current = null;
    if (g && !g.moved && placingId) {
      const [x, y] = toMap(e);
      const [lon, lat] = unproject(x, y);
      onPlace(placingId, lon, lat);
      setPlacingId(null);
    }
  };

  const setZoom = (index: number) => {
    setZoomIndex(clamp(index, 0, ZOOMS.length - 1));
    setCenter([x0 + vw / 2, y0 + vh / 2]);
  };
  const placing = placingId ? unplaced.find(i => i.id === placingId) ?? entries.find(e => e.item.id === placingId)?.item : undefined;

  return (
    <div className="bucket-map-wrap">
      {placing && (
        <div className="bucket-map-placing">
          <MapPin size={15} />
          <span>Click the map where <b>{placing.title}</b> belongs.</span>
          <button type="button" className="text-btn" onClick={() => setPlacingId(null)}>Cancel</button>
        </div>
      )}
      <div className={`bucket-map ${placingId ? 'placing' : ''} ${zoom > 1 ? 'zoomed' : ''}`}>
        <svg
          ref={svgRef} viewBox={`${x0} ${y0} ${vw} ${vh}`} role="img" aria-label="World map of your goals"
          onPointerDown={onMapDown} onPointerMove={onMapMove} onPointerUp={onMapUp} onPointerCancel={() => { gesture.current = null; setDragPin(null); }}
        >
          <rect x="0" y="0" width={MAP_W} height={MAP_H} className="bucket-map-sea" />
          <path d={LAND_PATH} className="bucket-map-land" style={{ strokeWidth: 0.6 / zoom }} />
          {/* Places you've been: a soft gold patch around each achieved goal. */}
          {pins.filter(p => p.entry.item.status === 'Achieved').map(({ entry, x, y }) => (
            <circle key={`v-${entry.item.id}`} cx={x} cy={y} r={20} className="bucket-map-visited" />
          ))}
          {pins.map(({ entry, x, y }) => {
            const id = entry.item.id;
            const dragging = dragPin?.id === id;
            const px = dragging ? dragPin.x : x;
            const py = dragging ? dragPin.y : y;
            const labelled = showAllLabels || hoverId === id || dragging;
            return (
              <g
                key={id}
                className={`bucket-map-pin status-${entry.item.status.toLowerCase()} ${dragging ? 'dragging' : ''}`}
                transform={`translate(${px} ${py}) scale(${fit / zoom})`}
                role="button" tabIndex={0}
                onPointerDown={e => { e.stopPropagation(); if (placingId) return; setDragPin({ id, x, y, sx: x, sy: y, moved: false }); try { svgRef.current?.setPointerCapture(e.pointerId); } catch { /* fine */ } }}
                onPointerEnter={() => setHoverId(id)} onPointerLeave={() => setHoverId(h => (h === id ? null : h))}
                onFocus={() => setHoverId(id)} onBlur={() => setHoverId(h => (h === id ? null : h))}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(id); } }}
              >
                <title>{`${entry.item.title}${entry.item.location ? ` — ${entry.item.location}` : ''} (${entry.item.status})`}</title>
                <circle r="11" className="bucket-map-halo" />
                <circle r="5.5" />
                {labelled && (
                  <text x="9" y="4" className="bucket-map-label">{entry.item.title.length > 26 ? `${entry.item.title.slice(0, 25)}…` : entry.item.title}</text>
                )}
              </g>
            );
          })}
        </svg>
        <div className="bucket-map-zoom">
          <button type="button" onClick={() => setZoom(zoomIndex + 1)} disabled={zoomIndex === ZOOMS.length - 1} aria-label="Zoom in" title="Zoom in"><Plus size={15} /></button>
          <button type="button" onClick={() => setZoom(zoomIndex - 1)} disabled={zoomIndex === 0} aria-label="Zoom out" title="Zoom out"><Minus size={15} /></button>
          <button type="button" onClick={() => { setZoomIndex(0); setCenter([MAP_W / 2, MAP_H / 2]); }} disabled={zoomIndex === 0} aria-label="Whole world" title="Whole world"><Maximize2 size={13} /></button>
        </div>
        <div className="bucket-map-legend">
          <span className="status-achieved"><i /> Achieved</span>
          <span className="status-planning"><i /> Planning</span>
          <span className="status-someday"><i /> Someday</span>
          {stat && <b>{stat}</b>}
        </div>
      </div>

      {entries.length > 0 && (
        <div className="bucket-map-list">
          {entries.map(({ item, manual }) => (
            <span className="bucket-map-chip" key={item.id}>
              <button type="button" onClick={() => onOpen(item.id)}>
                <i className={`status-${item.status.toLowerCase()}`} /> <b>{item.title}</b> {item.location && <small>{item.location}</small>}
              </button>
              {manual && (
                <button type="button" className="bucket-map-unpin" onClick={() => onClearPin(item.id)} aria-label={`Remove the pin for ${item.title}`} title="Remove this pin"><X size={12} /></button>
              )}
            </span>
          ))}
        </div>
      )}
      {unplaced.length > 0 && (
        <div className="bucket-map-unplaced">
          <span className="muted">Not on the map yet — place them by hand:</span>
          {unplaced.map(item => (
            <button type="button" key={item.id} className={`bucket-map-place ${placingId === item.id ? 'on' : ''}`} onClick={() => setPlacingId(placingId === item.id ? null : item.id)}>
              <MapPin size={12} /> {item.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
