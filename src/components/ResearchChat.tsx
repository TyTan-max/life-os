/**
 * ResearchChat — a self-contained hybrid AI chat panel.
 *
 * Two interchangeable engines, chosen from the compact dropdown built into the
 * input dock:
 *   • "Local"  → your own Ollama instance (free, offline, private)
 *   • "Cloud"  → the Gemini API (free tier, needs an API key)
 *
 * Both are spoken to with plain `fetch` + streaming response parsing — no SDKs.
 * Chat history and the selected engine are mirrored to localStorage, so a Vite
 * hot-reload or a tab refresh never loses the conversation.
 *
 * Layout: a centered, width-capped message column (easier to read than
 * full-width bubbles), a minimal header (name + status only), and a floating
 * pill-shaped input dock anchored to the bottom with quick-prompt chips,
 * voice input, and a text-file attach shortcut.
 *
 * Usage:  <ResearchChat />          — drop it anywhere, it manages its own state.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ClipboardEvent, CSSProperties, KeyboardEvent, MouseEvent } from 'react';
import {
  Check, Cloud, Copy, Cpu, ListChecks, MessagesSquare, Mic, MicOff, NotebookPen, Paperclip, Pencil, Plus, RotateCcw,
  Search, Send, Square, Trash2, X
} from 'lucide-react';
import { Modal } from './UI';
import { useStore, newRecord } from '../store';
import { DEFAULT_WORKSPACE_ID } from '../storage';
import { escapeHtml, listItemsOf, markdownToHtml } from '../lib/markdown';
import { buildLifeOsContext, CONTEXT_AREAS } from '../lib/researchContext';
import type { ContextArea } from '../lib/researchContext';
import type { Note, ResearchChatRecord, ResearchMessage, Task } from '../types';
import { checkCloudConfigured, ENGINE_STORAGE_KEY, GEMINI_API_KEY, GEMINI_MODEL, GEMINI_ORIGIN, OLLAMA_BASE_URL, OLLAMA_MODEL } from '../lib/aiEngine';
import type { Engine as SharedEngine } from '../lib/aiEngine';
import { useFabAction } from '../hooks/useFabAction';
import { useIsMobile } from '../hooks/useIsMobile';

/* ============================================================================
 * 1. CONFIGURATION
 *
 * The API key, model names, and endpoint live in ../lib/aiEngine.ts — shared
 * with the bucket list's "generate new ideas" feature, so there's one place to
 * update a model string or key rather than two drifting copies. See that file
 * for how to set VITE_GEMINI_API_KEY / swap models.
 * ========================================================================== */

/** Prepended to every conversation to set the assistant's behaviour. */
const SYSTEM_PROMPT =
  'You are a sharp, concise research assistant embedded in a personal dashboard. ' +
  'Prefer specific, actionable answers over hedging. Format with Markdown where it helps ' +
  '(short headings, bullet or numbered lists, **bold** for key terms, code blocks for code), ' +
  'and keep paragraphs short. If you are unsure about a fact, say so plainly.';

/** localStorage keys — namespaced to match the rest of the app. */
const STORAGE_MESSAGES = 'life-os-research-chat-v1';
const STORAGE_ENGINE = ENGINE_STORAGE_KEY;
/** Which saved chat is open, and whether Local mode may read your Life OS data. */
const STORAGE_ACTIVE_CHAT = 'life-os-research-active-chat-v1';
const STORAGE_INCLUDE_DATA = 'life-os-research-include-data-v1';
const STORAGE_DATA_AREAS = 'life-os-research-data-areas-v1';
const STORAGE_LOCAL_MODEL = 'life-os-research-local-model-v1';

/** "Try again" variations: each re-asks the same question with one extra instruction. */
const RETRY_OPTIONS: { label: string; instruction?: string }[] = [
  { label: 'Try again' },
  { label: 'Shorter', instruction: 'answer much more briefly' },
  { label: 'Simpler', instruction: 'explain it in simpler, plainer terms' },
  { label: 'More detail', instruction: 'go into more detail, with specifics' }
];

/** Max pixel height the input grows to before it starts scrolling internally. */
const TEXTAREA_MAX_HEIGHT = 160;

/** Max characters pulled in from an attached text file, to stay prompt-sized. */
const ATTACH_MAX_CHARS = 12000;

/** Pasted/attached images are downscaled + re-encoded to JPEG so they don't blow past localStorage's size limits. */
const IMAGE_MAX_DIM = 1400;
const IMAGE_QUALITY = 0.8;
/** Keep a single turn's payload sane — both engines slow down a lot past a handful of images. */
const MAX_IMAGES_PER_MESSAGE = 4;

/** One-tap prompts above the input. Which set shows depends on what there is to act on. */
// Something pasted or attached: act on it.
const ACT_PROMPTS = ['Summarize this', "Explain like I'm five", 'Give me key takeaways', 'Fact-check this claim'];
// Mid-conversation, nothing typed: follow up on the last answer.
const FOLLOW_UP_PROMPTS = ['Explain that more simply', 'Give me an example', 'Make it shorter', 'What are the counterarguments?'];
// Empty chat: sentence starters to finish.
const STARTER_PROMPTS = ['Explain in simple terms: ', 'Pros and cons of ', 'Compare ', 'Give me a step-by-step plan to '];

/* ============================================================================
 * 2. TYPES — no `any` anywhere.
 * ========================================================================== */

/** Which backend answers the next message. */
export type Engine = SharedEngine;

/** Roles we track in the UI. (Gemini's wire format calls this 'model'; we map it.) */
export type ChatRole = 'user' | 'assistant';

/** A pasted or attached image, downscaled and stored as a data URL. */
export interface Attachment {
  dataUrl: string;
  mimeType: string;
}

/** One turn in the conversation (the stored shape — chats are saved with the rest of Life OS). */
export type ChatMessage = ResearchMessage;
type ChatSource = { title: string; uri: string };

export interface ResearchChatProps {
  /** Optional heading override. */
  title?: string;
  /** Optional CSS height for the panel (default: fills the window under the page header). */
  height?: string;
}

/* --- Ollama wire format (POST /api/chat, stream:true → NDJSON) ------------- */

interface OllamaChunk {
  message?: { role?: string; content?: string };
  done?: boolean;
  error?: string;
}

/* --- Gemini wire format (streamGenerateContent?alt=sse → SSE) -------------- */

interface GeminiPart {
  text?: string;
}
interface GeminiCandidate {
  content?: { parts?: GeminiPart[]; role?: string };
  finishReason?: string;
  /** Present when the answer was grounded with Google Search. */
  groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] };
}
interface GeminiChunk {
  candidates?: GeminiCandidate[];
  error?: { message?: string; status?: string };
}

/* --- Minimal Web Speech API surface (not in every TS DOM lib version) ------ */

interface SpeechRecognitionResultLike {
  0: { transcript: string };
  isFinal: boolean;
}
interface SpeechRecognitionEventLike {
  results: ArrayLike<SpeechRecognitionResultLike>;
  resultIndex: number;
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/* ============================================================================
 * 3. HELPERS
 * ========================================================================== */

/** Collision-safe id, with a fallback for older/insecure contexts. */
function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Reads a streaming response body and yields it one line at a time.
 * Both engines stream line-delimited payloads (NDJSON for Ollama, SSE for
 * Gemini), so they share this reader; only the per-line parsing differs.
 */
async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // The last element may be a partial line — hold it until more bytes arrive.
      buffer = lines.pop() ?? '';
      for (const line of lines) yield line;
    }
    if (buffer.trim()) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Downscales an image file/blob and re-encodes it as JPEG, so pasted screenshots
 * don't blow past localStorage's size limits or bloat the request payload.
 */
