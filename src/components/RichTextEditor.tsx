import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Bold, Eraser, Heading2, Image as ImageIcon, Italic, Link2, List, ListOrdered, Quote, Strikethrough, Underline } from 'lucide-react';

const ALLOWED_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'A', 'BR', 'P', 'DIV', 'H2', 'IMG', 'SPAN']);
// The only classes a <span> is ever allowed to carry through — a caller's `decorate` callback
// (see the prop below) is the one place that creates these, wrapping a token like a [[Wikilink]]
// for a color. A span whose class isn't in here (a foreign one from pasted HTML, say) keeps
// existing as a bare, unstyled wrapper rather than being unwrapped outright — harmless, since it
// carries no other attributes or behavior once its class is gone.
const ALLOWED_SPAN_CLASSES = new Set(['sb-tok-wikilink', 'sb-tok-photo']);

// Strips anything that isn't a plain formatting tag (no styles/scripts/classes) — content
// here can come from pasted clipboard HTML, so it can't be trusted as-is even though this is
// a local-only app. Keeps `href` on <a> tags (restricted to http/https), `src` on <img> tags
// (restricted to data: URIs — an already-compressed photo, never a remote URL that could leak
// a viewer's IP to a third party just by loading the note), and `class` on a <span> but only
// when it's one of ALLOWED_SPAN_CLASSES.
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
      const src = el.tagName === 'IMG' ? el.getAttribute('src') : null;
      const spanClass = el.tagName === 'SPAN' && ALLOWED_SPAN_CLASSES.has(el.className) ? el.className : null;
      Array.from(el.attributes).forEach(attr => el.removeAttribute(attr.name));
      if (el.tagName === 'A' && href && /^https?:\/\//i.test(href)) {
        el.setAttribute('href', href);
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
      if (el.tagName === 'IMG' && src && /^data:image\//i.test(src)) el.setAttribute('src', src);
      if (spanClass) el.setAttribute('class', spanClass);
      walk(el);
    });
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

