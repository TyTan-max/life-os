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

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, ClipboardEvent, CSSProperties, KeyboardEvent } from 'react';
import {
  Check, Cloud, Copy, Cpu, Mic, MicOff, Paperclip, RotateCcw,
  Send, Square, ThumbsDown, ThumbsUp, Trash2, X
} from 'lucide-react';
import { checkCloudConfigured, ENGINE_STORAGE_KEY, GEMINI_API_KEY, GEMINI_MODEL, GEMINI_ORIGIN, OLLAMA_BASE_URL, OLLAMA_MODEL } from '../lib/aiEngine';
import type { Engine as SharedEngine } from '../lib/aiEngine';

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
  'Prefer specific, actionable answers over hedging. Use markdown-free plain text ' +
  'with short paragraphs. If you are unsure about a fact, say so plainly.';

/** localStorage keys — namespaced to match the rest of the app. */
const STORAGE_MESSAGES = 'life-os-research-chat-v1';
const STORAGE_ENGINE = ENGINE_STORAGE_KEY;

/** Max pixel height the input grows to before it starts scrolling internally. */
const TEXTAREA_MAX_HEIGHT = 160;

/** Max characters pulled in from an attached text file, to stay prompt-sized. */
const ATTACH_MAX_CHARS = 6000;

/** Pasted/attached images are downscaled + re-encoded to JPEG so they don't blow past localStorage's size limits. */
const IMAGE_MAX_DIM = 1400;
const IMAGE_QUALITY = 0.8;
/** Keep a single turn's payload sane — both engines slow down a lot past a handful of images. */
const MAX_IMAGES_PER_MESSAGE = 4;

/** One-tap conversation starters shown above the input dock. */
const QUICK_PROMPTS = ['Summarize this', "Explain like I'm five", 'Give me key takeaways', 'Fact-check this claim'];

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

/** One turn in the conversation. */
export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  /** Set when the turn failed, so it can be styled as an error instead of a reply. */
  isError?: boolean;
  /** Lightweight local reaction — never sent anywhere, just remembered. */
  feedback?: 'up' | 'down';
  /** Reference images attached to a user turn — sent to vision-capable models. */
  images?: Attachment[];
}

export interface ResearchChatProps {
  /** Optional heading override. */
  title?: string;
  /** Optional CSS height for the panel (default: 'min(78vh, 800px)'). */
  height?: string;
}

/** Signature every engine adapter conforms to. */
type StreamFn = (
  history: ChatMessage[],
  onDelta: (text: string) => void,
  signal: AbortSignal
) => Promise<void>;

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

/** Strips the `data:image/jpeg;base64,` prefix — engines want the raw base64 payload. */
function base64Of(attachment: Attachment): string {
  const comma = attachment.dataUrl.indexOf(',');
  return comma === -1 ? attachment.dataUrl : attachment.dataUrl.slice(comma + 1);
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

/** Local Ollama. Streams newline-delimited JSON objects. */
const streamOllama: StreamFn = async (history, onDelta, signal) => {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: true,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
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
};

/** Google Gemini. Streams server-sent events (`data: {...}`). */
const streamGemini: StreamFn = async (history, onDelta, signal) => {
  if (!GEMINI_ORIGIN && !GEMINI_API_KEY) {
    throw new Error(
      'No Gemini API key found. Add VITE_GEMINI_API_KEY to .env.local and restart the dev server.'
    );
  }

  const base = GEMINI_ORIGIN ? `${GEMINI_ORIGIN}/gemini` : 'https://generativelanguage.googleapis.com/v1beta';
  const keyQuery = GEMINI_ORIGIN ? '' : `&key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const url = `${base}/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse${keyQuery}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      // Gemini names the assistant role 'model', so map ours across. Images ride
      // alongside the text as inlineData parts — order doesn't matter to the API.
      contents: history.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [
          ...(m.content ? [{ text: m.content }] : []),
          ...(m.images ?? []).map(img => ({ inlineData: { mimeType: img.mimeType, data: base64Of(img) } }))
        ]
      }))
    })
  });

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
  }
};

const ENGINES: Record<Engine, { label: string; shortLabel: string; stream: StreamFn; model: string }> = {
  local: { label: 'Local Engine (offline)', shortLabel: 'Local', stream: streamOllama, model: OLLAMA_MODEL },
  cloud: { label: 'Google Cloud (Gemini)', shortLabel: 'Cloud', stream: streamGemini, model: GEMINI_MODEL }
};

/* ============================================================================
 * 5. STYLES — plain objects, no dependencies, tweak the palette in one place.
 * ========================================================================== */

const C = {
  base: '#121212',
  panel: '#1e1e1e',
  raised: '#252525',
  raised2: '#2a2a2a',
  border: '#2e2e2e',
  text: '#f2f2f3',
  dim: '#9a9aa2',
  faint: '#6a6a72',
  accent: '#5b8cff',
  danger: '#ff6b6b',
  success: '#3ecf8e',
  amber: '#f0b429'
} as const;

