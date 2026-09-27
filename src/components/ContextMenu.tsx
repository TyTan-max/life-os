import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useIsMobile } from '../hooks/useIsMobile';

// Right-click menus for desktop. A page calls `useContextMenu()`, spreads
// `onContextMenu={e => openMenu(e, items)}` onto whatever should have one, and renders `menu`.
// On a phone this is a no-op (long-press keeps the browser's own behaviour) — every action here
// already has a visible button, so the menu is a shortcut, never the only way to do something.

export type ContextMenuItem =
  | { label: string; icon?: LucideIcon; onSelect: () => void; danger?: boolean; checked?: boolean; hint?: string; disabled?: boolean }
  | { heading: string }
  | 'separator';

interface OpenState { x: number; y: number; items: ContextMenuItem[] }

function isAction(item: ContextMenuItem): item is Extract<ContextMenuItem, { onSelect: () => void }> {
  return typeof item === 'object' && 'onSelect' in item;
}

export function useContextMenu() {
  const isMobile = useIsMobile();
  const [state, setState] = useState<OpenState | null>(null);
  const close = useCallback(() => setState(null), []);
  const openMenu = useCallback((e: React.MouseEvent, items: ContextMenuItem[]) => {
    if (isMobile || !items.length) return;
    e.preventDefault();
    e.stopPropagation();
    setState({ x: e.clientX, y: e.clientY, items });
  }, [isMobile]);
  const menu = state ? <ContextMenuPopup {...state} onClose={close} /> : null;
  return { menu, openMenu, closeMenu: close };
}

function ContextMenuPopup({ x, y, items, onClose }: OpenState & { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const actionIdx = items.map((it, i) => (isAction(it) && !it.disabled ? i : -1)).filter(i => i >= 0);
  const [active, setActive] = useState(-1);

  // Keep the menu on screen: flip left/up when it would overflow the viewport edge.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 8;
    setPos({
      left: x + width + pad > window.innerWidth ? Math.max(pad, x - width) : x,
      top: y + height + pad > window.innerHeight ? Math.max(pad, y - height) : y
    });
    el.focus();
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        setActive(cur => {
          const at = actionIdx.indexOf(cur);
          const next = e.key === 'ArrowDown' ? (at + 1) % actionIdx.length : (at <= 0 ? actionIdx.length - 1 : at - 1);
          return actionIdx[next] ?? -1;
        });
      }
      if (e.key === 'Enter' && active >= 0) {
        e.preventDefault(); e.stopPropagation();
        const it = items[active];
        if (isAction(it)) { onClose(); it.onSelect(); }
      }
    };
    const onBlurish = () => onClose();
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onBlurish);
    window.addEventListener('scroll', onBlurish, true);
    window.addEventListener('blur', onBlurish);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onBlurish);
      window.removeEventListener('scroll', onBlurish, true);
      window.removeEventListener('blur', onBlurish);
    };
  }, [onClose, items, active, actionIdx]);

  return createPortal(
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={e => e.preventDefault()}
    >
      {items.map((it, i) => {
        if (it === 'separator') return <div key={i} className="ctx-sep" role="separator" />;
        if ('heading' in it) return <div key={i} className="ctx-heading">{it.heading}</div>;
        const Icon = it.icon;
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            className={`ctx-item ${it.danger ? 'danger' : ''} ${active === i ? 'active' : ''}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => { onClose(); it.onSelect(); }}
          >
            <span className="ctx-icon">{it.checked ? <Check size={14} /> : Icon ? <Icon size={14} /> : null}</span>
            <span className="ctx-label">{it.label}</span>
            {it.hint && <kbd>{it.hint}</kbd>}
          </button>
        );
      })}
    </div>,
    document.body
  );
}