function fileToCompressedAttachment(file: File | Blob, maxDim = IMAGE_MAX_DIM, quality = IMAGE_QUALITY): Promise<Attachment> {
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
        if (!ctx) { resolve({ dataUrl: reader.result as string, mimeType: file.type || 'image/png' }); return; }
        ctx.drawImage(img, 0, 0, w, h);
        resolve({ dataUrl: canvas.toDataURL('image/jpeg', quality), mimeType: 'image/jpeg' });
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

/** Images are kept in saved chats as small thumbnails only. */
const THUMB_MAX_DIM = 320;
const THUMB_MAX_CHARS = 60_000;
async function withThumbnails(messages: ChatMessage[]): Promise<ChatMessage[]> {
  return Promise.all(messages.map(async m => {
    if (!m.images?.some(img => img.dataUrl.length > THUMB_MAX_CHARS)) return m;
    const images = await Promise.all(m.images.map(async img => {
      if (img.dataUrl.length <= THUMB_MAX_CHARS) return img;
      try {
        const blob = await (await fetch(img.dataUrl)).blob();
        return await fileToCompressedAttachment(blob, THUMB_MAX_DIM, 0.6);
      } catch {
        return img;
      }
    }));
    return { ...m, images };
  }));
}

/** Strips the `data:image/jpeg;base64,` prefix — engines want the raw base64 payload. */
function base64Of(attachment: Attachment): string {
  const comma = attachment.dataUrl.indexOf(',');
  return comma === -1 ? attachment.dataUrl : attachment.dataUrl.slice(comma + 1);
}

/** A chat/note title from its first question: one line, trimmed to a readable length. */
function titleFrom(text: string): string {
  const line = text.replace(/^Attached file:.*$/m, '').replace(/\s+/g, ' ').trim();
  if (!line) return 'Untitled chat';
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function hostOf(uri: string): string {
  try { return new URL(uri).hostname.replace(/^www\./, ''); } catch { return uri; }
}

/** The sources of an answer as HTML, for a saved note. */
function sourcesHtml(sources: ChatSource[] | undefined): string {
  if (!sources?.length) return '';
  return `<p><strong>Sources</strong></p><ol>${sources.map(src => `<li><a href="${escapeHtml(src.uri)}" target="_blank" rel="noreferrer noopener">${escapeHtml(src.title || hostOf(src.uri))}</a></li>`).join('')}</ol>`;
}

/** Turns a failed Response into a message worth showing the user. */
async function describeHttpError(res: Response, label: string): Promise<string> {
  const raw = await res.text().catch(() => '');
  let detail = raw.slice(0, 300);
  try {
    const parsed = JSON.parse(raw) as GeminiChunk & { error?: string | { message?: string } };
    const err = parsed.error;
    if (typeof err === 'string') detail = err;
    else if (err && typeof err === 'object' && err.message) detail = err.message;
  } catch {
    /* body wasn't JSON — keep the raw snippet */
  }
  return `${label} request failed (${res.status}). ${detail}`.trim();
}

/* ============================================================================
 * 4. ENGINE ADAPTERS
 * ========================================================================== */

/**
 * Local Ollama. Streams newline-delimited JSON objects.
 * `context` is the optional summary of your Life OS data. This is the only adapter that takes
 * one: the request goes to Ollama on this computer and nowhere else.
 */
async function streamOllama(history: ChatMessage[], onDelta: (text: string) => void, signal: AbortSignal, context?: string, model: string = OLLAMA_MODEL): Promise<void> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model,
      stream: true,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...(context ? [{ role: 'system', content: `Use this when the question is about the user's own life, money, sleep, habits, tasks or goals. Quote their real numbers.\n\n${context}` }] : []),
        ...history.map(m => ({
          role: m.role,
          content: m.content,
          ...(m.images?.length ? { images: m.images.map(base64Of) } : {})
        }))
      ]
    })
  });

  if (!res.ok) throw new Error(await describeHttpError(res, 'Ollama'));
  if (!res.body) throw new Error('Ollama returned an empty response stream.');

  for await (const line of readLines(res.body)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let chunk: OllamaChunk;
    try {
      chunk = JSON.parse(trimmed) as OllamaChunk;
    } catch {
      continue; // ignore keep-alives / malformed fragments
    }
    if (chunk.error) throw new Error(`Ollama: ${chunk.error}`);
    const delta = chunk.message?.content;
    if (delta) onDelta(delta);
    if (chunk.done) break;
  }
}

/** Web-search grounding was refused for this key; skip trying it again until this time. */
let searchRefusedUntil = 0;
const SEARCH_RETRY_AFTER_MS = 30 * 60 * 1000;

/**
 * Google Gemini. Streams server-sent events (`data: {...}`).
 * Sends only the conversation itself (what was typed or attached). There is deliberately no
 * parameter for Life OS data here, so none can reach Google through this function.
 * Asks for Google Search grounding so answers can cite web sources; if the key or model doesn't
 * allow that, it retries without.
 */