const COLUMN_MAX_WIDTH = 760;

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
  headerTitle: { fontSize: 14, fontWeight: 650, letterSpacing: '-0.01em' },
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
    boxShadow: '0 6px 20px rgba(0,0,0,0.25)'
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

/* ============================================================================
 * 6. COMPONENT
 * ========================================================================== */

export function ResearchChat({
  title = 'Research Assistant',
  height = 'min(78vh, 800px)'
}: ResearchChatProps) {
  /* --- state, rehydrated from localStorage on first render --------------- */
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_MESSAGES);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as ChatMessage[]) : [];
    } catch {
      return [];
    }
  });

  const [engine, setEngine] = useState<Engine>(() => {
    const saved = window.localStorage.getItem(STORAGE_ENGINE);
    return saved === 'cloud' || saved === 'local' ? saved : 'local';
  });

  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [voiceSupported] = useState(() => getSpeechRecognitionCtor() !== null);
  const [pendingImages, setPendingImages] = useState<Attachment[]>([]);
  const [cloudReady, setCloudReady] = useState(true);
  useEffect(() => { void checkCloudConfigured().then(setCloudReady); }, []);

  const streamRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  /** False while the user has scrolled up to read — keeps streaming from yanking them back. */
  const pinnedRef = useRef(true);

  /* --- persistence -------------------------------------------------------- */
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_MESSAGES, JSON.stringify(messages));
    } catch {
      /* quota exceeded / storage disabled — non-fatal */
    }
  }, [messages]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_ENGINE, engine);
  }, [engine]);

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

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
  }, []);

  const clearChat = useCallback(() => {
    stop();
    setMessages([]);
    window.localStorage.removeItem(STORAGE_MESSAGES);
  }, [stop]);

  /** Streams a reply for the given history and appends it to the conversation. */
  const runTurn = useCallback(async (history: ChatMessage[]) => {
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

    try {
      await ENGINES[engine].stream(history, onDelta, controller.signal);
    } catch (err) {
      // A user-triggered abort isn't an error — keep whatever streamed in.
      const aborted = err instanceof DOMException && err.name === 'AbortError';
      if (!aborted) {
        const detail =
          err instanceof Error ? err.message : 'Unknown error contacting the model.';
        const hint =
          engine === 'local'
            ? ' — is Ollama running? Try `ollama serve`, and confirm the model is pulled.'
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
    }
  }, [engine]);

  const send = useCallback(async () => {
    const text = input.trim();
    if ((!text && !pendingImages.length) || isStreaming) return;
    const userMsg: ChatMessage = {
      id: createId(),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
      images: pendingImages.length ? pendingImages : undefined
    };
    setInput('');
    setPendingImages([]);
    await runTurn([...messages, userMsg]);
  }, [input, isStreaming, messages, pendingImages, runTurn]);

  /** Re-runs the exchange from the user turn a given assistant reply answers, discarding it and anything after. */
  const regenerate = useCallback(async (assistantId: string) => {
    if (isStreaming) return;
    const idx = messages.findIndex(m => m.id === assistantId);
    if (idx === -1) return;
    let userIdx = idx - 1;
    while (userIdx >= 0 && messages[userIdx].role !== 'user') userIdx--;
    if (userIdx < 0) return;
    await runTurn(messages.slice(0, userIdx + 1));
  }, [isStreaming, messages, runTurn]);

  const copyMessage = useCallback((m: ChatMessage) => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(m.content).then(() => {
      setCopiedId(m.id);
      window.setTimeout(() => setCopiedId(prev => (prev === m.id ? null : prev)), 1500);
    }).catch(() => { /* clipboard permission denied — silently ignore */ });
  }, []);

  const toggleFeedback = useCallback((id: string, value: 'up' | 'down') => {
    setMessages(prev =>
      prev.map(m => (m.id === id ? { ...m, feedback: m.feedback === value ? undefined : value } : m))
    );
  }, []);

  const applyChip = useCallback((prompt: string) => {
    setInput(prev => (prev.trim() ? `${prev}\n${prompt}` : prompt));
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
      const truncated = raw.length > ATTACH_MAX_CHARS
        ? `${raw.slice(0, ATTACH_MAX_CHARS)}\n…(truncated, ${raw.length - ATTACH_MAX_CHARS} more characters)`
        : raw;
      const block = `Attached file: ${file.name}\n---\n${truncated}\n---\n\n`;
      setInput(prev => `${block}${prev}`);
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
    recognition.lang = 'en-US';
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
  };

  const cloudUnconfigured = engine === 'cloud' && !cloudReady;
  const statusColor = isStreaming ? C.amber : cloudUnconfigured ? C.danger : C.success;
  const statusLabel = isStreaming ? 'Thinking…' : cloudUnconfigured ? 'Needs API key' : 'Ready';

  return (
    <div style={{ ...S.shell, height }}>
      {/* Blink keyframes for the streaming caret — scoped by a unique name. */}
      <style>{'@keyframes lifeosBlink { 0%,100% { opacity: 1 } 50% { opacity: 0 } }'}</style>

      {/* ---- header: name + status only ---- */}
      <div style={S.header}>
        <div style={S.headerTitle}>{title}</div>
        <div style={S.statusPill}>
          <span style={{ ...S.statusDot, background: statusColor }} />
          {statusLabel}
        </div>
      </div>

      {/* ---- centered message column ---- */}
      <div style={S.streamOuter} ref={streamRef} onScroll={handleScroll}>
        <div style={S.streamInner}>
          {messages.length === 0 ? (
            <p style={S.empty}>
              Ask anything to start researching.
              <br />
              <span style={{ color: C.faint, fontSize: 12 }}>
                Enter sends · Shift+Enter for a new line
              </span>
            </p>
          ) : (
            messages.map(m => {
              const isUser = m.role === 'user';
              const bubbleTone = m.isError ? S.bubbleError : isUser ? S.bubbleUser : S.bubbleBot;
              // The trailing empty reply is the one currently streaming.
              const isPending = !isUser && !m.content && isStreaming;
              const justCopied = copiedId === m.id;
              return (
                <div key={m.id} style={{ ...S.row, justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
                  <div style={{ ...S.messageBlock, alignItems: isUser ? 'flex-end' : 'flex-start' }}>
                    <div style={{ ...S.bubble, ...bubbleTone }}>
                      {Boolean(m.images?.length) && (
                        <div style={S.bubbleImages}>
                          {(m.images ?? []).map((img, i) => (
                            <img key={i} src={img.dataUrl} alt="Attached reference" style={S.bubbleImage} />
                          ))}
                        </div>
                      )}
                      {m.content}
                      {isPending && <span style={S.caret} />}
                    </div>
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
                          style={{ ...S.actionBtn, color: m.feedback === 'up' ? C.success : C.faint }}
                          onClick={() => toggleFeedback(m.id, 'up')}
                          title="Good response"
                          aria-label="Mark as good response"
                        >
                          <ThumbsUp size={13} />
                        </button>
                        <button
                          type="button"
                          style={{ ...S.actionBtn, color: m.feedback === 'down' ? C.danger : C.faint }}
                          onClick={() => toggleFeedback(m.id, 'down')}
                          title="Bad response"
                          aria-label="Mark as bad response"
                        >
                          <ThumbsDown size={13} />
                        </button>
                        <button
                          type="button"
                          style={S.actionBtn}
                          onClick={() => void regenerate(m.id)}
                          disabled={isStreaming}
                          title="Regenerate"
                          aria-label="Regenerate response"
                        >
                          <RotateCcw size={13} />
                        </button>
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

      {engine === 'local' && pendingImages.length > 0 && (
        <div style={S.noticeWarn}>
          The local model (<code>{OLLAMA_MODEL}</code>) may not understand images unless it's a
          vision model (e.g. <code>llava</code>). Switch to Cloud for reliable image understanding,
          or change <code>OLLAMA_MODEL</code> in the config.
        </div>
      )}

      {/* ---- floating input dock ---- */}
      <div style={S.dockOuter}>
        <div style={S.dockInner}>
          <div style={S.chipsRow}>
            {QUICK_PROMPTS.map(prompt => (
              <button key={prompt} type="button" style={S.chip} onClick={() => applyChip(prompt)}>
                {prompt}
              </button>
            ))}
          </div>

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

          <div style={S.pill}>
            <select
              style={S.pillEngineSelect}
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
            <button type="button" style={S.pillIconBtn} onClick={onAttachClick} title="Attach a text file or image" aria-label="Attach a text file or image">
              <Paperclip size={16} />
            </button>

            {voiceSupported && (
              <button
                type="button"
                style={{ ...S.pillIconBtn, color: listening ? C.danger : C.dim }}
                onClick={toggleVoice}
                title={listening ? 'Stop voice input' : 'Voice input'}
                aria-label={listening ? 'Stop voice input' : 'Start voice input'}
              >
                {listening ? <MicOff size={16} /> : <Mic size={16} />}
              </button>
            )}

            <textarea
              ref={textareaRef}
              style={S.pillTextarea}
              rows={1}
              value={input}
              placeholder={isStreaming ? 'Generating…' : 'Ask a research question, or paste an image…'}
              onChange={e => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
            />

            {isStreaming ? (
              <button type="button" style={{ ...S.pillSend, background: C.raised2, color: C.text }} onClick={stop} title="Stop" aria-label="Stop generating">
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                style={{ ...S.pillSend, opacity: input.trim() || pendingImages.length ? 1 : 0.4 }}
                onClick={() => void send()}
                disabled={!input.trim() && !pendingImages.length}
                title="Send"
                aria-label="Send"
              >
                <Send size={15} />
              </button>
            )}
          </div>

          <div style={S.footerRow}>
            <span style={S.footerHint}>Enter to send · Shift+Enter for a new line</span>
            <button type="button" style={S.clearBtn} onClick={clearChat} disabled={!messages.length} title="Reset library history">
              <Trash2 size={12} /> Clear
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
