import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Bold, Eraser, Heading2, Italic, Link2, List, ListOrdered, Quote, Strikethrough, Underline } from 'lucide-react';

const ALLOWED_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'A', 'BR', 'P', 'DIV', 'H2']);

// Strips anything that isn't a plain formatting tag (no styles/scripts/classes) — content
// here can come from pasted clipboard HTML, so it can't be trusted as-is even though this is
// a local-only app. Keeps `href` on <a> tags, restricted to http/https.
function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walk = (node: ParentNode) => {
    Array.from(node.childNodes).forEach(child => {
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      const el = child as HTMLElement;
      if (!ALLOWED_TAGS.has(el.tagName)) {
        const parent = el.parentNode;
        while (el.firstChild) parent?.insertBefore(el.firstChild, el);
        parent?.removeChild(el);
        return;
      }
      const href = el.tagName === 'A' ? el.getAttribute('href') : null;
      Array.from(el.attributes).forEach(attr => el.removeAttribute(attr.name));
      if (el.tagName === 'A' && href && /^https?:\/\//i.test(href)) {
        el.setAttribute('href', href);
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
      walk(el);
    });
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

export function isEmptyHtml(html: string): boolean {
  const text = html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
  return text.length === 0;
}

const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Plain-text paste (no text/html on the clipboard) still deserves paragraph breaks — a bare
// insertText of "\n" doesn't render as a line break in a contentEditable, so blank-line-
// separated blocks become <p> and single line breaks become <br>.
function plainTextToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(block => `<p>${escapeHtml(block).split('\n').map(l => l || '&nbsp;').join('<br>')}</p>`)
    .join('');
}

// Rewrites pasted HTML (from Google Docs, Word, browsers, etc.) down to our allowed tag set
// while preserving structure — paragraphs, nested bullet/numbered lists (indentation), and
// bold/italic/underline/strikethrough, whether they arrive as semantic tags (<b>, <em>) or as
// inline styles on <span>/<div> (the common case for Docs/Word paste).
function convertPastedHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('style, script, meta, link, img, table').forEach(n => n.remove());

  const isBold = (el: HTMLElement) => {
    const w = el.style.fontWeight;
    return el.tagName === 'B' || el.tagName === 'STRONG' || w === 'bold' || (w !== '' && Number(w) >= 600);
  };
  const isItalic = (el: HTMLElement) => el.tagName === 'I' || el.tagName === 'EM' || el.style.fontStyle === 'italic';
  const isUnderline = (el: HTMLElement) =>
    el.tagName === 'U' || /underline/.test(el.style.textDecorationLine || el.style.textDecoration || '');
  const isStrike = (el: HTMLElement) =>
    el.tagName === 'S' || el.tagName === 'STRIKE' || el.tagName === 'DEL' ||
    /line-through/.test(el.style.textDecorationLine || el.style.textDecoration || '');

  const walk = (node: ParentNode) => {
    Array.from(node.childNodes).forEach(child => {
      if (child.nodeType === Node.COMMENT_NODE) { child.remove(); return; }
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      let el = child as HTMLElement;
      walk(el);

      const tag = HEADING_TAGS.has(el.tagName) ? 'H2' : el.tagName === 'TR' ? 'DIV' : el.tagName;

      if (ALLOWED_TAGS.has(tag) && tag !== 'DIV') {
        if (el.tagName !== tag) {
          const renamed = doc.createElement(tag);
          while (el.firstChild) renamed.appendChild(el.firstChild);
          el.replaceWith(renamed);
          el = renamed;
        }
        const href = el.tagName === 'A' ? el.getAttribute('href') : null;
        Array.from(el.attributes).forEach(attr => el.removeAttribute(attr.name));
        if (el.tagName === 'A' && href && /^https?:\/\//i.test(href)) {
          el.setAttribute('href', href);
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer');
        }
        return;
      }

      const bold = isBold(el);
      const italic = isItalic(el);
      const underline = isUnderline(el);
      const strike = isStrike(el);
      const isBlock = tag === 'DIV' || tag === 'P';

      let replacement: Node = doc.createDocumentFragment();
      while (el.firstChild) (replacement as DocumentFragment).appendChild(el.firstChild);
      if (strike) replacement = wrap(doc, 'S', replacement);
      if (underline) replacement = wrap(doc, 'U', replacement);
      if (italic) replacement = wrap(doc, 'I', replacement);
      if (bold) replacement = wrap(doc, 'B', replacement);
      if (isBlock) replacement = wrap(doc, 'DIV', replacement);
      el.replaceWith(replacement);
    });
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

function wrap(doc: Document, tagName: string, inner: Node): Node {
  const w = doc.createElement(tagName);
  w.appendChild(inner);
  return w;
}

// A field that switched to this editor from a plain <textarea> (or migrated data written as
// bare text) won't have any markup at all — assigning that straight to innerHTML would collapse
// every newline into a single space, since HTML doesn't render bare "\n" as a line break.
function normalizeValue(value: string): string {
  return value.includes('<') ? value : plainTextToHtml(value);
}

export function RichTextEditor({ value, onChange, placeholder, toolbar = true, compact = false }: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  // Hides the formatting buttons for tight inline spots (e.g. a quick log line) that still need
  // to accept and preserve rich pasted content — just without the chrome to format it by hand.
  toolbar?: boolean;
  // Starts input-height instead of the default ~110px block, for a field that sits inline
  // alongside other compact controls rather than in its own form row.
  compact?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [empty, setEmpty] = useState(isEmptyHtml(value || ''));
  const [linkPopover, setLinkPopover] = useState<{ top: number; left: number } | null>(null);
  const [linkDraft, setLinkDraft] = useState('');
  // The button's onMouseDown already preventDefaults so clicking it doesn't blur the editor and
  // collapse the selection — but moving focus into the popover's own input field would, so the
  // exact selection range is captured here and re-applied right before the link is inserted.
  const savedRangeRef = useRef<Range | null>(null);
  const linkInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const normalized = normalizeValue(value || '');
    if (ref.current && ref.current.innerHTML !== normalized) {
      ref.current.innerHTML = normalized;
    }
    setEmpty(isEmptyHtml(normalized));
  }, [value]);

  const commit = () => {
    if (!ref.current) return;
    const html = sanitizeHtml(ref.current.innerHTML);
    onChange(html);
    setEmpty(isEmptyHtml(html));
  };

  const exec = (command: string, arg?: string) => {
    ref.current?.focus();
    document.execCommand(command, false, arg);
    commit();
  };

  // Native window.prompt() doesn't render in every host environment (some embed/kiosk contexts
  // suppress it outright), and even where it does it's an unstyled OS dialog that clashes with
  // the app's own dark theme — so this is a small in-app popover instead, matching how the rest
  // of the app avoids native confirm()/prompt() dialogs in favor of its own UI.
  const openLinkPopover = (e: ReactMouseEvent<HTMLButtonElement>) => {
    const sel = window.getSelection();
    savedRangeRef.current = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
    const rect = e.currentTarget.getBoundingClientRect();
    setLinkDraft('');
    setLinkPopover({ top: rect.bottom + 6, left: rect.left });
  };

  const closeLinkPopover = () => {
    setLinkPopover(null);
    setLinkDraft('');
    savedRangeRef.current = null;
  };

  const confirmLink = () => {
    const trimmed = linkDraft.trim();
    if (!trimmed) { closeLinkPopover(); return; }
    const safe = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    ref.current?.focus();
    const range = savedRangeRef.current;
    const sel = window.getSelection();
    if (range && sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
    // No text was selected (just a cursor position, or focus never reached the editor) — there's
    // nothing for createLink to wrap, so insert the URL itself as the link's visible text instead
    // of silently doing nothing.
    if (!range || range.collapsed) {
      document.execCommand('insertHTML', false, `<a href="${safe}">${escapeHtml(trimmed)}</a>`);
    } else {
      document.execCommand('createLink', false, safe);
    }
    commit();
    closeLinkPopover();
  };

  const linkPopoverRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!linkPopover) return;
    linkInputRef.current?.focus();
    const onMouseDown = (e: MouseEvent) => {
      if (linkPopoverRef.current?.contains(e.target as Node)) return;
      closeLinkPopover();
    };
    const onKeyDown = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') closeLinkPopover(); };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkPopover]);

  // The conventional trio (bold/italic/underline) — not relying on the browser's own
  // contentEditable defaults, which don't reliably fire the same way across browsers/OSes.
  const KEY_COMMANDS: Record<string, string> = { b: 'bold', i: 'italic', u: 'underline' };
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.shiftKey) {
      // Google Docs/Word convention. Prefer e.code (the physical key) since Shift turns e.key
      // into "*"/"&" on most layouts instead of leaving it "8"/"7" — but e.code isn't always
      // populated (e.g. synthetic/automated key events), so fall back to checking e.key too.
      const isEight = e.code === 'Digit8' || e.key === '8' || e.key === '*';
      const isSeven = e.code === 'Digit7' || e.key === '7' || e.key === '&';
      if (isEight) { e.preventDefault(); exec('insertUnorderedList'); }
      else if (isSeven) { e.preventDefault(); exec('insertOrderedList'); }
      return;
    }
    const command = KEY_COMMANDS[e.key.toLowerCase()];
    if (!command) return;
    e.preventDefault();
    exec(command);
  };

  return (
    <div className={`rte ${compact ? 'rte-compact' : ''}`}>
      {toolbar && (
        <div className="rte-toolbar">
          <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => exec('bold')} title="Bold" aria-label="Bold"><Bold size={14} /></button>
          <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => exec('italic')} title="Italic" aria-label="Italic"><Italic size={14} /></button>
          <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => exec('underline')} title="Underline" aria-label="Underline"><Underline size={14} /></button>
          <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => exec('strikeThrough')} title="Strikethrough" aria-label="Strikethrough"><Strikethrough size={14} /></button>
          <span className="rte-divider" />
          <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => exec('formatBlock', '<h2>')} title="Heading" aria-label="Heading"><Heading2 size={14} /></button>
          <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => exec('formatBlock', '<blockquote>')} title="Quote" aria-label="Quote"><Quote size={14} /></button>
          <span className="rte-divider" />
          <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => exec('insertUnorderedList')} title="Bulleted list" aria-label="Bulleted list"><List size={14} /></button>
          <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => exec('insertOrderedList')} title="Numbered list" aria-label="Numbered list"><ListOrdered size={14} /></button>
          <span className="rte-divider" />
          <button type="button" onMouseDown={e => e.preventDefault()} onClick={openLinkPopover} title="Add link" aria-label="Add link"><Link2 size={14} /></button>
          <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => exec('removeFormat')} title="Clear formatting" aria-label="Clear formatting"><Eraser size={14} /></button>
        </div>
      )}
      <div className="rte-body-wrap">
        <div
          ref={ref}
          className="rte-body"
          contentEditable
          suppressContentEditableWarning
          onInput={commit}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          onPaste={e => {
            e.preventDefault();
            const html = e.clipboardData.getData('text/html');
            const inserted = html ? convertPastedHtml(html) : plainTextToHtml(e.clipboardData.getData('text/plain'));
            document.execCommand('insertHTML', false, inserted);
            commit();
          }}
        />
        {empty && placeholder && <span className="rte-placeholder">{placeholder}</span>}
      </div>
      {linkPopover && createPortal(
        <div className="rte-link-popover" ref={linkPopoverRef} style={{ position: 'fixed', top: linkPopover.top, left: linkPopover.left }}>
          <input
            ref={linkInputRef}
            type="text"
            value={linkDraft}
            placeholder="Link URL (https://…)"
            onChange={e => setLinkDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); confirmLink(); }
              else if (e.key === 'Escape') { e.preventDefault(); closeLinkPopover(); }
            }}
          />
          <button type="button" className="btn teal small" onClick={confirmLink} disabled={!linkDraft.trim()}>Add</button>
        </div>,
        document.body
      )}
    </div>
  );
}