async function streamGemini(history: ChatMessage[], onDelta: (text: string) => void, signal: AbortSignal, onSources?: (sources: ChatSource[]) => void): Promise<void> {
  if (!GEMINI_ORIGIN && !GEMINI_API_KEY) {
    throw new Error(
      'No Gemini API key found. Add VITE_GEMINI_API_KEY to .env.local and restart the dev server.'
    );
  }

  const base = GEMINI_ORIGIN ? `${GEMINI_ORIGIN}/gemini` : 'https://generativelanguage.googleapis.com/v1beta';
  const keyQuery = GEMINI_ORIGIN ? '' : `&key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const url = `${base}/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse${keyQuery}`;

  const body = (withSearch: boolean) => JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    // Gemini names the assistant role 'model', so map ours across. Images ride
    // alongside the text as inlineData parts — order doesn't matter to the API.
    contents: history.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [
        ...(m.content ? [{ text: m.content }] : []),
        ...(m.images ?? []).map(img => ({ inlineData: { mimeType: img.mimeType, data: base64Of(img) } }))
      ]
    })),
    ...(withSearch ? { tools: [{ google_search: {} }] } : {})
  });
  const post = (withSearch: boolean) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: body(withSearch) });

  // Search grounding isn't available for every key/model/quota (the free tier refuses it). When
  // it's refused, answer without it and don't ask again for a while, so each message isn't slowed
  // by a request that's known to fail.
  const trySearch = Date.now() > searchRefusedUntil;
  let res = await post(trySearch);
  if (trySearch && !res.ok && [400, 403, 404, 429].includes(res.status)) {
    searchRefusedUntil = Date.now() + SEARCH_RETRY_AFTER_MS;
    res = await post(false);
  }

  if (!res.ok) throw new Error(await describeHttpError(res, 'Gemini'));
  if (!res.body) throw new Error('Gemini returned an empty response stream.');

  for await (const line of readLines(res.body)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;

    let chunk: GeminiChunk;
    try {
      chunk = JSON.parse(payload) as GeminiChunk;
    } catch {
      continue;
    }
    if (chunk.error?.message) throw new Error(`Gemini: ${chunk.error.message}`);

    const parts = chunk.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map(p => p.text ?? '').join('');
    if (text) onDelta(text);

    const sources = (chunk.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [])
      .map(c => c.web)
      .filter((w): w is { uri: string; title?: string } => Boolean(w?.uri))
      .map(w => ({ uri: w.uri, title: w.title ?? '' }));
    if (sources.length) onSources?.(sources);
  }
}

const ENGINES: Record<Engine, { label: string; shortLabel: string; model: string }> = {
  local: { label: 'Local — runs on this computer; nothing leaves it', shortLabel: 'Local', model: OLLAMA_MODEL },
  cloud: { label: 'Cloud — Google Gemini; what you type or attach is sent to Google', shortLabel: 'Cloud', model: GEMINI_MODEL }
};

/* ============================================================================
 * 5. STYLES — plain objects, no dependencies, tweak the palette in one place.
 * ========================================================================== */

// The app's own theme colours, so the panel follows light / dark like every other page.
const C = {
  base: 'var(--bg)',
  panel: 'var(--surface)',
  raised: 'color-mix(in srgb, var(--surface-hover) 55%, var(--surface))',
  raised2: 'var(--surface-hover)',
  border: 'var(--border)',
  text: 'var(--text)',
  dim: 'var(--text-muted)',
  faint: 'var(--text-faint)',
  accent: 'var(--accent)',
  danger: 'var(--red)',
  success: 'var(--green)',
  amber: 'var(--amber)'
} as const;

const COLUMN_MAX_WIDTH = 900;

// Phone overrides, merged over S by `st()` inside the component. On a 375px screen the pill put
// the engine select and three icons in front of the textarea, squeezing it into a ~70px column
// that wrapped its placeholder over four lines; here the textarea takes a full-width first line
// and the controls drop to a row beneath it, every one at a 44px touch size.
const MOBILE_S: Record<string, CSSProperties> = {
  shell: { borderRadius: 12 },
  dockOuter: { padding: '10px 10px 12px' },
  chip: { minHeight: 40, padding: '0 14px', fontSize: 13 },
  pill: { flexWrap: 'wrap', alignItems: 'center', borderRadius: 20, padding: '4px 6px 6px 8px' },
  pillTextarea: { flexBasis: '100%', order: -1, fontSize: 16, padding: '10px 6px 6px' },
  pillEngineSelect: { minHeight: 44, fontSize: 14, maxWidth: 80 },
  pillIconBtn: { width: 44, height: 44 },
  pillSend: { width: 44, height: 44, marginLeft: 'auto' },
  footerRow: { flexWrap: 'wrap' },
  clearBtn: { minHeight: 40, fontSize: 12.5, padding: '0 8px' }
};

const S: Record<string, CSSProperties> = {
  shell: {
    display: 'flex',
    flexDirection: 'column',
    background: C.base,
    border: `1px solid ${C.border}`,
    borderRadius: 14,
    overflow: 'hidden',
    color: C.text,
    fontSize: 14,
    lineHeight: 1.55
  },

  /* ---- header: name + status only ---- */
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '13px 18px',
    background: C.panel,
    borderBottom: `1px solid ${C.border}`,
    flexShrink: 0
  },
  headerTitle: { fontSize: 14, fontWeight: 650, letterSpacing: '-0.01em', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 },
  headerRight: { display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 },
  headerBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', border: `1px solid ${C.border}`,
    color: C.dim, borderRadius: 8, padding: '5px 9px', fontSize: 12, fontWeight: 550, cursor: 'pointer', flexShrink: 0
  },

  /* ---- saved chats ---- */
  main: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, position: 'relative' },
  side: {
    display: 'flex', flexDirection: 'column', gap: 10, width: 232, flexShrink: 0, padding: 12,
    background: C.panel, borderRight: `1px solid ${C.border}`, minHeight: 0
  },
  mobileChats: {
    position: 'absolute', top: 48, left: 0, right: 0, zIndex: 5, display: 'flex', flexDirection: 'column', gap: 10,
    maxHeight: '60%', padding: 12, background: C.panel, borderBottom: `1px solid ${C.border}`, boxShadow: '0 12px 24px rgba(0,0,0,0.4)'
  },
  newChatBtn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: C.raised, color: C.text,
    border: `1px solid ${C.border}`, borderRadius: 9, padding: '8px 10px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', flexShrink: 0
  },
  chatList: { display: 'flex', flexDirection: 'column', gap: 2, overflowY: 'auto', minHeight: 0 },
  chatListEmpty: { margin: '6px 4px', fontSize: 12, color: C.faint },
  chatRow: { display: 'flex', alignItems: 'center', borderRadius: 8 },
  chatRowActive: { background: C.raised2 },
  chatRowBtn: {
    display: 'flex', flexDirection: 'column', gap: 1, flex: 1, minWidth: 0, background: 'transparent', border: 'none',
    color: C.text, textAlign: 'left', padding: '7px 8px', cursor: 'pointer', font: 'inherit'
  },
  chatRowTitle: { fontSize: 12.5, fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  chatRowMeta: { fontSize: 11, color: C.faint },
  chatRowDelete: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, flexShrink: 0,
    background: 'transparent', border: 'none', color: C.faint, borderRadius: 6, cursor: 'pointer', marginRight: 2
  },

  /* ---- web sources under a cloud answer ---- */
  sources: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 10px', marginTop: 6, marginLeft: 2, fontSize: 11.5 },
  sourcesLabel: { color: C.faint, fontWeight: 600 },
  sourceLink: { color: C.accent, textDecoration: 'none', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },

  /* ---- privacy line under the input ---- */
  privacyLine: { display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, fontSize: 11.5, color: C.faint, minWidth: 0 },
  includeData: { display: 'inline-flex', alignItems: 'center', gap: 5, marginLeft: 6, color: C.dim, cursor: 'pointer' },
  footerActions: { display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 },
  noticeOk: {
    maxWidth: COLUMN_MAX_WIDTH, margin: '0 auto 10px', padding: '9px 12px', borderRadius: 8, fontSize: 12.5, flexShrink: 0,
    background: 'color-mix(in srgb, var(--green) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--green) 35%, transparent)', color: C.success
  },
  editingBar: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginBottom: 10, fontSize: 12, color: C.amber },
  bubbleEditing: { outline: `2px dashed ${C.amber}`, outlineOffset: 2 },
  retryChip: {
    background: C.raised, color: C.dim, border: `1px solid ${C.border}`, borderRadius: 999, padding: '3px 10px',
    fontSize: 11.5, fontWeight: 550, cursor: 'pointer', marginLeft: 4
  },
  chatSearch: {
    display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px', height: 28, border: `1px solid ${C.border}`,
    borderRadius: 8, color: C.faint, flexShrink: 0
  },
  chatSearchInput: { flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', color: C.text, font: 'inherit', fontSize: 12.5 },
  chatGroup: { margin: '8px 6px 2px', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.faint },
  chatRename: {
    flex: 1, minWidth: 0, margin: '4px 4px 4px 6px', padding: '5px 7px', border: `1px solid ${C.accent}`, borderRadius: 6,
    background: C.base, color: C.text, font: 'inherit', fontSize: 12.5, outline: 'none'
  },
  modelSelect: {
    background: 'transparent', color: C.dim, border: `1px solid ${C.border}`, borderRadius: 6, padding: '1px 4px',
    fontSize: 11.5, maxWidth: 150, marginLeft: 4
  },
  linkBtn: { background: 'transparent', border: 'none', padding: 0, color: C.accent, fontSize: 11.5, cursor: 'pointer', textDecoration: 'underline' },
  noticeBtn: { background: 'transparent', border: `1px solid ${C.amber}`, color: C.amber, borderRadius: 6, padding: '2px 8px', fontSize: 12, cursor: 'pointer', marginLeft: 4 },
  statusPill: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.dim, fontWeight: 550 },
  statusDot: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },

  /* ---- centered message column ---- */
  streamOuter: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    background: C.base,
    padding: '22px 16px 8px'
  },
  streamInner: {
    maxWidth: COLUMN_MAX_WIDTH,
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 18
  },
  empty: {
    margin: '40px auto',
    textAlign: 'center',
    color: C.faint,
    fontSize: 13,
    maxWidth: 380,
    lineHeight: 1.6
  },

  messageBlock: { display: 'flex', flexDirection: 'column', maxWidth: '84%' },
  row: { display: 'flex', width: '100%' },
  bubble: {
    padding: '11px 14px',
    borderRadius: 14,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word'
  },
  bubbleUser: { background: C.accent, color: '#fff', borderBottomRightRadius: 4 },
  bubbleBot: {
    background: C.panel,
    color: C.text,
    border: `1px solid ${C.border}`,
    borderBottomLeftRadius: 4
  },
  bubbleError: {
    background: 'rgba(255,107,107,0.08)',
    color: C.danger,
    border: '1px solid rgba(255,107,107,0.3)',
    borderBottomLeftRadius: 4
  },
  caret: {
    display: 'inline-block',
    width: 7,
    height: 15,
    marginLeft: 2,
    background: C.dim,
    verticalAlign: 'text-bottom',
    animation: 'lifeosBlink 1s steps(2, start) infinite'
  },

  /* ---- images attached to a message bubble ---- */
  bubbleImages: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  bubbleImage: { width: 120, height: 120, objectFit: 'cover', borderRadius: 8, display: 'block' },

  /* ---- pending attachment tray, shown above the pill while composing ---- */
  pendingTray: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  pendingThumbWrap: { position: 'relative', width: 56, height: 56, flexShrink: 0 },
  pendingThumb: { width: 56, height: 56, objectFit: 'cover', borderRadius: 8, border: `1px solid ${C.border}`, display: 'block' },
  pendingRemove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 18,
    height: 18,
    borderRadius: '50%',
    background: C.raised2,
    border: `1px solid ${C.border}`,
    color: C.text,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    padding: 0
  },

  /* ---- contextual action row under each AI reply ---- */
  actionsRow: { display: 'flex', alignItems: 'center', gap: 2, marginTop: 5, marginLeft: 2 },
  actionBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 26,
    height: 26,
    border: 'none',
    background: 'transparent',
    color: C.faint,
    borderRadius: 6,
    cursor: 'pointer'
  },

  /* ---- notice banner ---- */
  notice: {
    maxWidth: COLUMN_MAX_WIDTH,
    margin: '0 auto 10px',
    padding: '9px 12px',
    borderRadius: 8,
    background: 'rgba(255,107,107,0.08)',
    border: '1px solid rgba(255,107,107,0.25)',
    color: C.danger,
    fontSize: 12.5,
    flexShrink: 0
  },
  noticeWarn: {
    maxWidth: COLUMN_MAX_WIDTH,
    margin: '0 auto 10px',
    padding: '9px 12px',
    borderRadius: 8,
    background: 'rgba(240,180,41,0.08)',
    border: '1px solid rgba(240,180,41,0.3)',
    color: C.amber,
    fontSize: 12.5,
    flexShrink: 0
  },

  /* ---- floating input dock ---- */
  dockOuter: {
    flexShrink: 0,
    background: C.base,
    borderTop: `1px solid ${C.border}`,
    padding: '12px 16px 16px'
  },
  dockInner: { maxWidth: COLUMN_MAX_WIDTH, margin: '0 auto' },

  chipsRow: {
    display: 'flex',
    gap: 8,
    overflowX: 'auto',
    paddingBottom: 10,
    marginBottom: 2
  },
  chip: {
    flexShrink: 0,
    background: C.raised,
    color: C.dim,
    border: `1px solid ${C.border}`,
    borderRadius: 999,
    padding: '6px 13px',
    fontSize: 12,
    fontWeight: 550,
    cursor: 'pointer',
    whiteSpace: 'nowrap'
  },

  pill: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: 4,
    background: C.raised,
    border: `1px solid ${C.border}`,
    borderRadius: 24,
    padding: '6px 6px 6px 8px',
    boxShadow: 'var(--shadow, 0 6px 20px rgba(0,0,0,0.25))'
  },
  pillEngineSelect: {
    background: 'transparent',
    color: C.dim,
    border: 'none',
    outline: 'none',
    fontSize: 12.5,
    fontWeight: 600,
    cursor: 'pointer',
    padding: '9px 2px 9px 6px',
    maxWidth: 64
  },
  pillIconBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 34,
    height: 34,
    flexShrink: 0,
    border: 'none',
    background: 'transparent',
    color: C.dim,
    borderRadius: '50%',
    cursor: 'pointer'
  },
  pillTextarea: {
    flex: 1,
    resize: 'none',
    background: 'transparent',
    color: C.text,
    border: 'none',
    outline: 'none',
    padding: '9px 4px',
    fontSize: 14,
    lineHeight: 1.5,
    fontFamily: 'inherit',
    maxHeight: TEXTAREA_MAX_HEIGHT,
    overflowY: 'auto'
  },
  pillSend: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 36,
    height: 36,
    flexShrink: 0,
    background: C.accent,
    color: '#fff',
    border: 'none',
    borderRadius: '50%',
    cursor: 'pointer'
  },

  footerRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginTop: 8,
    padding: '0 6px'
  },
  footerHint: { fontSize: 11, color: C.faint },
  clearBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    background: 'transparent',
    border: 'none',
    color: C.faint,
    fontSize: 11,
    fontWeight: 550,
    cursor: 'pointer',
    padding: '3px 4px'
  }
};

const RESEARCH_CSS = `
@keyframes lifeosBlink { 0%,100% { opacity: 1 } 50% { opacity: 0 } }
.research-md > :first-child { margin-top: 0; }
.research-md > :last-child { margin-bottom: 0; }
.research-md p { margin: 0 0 10px; }
.research-md h3, .research-md h4, .research-md h5, .research-md h6 { margin: 14px 0 6px; font-size: 14.5px; font-weight: 700; line-height: 1.35; }
.research-md h3 { font-size: 16px; }
.research-md ul, .research-md ol { margin: 0 0 10px; padding-left: 20px; }
.research-md li { margin: 3px 0; }
.research-md code { padding: 1px 5px; border-radius: 5px; background: ${C.raised2}; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
.research-md pre { position: relative; margin: 0 0 10px; padding: 10px 12px; border-radius: 8px; background: ${C.base}; border: 1px solid ${C.border}; overflow-x: auto; }
.research-copy-code { position: absolute; top: 6px; right: 6px; padding: 2px 8px; border: 1px solid ${C.border}; border-radius: 6px; background: ${C.panel}; color: ${C.dim}; font: inherit; font-size: 11px; cursor: pointer; opacity: 0.75; }
.research-copy-code:hover { opacity: 1; color: ${C.text}; }
.research-data-preview { margin: 0; max-height: min(46vh, 420px); overflow: auto; padding: 10px 12px; border: 1px solid ${C.border}; border-radius: 8px; background: ${C.base}; color: ${C.dim}; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.research-task-row { display: grid; grid-template-columns: 18px 1fr; align-items: center; gap: 8px; }
.research-task-row input[type="text"] { width: 100%; padding: 7px 9px; border: 1px solid ${C.border}; border-radius: 8px; background: ${C.base}; color: ${C.text}; font: inherit; font-size: 13px; }
.research-md pre code { padding: 0; background: transparent; white-space: pre; }
.research-md blockquote { margin: 0 0 10px; padding: 2px 0 2px 12px; border-left: 3px solid ${C.border}; color: ${C.dim}; }
.research-md a { color: ${C.accent}; }
.research-md hr { border: 0; border-top: 1px solid ${C.border}; margin: 12px 0; }
`;

/* ============================================================================
 * 6. COMPONENT
 * ========================================================================== */

export function ResearchChat({
  title = 'Research Assistant',
  height = 'calc(100dvh - 150px)'
}: ResearchChatProps) {
  const { data, upsert, remove, loading } = useStore();
  const dataRef = useRef(data);
  dataRef.current = data;
  const isMobile = useIsMobile();
  const st = (key: string): CSSProperties => (isMobile && MOBILE_S[key] ? { ...S[key], ...MOBILE_S[key] } : S[key]);

  /* --- saved chats (stored with the rest of Life OS, so they sync and back up) --- */
  const chats = useMemo(
    () => data.researchChats.slice().sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt)),
    [data.researchChats]
  );
  const [chatId, setChatId] = useState<string | null>(() => {
    try { return window.localStorage.getItem(STORAGE_ACTIVE_CHAT); } catch { return null; }
  });
  const chatIdRef = useRef(chatId);
  /** A chat id this component just created itself — its messages are already on screen. */
  const skipLoadRef = useRef<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const [persistTick, setPersistTick] = useState(0);
  const [showChats, setShowChats] = useState(false);
  const [chatSearch, setChatSearch] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const [engine, setEngine] = useState<Engine>(() => {
    const saved = window.localStorage.getItem(STORAGE_ENGINE);
    return saved === 'cloud' || saved === 'local' ? saved : 'local';
  });
  const hadSavedEngine = useRef(Boolean(window.localStorage.getItem(STORAGE_ENGINE)));
  const [includeData, setIncludeData] = useState(() => {
    try { return window.localStorage.getItem(STORAGE_INCLUDE_DATA) === '1'; } catch { return false; }
  });
  // Which areas of your data Local mode may read — and a window showing exactly what that is.
  const [dataAreas, setDataAreas] = useState<ContextArea[]>(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_DATA_AREAS) ?? 'null') as unknown;
      if (Array.isArray(saved)) return CONTEXT_AREAS.map(a => a.key).filter(k => saved.includes(k));
    } catch { /* fall through to everything */ }
    return CONTEXT_AREAS.map(a => a.key);
  });
  const [showDataPicker, setShowDataPicker] = useState(false);

  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [voiceSupported] = useState(() => getSpeechRecognitionCtor() !== null);
  const [pendingImages, setPendingImages] = useState<Attachment[]>([]);
  /** The earlier question being edited — sending replaces it and everything after. */
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [retryMenuFor, setRetryMenuFor] = useState<string | null>(null);
  const [attachNote, setAttachNote] = useState<string | null>(null);
  /** "Add to Tasks": the list items of an answer, each with a tick. */
  const [taskDraft, setTaskDraft] = useState<{ text: string; on: boolean }[] | null>(null);
  const [tasksAdded, setTasksAdded] = useState<number | null>(null);
  const [cloudReady, setCloudReady] = useState(true);
  useEffect(() => { void checkCloudConfigured().then(setCloudReady); }, []);

  // Is the local engine (Ollama) actually reachable, and which models does it have?
  // null = still checking.
  const [localReady, setLocalReady] = useState<boolean | null>(null);
  const [localModels, setLocalModels] = useState<string[]>([]);
  const [localModel, setLocalModel] = useState(() => {
    try { return window.localStorage.getItem(STORAGE_LOCAL_MODEL) ?? OLLAMA_MODEL; } catch { return OLLAMA_MODEL; }
  });
  const checkLocal = useCallback(() => {
    setLocalReady(null);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 2500);
    fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: controller.signal })
      .then(async res => {
        if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
        const body = await res.json() as { models?: { name?: string }[] };
        return (body.models ?? []).map(m => m.name ?? '').filter(Boolean);
      })
      .catch(() => null)
      .then(models => {
        setLocalReady(models !== null);
        setLocalModels(models ?? []);
      })
      .finally(() => window.clearTimeout(timer));
  }, []);
  useEffect(() => { checkLocal(); }, [checkLocal]);
  // Use a model Ollama actually has: the saved one if it's installed, otherwise the first.
  useEffect(() => {
    if (!localModels.length) return;
    const match = localModels.find(m => m === localModel || m.startsWith(`${localModel}:`));
    if (match && match !== localModel) setLocalModel(match);
    else if (!match) setLocalModel(localModels[0]);
  }, [localModels, localModel]);
  useEffect(() => {
    try { window.localStorage.setItem(STORAGE_LOCAL_MODEL, localModel); } catch { /* ignore */ }
  }, [localModel]);
  // No engine chosen yet and Local can't work here (the hosted site, a phone): start on Cloud.
  useEffect(() => {
    if (localReady === false && !hadSavedEngine.current) setEngine('cloud');
  }, [localReady]);

  const streamRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useFabAction('Research', 'Ask a question', () => {
    textareaRef.current?.focus();
    textareaRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  /** False while the user has scrolled up to read — keeps streaming from yanking them back. */
  const pinnedRef = useRef(true);

  /* --- load the open chat's messages when switching chats / once data has loaded --- */
  useEffect(() => {
    if (loading) return;
    if (skipLoadRef.current && skipLoadRef.current === chatId) { skipLoadRef.current = null; return; }
    const chat = chatId ? dataRef.current.researchChats.find(c => c.id === chatId) : undefined;
    if (chatId && !chat) { chatIdRef.current = null; setChatId(null); setMessages([]); return; }
    setMessages(chat?.messages ?? []);
    pinnedRef.current = true;
  }, [chatId, loading]);

  useEffect(() => {
    try {
      if (chatId) window.localStorage.setItem(STORAGE_ACTIVE_CHAT, chatId);
      else window.localStorage.removeItem(STORAGE_ACTIVE_CHAT);
    } catch { /* storage disabled — non-fatal */ }
  }, [chatId]);

  /** Saves the conversation on screen as a chat (creating it on the first turn). */
  const persist = useCallback((final: ChatMessage[]) => {
    if (!final.length) return;
    const now = new Date().toISOString();
    let id = chatIdRef.current;
    if (!id) {
      id = createId();
      chatIdRef.current = id;
      skipLoadRef.current = id;
      setChatId(id);
    }
    const chatIdToSave = id;
    // Saved chats keep a small thumbnail of each attached image, not the full picture — full
    // images in every chat would bloat every sync and backup.
    void withThumbnails(final).then(stored => {
      const existing = dataRef.current.researchChats.find(c => c.id === chatIdToSave);
      void upsert('researchChats', {
        ...(existing ?? {}),
        id: chatIdToSave,
        title: existing?.title || titleFrom(stored.find(m => m.role === 'user')?.content ?? stored[0].content),
        messages: stored,
        createdAt: existing?.createdAt ?? stored[0].createdAt ?? now,
        updatedAt: now
      } as ResearchChatRecord);
    });
  }, [upsert]);
  useEffect(() => {
    if (persistTick > 0) persist(messagesRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistTick]);

  /* --- one-time move of the old single conversation (kept in this browser only) into a saved chat --- */
  useEffect(() => {
    if (loading) return;
    let raw: string | null = null;
    try { raw = window.localStorage.getItem(STORAGE_MESSAGES); } catch { return; }
    if (!raw) return;
    try {
      window.localStorage.removeItem(STORAGE_MESSAGES);
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed.length) return;
      const old = parsed as ChatMessage[];
      const id = createId();
      const now = new Date().toISOString();
      void upsert('researchChats', {
        id, title: titleFrom(old.find(m => m.role === 'user')?.content ?? old[0].content),
        messages: old, createdAt: old[0].createdAt ?? now, updatedAt: now
      } as ResearchChatRecord);
      if (!chatIdRef.current) {
        chatIdRef.current = id;
        skipLoadRef.current = id;
        setChatId(id);
        setMessages(old);
      }
    } catch { /* unreadable old history — nothing to move */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_ENGINE, engine);
  }, [engine]);
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_INCLUDE_DATA, includeData ? '1' : '0');
      window.localStorage.setItem(STORAGE_DATA_AREAS, JSON.stringify(dataAreas));
    } catch { /* ignore */ }
  }, [includeData, dataAreas]);

  /* --- auto-scroll to the newest content, unless the user scrolled away --- */
  useEffect(() => {
    const el = streamRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  /* --- auto-expanding textarea ------------------------------------------- */
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
  }, [input]);

  /* --- abort any in-flight stream / stop listening on unmount -------------- */
  useEffect(() => () => {
    abortRef.current?.abort();
    recognitionRef.current?.stop();
  }, []);

  const handleScroll = useCallback(() => {
    const el = streamRef.current;
    if (!el) return;
    // "Pinned" if within 60px of the bottom.
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }, []);

  /** Copy buttons inside code blocks are plain HTML — handled here by delegation. */
  const onStreamClick = useCallback((e: MouseEvent<HTMLDivElement>) => {
    const btn = (e.target as HTMLElement).closest('[data-copy-code]');
    if (!btn || !navigator.clipboard) return;
    const code = btn.parentElement?.querySelector('code')?.textContent ?? '';
    navigator.clipboard.writeText(code).then(() => {
      btn.textContent = 'Copied';
      window.setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    }).catch(() => { /* clipboard permission denied */ });
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
  }, []);

  const newChat = useCallback(() => {
    stop();
    chatIdRef.current = null;
    setChatId(null);
    setMessages([]);
    setShowChats(false);
    setEditingMsgId(null);
    textareaRef.current?.focus();
  }, [stop]);

  const openChat = useCallback((id: string) => {
    if (id === chatIdRef.current) { setShowChats(false); return; }
    stop();
    chatIdRef.current = id;
    setChatId(id);
    setShowChats(false);
    setEditingMsgId(null);
  }, [stop]);

  /** Deleting goes through the store, so the app's Undo brings the chat back. */
  const deleteChat = useCallback((id: string) => {
    void remove('researchChats', id);
    if (id === chatIdRef.current) newChat();
  }, [remove, newChat]);

  const commitRename = useCallback(() => {
    const chat = renamingId ? dataRef.current.researchChats.find(c => c.id === renamingId) : undefined;
    const next = renameDraft.trim();
    if (chat && next && next !== chat.title) void upsert('researchChats', { ...chat, title: next });
    setRenamingId(null);
  }, [renamingId, renameDraft, upsert]);

  /**
   * Streams a reply for the given history and appends it to the conversation.
   * `instruction` (e.g. "shorter") shapes this one answer without becoming part of the chat.
   */
  const runTurn = useCallback(async (history: ChatMessage[], instruction?: string) => {
    const replyId = createId();
    const placeholder: ChatMessage = {
      id: replyId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString()
    };

    setMessages([...history, placeholder]);
    setIsStreaming(true);
    pinnedRef.current = true;

    const controller = new AbortController();
    abortRef.current = controller;

    const onDelta = (delta: string) => {
      setMessages(prev =>
        prev.map(m => (m.id === replyId ? { ...m, content: m.content + delta } : m))
      );
    };
    const onSources = (sources: ChatSource[]) => {
      setMessages(prev => prev.map(m => {
        if (m.id !== replyId) return m;
        const seen = new Set((m.sources ?? []).map(s => s.uri));
        return { ...m, sources: [...(m.sources ?? []), ...sources.filter(s => !seen.has(s.uri))] };
      }));
    };
    const request = instruction
      ? history.map((m, i) => (i === history.length - 1 && m.role === 'user' ? { ...m, content: `${m.content}\n\n(For this answer: ${instruction})` } : m))
      : history;

    try {
      if (engine === 'local') {
        // Your Life OS data is only ever built for, and handed to, the local engine.
        const context = includeData && dataAreas.length ? buildLifeOsContext(dataRef.current, dataAreas) : undefined;
        await streamOllama(request, onDelta, controller.signal, context, localModel);
      } else {
        await streamGemini(request, onDelta, controller.signal, onSources);
      }
    } catch (err) {
      // A user-triggered abort isn't an error — keep whatever streamed in.
      const aborted = err instanceof DOMException && err.name === 'AbortError';
      if (!aborted) {
        const detail =
          err instanceof Error ? err.message : 'Unknown error contacting the model.';
        const hint =
          engine === 'local'
            ? ' — is Ollama running? Open the Ollama app, then press "Check again".'
            : '';
        setMessages(prev =>
          prev.map(m =>
            m.id === replyId ? { ...m, content: `${detail}${hint}`, isError: true } : m
          )
        );
      }
    } finally {
      abortRef.current = null;
      setIsStreaming(false);
      // Drop the placeholder entirely if nothing ever arrived (e.g. instant abort).
      setMessages(prev => prev.filter(m => m.content.length > 0 || m.role === 'user'));
      setPersistTick(t => t + 1);
    }
  }, [engine, includeData, dataAreas, localModel]);

  const send = useCallback(async () => {
    const text = input.trim();
    if ((!text && !pendingImages.length) || isStreaming) return;
    // Editing an earlier question: it, and everything after it, is replaced by this version.
    const editIdx = editingMsgId ? messages.findIndex(m => m.id === editingMsgId) : -1;
    const base = editIdx >= 0 ? messages.slice(0, editIdx) : messages;
    const original = editIdx >= 0 ? messages[editIdx] : undefined;
    const userMsg: ChatMessage = {
      id: createId(),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
      images: pendingImages.length ? pendingImages : original?.images
    };
    setInput('');
    setPendingImages([]);
    setEditingMsgId(null);
    setAttachNote(null);
    await runTurn([...base, userMsg]);
  }, [input, isStreaming, messages, pendingImages, editingMsgId, runTurn]);

  const startEdit = useCallback((m: ChatMessage) => {
    setEditingMsgId(m.id);
    setInput(m.content);
    textareaRef.current?.focus();
  }, []);
  const cancelEdit = useCallback(() => { setEditingMsgId(null); setInput(''); }, []);

  /** Re-runs the exchange from the user turn a given assistant reply answers, discarding it and anything after. */
  const regenerate = useCallback(async (assistantId: string, instruction?: string) => {
    if (isStreaming) return;
    setRetryMenuFor(null);
    const idx = messages.findIndex(m => m.id === assistantId);
    if (idx === -1) return;
    let userIdx = idx - 1;
    while (userIdx >= 0 && messages[userIdx].role !== 'user') userIdx--;
    if (userIdx < 0) return;
    await runTurn(messages.slice(0, userIdx + 1), instruction);
  }, [isStreaming, messages, runTurn]);

  const copyMessage = useCallback((m: ChatMessage) => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(m.content).then(() => {
      setCopiedId(m.id);
      window.setTimeout(() => setCopiedId(prev => (prev === m.id ? null : prev)), 1500);
    }).catch(() => { /* clipboard permission denied — silently ignore */ });
  }, []);

  /** One answer (with the question it answers) → a Second Brain note. Saving again updates that note. */
  const saveAnswerToNote = useCallback((m: ChatMessage) => {
    const all = messagesRef.current;
    const idx = all.findIndex(x => x.id === m.id);
    let question = '';
    for (let i = idx - 1; i >= 0; i--) if (all[i].role === 'user') { question = all[i].content; break; }
    const body = `${question ? `<p><strong>Question:</strong> ${escapeHtml(question).replace(/\n/g, '<br>')}</p>` : ''}${markdownToHtml(m.content)}${sourcesHtml(m.sources)}`;
    const existing = m.savedNoteId ? dataRef.current.notes.find(n => n.id === m.savedNoteId) : undefined;
    if (existing) {
      void upsert('notes', { ...existing, body });
    } else {
      const note = newRecord<Note>({ title: titleFrom(question || m.content), body, tags: ['research'], pinned: false, workspaceId: DEFAULT_WORKSPACE_ID });
      void upsert('notes', note);
      setMessages(prev => prev.map(x => (x.id === m.id ? { ...x, savedNoteId: note.id } : x)));
      setPersistTick(t => t + 1);
    }
    setSavedId(m.id);
    window.setTimeout(() => setSavedId(prev => (prev === m.id ? null : prev)), 2000);
  }, [upsert]);

  /** The whole conversation → one Second Brain note. Saving again updates the same note. */
  const saveChatToNote = useCallback(() => {
    const all = messagesRef.current.filter(m => !m.isError && m.content);
    if (!all.length) return;
    const body = all.map(m => (m.role === 'user'
      ? `<p><strong>You:</strong> ${escapeHtml(m.content).replace(/\n/g, '<br>')}</p>`
      : `${markdownToHtml(m.content)}${sourcesHtml(m.sources)}`)).join('<hr>');
    const chat = chatIdRef.current ? dataRef.current.researchChats.find(c => c.id === chatIdRef.current) : undefined;
    const existing = chat?.noteId ? dataRef.current.notes.find(n => n.id === chat.noteId) : undefined;
    if (existing) {
      void upsert('notes', { ...existing, body });
    } else {
      const note = newRecord<Note>({ title: chat?.title || titleFrom(all.find(m => m.role === 'user')?.content ?? all[0].content), body, tags: ['research'], pinned: false, workspaceId: DEFAULT_WORKSPACE_ID });
      void upsert('notes', note);
      if (chat) void upsert('researchChats', { ...chat, noteId: note.id });
    }
    setSavedId('chat');
    window.setTimeout(() => setSavedId(prev => (prev === 'chat' ? null : prev)), 2000);
  }, [upsert]);

  /** Ticked list items of an answer → tasks. */
  const addTasks = useCallback(() => {
    const picked = (taskDraft ?? []).filter(t => t.on && t.text.trim());
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    for (const t of picked) {
      void upsert('tasks', newRecord<Task>({ title: t.text.trim(), status: 'Not Started', priority: 'Medium', dueDate: today, notes: 'From Research' }));
    }
    setTaskDraft(null);
    setTasksAdded(picked.length);
    window.setTimeout(() => setTasksAdded(null), 2500);
  }, [taskDraft, upsert]);

  const hasDraft = input.trim().length > 0 || pendingImages.length > 0;
  // What the chips offer depends on what's there to act on: something you've pasted/attached,
  // the last answer, or nothing yet.
  const chipMode: 'act' | 'follow' | 'start' = hasDraft ? 'act' : messages.length ? 'follow' : 'start';
  const chips = chipMode === 'act' ? ACT_PROMPTS : chipMode === 'follow' ? FOLLOW_UP_PROMPTS : STARTER_PROMPTS;
  const applyChip = useCallback((prompt: string, mode: 'act' | 'follow' | 'start') => {
    setInput(prev => (mode === 'act' && prev.trim() ? `${prev}\n${prompt}` : prompt));
    textareaRef.current?.focus();
  }, []);

  const onAttachClick = useCallback(() => fileInputRef.current?.click(), []);

  /** Downscales + queues an image as a pending attachment, ready to send with the next message. */
  const addImageFile = useCallback(async (file: File | Blob) => {
    try {
      const attachment = await fileToCompressedAttachment(file);
      setPendingImages(prev =>
        prev.length >= MAX_IMAGES_PER_MESSAGE ? prev : [...prev, attachment]
      );
    } catch {
      /* unreadable image — silently skip rather than block the whole paste/drop */
    }
  }, []);

  const removePendingImage = useCallback((index: number) => {
    setPendingImages(prev => prev.filter((_, i) => i !== index));
  }, []);

  const onFileSelected = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-attaching the same file later
    if (!file) return;
    if (file.type.startsWith('image/')) {
      void addImageFile(file);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result ?? '');
      const cut = raw.length > ATTACH_MAX_CHARS;
      const truncated = cut
        ? `${raw.slice(0, ATTACH_MAX_CHARS)}\n…(truncated, ${raw.length - ATTACH_MAX_CHARS} more characters)`
        : raw;
      const block = `Attached file: ${file.name}\n---\n${truncated}\n---\n\n`;
      setInput(prev => `${block}${prev}`);
      // Say so clearly: the assistant will only see the first part of a long file.
      setAttachNote(cut
        ? `Only the first ${ATTACH_MAX_CHARS.toLocaleString()} of ${raw.length.toLocaleString()} characters of “${file.name}” were included (about ${Math.round((ATTACH_MAX_CHARS / raw.length) * 100)}%). The assistant won’t see the rest.`
        : null);
      textareaRef.current?.focus();
    };
    reader.readAsText(file);
  }, [addImageFile]);

  /** Lets you paste a screenshot straight from the clipboard — text pastes through untouched. */
  const onPaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles = Array.from(items)
      .filter(item => item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (!imageFiles.length) return;
    e.preventDefault();
    imageFiles.forEach(file => void addImageFile(file));
  }, [addImageFile]);

  const toggleVoice = useCallback(() => {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.continuous = false;
    recognition.interimResults = true;
    // Whatever language the browser is set to, not always US English.
    recognition.lang = navigator.language || 'en-US';
    recognition.onresult = event => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      setInput(prev => (prev ? `${prev} ${transcript}` : transcript));
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }, [listening]);

  /** Enter sends; Shift+Enter inserts a newline. */
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
    if (e.key === 'Escape' && editingMsgId) cancelEdit();
  };

  const cloudUnconfigured = engine === 'cloud' && !cloudReady;
  const localDown = engine === 'local' && localReady === false;
  const statusColor = isStreaming ? C.amber : cloudUnconfigured || localDown ? C.danger : C.success;
  const statusLabel = isStreaming ? 'Thinking…'
    : cloudUnconfigured ? 'Needs API key'
    : localDown ? 'Local engine not running'
    : engine === 'local' && localReady === null ? 'Checking…'
    : 'Ready';
  const activeChat = chatId ? chats.find(c => c.id === chatId) : undefined;
  const chatNoteLinked = Boolean(activeChat?.noteId && data.notes.some(n => n.id === activeChat.noteId));

  // The chat list: searchable, grouped by when each chat was last used.
  const searchTerm = chatSearch.trim().toLowerCase();
  const shownChats = searchTerm
    ? chats.filter(c => c.title.toLowerCase().includes(searchTerm) || c.messages.some(m => m.content.toLowerCase().includes(searchTerm)))
    : chats;
  const groupOf = (iso: string): string => {
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
    const sameDay = new Date(iso).toDateString() === new Date().toDateString();
    return sameDay ? 'Today' : days < 7 ? 'This week' : 'Earlier';
  };

  const chatList = (
    <>
      <button type="button" style={S.newChatBtn} onClick={newChat}><Plus size={14} /> New chat</button>
      {chats.length > 5 && (
        <label style={S.chatSearch}>
          <Search size={12} />
          <input style={S.chatSearchInput} value={chatSearch} onChange={e => setChatSearch(e.target.value)} placeholder="Search chats…" aria-label="Search chats" />
        </label>
      )}
      <div style={S.chatList}>
        {shownChats.map((c, i) => {
          const group = groupOf(c.updatedAt ?? c.createdAt);
          const showGroup = !searchTerm && chats.length > 5 && (i === 0 || groupOf(shownChats[i - 1].updatedAt ?? shownChats[i - 1].createdAt) !== group);
          const questions = c.messages.filter(m => m.role === 'user').length;
          return (
            <Fragment key={c.id}>
              {showGroup && <div style={S.chatGroup}>{group}</div>}
              <div style={{ ...S.chatRow, ...(c.id === chatId ? S.chatRowActive : {}) }}>
                {renamingId === c.id ? (
                  <input
                    style={S.chatRename}
                    value={renameDraft}
                    autoFocus
                    onChange={e => setRenameDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenamingId(null); }}
                    aria-label="Chat name"
                  />
                ) : (
                  <button type="button" style={S.chatRowBtn} onClick={() => openChat(c.id)} onDoubleClick={() => { setRenamingId(c.id); setRenameDraft(c.title); }} title={`${c.title}\nDouble-click to rename`}>
                    <span style={S.chatRowTitle}>{c.title || 'Untitled chat'}</span>
                    <span style={S.chatRowMeta}>{shortDate(c.updatedAt ?? c.createdAt)} · {questions} question{questions === 1 ? '' : 's'}</span>
                  </button>
                )}
                <button type="button" style={S.chatRowDelete} onClick={() => { setRenamingId(c.id); setRenameDraft(c.title); }} title="Rename" aria-label={`Rename chat: ${c.title}`}>
                  <Pencil size={12} />
                </button>
                <button type="button" style={S.chatRowDelete} onClick={() => deleteChat(c.id)} title="Delete chat (Undo brings it back)" aria-label={`Delete chat: ${c.title}`}>
                  <Trash2 size={12} />
                </button>
              </div>
            </Fragment>
          );
        })}
        {!chats.length && <p style={S.chatListEmpty}>Your chats are saved here.</p>}
        {chats.length > 0 && !shownChats.length && <p style={S.chatListEmpty}>No chats match “{chatSearch}”.</p>}
      </div>
    </>
  );

  return (
    <div style={{ ...st('shell'), flexDirection: 'row', height: isMobile ? 'calc(100dvh - 144px - env(safe-area-inset-bottom))' : height, minHeight: isMobile ? 360 : 460 }}>
      {/* Blink keyframes for the streaming caret + formatting for answers — scoped by unique names. */}
      <style>{RESEARCH_CSS}</style>

      {!isMobile && <aside style={S.side}>{chatList}</aside>}

      <div style={S.main}>
        {/* ---- header: chat name + status ---- */}
        <div style={S.header}>
          <div style={S.headerLeft}>
            {isMobile && (
              <button type="button" style={S.headerBtn} onClick={() => setShowChats(s => !s)} aria-label="Chats" title="Chats" aria-expanded={showChats}>
                <MessagesSquare size={15} />
              </button>
            )}
            <div style={S.headerTitle} title={activeChat?.title}>{activeChat?.title || (messages.length ? 'New chat' : title)}</div>
          </div>
          <div style={S.headerRight}>
            {messages.some(m => m.role === 'assistant' && !m.isError && m.content) && !isStreaming && (
              <button type="button" style={S.headerBtn} onClick={saveChatToNote} title={chatNoteLinked ? 'Update this chat’s note in Second Brain' : 'Save this whole chat to Second Brain'} aria-label={chatNoteLinked ? 'Update this chat’s note in Second Brain' : 'Save this whole chat to Second Brain'}>
                {savedId === 'chat' ? <Check size={14} color={C.success} /> : <NotebookPen size={14} />}
                {!isMobile && <span>{savedId === 'chat' ? 'Saved' : chatNoteLinked ? 'Update note' : 'Save chat'}</span>}
              </button>
            )}
            <div style={S.statusPill}>
              <span style={{ ...S.statusDot, background: statusColor }} />
              {statusLabel}
            </div>
          </div>
        </div>

        {isMobile && showChats && <div style={S.mobileChats}>{chatList}</div>}

        {/* ---- centered message column ---- */}
        <div style={S.streamOuter} ref={streamRef} onScroll={handleScroll} onClick={onStreamClick}>
          <div style={S.streamInner}>
            {messages.length === 0 ? (
              <p style={S.empty}>
                Ask anything to start researching.
                {!isMobile && <>
                  <br />
                  <span style={{ color: C.faint, fontSize: 12 }}>
                    Enter sends · Shift+Enter for a new line
                  </span>
                </>}
              </p>
            ) : (
              messages.map(m => {
                const isUser = m.role === 'user';
                const bubbleTone = m.isError ? S.bubbleError : isUser ? S.bubbleUser : S.bubbleBot;
                // The trailing empty reply is the one currently streaming.
                const isPending = !isUser && !m.content && isStreaming;
                const justCopied = copiedId === m.id;
                const formatted = !isUser && !m.isError;
                const listItems = formatted && !isStreaming ? listItemsOf(m.content) : [];
                return (
                  <div key={m.id} style={{ ...S.row, justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
                    <div style={{ ...S.messageBlock, alignItems: isUser ? 'flex-end' : 'flex-start' }}>
                      <div style={{ ...S.bubble, ...bubbleTone, ...(formatted ? { whiteSpace: 'normal' } : {}), ...(m.id === editingMsgId ? S.bubbleEditing : {}) }}>
                        {Boolean(m.images?.length) && (
                          <div style={S.bubbleImages}>
                            {(m.images ?? []).map((img, i) => (
                              <img key={i} src={img.dataUrl} alt="Attached reference" style={S.bubbleImage} />
                            ))}
                          </div>
                        )}
                        {formatted
                          ? <div className="research-md" dangerouslySetInnerHTML={{ __html: markdownToHtml(m.content, { copyButtons: true }) }} />
                          : m.content}
                        {isPending && <span style={S.caret} />}
                      </div>
                      {isUser && !isStreaming && (
                        <div style={S.actionsRow}>
                          <button type="button" style={S.actionBtn} onClick={() => startEdit(m)} title="Edit and resend" aria-label="Edit this question and resend">
                            <Pencil size={12} />
                          </button>
                        </div>
                      )}
                      {Boolean(m.sources?.length) && (
                        <div style={S.sources}>
                          <span style={S.sourcesLabel}>Sources</span>
                          {(m.sources ?? []).map((s, i) => (
                            <a key={s.uri} href={s.uri} target="_blank" rel="noreferrer noopener" style={S.sourceLink} title={s.uri}>{i + 1}. {s.title || hostOf(s.uri)}</a>
                          ))}
                        </div>
                      )}
                      {!isUser && !isPending && m.content && !m.isError && (
                        <div style={S.actionsRow}>
                          <button
                            type="button"
                            style={S.actionBtn}
                            onClick={() => copyMessage(m)}
                            title={justCopied ? 'Copied' : 'Copy'}
                            aria-label="Copy response"
                          >
                            {justCopied ? <Check size={13} color={C.success} /> : <Copy size={13} />}
                          </button>
                          <button
                            type="button"
                            style={S.actionBtn}
                            onClick={() => saveAnswerToNote(m)}
                            title={savedId === m.id ? 'Saved to Second Brain' : m.savedNoteId ? 'Update the saved note' : 'Save to Second Brain'}
                            aria-label={m.savedNoteId ? 'Update the saved note in Second Brain' : 'Save this answer to Second Brain'}
                          >
                            {savedId === m.id ? <Check size={13} color={C.success} /> : <NotebookPen size={13} />}
                          </button>
                          {listItems.length >= 2 && (
                            <button
                              type="button"
                              style={S.actionBtn}
                              onClick={() => setTaskDraft(listItems.map(text => ({ text, on: true })))}
                              title="Add the list in this answer to Tasks"
                              aria-label="Add the list in this answer to Tasks"
                            >
                              <ListChecks size={13} />
                            </button>
                          )}
                          <button
                            type="button"
                            style={{ ...S.actionBtn, color: retryMenuFor === m.id ? C.text : C.faint }}
                            onClick={() => setRetryMenuFor(prev => (prev === m.id ? null : m.id))}
                            disabled={isStreaming}
                            title="Try again…"
                            aria-label="Try again"
                            aria-expanded={retryMenuFor === m.id}
                          >
                            <RotateCcw size={13} />
                          </button>
                          {retryMenuFor === m.id && RETRY_OPTIONS.map(o => (
                            <button key={o.label} type="button" style={S.retryChip} onClick={() => void regenerate(m.id, o.instruction)}>{o.label}</button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {cloudUnconfigured && (
          <div style={S.notice}>
            {GEMINI_ORIGIN
              ? 'The Gemini proxy isn’t configured — set the GEMINI_API_KEY secret on the Cloudflare Worker (see cloudflare/gemini-proxy/).'
              : <>No Gemini API key detected. Add <code>VITE_GEMINI_API_KEY=…</code> to <code>.env.local</code> and restart the dev server.</>}
          </div>
        )}

        {localDown && (
          <div style={S.noticeWarn}>
            <b>The local engine isn’t running here.</b> To use it: open the Ollama app on this computer
            (install it from ollama.com if you haven’t), then press Check again. It can’t run on the
            hosted site or a phone.{' '}
            <button type="button" style={S.noticeBtn} onClick={checkLocal}>Check again</button>
            {cloudReady && <button type="button" style={S.noticeBtn} onClick={() => setEngine('cloud')}>Switch to Cloud</button>}
          </div>
        )}

        {engine === 'local' && localReady && localModels.length === 0 && (
          <div style={S.noticeWarn}>
            Ollama is running but has no models yet. In a terminal, run <code>ollama pull llama3</code>, then press{' '}
            <button type="button" style={S.noticeBtn} onClick={checkLocal}>Check again</button>
          </div>
        )}

        {engine === 'local' && pendingImages.length > 0 && (
          <div style={S.noticeWarn}>
            The local model (<code>{localModel}</code>) may not understand images unless it's a
            vision model (e.g. <code>llava</code>). Switch to Cloud for reliable image understanding.
          </div>
        )}

        {attachNote && (
          <div style={S.noticeWarn}>
            {attachNote}{' '}
            <button type="button" style={S.noticeBtn} onClick={() => setAttachNote(null)}>OK</button>
          </div>
        )}

        {tasksAdded != null && (
          <div style={S.noticeOk}>{tasksAdded} task{tasksAdded === 1 ? '' : 's'} added to your Tasks, due today.</div>
        )}

        {/* ---- floating input dock ---- */}
        <div style={st('dockOuter')}>
          <div style={S.dockInner}>
            {editingMsgId ? (
              <div style={S.editingBar}>
                <Pencil size={12} /> Editing an earlier question — sending replaces it and the answers after it.
                <button type="button" style={S.noticeBtn} onClick={cancelEdit}>Cancel</button>
              </div>
            ) : (!isMobile || messages.length === 0 || hasDraft) && <div style={st('chipsRow')}>
              {chips.map(prompt => (
                <button key={prompt} type="button" style={st('chip')} onClick={() => applyChip(prompt, chipMode)}>
                  {prompt.trim()}
                </button>
              ))}
            </div>}

            {pendingImages.length > 0 && (
              <div style={S.pendingTray}>
                {pendingImages.map((img, i) => (
                  <div key={i} style={S.pendingThumbWrap}>
                    <img src={img.dataUrl} alt="Pending attachment" style={S.pendingThumb} />
                    <button
                      type="button"
                      style={S.pendingRemove}
                      onClick={() => removePendingImage(i)}
                      title="Remove image"
                      aria-label="Remove image"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div style={st('pill')}>
              <select
                style={st('pillEngineSelect')}
                value={engine}
                disabled={isStreaming}
                onChange={e => setEngine(e.target.value as Engine)}
                aria-label="Choose AI engine"
                title={ENGINES[engine].label}
              >
                <option value="local">Local</option>
                <option value="cloud">Cloud</option>
              </select>
              {engine === 'local' ? <Cpu size={14} color={C.faint} /> : <Cloud size={14} color={C.faint} />}

              <input ref={fileInputRef} type="file" accept=".txt,.md,.csv,.json,.log,image/*" hidden onChange={onFileSelected} />
              <button type="button" style={st('pillIconBtn')} onClick={onAttachClick} title="Attach a text file or image" aria-label="Attach a text file or image">
                <Paperclip size={16} />
              </button>

              {voiceSupported && (
                <button
                  type="button"
                  style={{ ...st('pillIconBtn'), color: listening ? C.danger : C.dim }}
                  onClick={toggleVoice}
                  title={listening ? 'Stop voice input' : 'Voice input'}
                  aria-label={listening ? 'Stop voice input' : 'Start voice input'}
                >
                  {listening ? <MicOff size={16} /> : <Mic size={16} />}
                </button>
              )}

              <textarea
                ref={textareaRef}
                style={st('pillTextarea')}
                rows={1}
                value={input}
                placeholder={isStreaming ? 'Generating…' : 'Ask a research question, or paste an image…'}
                onChange={e => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
              />

              {isStreaming ? (
                <button type="button" style={{ ...st('pillSend'), background: C.raised2, color: C.text }} onClick={stop} title="Stop" aria-label="Stop generating">
                  <Square size={13} fill="currentColor" />
                </button>
              ) : (
                <button
                  type="button"
                  style={{ ...st('pillSend'), opacity: input.trim() || pendingImages.length ? 1 : 0.4 }}
                  onClick={() => void send()}
                  disabled={!input.trim() && !pendingImages.length}
                  title="Send"
                  aria-label="Send"
                >
                  <Send size={15} />
                </button>
              )}
            </div>

            {/* Where this message goes — always visible, so the mode is never a surprise. */}
            <div style={st('footerRow')}>
              {engine === 'local' ? (
                <span style={S.privacyLine}>
                  <Cpu size={12} /> Local · stays on this computer
                  {localModels.length > 1 && (
                    <select style={S.modelSelect} value={localModel} onChange={e => setLocalModel(e.target.value)} disabled={isStreaming} aria-label="Local model" title="Which Ollama model answers">
                      {localModels.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                  )}
                  <label style={S.includeData} title="Adds a summary of your data to the question. Only available in Local mode — never sent to Google.">
                    <input type="checkbox" checked={includeData} onChange={e => setIncludeData(e.target.checked)} />
                    Include my Life OS data
                  </label>
                  <button type="button" style={S.linkBtn} onClick={() => setShowDataPicker(true)}>See what’s included</button>
                </span>
              ) : (
                <span />
              )}
              <span style={S.footerActions}>
                {isMobile && messages.length > 0 && (
                  <button type="button" style={st('clearBtn')} onClick={newChat}><Plus size={12} /> New</button>
                )}
                {chatId && (
                  <button type="button" style={st('clearBtn')} onClick={() => deleteChat(chatId)} title="Delete this chat (Undo brings it back)">
                    <Trash2 size={12} /> Delete chat
                  </button>
                )}
              </span>
            </div>
          </div>
        </div>
      </div>

      {showDataPicker && (
        <Modal
          eyebrow="Research · Local mode only"
          title="What the local assistant can see"
          onClose={() => setShowDataPicker(false)}
          footer={<button type="button" className="btn primary" onClick={() => setShowDataPicker(false)}>Done</button>}
        >
          <p className="muted" style={{ margin: '0 0 12px', fontSize: 13 }}>
            When “Include my Life OS data” is on, exactly the text below is added to your question —
            for the local engine on this computer only. It is never sent to Google.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px', marginBottom: 12 }}>
            {CONTEXT_AREAS.map(a => (
              <label key={a.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={dataAreas.includes(a.key)}
                  onChange={e => setDataAreas(prev => (e.target.checked ? CONTEXT_AREAS.map(x => x.key).filter(k => k === a.key || prev.includes(k)) : prev.filter(k => k !== a.key)))}
                />
                {a.label}
              </label>
            ))}
          </div>
          <pre className="research-data-preview">{dataAreas.length ? buildLifeOsContext(data, dataAreas) : 'Nothing selected — no data would be included.'}</pre>
        </Modal>
      )}

      {taskDraft && (
        <Modal
          eyebrow="Research"
          title="Add to Tasks"
          onClose={() => setTaskDraft(null)}
          footer={<>
            <button type="button" className="btn ghost" onClick={() => setTaskDraft(null)}>Cancel</button>
            <button type="button" className="btn primary" onClick={addTasks} disabled={!taskDraft.some(t => t.on && t.text.trim())}>
              Add {taskDraft.filter(t => t.on && t.text.trim()).length} task{taskDraft.filter(t => t.on && t.text.trim()).length === 1 ? '' : 's'}
            </button>
          </>}
        >
          <p className="muted" style={{ margin: '0 0 12px', fontSize: 13 }}>Untick anything you don’t want, and edit the wording. They’re added as tasks due today.</p>
          <div style={{ display: 'grid', gap: 8 }}>
            {taskDraft.map((t, i) => (
              <label key={i} className="research-task-row">
                <input type="checkbox" checked={t.on} onChange={e => setTaskDraft(prev => prev && prev.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} />
                <input type="text" value={t.text} onChange={e => setTaskDraft(prev => prev && prev.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} aria-label={`Task ${i + 1}`} />
              </label>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