export function isEmptyHtml(html: string): boolean {
  if (/<img[\s>]/i.test(html)) return false;
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

      if (ALLOWED_TAGS.has(tag) && tag !== 'DIV' && tag !== 'SPAN') {
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

// Selection endpoints as plain-text character counts from the start of `root` — survives a
// `decorate` pass restructuring the DOM (wrapping text in <span>s) since that never changes total
// text length, unlike a Range/node+offset pair which would point at the wrong (or a detached) node
// afterward. Tracking both ends (not just the caret) matters because a bold/italic toolbar click
// leaves the current selection in place rather than collapsing it — losing the end would visually
// deselect the just-formatted text after every command.
function getSelectionOffsets(root: HTMLElement): { start: number; end: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const preStart = range.cloneRange();
  preStart.selectNodeContents(root);
  preStart.setEnd(range.startContainer, range.startOffset);
  const preEnd = range.cloneRange();
  preEnd.selectNodeContents(root);
  preEnd.setEnd(range.endContainer, range.endOffset);
  return { start: preStart.toString().length, end: preEnd.toString().length };
}

function resolveOffset(root: HTMLElement, offset: number): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node = walker.nextNode() as Text | null;
  let last: Text | null = null;
  while (node) {
    last = node;
    const len = node.textContent?.length ?? 0;
    if (remaining <= len) return { node, offset: remaining };
    remaining -= len;
    node = walker.nextNode() as Text | null;
  }
  return last ? { node: last, offset: last.textContent?.length ?? 0 } : null;
}

function setSelectionOffsets(root: HTMLElement, start: number, end: number): void {
  const startPos = resolveOffset(root, start);
  const endPos = resolveOffset(root, end);
  if (!startPos || !endPos) return;
  const range = document.createRange();
  range.setStart(startPos.node, startPos.offset);
  range.setEnd(endPos.node, endPos.offset);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

// A field that switched to this editor from a plain <textarea> (or migrated data written as
// bare text) won't have any markup at all — assigning that straight to innerHTML would collapse
// every newline into a single space, since HTML doesn't render bare "\n" as a line break.
function normalizeValue(value: string): string {
  return value.includes('<') ? value : plainTextToHtml(value);
}

export interface RichTextEditorHandle {
  // Inserts plain text at the current cursor position (or `atRange` if given — restores that
  // exact spot first, for a caller whose insert happens after an async gap, e.g. compressing a
  // photo, that would otherwise have let the live selection drift or collapse away). Falls back
  // to wherever focus() lands if neither a live selection nor atRange is available.
  insertText: (text: string, atRange?: Range | null) => void;
  // Same, but for a sanitized HTML fragment.
  insertHtml: (html: string, atRange?: Range | null) => void;
  // Same as insertText, but returns the resulting sanitized HTML instead of calling onChange
  // itself — for a caller that needs to fold this insertion into one larger atomic update (e.g.
  // a photo marker plus that photo's own metadata) rather than firing two separate updates
  // against the same record, where the second (built from a pre-insert snapshot) would otherwise
  // overwrite the first the instant it lands.
  insertTextRaw: (text: string, atRange?: Range | null) => string;
  focus: () => void;
}

export const RichTextEditor = forwardRef<RichTextEditorHandle, {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  // Hides the formatting buttons for tight inline spots (e.g. a quick log line) that still need
  // to accept and preserve rich pasted content — just without the chrome to format it by hand.
  toolbar?: boolean;
  // Starts input-height instead of the default ~110px block, for a field that sits inline
  // alongside other compact controls rather than in its own form row.
  compact?: boolean;
  // Extra class on the outer wrapper, for a page-specific size override (e.g. letting a primary
  // note body grow past the default's ~340px cap) without a new prop per possible tweak.
  className?: string;
  // When set, an image toolbar button appears (and pasting an image file directly is caught too),
  // both just handing the raw File off here — this component doesn't insert anything itself, so
  // the caller decides what a "photo" becomes (a marker + gallery entry, an inline <img>, etc).
  // The second argument is the cursor position at the moment of paste/upload, captured before
  // whatever the caller awaits (compressing the file) has a chance to let it drift — pass it back
  // into insertText/insertHtml's atRange so the result lands where the photo was actually dropped,
  // not wherever the cursor happens to be once that finishes. Omit the prop to leave image support
  // off entirely for a field that has no business embedding photos.
  onImageFile?: (file: File, atRange: Range | null) => void;
  // Fires on every click inside the editor body, alongside (not instead of) normal cursor
  // placement — lets a caller inspect the clicked text (e.g. to detect landing inside a
  // [[Wikilink]]) without this component needing to know what that convention means.
  onBodyClick?: (e: ReactMouseEvent<HTMLDivElement>) => void;
  // Runs in-place against the live editor DOM right after every commit (and after the initial
  // value sync), letting a caller wrap recognized tokens (e.g. [[Wikilink]] or [Photo N]) in a
  // colored <span> for live highlighting. Mutating `root` directly is deliberate — anything more
  // indirect (e.g. returning replacement HTML) would need its own separate caret-preserving pass;
  // this component already saves/restores the caret by character offset around the call.
  decorate?: (root: HTMLElement) => void;
}>(function RichTextEditor({ value, onChange, placeholder, toolbar = true, compact = false, className, onImageFile, onBodyClick, decorate }, forwardedRef) {
  const ref = useRef<HTMLDivElement>(null);
  const [empty, setEmpty] = useState(isEmptyHtml(value || ''));
  const [linkPopover, setLinkPopover] = useState<{ top: number; left: number } | null>(null);
  const [linkDraft, setLinkDraft] = useState('');
  // The button's onMouseDown already preventDefaults so clicking it doesn't blur the editor and
  // collapse the selection — but moving focus into the popover's own input field would, so the
  // exact selection range is captured here and re-applied right before the link is inserted.
  const savedRangeRef = useRef<Range | null>(null);
  const linkInputRef = useRef<HTMLInputElement>(null);
  const imageFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const normalized = normalizeValue(value || '');
    if (ref.current && ref.current.innerHTML !== normalized) {
      ref.current.innerHTML = normalized;
    }
    if (ref.current && decorate) decorate(ref.current);
    setEmpty(isEmptyHtml(normalized));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Wrapping recognized tokens in colored spans restructures the DOM mid-typing, so the caret
  // (tracked by the browser as a node+offset pair) would otherwise land in the wrong place — or a
  // now-detached node — the instant a keystroke completes a token match. Character-offset
  // save/restore around the decorate call keeps it exactly where the user left it regardless.
  const commit = () => {
    if (!ref.current) return;
    if (decorate) {
      const offsets = getSelectionOffsets(ref.current);
      decorate(ref.current);
      if (offsets !== null) setSelectionOffsets(ref.current, offsets.start, offsets.end);
    }
    const html = sanitizeHtml(ref.current.innerHTML);
    onChange(html);
    setEmpty(isEmptyHtml(html));
  };

  // Restores a caller-supplied range before inserting — without this, an insert that happens
  // after an await (compressing a photo) lands wherever the selection happened to drift to by
  // the time it runs, or nowhere at all if it collapsed away entirely.
  const restoreRange = (atRange?: Range | null) => {
    ref.current?.focus();
    if (!atRange) return;
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(atRange);
  };

  useImperativeHandle(forwardedRef, () => ({
    insertText: (text: string, atRange?: Range | null) => {
      restoreRange(atRange);
      document.execCommand('insertText', false, text);
      commit();
    },
    insertHtml: (html: string, atRange?: Range | null) => {
      restoreRange(atRange);
      document.execCommand('insertHTML', false, html);
      commit();
    },
    insertTextRaw: (text: string, atRange?: Range | null) => {
      restoreRange(atRange);
      document.execCommand('insertText', false, text);
      // Skips commit()'s own onChange (that's the whole point of this method — see the interface
      // comment), but still needs the same decorate pass, or a freshly inserted [Photo N] marker
      // would stay plain text until some unrelated later edit happened to trigger commit().
      if (ref.current && decorate) decorate(ref.current);
      const html = ref.current ? sanitizeHtml(ref.current.innerHTML) : '';
      setEmpty(isEmptyHtml(html));
      return html;
    },
    focus: () => ref.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  // Captured up front — the file picker dialog steals focus the moment it opens, so by the time
  // its onChange fires the live selection is long gone (same reasoning as savedRangeRef above,
  // for the link popover).
  const pendingImageRangeRef = useRef<Range | null>(null);
  const getCurrentRange = (): Range | null => {
    const sel = window.getSelection();
    return sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
  };

  const triggerImageUpload = () => {
    pendingImageRangeRef.current = getCurrentRange();
    imageFileRef.current?.click();
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
    <div className={`rte ${compact ? 'rte-compact' : ''} ${className ?? ''}`}>
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
          {onImageFile && (
            <button type="button" onMouseDown={e => e.preventDefault()} onClick={triggerImageUpload} title="Add a photo" aria-label="Add a photo"><ImageIcon size={14} /></button>
          )}
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
          onClick={onBodyClick}
          onPaste={e => {
            const imageItem = Array.from(e.clipboardData.items).find(item => item.type.startsWith('image/'));
            const imageFile = onImageFile ? imageItem?.getAsFile() : null;
            e.preventDefault();
            if (imageFile) { onImageFile?.(imageFile, getCurrentRange()); return; }
            const html = e.clipboardData.getData('text/html');
            const inserted = html ? convertPastedHtml(html) : plainTextToHtml(e.clipboardData.getData('text/plain'));
            document.execCommand('insertHTML', false, inserted);
            commit();
          }}
        />
        {empty && placeholder && <span className="rte-placeholder">{placeholder}</span>}
      </div>
      {onImageFile && (
        <input
          ref={imageFileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={e => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) onImageFile?.(file, pendingImageRangeRef.current);
          }}
        />
      )}
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
});
