import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  Archive, Bell, Briefcase, Cake, CalendarCheck, CalendarDays, Camera, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, ChevronUp, CircleSlash, Clock, GraduationCap,
  GripVertical, Handshake, Home, IdCard, LayoutGrid, Link2, Mail, MapPin, Medal, MessageCircle, Pencil, Phone, Plus,
  Search, Send, SlidersHorizontal, Sparkles, Star, Table2, Tag as TagIcon, Trash2, Upload, UserPlus, Users, Wrench, X
} from 'lucide-react';
import { useStore, newRecord } from '../store';
import { Badge, Card, EmptyState, Kpi, Modal, PageHeader, formatDate } from '../components/UI';
import { DatePicker } from '../components/DatePicker';
import { RichTextEditor, isEmptyHtml } from '../components/RichTextEditor';
import { MobileRecordList } from '../components/MobileRecordList';
import { SwipeRow } from '../components/SwipeRow';
import { Sheet } from '../components/Sheet';
import { useIsMobile, MOBILE_QUERY } from '../hooks/useIsMobile';
import { useFabAction } from '../hooks/useFabAction';
import { ListManagerModal } from '../components/ListManagerModal';
import { DetailPanel } from '../components/DetailPanel';
import { useContextMenu } from '../components/ContextMenu';
import type { ContextMenuItem } from '../components/ContextMenu';
import type { ContactTier } from '../types';
import { SortableTh, toggleGridSort } from '../components/SortableTh';
import type { GridSortState } from '../components/SortableTh';
import type { Contact, ContactInteraction, ContactCategory, InteractionType } from '../types';
import { CONTACT_CATEGORIES, INTERACTION_TYPES } from '../types';
import {
  lastContactedDate, contactStatus, daysBetween, daysUntilNextBirthday, ageFromBirthYear,
  STATUS_PRIORITY, STATUS_BADGE_TONE, nextReachOutDate, remindersOn, REACH_OUT_DEFAULT_CATEGORIES
} from '../lib/crmCadence';
import type { ContactStatus } from '../lib/crmCadence';

function localIso(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_LABELS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function blankContact(): Partial<Contact> {
  return { name: '', tier: 'Close' };
}

function composeLocation(c: Partial<Contact>): string {
  return [c.address, c.city, c.region].filter(Boolean).join(', ');
}

// Freeform "Street, City, Region" entry, comma-delimited from the right: the last segment is
// always the region, the one before it the city, anything left over the street address.
function parseLocation(input: string): { address?: string; city?: string; region?: string } {
  const parts = input.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return { address: undefined, city: undefined, region: undefined };
  if (parts.length === 1) return { address: undefined, city: parts[0], region: undefined };
  if (parts.length === 2) return { address: undefined, city: parts[0], region: parts[1] };
  return { address: parts.slice(0, -2).join(', '), city: parts[parts.length - 2], region: parts[parts.length - 1] };
}

function formatBirthdayOnly(mmdd: string): string {
  const match = mmdd.match(/^(\d{2})-(\d{2})$/);
  if (!match) return mmdd;
  const [, mm, dd] = match;
  return `${MONTH_NAMES[Number(mm) - 1]} ${Number(dd)}`;
}

// ch-based (not field-sizing, for reliable cross-browser support) so the input — and with it
// the table column, since grid-table has no fixed layout — grows/shrinks with what's typed
// instead of always claiming a fixed column width.
function autosizeCh(value: string, placeholder: string, min = 10, max = 34): number {
  return Math.min(Math.max((value || placeholder).length + 1, min), max);
}

// Formats progressively as digits come in (not just on blur), so the field always reflects
// "(xxx) xxx-xxxx" shape while typing. A leading "+" (or an 11th digit starting with 1, i.e. a
// dialed US country code) keeps the extra digit as a "+1 " prefix instead of forcing it into the
// 10-digit shape; anything longer than that (a real international number) is left as-is — this
// formatter only targets the common US/Canada case, not full E.164 parsing.
function formatPhoneInput(raw: string): string {
  const hadPlus = raw.trim().startsWith('+');
  let digits = raw.replace(/\D/g, '');
  if (digits.length > 11) digits = digits.slice(0, 11);
  if (!hadPlus && digits.length === 11 && !digits.startsWith('1')) return raw;
  let prefix = '';
  if (hadPlus || digits.length === 11) {
    if (digits.startsWith('1')) digits = digits.slice(1);
    prefix = '+1 ';
  }
  const len = digits.length;
  if (len === 0) return hadPlus ? prefix.trim() : '';
  if (len < 4) return `${prefix}(${digits}`;
  if (len < 7) return `${prefix}(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `${prefix}(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function blankInteraction(contactId?: string): Partial<ContactInteraction> {
  return { contactId, type: 'Check-in', summary: '', date: localIso() };
}

// How often each tier comes due — shown wherever the tier can be picked.
const TIER_OPTIONS: { tier: ContactTier; label: string }[] = [
  { tier: 'Inner Circle', label: 'Inner Circle · every 2 weeks' },
  { tier: 'Close', label: 'Close · every 6 weeks' },
  { tier: 'Extended', label: 'Extended · every 4 months' }
];

type FeedFilter = 'All' | 'Gifts' | 'Life events';
const FEED_PREVIEW = 5;
// The timeline gets a search box once it's this long.
const FEED_SEARCH_MIN = 20;

// "3 check-ins, 1 gift" — the one-line summary on a folded month or year.
function feedSummary(items: ContactInteraction[]): string {
  const counts = new Map<InteractionType, number>();
  for (const i of items) counts.set(i.type, (counts.get(i.type) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${n} ${t === 'Other' ? 'other' : t.toLowerCase() + (n > 1 ? 's' : '')}`)
    .join(', ');
}

function monthLabel(ym: string): string {
  return new Date(`${ym}-15T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// Groups entries (newest first) into consecutive runs by a key.
function groupRuns<T>(items: T[], key: (item: T) => string): { key: string; items: T[] }[] {
  const out: { key: string; items: T[] }[] = [];
  for (const item of items) {
    const k = key(item);
    if (out.length && out[out.length - 1].key === k) out[out.length - 1].items.push(item);
    else out.push({ key: k, items: [item] });
  }
  return out;
}

// "Today" / "Yesterday" / "3 days ago" / "Sep 3".
function relativeDay(iso: string, todayIso: string): string {
  const days = daysBetween(iso, todayIso);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return `${days} days ago`;
  return formatDate(iso);
}

// Rich text → one plain line, for the collapsed timeline row.
function plainText(html: string): string {
  return html.replace(/<(br|\/p|\/li|\/h\d)[^>]*>/gi, ' ').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function notePreview(html?: string): string {
  const text = (html ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

// A real photo when one's been set, falling back to the colored-initials avatar otherwise —
// used everywhere a contact's avatar shows up (card, table row, detail header) so all three
// stay in sync with a single rendering rule. "card" reuses the card grid's own avatar class
// (a fixed white-on-color style, no size modifier) rather than crm-contact-avatar's small/large.
function ContactAvatar({ contact, size }: { contact: Pick<Contact, 'id' | 'name' | 'photoUrl'>; size: 'card' | 'small' | 'large' }) {
  const className = size === 'card' ? 'crm-card-avatar' : `crm-contact-avatar ${size}`;
  if (contact.photoUrl) {
    return <img className={className} src={contact.photoUrl} alt="" />;
  }
  return (
    <span className={`${className} initials`}>
      {initials(contact.name)}
    </span>
  );
}

// Downscaled + re-encoded to JPEG so a phone-camera photo (often several MB) doesn't sit around
// at full resolution — capped generously (well above the crop viewport below) since this is the
// working copy PhotoCropModal pans/zooms across, not the final small avatar it produces.
function fileToCompressedDataUrl(file: File, maxDim = 1600, quality = 0.9): Promise<string> {
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

const CROP_VIEWPORT = 260;
const CROP_OUTPUT = 480;

// A minimal pan/zoom cropper — no library, since this is the only place in the app that needs
// one. Always "covers" the square viewport (zoom 1 = the tightest fit, never smaller), so the
// output is always a fully-filled square with no letterboxing to reason about.
function PhotoCropModal({ src, onCancel, onSave }: { src: string; onCancel: () => void; onSave: (dataUrl: string) => void }) {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);

  useEffect(() => {
    setNatural(null);
    setLoadError(false);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    const img = new Image();
    img.onload = () => setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => setLoadError(true);
    img.src = src;
  }, [src]);

  const baseScale = natural ? CROP_VIEWPORT / Math.min(natural.w, natural.h) : 1;
  const dispW = (natural?.w ?? 0) * baseScale * zoom;
  const dispH = (natural?.h ?? 0) * baseScale * zoom;
  const minX = Math.min(0, CROP_VIEWPORT - dispW);
  const minY = Math.min(0, CROP_VIEWPORT - dispH);
  const clamp = (x: number, y: number) => ({ x: Math.min(0, Math.max(minX, x)), y: Math.min(0, Math.max(minY, y)) });

  // Re-clamp whenever zooming changes the bounds — panned to a corner at 1x, then zoomed out,
  // would otherwise leave a gap between the image edge and the viewport edge.
  useEffect(() => { setPan(p => clamp(p.x, p.y)); }, [zoom, natural]); // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerDown = (e: ReactPointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!dragRef.current) return;
    const { startX, startY, panX, panY } = dragRef.current;
    setPan(clamp(panX + (e.clientX - startX), panY + (e.clientY - startY)));
  };
  const endDrag = () => { dragRef.current = null; };

  const [exportError, setExportError] = useState<string | null>(null);
  const confirmCrop = () => {
    if (!natural) return;
    setExportError(null);
    const scaleFactor = CROP_OUTPUT / CROP_VIEWPORT;
    const canvas = document.createElement('canvas');
    canvas.width = CROP_OUTPUT;
    canvas.height = CROP_OUTPUT;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // A fresh Image (rather than reusing the on-screen <img>) with crossOrigin set — needed to
    // read pixel data back out via toDataURL at all for a remote URL. Data URLs (every uploaded
    // file) and same-origin images work regardless; a pasted external URL only works if that
    // host happens to send CORS headers, which not all do.
    const exportImg = new Image();
    exportImg.crossOrigin = 'anonymous';
    exportImg.onload = () => {
      try {
        ctx.drawImage(exportImg, pan.x * scaleFactor, pan.y * scaleFactor, dispW * scaleFactor, dispH * scaleFactor);
        onSave(canvas.toDataURL('image/jpeg', 0.88));
      } catch {
        setExportError("This photo can't be cropped because it's hosted on another site that doesn't allow it. Try uploading the file directly instead.");
      }
    };
    exportImg.onerror = () => {
      setExportError("This photo can't be cropped because it's hosted on another site that doesn't allow it. Try uploading the file directly instead.");
    };
    exportImg.src = src;
  };

  return (
    <Modal
      eyebrow="Personal CRM"
      title="Adjust photo"
      onClose={onCancel}
      footer={<>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn teal" onClick={confirmCrop} disabled={!natural}>Save</button>
      </>}
    >
      {loadError ? (
        <p className="muted">Couldn't load that photo to crop it.</p>
      ) : !natural ? (
        <p className="muted">Loading photo…</p>
      ) : (
        <>
          <div
            className="crm-crop-viewport"
            style={{ width: CROP_VIEWPORT, height: CROP_VIEWPORT }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <img src={src} alt="" draggable={false} style={{ left: pan.x, top: pan.y, width: dispW, height: dispH }} />
          </div>
          <label className="crm-crop-zoom">
            <span>Zoom</span>
            <input type="range" min={1} max={3} step={0.01} value={zoom} onChange={e => setZoom(Number(e.target.value))} />
          </label>
          <p className="muted">Drag to reposition, use the slider to zoom.</p>
          {exportError && <p className="crm-crop-error">{exportError}</p>}
        </>
      )}
    </Modal>
  );
}

// Fixed, explicit icon per category (grouped by relationship "kind") rather than a hash — so
// e.g. every people-network category (Family/Friends/Relatives/Acquaintances) reads at a glance
// as "people", regardless of which specific category it is.
const CATEGORY_ICONS: Record<string, typeof Users> = {
  'Family': Users, 'Friends': Users, 'Relatives': Users, 'Acquaintances': Users,
  'Colleagues': Briefcase, 'Clients': Briefcase, 'Influencers': Briefcase,
  'College': GraduationCap,
  'Sport Club': Medal,
  'Mentors & Mentees': Handshake,
  'Service Providers': Wrench,
  'VIP / High-Value Contacts': Star,
  'Neighbors & Community': Home,
  'Inactive / Archive': Archive
};
function categoryIcon(category: string) {
  return CATEGORY_ICONS[category] ?? CircleSlash;
}

// Curated starting points for the free-text Tags field — specific, personal context (not
// another category system), so these are grouped by kind rather than shown as a flat list.
const TAG_EXAMPLE_GROUPS: { label: string; examples: string[] }[] = [
  { label: 'Context', examples: ['High-School', 'Tech-Crunch-2026', 'Local'] },
  { label: 'Expertise', examples: ['AI-Engineering', 'Real-Estate', 'Marketing'] },
  { label: 'Interests', examples: ['Chess', 'Rock-Climbing', 'Crypto'] }
];

type CrmView = 'Overview' | 'Details' | 'Calendar' | 'Reach out';
type OverviewGroup = 'Category' | 'Company' | 'Role';
const CRM_VIEWS: { key: CrmView; icon: typeof LayoutGrid }[] = [
  { key: 'Overview', icon: LayoutGrid },
  { key: 'Details', icon: Table2 },
  { key: 'Calendar', icon: CalendarDays },
  { key: 'Reach out', icon: Send }
];

type DetailsSortKey = 'name' | 'company' | 'role' | 'email' | 'socialProfiles' | 'address' | 'category' | 'lastContact';

function addressOf(c: Contact): string {
  return c.address || [c.city, c.region].filter(Boolean).join(', ');
}
function socialCountOf(c: Contact): number {
  return [c.linkedin, c.instagram, c.facebook].filter(Boolean).length;
}

export function PersonalCRM() {
  const { data, upsert, remove, updateSettings } = useStore();
  const isMobile = useIsMobile();
  const contacts = data.contacts;
  const interactions = data.contactInteractions;
  const today = localIso();
  const allCategories = data.settings.contactCategories ?? CONTACT_CATEGORIES;

  const [view, setView] = useState<CrmView>('Overview');
  const [search, setSearch] = useState('');
  const [showManageCategories, setShowManageCategories] = useState(false);
  const [showFilterSheet, setShowFilterSheet] = useState(false);
  const [tagFilter, setTagFilter] = useState<string>('All');
  // Overview's sections: by category (default), company, or role. Remembered per browser.
  const [groupBy, setGroupByState] = useState<OverviewGroup>(() => {
    try { const v = localStorage.getItem('crm-group-by'); if (v === 'Company' || v === 'Role') return v; } catch { /* storage unavailable */ }
    return 'Category';
  });
  const setGroupBy = (g: OverviewGroup) => { setGroupByState(g); try { localStorage.setItem('crm-group-by', g); } catch { /* ignore */ } };
  const [showBdayQuickAdd, setShowBdayQuickAdd] = useState(false);
  // Rows stay in the quick-add list after a date is picked, so the list doesn't jump.
  const [bdayQuickTouched, setBdayQuickTouched] = useState<Set<string>>(() => new Set());
  const [bulkTier, setBulkTier] = useState<ContactTier>('Close');
  // "All" shows the full fixed preset roster (even 0-count tags) plus any ad-hoc tags in use;
  // "Used" shows that same set ranked by actual usage, busiest first.
  // Defaults to "Used" on a phone: a sheet listing 14 categories where most read 0 is mostly
  // scrolling. The toggle is right there if the full taxonomy is wanted.
  const [tagViewMode, setTagViewMode] = useState<'All' | 'Used'>(
    () => (typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches ? 'Used' : 'All')
  );
  // null = showing manual drag order (each contact's own `order` field); clicking a header sorts
  // by that column instead, and a third click clears it back to drag order — same pattern as the
  // Goals/Debt grids' own drag-reorder.
  const [detailsSort, setDetailsSort] = useState<GridSortState<DetailsSortKey>>(null);
  const [dragContactId, setDragContactId] = useState<string | null>(null);
  const [dragOverCardId, setDragOverCardId] = useState<string | null>(null);
  // Separate from detailsSort's alphabetical Role/Company toggle — these narrow the Details table
  // down to one exact value via the header's dropdown, rather than reordering everyone by it.
  const [roleFilter, setRoleFilter] = useState<string>('All');
  const [companyFilter, setCompanyFilter] = useState<string>('All');

  const now = new Date();
  const [bdayMonth, setBdayMonth] = useState(now.getMonth());
  const [bdayYear, setBdayYear] = useState(now.getFullYear());

  const [showContactForm, setShowContactForm] = useState(false);
  const [editingContactId, setEditingContactId] = useState<string | null>(null);
  const [contactForm, setContactForm] = useState<Partial<Contact>>(blankContact());
  // The photo-URL field is a fallback to Upload, so it stays tucked behind a link until asked for.
  const [photoUrlOpen, setPhotoUrlOpen] = useState(false);
  const [locationDraft, setLocationDraft] = useState('');
  const [showLocationSuggest, setShowLocationSuggest] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const contactPhotoFileRef = useRef<HTMLInputElement>(null);
  const [contactCropSrc, setContactCropSrc] = useState<string | null>(null);

  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);

  const [showQuickLog, setShowQuickLog] = useState(false);
  const [quickLogContactId, setQuickLogContactId] = useState<string | null>(null);
  const [quickLogSearch, setQuickLogSearch] = useState('');
  const [quickLogForm, setQuickLogForm] = useState<Partial<ContactInteraction>>(blankInteraction());

  const [confirmDeleteContact, setConfirmDeleteContact] = useState<{ id: string; name: string; count: number } | null>(null);

  // ---- Derived data -------------------------------------------------------

  const activeContacts = contacts.filter(c => !c.archived);

  const statusByContact = useMemo(() => {
    const map = new Map<string, { status: ContactStatus; lastDate?: string; dueDate: string }>();
    for (const c of activeContacts) {
      const lastDate = lastContactedDate(c.id, interactions);
      map.set(c.id, { status: contactStatus(c, lastDate, today), lastDate, dueDate: nextReachOutDate(c, lastDate) });
    }
    return map;
  }, [activeContacts, interactions, today]);

  // "Due in 12d" / "3d overdue" / "Talked Sep 3" — one short line for cards and Reach out.
  const dueLabel = (c: Contact): string => {
    const info = statusByContact.get(c.id);
    if (!info) return '';
    if (info.status === 'Off') return info.lastDate ? `Talked ${formatDate(info.lastDate)}` : '';
    const left = daysBetween(today, info.dueDate);
    if (left < 0) return info.lastDate ? `${-left}d overdue` : `Never contacted · ${-left}d past due`;
    if (left === 0) return 'Due today';
    if (info.status === 'Due soon') return `Due in ${left}d`;
    return info.lastDate ? `Talked ${formatDate(info.lastDate)}` : `First reach-out ${formatDate(info.dueDate)}`;
  };
  // Reach-out shortcuts: log a check-in in one click, or push the reminder back.
  const talkedToday = (c: Contact) => void upsert('contactInteractions', newRecord<ContactInteraction>({ contactId: c.id, date: today, type: 'Check-in', summary: '<p>Quick check-in</p>' }));
  const snooze = (c: Contact, days: number) => {
    const d = new Date(`${today}T12:00:00`);
    d.setDate(d.getDate() + days);
    void upsert('contacts', { ...c, snoozedUntil: localIso(d) });
  };

  // Sidebar category counts reflect the full active set, independent of the current
  // search/category filter, so the sidebar stays a stable map of "what's out there" rather
  // than shrinking to match whatever's currently on screen. Driven by each contact's single
  // Category field (not the freeform Tags pills), so it stays in sync with what you set there.
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of activeContacts) if (c.category) counts.set(c.category, (counts.get(c.category) ?? 0) + 1);
    return allCategories.map(cat => [cat, counts.get(cat) ?? 0] as [string, number]);
  }, [activeContacts, allCategories]);

  const displayedTagCounts = useMemo(() => {
    if (tagViewMode === 'Used') return tagCounts.filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return tagCounts;
  }, [tagCounts, tagViewMode]);

  // Local-only "smart" location autocomplete: no geocoding API/key in this offline-first app,
  // so suggestions are drawn from city/region combos already on file for other contacts.
  const knownLocations = useMemo(() => {
    const set = new Set<string>();
    for (const c of activeContacts) {
      const combo = [c.city, c.region].filter(Boolean).join(', ');
      if (combo) set.add(combo);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [activeContacts]);

  const locationSuggestions = useMemo(() => {
    const q = locationDraft.trim().toLowerCase();
    if (!q) return [];
    return knownLocations.filter(s => s.toLowerCase().includes(q) && s.toLowerCase() !== q).slice(0, 6);
  }, [knownLocations, locationDraft]);

  const searchedContacts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return activeContacts.filter(c => !q
      || c.name.toLowerCase().includes(q)
      || (c.company ?? '').toLowerCase().includes(q)
      || (c.city ?? '').toLowerCase().includes(q)
      || (c.tags ?? []).some(t => t.toLowerCase().includes(q)));
  }, [activeContacts, search]);

  const tagFilteredContacts = useMemo(
    () => tagFilter === 'All' ? searchedContacts : searchedContacts.filter(c => c.category === tagFilter),
    [searchedContacts, tagFilter]
  );

  // Each contact has exactly one Category, so this is a straight partition (unlike the old
  // multi-tag grouping, where one contact could land in several buckets at once). Each group's
  // own list is sorted by `order` so Overview's drag-reorder (scoped to one category at a time)
  // has something stable to reorder.
  const groupedByTag = useMemo(() => {
    const map = new Map<string, Contact[]>();
    for (const c of tagFilteredContacts) {
      const cat = groupBy === 'Company' ? (c.company || 'No company')
        : groupBy === 'Role' ? (c.role || 'No role')
        : (c.category ?? 'Uncategorized');
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(c);
    }
    for (const list of map.values()) list.sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999));
    // "No company" / "No role" / "Uncategorized" sink to the bottom.
    const last = (k: string) => (k === 'No company' || k === 'No role' || k === 'Uncategorized' ? 1 : 0);
    return Array.from(map.entries()).sort((a, b) => last(a[0]) - last(b[0]) || a[0].localeCompare(b[0]));
  }, [tagFilteredContacts, groupBy]);

  // Drag-to-reorder helper shared by Overview (scoped to one category's own id list) and Details
  // (scoped to the whole currently-filtered/sorted table) — reindexes just the ids handed to it,
  // so dragging in one place never touches contacts outside that specific list.
  const reorderContacts = (ids: string[], fromId: string, toId: string) => {
    if (fromId === toId) return;
    const fromIndex = ids.indexOf(fromId);
    const toIndex = ids.indexOf(toId);
    if (fromIndex === -1 || toIndex === -1) return;
    const next = [...ids];
    next.splice(fromIndex, 1);
    next.splice(toIndex, 0, fromId);
    next.forEach((id, index) => {
      const c = contacts.find(x => x.id === id);
      if (c && c.order !== index) void upsert('contacts', { ...c, order: index });
    });
  };

  // Every distinct role/company currently in use, for their header filter dropdowns — scoped to
  // tagFilteredContacts so they only ever offer values that could actually match something.
  const distinctRoles = useMemo(
    () => Array.from(new Set(tagFilteredContacts.map(c => c.role).filter((r): r is string => !!r))).sort((a, b) => a.localeCompare(b)),
    [tagFilteredContacts]
  );
  const distinctCompanies = useMemo(
    () => Array.from(new Set(tagFilteredContacts.map(c => c.company).filter((c): c is string => !!c))).sort((a, b) => a.localeCompare(b)),
    [tagFilteredContacts]
  );

  const roleFilteredContacts = useMemo(() => {
    let list = tagFilteredContacts;
    if (roleFilter !== 'All') list = list.filter(c => c.role === roleFilter);
    if (companyFilter !== 'All') list = list.filter(c => c.company === companyFilter);
    return list;
  }, [tagFilteredContacts, roleFilter, companyFilter]);

  // Manual drag order first — a header sort (when active) re-sorts on top of it, and clearing
  // that sort (the SortableTh's third click) falls straight back to this order.
  const orderedRoleFilteredContacts = useMemo(
    () => roleFilteredContacts.slice().sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999)),
    [roleFilteredContacts]
  );

  const sortedDetailsContacts = useMemo(() => {
    if (!detailsSort) return orderedRoleFilteredContacts;
    return orderedRoleFilteredContacts.slice().sort((a, b) => {
      let cmp: number;
      switch (detailsSort.key) {
        case 'name': cmp = a.name.localeCompare(b.name); break;
        case 'company': cmp = (a.company ?? '').localeCompare(b.company ?? ''); break;
        case 'role': cmp = (a.role ?? '').localeCompare(b.role ?? ''); break;
        case 'email': cmp = (a.email ?? '').localeCompare(b.email ?? ''); break;
        case 'socialProfiles': cmp = socialCountOf(a) - socialCountOf(b); break;
        case 'address': cmp = addressOf(a).localeCompare(addressOf(b)); break;
        case 'category': cmp = (a.category ?? '').localeCompare(b.category ?? ''); break;
        case 'lastContact': cmp = (statusByContact.get(a.id)?.lastDate ?? '').localeCompare(statusByContact.get(b.id)?.lastDate ?? ''); break;
      }
      return detailsSort.dir === 'asc' ? cmp : -cmp;
    });
  }, [orderedRoleFilteredContacts, detailsSort, statusByContact]);

  // Details table: columns nobody has data for stay hidden (like Finance's Notes column).
  const showSocialCol = activeContacts.some(c => c.linkedin || c.instagram || c.facebook);
  const showAddressCol = activeContacts.some(c => c.address || c.city || c.region);
  // Everyone at the same company says nothing per row — the table notes it once instead.
  const sharedCompany = activeContacts.length > 1 && activeContacts.every(c => c.company && c.company === activeContacts[0].company)
    ? activeContacts[0].company : undefined;
  const remindersCount = activeContacts.filter(c => remindersOn(c)).length;
  const missingBirthdays = activeContacts.filter(c => !c.birthday);
  // Next birthday on file, however far off (the Reach out list only looks 3 weeks ahead).
  const nextBirthday = useMemo(() => activeContacts
    .filter(c => c.birthday)
    .map(c => ({ contact: c, days: daysUntilNextBirthday(c.birthday!, today) ?? 999 }))
    .sort((a, b) => a.days - b.days)[0], [activeContacts, today]);
  // Categories with people whose reminders are off — where a bulk "turn on" makes sense.
  const bulkReminderCategories = tagCounts
    .filter(([, n]) => n > 0)
    .map(([cat]) => ({ cat, list: activeContacts.filter(c => c.category === cat && !remindersOn(c)) }))
    .filter(x => x.list.length > 0);
  const turnOnReminders = (list: Contact[], tier: ContactTier) => {
    for (const c of list) {
      void upsert('contacts', { ...c, tier, reachOut: REACH_OUT_DEFAULT_CATEGORIES.has(c.category ?? '') ? undefined : true, snoozedUntil: undefined });
    }
  };
  const overdueCount = activeContacts.filter(c => statusByContact.get(c.id)?.status === 'Overdue').length;
  const dueSoonCount = activeContacts.filter(c => statusByContact.get(c.id)?.status === 'Due soon').length;
  const neverCount = activeContacts.filter(c => statusByContact.get(c.id)?.status === 'Never contacted').length;

  const reachOutList = useMemo(() => {
    return activeContacts
      .filter(c => {
        const s = statusByContact.get(c.id)?.status;
        return s === 'Overdue' || s === 'Due soon' || s === 'Never contacted';
      })
      .sort((a, b) => STATUS_PRIORITY[statusByContact.get(a.id)!.status] - STATUS_PRIORITY[statusByContact.get(b.id)!.status] || a.name.localeCompare(b.name));
  }, [activeContacts, statusByContact]);

  const upcomingBirthdays = useMemo(() => {
    return activeContacts
      .map(c => ({ contact: c, days: c.birthday ? daysUntilNextBirthday(c.birthday, today) : undefined }))
      .filter((x): x is { contact: Contact; days: number } => x.days != null && x.days <= 21)
      .sort((a, b) => a.days - b.days);
  }, [activeContacts, today]);

  const bdayWeeks = useMemo(() => {
    const first = new Date(bdayYear, bdayMonth, 1);
    const gridStart = addDays(first, -first.getDay());
    const cells = Array.from({ length: 42 }, (_, i) => {
      const date = addDays(gridStart, i);
      const mmdd = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const dateStr = localIso(date);
      return {
        date,
        dateStr,
        inMonth: date.getMonth() === bdayMonth,
        isToday: dateStr === today,
        contacts: activeContacts.filter(c => c.birthday === mmdd),
        checkups: activeContacts.filter(c => c.nextCheckup === dateStr),
        dues: activeContacts.filter(c => statusByContact.get(c.id)?.status !== 'Off' && statusByContact.get(c.id)?.dueDate === dateStr)
      };
    });
    const weeks: typeof cells[] = [];
    for (let i = 0; i < 42; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
  }, [bdayMonth, bdayYear, activeContacts, today, statusByContact]);

  const jumpToNextBirthday = () => {
    if (!nextBirthday) { setView('Calendar'); return; }
    const target = new Date(`${today}T00:00:00`);
    target.setDate(target.getDate() + nextBirthday.days);
    setBdayMonth(target.getMonth());
    setBdayYear(target.getFullYear());
    setView('Calendar');
  };

  // ---- Contact CRUD ---------------------------------------------------------

  const startAddContact = () => {
    setContactForm(blankContact());
    setLocationDraft('');
    setTagDraft('');
    setEditingContactId(null);
    setShowContactForm(true);
  };
  useFabAction('Personal CRM', 'New contact', startAddContact);
  const startEditContact = (c: Contact) => {
    // "How we met" and the old single "Notes" field are retired — fold both into Personal notes
    // once, here, so the record stops carrying them after the next save.
    const legacyNotes = (c as unknown as { notes?: string }).notes;
    const personalNotes = [c.howWeMet && `How we met: ${c.howWeMet}`, legacyNotes, c.personalNotes].filter(Boolean).join('\n\n') || undefined;
    setContactForm({ ...c, personalNotes, howWeMet: undefined });
    setLocationDraft(composeLocation(c));
    setTagDraft('');
    setEditingContactId(c.id);
    setShowContactForm(true);
  };
  const cancelContactForm = () => {
    setShowContactForm(false);
    setEditingContactId(null);
    setPhotoUrlOpen(false);
    setContactForm(blankContact());
    setLocationDraft('');
    setTagDraft('');
  };

  const saveContact = async () => {
    const name = (contactForm.name ?? '').trim();
    if (!name) return;
    const payload = { ...contactForm, ...parseLocation(locationDraft), name };
    if (editingContactId) {
      const base = contacts.find(c => c.id === editingContactId);
      if (!base) return cancelContactForm();
      await upsert('contacts', { ...base, ...payload } as Contact);
    } else {
      await upsert('contacts', newRecord<Contact>(payload));
    }
    cancelContactForm();
  };

  const setContactField = <K extends keyof Contact>(key: K, value: Contact[K]) => setContactForm(prev => ({ ...prev, [key]: value }));

  const uploadContactPhoto = async (file: File) => {
    try {
      setContactCropSrc(await fileToCompressedDataUrl(file));
    } catch {
      /* unreadable file — the Photo URL field is still there to paste a link instead */
    }
  };

  const addCategory = (name: string) => {
    if (allCategories.some(c => c.toLowerCase() === name.toLowerCase())) return;
    void updateSettings({ contactCategories: [...allCategories, name] });
  };

  // Built-in categories aren't locked — deleting or renaming one is a real edit to the roster,
  // not just removing an addition on top of it, so every contact using it needs to follow along.
  const deleteCategory = (name: string) => {
    void updateSettings({ contactCategories: allCategories.filter(c => c !== name) });
    for (const c of contacts) if (c.category === name) void upsert('contacts', { ...c, category: undefined });
  };

  const renameCategory = (oldName: string, newName: string) => {
    void updateSettings({ contactCategories: allCategories.map(c => c === oldName ? newName : c) });
    for (const c of contacts) if (c.category === oldName) void upsert('contacts', { ...c, category: newName });
  };

  const reorderCategories = (orderedIds: string[]) => {
    void updateSettings({ contactCategories: orderedIds });
  };

  const addTagToForm = (tag: string) => {
    const clean = tag.trim();
    if (!clean) return;
    setContactForm(prev => (prev.tags ?? []).includes(clean) ? prev : { ...prev, tags: [...(prev.tags ?? []), clean] });
    setTagDraft('');
  };
  const removeTagFromForm = (tag: string) => setContactForm(prev => ({ ...prev, tags: (prev.tags ?? []).filter(t => t !== tag) }));

  const patchContact = (c: Contact, patch: Partial<Contact>) => void upsert('contacts', { ...c, ...patch });

  const requestDeleteContact = (c: Contact) => {
    const count = interactions.filter(i => i.contactId === c.id).length;
    setConfirmDeleteContact({ id: c.id, name: c.name, count });
  };

  const confirmDeleteContactNow = async () => {
    if (!confirmDeleteContact) return;
    const { id } = confirmDeleteContact;
    for (const i of interactions.filter(x => x.contactId === id)) await remove('contactInteractions', i.id);
    await remove('contacts', id);
    if (selectedContactId === id) setSelectedContactId(null);
    setConfirmDeleteContact(null);
  };

  // ---- Interaction logging ---------------------------------------------------

  const openQuickLog = (contactId?: string) => {
    setQuickLogContactId(contactId ?? null);
    setQuickLogSearch('');
    setQuickLogForm(blankInteraction(contactId));
    setShowQuickLog(true);
  };
  const closeQuickLog = () => { setShowQuickLog(false); setQuickLogContactId(null); setQuickLogForm(blankInteraction()); };

  const saveQuickLog = async () => {
    const contactId = quickLogContactId;
    const summary = (quickLogForm.summary ?? '').trim();
    if (!contactId || !summary) return;
    await upsert('contactInteractions', newRecord<ContactInteraction>({ ...quickLogForm, contactId, summary }));
    closeQuickLog();
  };

  const addInteractionFromPerson = async (contactId: string, patch: Partial<ContactInteraction>) => {
    const summary = patch.summary ?? '';
    if (isEmptyHtml(summary)) return;
    await upsert('contactInteractions', newRecord<ContactInteraction>({ ...patch, contactId, summary }));
  };

  const deleteInteraction = (id: string) => remove('contactInteractions', id);

  const quickLogCandidates = useMemo(() => {
    const q = quickLogSearch.trim().toLowerCase();
    if (!q) return activeContacts.slice(0, 8);
    return activeContacts.filter(c => c.name.toLowerCase().includes(q)).slice(0, 8);
  }, [activeContacts, quickLogSearch]);

  const selectedContact = contacts.find(c => c.id === selectedContactId) ?? null;

  // Shared by the desktop rail and the mobile filter sheet so the two can't drift. `onPick`
  // lets the sheet close itself once a category is chosen — on desktop the rail stays put.
  const renderCategoryPicker = (onPick?: () => void) => (
    <>
      <div className="crm-tag-view-toggle">
        <button type="button" className={tagViewMode === 'All' ? 'on' : ''} onClick={() => { setTagViewMode('All'); setTagFilter('All'); }}>
          <TagIcon size={12} /> All
        </button>
        <button type="button" className={tagViewMode === 'Used' ? 'on' : ''} onClick={() => { setTagViewMode('Used'); setTagFilter('All'); }}>
          <TagIcon size={12} /> Used
        </button>
      </div>
      {displayedTagCounts.length ? displayedTagCounts.map(([tag, count]) => {
        const Icon = categoryIcon(tag);
        return (
          <button
            type="button"
            key={tag}
            className={`crm-tag-row ${tagFilter === tag ? 'active' : ''} ${count === 0 ? 'empty' : ''}`}
            onClick={() => { setTagFilter(tagFilter === tag ? 'All' : tag); onPick?.(); }}
          >
            <span className="crm-tag-count">{count}</span>
            <Icon size={13} />
            <span>{tag}</span>
          </button>
        );
      }) : <p className="muted crm-sidebar-empty">Set a contact's category to see it here.</p>}
    </>
  );

  // Right-click a contact (desktop): open, log, edit, change tier, delete.
  const { menu: contextMenu, openMenu } = useContextMenu();
  const contactMenu = (c: Contact): ContextMenuItem[] => [
    { label: 'Open profile', icon: IdCard, onSelect: () => setSelectedContactId(c.id) },
    { label: 'Talked today', icon: Check, onSelect: () => talkedToday(c) },
    { label: 'Log interaction…', icon: MessageCircle, onSelect: () => openQuickLog(c.id) },
    ...(remindersOn(c) ? [
      { label: 'Snooze 1 week', icon: Clock, onSelect: () => snooze(c, 7) },
      { label: 'Snooze 1 month', icon: Clock, onSelect: () => snooze(c, 30) }
    ] : []),
    { label: remindersOn(c) ? 'Turn off reminders' : 'Remind me to stay in touch', icon: Bell, onSelect: () => {
      const next = !remindersOn(c);
      void upsert('contacts', { ...c, reachOut: next === REACH_OUT_DEFAULT_CATEGORIES.has(c.category ?? '') ? undefined : next });
    } },
    { label: 'Edit details…', icon: Pencil, onSelect: () => startEditContact(c) },
    'separator',
    { heading: 'Tier' },
    ...(['Inner Circle', 'Close', 'Extended'] as ContactTier[]).map(tier => ({
      label: tier,
      checked: c.tier === tier,
      onSelect: () => { if (c.tier !== tier) void upsert('contacts', { ...c, tier }); }
    })),
    'separator',
    { label: 'Delete…', icon: Trash2, danger: true, onSelect: () => requestDeleteContact(c) }
  ];

  return (
    <>
      {contextMenu}
      <PageHeader
        title="Personal CRM"
        subtitle="Keep track of the people in your life — birthdays, last contact, notes."
      />

      <div className="crm-layout">
        {!isMobile && (
        <aside className="crm-sidebar">
          <div className="crm-sidebar-block">
            <h3 className="crm-sidebar-title">Actions</h3>
            <button type="button" className="crm-sidebar-btn" onClick={startAddContact}><UserPlus size={15} /> New Contact</button>
            <button type="button" className="crm-sidebar-btn" onClick={() => openQuickLog()}><MessageCircle size={15} /> Quick log</button>
          </div>
          <div className="crm-sidebar-block">
            <div className="crm-sidebar-title-row">
              <h3 className="crm-sidebar-title">Categories</h3>
              <button type="button" className="col-edit-btn" onClick={() => setShowManageCategories(true)} aria-label="Manage categories" title="Add or remove categories">
                <Pencil size={11} />
              </button>
            </div>
            {renderCategoryPicker()}
          </div>
          <div className="crm-sidebar-block">
            <h3 className="crm-sidebar-title">Birthdays</h3>
            {nextBirthday ? (
              <button type="button" className="crm-sidebar-btn" onClick={jumpToNextBirthday}>
                <Cake size={15} /> <span>{nextBirthday.contact.name} <small className="muted">{nextBirthday.days === 0 ? 'today' : nextBirthday.days === 1 ? 'tomorrow' : `in ${nextBirthday.days}d`}</small></span>
              </button>
            ) : <p className="muted crm-sidebar-empty">No birthdays added yet.</p>}
            {missingBirthdays.length > 0 && (
              <button type="button" className="crm-sidebar-btn" onClick={() => setShowBdayQuickAdd(true)}>
                <Plus size={15} /> Add birthdays <span className="crm-tag-count crm-sidebar-count">{missingBirthdays.length}</span>
              </button>
            )}
          </div>
        </aside>
        )}
        {/* The rail costs nothing beside a wide canvas, but stacked on a phone it is a full
            viewport of filter chrome before the first contact — there it becomes a sheet. */}

        <main className="crm-main">
          <div className="crm-main-topbar">
            <h1>Contacts</h1>
            <div className="crm-search">
              <Search size={14} />
              <input type="text" placeholder="Search by name, company, city, tag…" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
          </div>

          {isMobile && (
            <div className="crm-mobile-bar">
              <button type="button" className={`crm-filter-chip ${tagFilter !== 'All' ? 'on' : ''}`} onClick={() => setShowFilterSheet(true)}>
                <SlidersHorizontal size={13} />
                <span>{tagFilter === 'All' ? 'All categories' : tagFilter}</span>
                <span className="crm-filter-count">{tagFilteredContacts.length}</span>
              </button>
              <button type="button" className="crm-mobile-action" onClick={startAddContact} aria-label="New contact"><UserPlus size={16} /></button>
              <button type="button" className="crm-mobile-action" onClick={() => openQuickLog()} aria-label="Quick log"><MessageCircle size={16} /></button>
            </div>
          )}

          <div className="crm-view-bar">
            <div className="segmented crm-view-tabs">
              {CRM_VIEWS.map(({ key, icon: Icon }) => (
                <button type="button" key={key} className={view === key ? 'on' : ''} onClick={() => setView(key)}>
                  <Icon size={14} /> {key}
                </button>
              ))}
            </div>
            {view === 'Overview' && activeContacts.length > 0 && (
              <label className="crm-group-by">
                <span>Group by</span>
                <select value={groupBy} onChange={e => setGroupBy(e.target.value as OverviewGroup)}>
                  <option value="Category">Category</option>
                  <option value="Company">Company</option>
                  <option value="Role">Role</option>
                </select>
              </label>
            )}
          </div>


          {view === 'Overview' && (
            groupedByTag.length ? (
              <div className="crm-overview">
                {groupedByTag.map(([tag, list]) => {
                  const Icon = groupBy === 'Company' ? Briefcase : groupBy === 'Role' ? IdCard : categoryIcon(tag);
                  return (
                    <div className="crm-group" key={tag}>
                      <div className="crm-group-head">
                        <Icon size={14} />
                        <b>{tag}</b>
                        <span className="crm-group-count">{list.length}</span>
                      </div>
                      <div className="crm-card-grid">
                        {list.map(c => (
                          <div
                            className={`crm-card ${dragContactId === c.id ? 'dragging' : ''} ${selectedContactId === c.id ? 'selected' : ''} ${dragOverCardId === c.id && dragContactId !== null && dragContactId !== c.id ? 'drag-over' : ''}`}
                            key={c.id}
                            draggable={!isMobile}
                            onDragStart={() => setDragContactId(c.id)}
                            onDragEnter={() => setDragOverCardId(c.id)}
                            onDragOver={e => e.preventDefault()}
                            onDrop={() => {
                              if (dragContactId) reorderContacts(list.map(x => x.id), dragContactId, c.id);
                              setDragContactId(null);
                              setDragOverCardId(null);
                            }}
                            onDragEnd={() => { setDragContactId(null); setDragOverCardId(null); }}
                            onContextMenu={e => openMenu(e, contactMenu(c))}
                          >
                            {/* Edit/Delete here only ever worked on :hover, which never fires on
                                touch — silently unreachable on mobile with no fallback. Swipe
                                replaces it there; desktop keeps the hover reveal unchanged. */}
                            {!isMobile && (
                              <div className="crm-card-actions">
                                <button type="button" className="icon-btn" onClick={() => startEditContact(c)} aria-label={`Edit ${c.name}`}><Pencil size={12} /></button>
                                <button type="button" className="icon-btn danger" onClick={() => requestDeleteContact(c)} aria-label={`Delete ${c.name}`}><Trash2 size={12} /></button>
                              </div>
                            )}
                            <SwipeRow
                              disabled={!isMobile}
                              leading={{ label: 'Log', icon: <MessageCircle size={16} />, onTrigger: () => openQuickLog(c.id) }}
                              trailing={{ label: 'Delete', icon: <Trash2 size={16} />, onTrigger: () => requestDeleteContact(c) }}
                            >
                              <button type="button" className="crm-card-body" onClick={() => setSelectedContactId(c.id)}>
                                <ContactAvatar contact={c} size="card" />
                                <b>{c.name}</b>
                                {(c.role || c.company) && (
                                  <small className="crm-card-role">{[c.role, c.company].filter(Boolean).join(' at ')}</small>
                                )}
                                {c.email && <small>{c.email}</small>}
                                {c.phone && <small>{c.phone}</small>}
                                {statusByContact.get(c.id) && dueLabel(c) && (
                                  <span className={`crm-card-status status-${statusByContact.get(c.id)!.status.replace(/\s+/g, '-').toLowerCase()}`}>
                                    <i />{dueLabel(c)}
                                  </span>
                                )}
                              </button>
                            </SwipeRow>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : <Card><EmptyState><Users size={22} /> {contacts.length ? 'No contacts match your filters.' : 'No contacts yet — add your first one.'}</EmptyState></Card>
          )}

          {view === 'Details' && (
            <Card>
              {isMobile ? (
                <MobileRecordList
                  items={sortedDetailsContacts}
                  primary={c => c.name}
                  secondary={c => c.category ?? 'Uncategorized'}
                  // Right-hand column: phone number, with the stage (tinted like its badge) beneath
                  // it. The stage alone in that slot used to truncate the name.
                  trailing={c => {
                    const status = statusByContact.get(c.id)?.status;
                    return (
                      <span className="crm-trailing-stack">
                        {c.phone && <span>{c.phone}</span>}
                        {status && status !== 'Off' && <small className={`crm-status-text tone-${STATUS_BADGE_TONE[status]}`}>{status}</small>}
                      </span>
                    );
                  }}
                  fields={[
                    { label: 'Company', value: c => [c.role, c.company].filter(Boolean).join(' at ') || '—' },
                    { label: 'Last contact', value: c => {
                      const d = statusByContact.get(c.id)?.lastDate;
                      return d ? formatDate(d) : 'Never';
                    } },
                    { label: 'Email', value: c => c.email || '—' }
                  ]}
                  onOpen={c => setSelectedContactId(c.id)}
                  leadingAction={c => ({ label: 'Log', icon: <MessageCircle size={16} />, onTrigger: () => openQuickLog(c.id) })}
                  onDelete={requestDeleteContact}
                  deleteLabel={c => `Delete ${c.name}`}
                  empty={contacts.length ? 'No contacts match your filters.' : 'No contacts yet — add your first one.'}
                />
              ) : sortedDetailsContacts.length ? (
                <>
                {sharedCompany && <p className="crm-table-note"><Briefcase size={12} /> Everyone here is at {sharedCompany}</p>}
                <div className="grid-table-wrap grid-table-scroll">
                  <table className="grid-table">
                    <thead>
                      <tr>
                        <th className="grid-drag-col" />
                        <SortableTh label="Name" sortKey="name" state={detailsSort} onSort={k => setDetailsSort(s => toggleGridSort(s, k))} />
                        <SortableTh label="Last contact" sortKey="lastContact" state={detailsSort} onSort={k => setDetailsSort(s => toggleGridSort(s, k, 'desc'))} />
                        <th>Status</th>
                        {!sharedCompany && <th className="sortable-th">
                          {/* Same split as the Role header: label is a filter dropdown, arrow icon
                              is the normal alphabetical toggle sort. */}
                          <span className="sortable-th-inner role-th-inner">
                            <select
                              className={`role-filter-select ${companyFilter !== 'All' ? 'active' : ''}`}
                              value={companyFilter}
                              onChange={e => setCompanyFilter(e.target.value)}
                              onClick={e => e.stopPropagation()}
                              aria-label="Filter by company"
                            >
                              <option value="All">Company</option>
                              {distinctCompanies.map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                            <span
                              className={`sort-icon ${detailsSort?.key === 'company' ? 'active' : ''}`}
                              onClick={() => setDetailsSort(s => toggleGridSort(s, 'company'))}
                              role="button"
                              aria-label="Sort by company"
                            >
                              {detailsSort?.key === 'company' ? (detailsSort.dir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />) : <ChevronsUpDown size={11} />}
                            </span>
                          </span>
                        </th>}
                        <th className="sortable-th">
                          {/* Split header: the label itself is a filter dropdown (narrows to one exact
                              role), while the arrow icon keeps the normal alphabetical toggle sort —
                              two different jobs living in the same header, like Category's filter
                              chip elsewhere plus this table's usual A-Z sort. */}
                          <span className="sortable-th-inner role-th-inner">
                            <select
                              className={`role-filter-select ${roleFilter !== 'All' ? 'active' : ''}`}
                              value={roleFilter}
                              onChange={e => setRoleFilter(e.target.value)}
                              onClick={e => e.stopPropagation()}
                              aria-label="Filter by role"
                            >
                              <option value="All">Role</option>
                              {distinctRoles.map(r => <option key={r} value={r}>{r}</option>)}
                            </select>
                            <span
                              className={`sort-icon ${detailsSort?.key === 'role' ? 'active' : ''}`}
                              onClick={() => setDetailsSort(s => toggleGridSort(s, 'role'))}
                              role="button"
                              aria-label="Sort by role"
                            >
                              {detailsSort?.key === 'role' ? (detailsSort.dir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />) : <ChevronsUpDown size={11} />}
                            </span>
                          </span>
                        </th>
                        <SortableTh label="Email" sortKey="email" state={detailsSort} onSort={k => setDetailsSort(s => toggleGridSort(s, k))} />
                        <th>Phone</th>
                        {showSocialCol && <SortableTh label="Social profiles" sortKey="socialProfiles" state={detailsSort} onSort={k => setDetailsSort(s => toggleGridSort(s, k, 'desc'))} />}
                        {showAddressCol && <SortableTh label="Address" sortKey="address" state={detailsSort} onSort={k => setDetailsSort(s => toggleGridSort(s, k))} />}
                        <SortableTh label="Category" sortKey="category" state={detailsSort} onSort={k => setDetailsSort(s => toggleGridSort(s, k))} />
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {sortedDetailsContacts.map(c => {
                        const info = statusByContact.get(c.id)!;
                        const socials: [string, string | undefined][] = [['LinkedIn', c.linkedin], ['Instagram', c.instagram], ['Facebook', c.facebook]];
                        return (
                          <tr
                            key={c.id}
                            className={dragContactId === c.id ? 'dragging' : ''}
                            onDragOver={e => e.preventDefault()}
                            onDrop={() => {
                              if (dragContactId) reorderContacts(orderedRoleFilteredContacts.map(x => x.id), dragContactId, c.id);
                              setDragContactId(null);
                            }}
                          >
                            <td className="grid-drag-col">
                              <span
                                className="drag-handle"
                                draggable={!detailsSort}
                                aria-disabled={Boolean(detailsSort)}
                                title={detailsSort ? 'Clear the sort to drag-reorder' : 'Drag to reorder'}
                                aria-label={`Drag to reorder ${c.name}`}
                                onDragStart={e => { if (detailsSort) { e.preventDefault(); return; } setDragContactId(c.id); e.dataTransfer.effectAllowed = 'move'; }}
                                onDragEnd={() => setDragContactId(null)}
                              >
                                <GripVertical size={13} />
                              </span>
                            </td>
                            <td><button type="button" className="text-btn" onClick={() => setSelectedContactId(c.id)}>{c.name}</button></td>
                            <td>{info.lastDate ? formatDate(info.lastDate) : <span className="grid-static-cell">Never</span>}</td>
                            <td>{info.status === 'Off' ? <span className="grid-static-cell">Off</span> : <><Badge tone={STATUS_BADGE_TONE[info.status]}>{info.status}</Badge> <span className="crm-tier-inline">{c.tier}</span></>}</td>
                            {!sharedCompany && <td className="grid-td-compact">
                              <input
                                type="text" className="grid-cell-input autosize" placeholder="Add company…"
                                style={{ width: `${autosizeCh(c.company ?? '', 'Add company…')}ch` }}
                                value={c.company ?? ''} onChange={e => patchContact(c, { company: e.target.value || undefined })}
                              />
                            </td>}
                            <td className="grid-td-compact">
                              <input
                                type="text" className="grid-cell-input autosize" placeholder="Add role…"
                                style={{ width: `${autosizeCh(c.role ?? '', 'Add role…')}ch` }}
                                value={c.role ?? ''} onChange={e => patchContact(c, { role: e.target.value || undefined })}
                              />
                            </td>
                            <td className="grid-td-compact">
                              <input
                                type="email" className="grid-cell-input autosize" placeholder="Add email…"
                                style={{ width: `${autosizeCh(c.email ?? '', 'Add email…')}ch` }}
                                value={c.email ?? ''} onChange={e => patchContact(c, { email: e.target.value })}
                              />
                            </td>
                            <td className="grid-td-compact">
                              <input
                                type="tel" className="grid-cell-input autosize" placeholder="Add phone…"
                                style={{ width: `${autosizeCh(c.phone ?? '', 'Add phone…', 8, 24)}ch` }}
                                value={c.phone ?? ''} onChange={e => patchContact(c, { phone: formatPhoneInput(e.target.value) })}
                              />
                            </td>
                            {showSocialCol && (
                              <td className="crm-social-cell">
                                {socials.some(([, url]) => url) ? socials.filter(([, url]) => url).map(([label, url]) => (
                                  <a key={label} href={url} target="_blank" rel="noreferrer"><Link2 size={11} /> {label}</a>
                                )) : <span className="grid-static-cell">—</span>}
                              </td>
                            )}
                            {showAddressCol && <td>{c.address || [c.city, c.region].filter(Boolean).join(', ') || <span className="grid-static-cell">—</span>}</td>}
                            <td className="grid-td-compact">
                              <select className="grid-cell-select select-wide" value={c.category ?? ''} onChange={e => patchContact(c, { category: e.target.value || undefined })}>
                                <option value="">—</option>
                                {allCategories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                              </select>
                            </td>
                            <td className="grid-row-actions">
                              <button type="button" className="icon-btn" onClick={() => startEditContact(c)} aria-label={`Edit ${c.name}`}><Pencil size={13} /></button>
                              <button type="button" className="icon-btn danger" onClick={() => requestDeleteContact(c)} aria-label={`Delete ${c.name}`}><Trash2 size={13} /></button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                </>
              ) : <EmptyState><Users size={22} /> {contacts.length ? 'No contacts match your filters.' : 'No contacts yet — add your first one.'}</EmptyState>}
            </Card>
          )}

          {view === 'Calendar' && (
            <Card>
              <div className="week-card-header">
                <div className="week-card-title">
                  <CalendarDays size={17} /><h2>{MONTH_NAMES[bdayMonth]} {bdayYear}</h2>
                  <span className="crm-cal-legend"><span><Cake size={11} /> Birthday</span><span><CalendarCheck size={11} /> Check-up</span><span><Send size={11} /> Reach out</span></span>
                </div>
                <div className="calendar-nav">
                  <button type="button" className="icon-btn" onClick={() => setBdayMonth(m => { if (m === 0) { setBdayYear(y => y - 1); return 11; } return m - 1; })} aria-label="Previous month"><ChevronLeft size={16} /></button>
                  <button type="button" className="btn ghost small" onClick={() => { setBdayMonth(now.getMonth()); setBdayYear(now.getFullYear()); }}>Today</button>
                  <button type="button" className="icon-btn" onClick={() => setBdayMonth(m => { if (m === 11) { setBdayYear(y => y + 1); return 0; } return m + 1; })} aria-label="Next month"><ChevronRight size={16} /></button>
                </div>
              </div>
              {!bdayWeeks.some(w => w.some(cell => cell.inMonth && (cell.contacts.length || cell.checkups.length || cell.dues.length))) && (
                <p className="crm-cal-empty">
                  Nothing this month.
                  {missingBirthdays.length > 0
                    ? <> <button type="button" className="text-btn" onClick={() => setShowBdayQuickAdd(true)}>Add birthdays</button> for {missingBirthdays.length} contact{missingBirthdays.length === 1 ? '' : 's'} to see them here.</>
                    : ' Birthdays and check-ups show up here.'}
                </p>
              )}
              <div className="calendar-grid crm-bday-grid">
                <div className="calendar-grid-row calendar-grid-header">
                  {DAY_LABELS.map(d => <span key={d}>{d}</span>)}
                </div>
                {bdayWeeks.map((week, wi) => (
                  <div className="calendar-grid-row" key={wi}>
                    {week.map(cell => (
                      <div key={cell.dateStr} className={`calendar-cell crm-bday-cell ${cell.inMonth ? '' : 'other-month'} ${cell.isToday ? 'today' : ''}`}>
                        <span className="calendar-cell-date">{cell.date.getDate()}</span>
                        {cell.contacts.map(c => {
                          const age = ageFromBirthYear(c.birthYear, c.birthday, today);
                          return (
                            <button type="button" key={`b-${c.id}`} className="crm-bday-chip" onClick={() => setSelectedContactId(c.id)}>
                              <Cake size={11} />
                              <span>{c.name}{age != null ? ` · ${age}` : ''}</span>
                            </button>
                          );
                        })}
                        {cell.checkups.map(c => (
                          <button type="button" key={`c-${c.id}`} className="crm-bday-chip crm-checkup-chip" onClick={() => setSelectedContactId(c.id)}>
                            <CalendarCheck size={11} />
                            <span>{c.name}</span>
                          </button>
                        ))}
                        {cell.dues.map(c => (
                          <button type="button" key={`d-${c.id}`} className="crm-bday-chip crm-due-chip" onClick={() => setSelectedContactId(c.id)} title={`Reach out to ${c.name}`}>
                            <Send size={11} />
                            <span>{c.name}</span>
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {view === 'Reach out' && (
            <>
              {remindersCount > 0 && <div className="kpi-grid four calm-kpis">
                <Kpi label="Contacts" value={activeContacts.length} caption={`${activeContacts.filter(c => remindersOn(c)).length} with reach-out reminders`} tone="default" />
                <Kpi label="Overdue" value={overdueCount} caption="past their cadence" tone={overdueCount ? 'red' : 'muted'} />
                <Kpi label="Due soon" value={dueSoonCount} caption="in the last stretch of their cadence" tone={dueSoonCount ? 'amber' : 'muted'} />
                <Kpi label="Never contacted" value={neverCount} caption="past their first due date" tone={neverCount ? 'red' : 'muted'} />
              </div>}
              <Card className="crm-weekly-digest">
                <div className="card-title"><div><Sparkles size={17} /><h2>Reach Out</h2></div></div>
                {reachOutList.length || upcomingBirthdays.length ? (
                  <div className="crm-weekly-grid">
                    {reachOutList.length > 0 && (
                      <div className="crm-weekly-col">
                        <h3>Needs outreach</h3>
                        {reachOutList.map(c => {
                          const info = statusByContact.get(c.id)!;
                          return (
                            <div className="crm-weekly-row" key={c.id}>
                              <button type="button" className="crm-weekly-row-name" onClick={() => setSelectedContactId(c.id)}>
                                <b>{c.name}</b>
                                <small>{dueLabel(c)}{info.lastDate ? ` · last talked ${formatDate(info.lastDate)}` : ''}</small>
                              </button>
                              <Badge tone={STATUS_BADGE_TONE[info.status]}>{info.status}</Badge>
                              <div className="crm-reach-actions">
                                <button type="button" className="btn ghost small" onClick={() => talkedToday(c)} title="Log a check-in for today"><Check size={13} /> Talked today</button>
                                <button type="button" className="btn ghost small" onClick={() => openQuickLog(c.id)}>Log…</button>
                                {!isMobile && <button type="button" className="icon-btn" onClick={e => openMenu(e, [
                                  { label: 'Snooze 1 week', icon: Clock, onSelect: () => snooze(c, 7) },
                                  { label: 'Snooze 1 month', icon: Clock, onSelect: () => snooze(c, 30) },
                                  { label: 'Snooze 3 months', icon: Clock, onSelect: () => snooze(c, 90) }
                                ])} title="Snooze" aria-label={`Snooze ${c.name}`}><Clock size={14} /></button>}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {upcomingBirthdays.length > 0 && (
                      <div className="crm-weekly-col">
                        <h3>Upcoming birthdays</h3>
                        {upcomingBirthdays.map(({ contact: c, days }) => (
                          <div className="crm-weekly-row" key={c.id}>
                            <button type="button" className="crm-weekly-row-name" onClick={() => setSelectedContactId(c.id)}>
                              <b>{c.name}</b>
                              <small>{days === 0 ? 'Today!' : days === 1 ? 'Tomorrow' : `In ${days} days`}</small>
                            </button>
                            <Cake size={15} className="crm-birthday-icon" />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : remindersCount > 0 ? <EmptyState>You're all caught up — nobody's overdue or due soon.</EmptyState> : null}
                {remindersCount === 0 && (
                  <div className="crm-reach-setup">
                    <p><b>No one has reach-out reminders on yet.</b> Turn them on and people show up here when it's been a while.</p>
                    {bulkReminderCategories.length > 0 && (
                      <div className="crm-reach-setup-row">
                        <label className="crm-tier-picker">
                          <span>Every</span>
                          <select value={bulkTier} onChange={e => setBulkTier(e.target.value as ContactTier)}>
                            {TIER_OPTIONS.map(o => <option key={o.tier} value={o.tier}>{o.label}</option>)}
                          </select>
                        </label>
                        {bulkReminderCategories.map(({ cat, list }) => (
                          <button type="button" key={cat} className="btn ghost small" onClick={() => turnOnReminders(list, bulkTier)}>
                            <Bell size={13} /> Turn on for {cat} ({list.length})
                          </button>
                        ))}
                      </div>
                    )}
                    <small className="muted">Or per person: open a contact and flip "Remind me to stay in touch".</small>
                  </div>
                )}
              </Card>
            </>
          )}
        </main>
      </div>

      {showContactForm && (
        <Modal
          eyebrow="Life OS"
          title={editingContactId ? 'Edit contact' : 'Add contact'}
          onClose={cancelContactForm}
          size="wide"
          footer={<>
            {/* saveContact quietly ignored a blank name, so Save looked broken. Say why instead. */}
            {!contactForm.name?.trim() && <span className="cf-footer-hint">Add a name to save</span>}
            <button type="button" className="btn ghost" onClick={cancelContactForm}>Cancel</button>
            <button type="button" className="btn teal" onClick={() => void saveContact()} disabled={!contactForm.name?.trim()}>
              {editingContactId ? 'Save' : 'Add contact'}
            </button>
          </>}
        >
          <div className="contact-form">
            {/* Identity first: who this is, with a live preview of how they'll appear. */}
            <div className="cf-identity">
              <button
                type="button"
                className="cf-avatar"
                onClick={() => contactPhotoFileRef.current?.click()}
                aria-label={contactForm.photoUrl ? 'Change photo' : 'Add a photo'}
                title={contactForm.photoUrl ? 'Change photo' : 'Add a photo'}
              >
                <ContactAvatar contact={{ id: contactForm.id ?? 'new-contact', name: contactForm.name || '?', photoUrl: contactForm.photoUrl }} size="large" />
                <span className="crm-contact-avatar-edit-badge"><Camera size={11} /></span>
              </button>
              <input
                ref={contactPhotoFileRef} type="file" accept="image/*" hidden
                onChange={e => { const file = e.target.files?.[0]; if (file) void uploadContactPhoto(file); e.target.value = ''; }}
              />
              <div className="cf-identity-fields">
                <label className="cf-name">
                  <span>Name</span>
                  <input
                    value={contactForm.name ?? ''}
                    placeholder="Full name"
                    autoFocus={!editingContactId}
                    autoComplete="off"
                    onChange={e => setContactField('name', e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && contactForm.name?.trim()) { e.preventDefault(); void saveContact(); } }}
                  />
                </label>
                <div className="cf-photo-actions">
                  <button type="button" className="text-btn" onClick={() => contactPhotoFileRef.current?.click()}>
                    <Upload size={13} /> {contactForm.photoUrl ? 'Replace photo' : 'Upload photo'}
                  </button>
                  <button type="button" className="text-btn" onClick={() => setPhotoUrlOpen(open => !open)} aria-expanded={photoUrlOpen}>
                    <Link2 size={13} /> Photo URL
                  </button>
                  {contactForm.photoUrl && <>
                    <button type="button" className="text-btn" onClick={() => setContactCropSrc(contactForm.photoUrl!)}>Adjust crop</button>
                    <button type="button" className="text-btn danger" onClick={() => setContactField('photoUrl', undefined)}>Remove</button>
                  </>}
                </div>
              </div>
            </div>
            {photoUrlOpen && (
              <label className="cf-photo-url">
                <span>Photo URL</span>
                <input type="url" value={contactForm.photoUrl ?? ''} onChange={e => setContactField('photoUrl', e.target.value || undefined)} placeholder="https://…" />
              </label>
            )}

            <div className="cf-section">
              <div className="form-section-title">Category</div>
              <div className="cf-category-chips" role="radiogroup" aria-label="Category">
                <button
                  type="button"
                  role="radio"
                  aria-checked={!contactForm.category}
                  className={`cf-chip ${!contactForm.category ? 'on' : ''}`}
                  onClick={() => setContactField('category', undefined)}
                >
                  <CircleSlash size={14} /> None
                </button>
                {tagCounts.map(([cat]) => {
                  const Icon = categoryIcon(cat);
                  const active = contactForm.category === cat;
                  return (
                    <button
                      type="button"
                      key={cat}
                      role="radio"
                      aria-checked={active}
                      className={`cf-chip ${active ? 'on' : ''}`}
                      onClick={() => setContactField('category', (active ? undefined : cat) as ContactCategory | undefined)}
                    >
                      <Icon size={14} /> {cat}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="form-grid cf-grid">
              <div className="field-full form-section-title">Work</div>
              <label><span>Company</span><input value={contactForm.company ?? ''} onChange={e => setContactField('company', e.target.value)} placeholder="Where they work" /></label>
              <label><span>Role</span><input value={contactForm.role ?? ''} onChange={e => setContactField('role', e.target.value)} placeholder="What they do" /></label>

              <div className="field-full form-section-title">Reach</div>
              <label><span>Email</span><input type="email" inputMode="email" autoComplete="off" value={contactForm.email ?? ''} onChange={e => setContactField('email', e.target.value)} placeholder="name@example.com" /></label>
              <label><span>Phone</span><input type="tel" inputMode="tel" autoComplete="off" value={contactForm.phone ?? ''} onChange={e => setContactField('phone', formatPhoneInput(e.target.value))} placeholder="(555) 123-4567" /></label>

              <div className="field-full form-section-title">Staying in touch</div>
              <label className="sheet-checkbox-row">
                <input
                  type="checkbox"
                  checked={remindersOn(contactForm as Contact)}
                  onChange={e => setContactField('reachOut', e.target.checked === REACH_OUT_DEFAULT_CATEGORIES.has(contactForm.category ?? '') ? undefined : e.target.checked)}
                />
                <span>Remind me to stay in touch{contactForm.reachOut === undefined ? ` (${contactForm.category ?? 'uncategorized'} default)` : ''}</span>
              </label>
              <label>
                <span>How often</span>
                <select value={contactForm.tier ?? 'Close'} onChange={e => setContactField('tier', e.target.value as ContactTier)} disabled={!remindersOn(contactForm as Contact)}>
                  {TIER_OPTIONS.map(o => <option key={o.tier} value={o.tier}>{o.label}</option>)}
                </select>
              </label>

              <div className="field-full form-section-title">Dates</div>
              <label>
                <span>Next check-up</span>
                <DatePicker
                  value={contactForm.nextCheckup}
                  onChange={v => setContactField('nextCheckup', v)}
                  placeholder="Pick a date"
                />
              </label>
              <label>
                <span>Birthday</span>
                <DatePicker
                  value={contactForm.birthday ? `${contactForm.birthYear ?? 2000}-${contactForm.birthday}` : undefined}
                  onChange={iso => {
                    const [y, m, d] = iso.split('-');
                    setContactForm(prev => ({ ...prev, birthday: `${m}-${d}`, birthYear: Number(y) }));
                  }}
                  placeholder="Select date"
                  displayLabel={contactForm.birthday && !contactForm.birthYear ? formatBirthdayOnly(contactForm.birthday) : undefined}
                />
              </label>

              <label className="field-full crm-location-field">
                <span>Location</span>
                <input
                  value={locationDraft}
                  placeholder="City or full address"
                  onChange={e => { setLocationDraft(e.target.value); setShowLocationSuggest(true); }}
                  onFocus={() => setShowLocationSuggest(true)}
                  onBlur={() => window.setTimeout(() => setShowLocationSuggest(false), 120)}
                />
                {showLocationSuggest && locationSuggestions.length > 0 && (
                  <div className="location-suggest-list">
                    {locationSuggestions.map(s => (
                      <button type="button" key={s} onMouseDown={() => { setLocationDraft(s); setShowLocationSuggest(false); }}>
                        <MapPin size={12} /> {s}
                      </button>
                    ))}
                  </div>
                )}
              </label>
            </div>

            {/* Optional detail folds away so a new contact is just a name plus a way to reach
                them. Each section starts open when it already holds something (editing). */}
            <details className="cf-more" open={Boolean(contactForm.linkedin || contactForm.instagram || contactForm.facebook) || undefined}>
              <summary>
                <span>Social links</span>
                <small>{[contactForm.linkedin && 'LinkedIn', contactForm.instagram && 'Instagram', contactForm.facebook && 'Facebook'].filter(Boolean).join(' · ') || 'LinkedIn, Instagram, Facebook'}</small>
                <ChevronDown size={16} />
              </summary>
              <div className="form-grid cf-grid">
                <label><span>LinkedIn</span><input type="url" value={contactForm.linkedin ?? ''} onChange={e => setContactField('linkedin', e.target.value)} placeholder="https://linkedin.com/in/…" /></label>
                <label><span>Instagram</span><input type="url" value={contactForm.instagram ?? ''} onChange={e => setContactField('instagram', e.target.value)} placeholder="https://instagram.com/…" /></label>
                <label className="field-full"><span>Facebook</span><input type="url" value={contactForm.facebook ?? ''} onChange={e => setContactField('facebook', e.target.value)} placeholder="https://facebook.com/…" /></label>
              </div>
            </details>

            <details className="cf-more" open={(contactForm.tags ?? []).length > 0 || undefined}>
              <summary>
                <span>Tags</span>
                <small>{(contactForm.tags ?? []).length ? (contactForm.tags ?? []).join(' · ') : 'Specific context — not another category'}</small>
                <ChevronDown size={16} />
              </summary>
              <div className="tag-pill-input">
                {(contactForm.tags ?? []).map(tag => (
                  <span className="tag-pill" key={tag}>
                    {tag}
                    <button type="button" onClick={() => removeTagFromForm(tag)} aria-label={`Remove ${tag}`}><X size={11} /></button>
                  </span>
                ))}
                <input
                  value={tagDraft}
                  aria-label="Add a tag"
                  placeholder={(contactForm.tags ?? []).length ? 'Add another…' : 'e.g. AI-Engineering, Chess, Local…'}
                  onChange={e => setTagDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTagToForm(tagDraft); }
                    else if (e.key === 'Backspace' && !tagDraft && (contactForm.tags ?? []).length) removeTagFromForm((contactForm.tags ?? [])[(contactForm.tags ?? []).length - 1]);
                  }}
                />
              </div>
              <div className="tag-example-groups">
                {TAG_EXAMPLE_GROUPS.map(group => (
                  <div className="tag-example-group" key={group.label}>
                    <span className="tag-example-group-label">{group.label}</span>
                    {group.examples.filter(t => !(contactForm.tags ?? []).includes(t)).map(t => (
                      <button type="button" key={t} onClick={() => addTagToForm(t)}>+ {t}</button>
                    ))}
                  </div>
                ))}
              </div>
            </details>

            <details className="cf-more" open={!isEmptyHtml(contactForm.personalNotes ?? '') || !isEmptyHtml(contactForm.businessNotes ?? '') || undefined}>
              <summary>
                <span>Notes</span>
                <small>Personal and business</small>
                <ChevronDown size={16} />
              </summary>
              <div className="form-grid cf-grid">
                <label className="field-full">
                  <span>Personal</span>
                  <RichTextEditor
                    value={contactForm.personalNotes ?? ''}
                    onChange={v => setContactField('personalNotes', v)}
                    placeholder="Likes, dislikes, family details, anything personal…"
                  />
                </label>
                <label className="field-full">
                  <span>Business</span>
                  <RichTextEditor
                    value={contactForm.businessNotes ?? ''}
                    onChange={v => setContactField('businessNotes', v)}
                    placeholder="Deals, work history, professional context…"
                  />
                </label>
              </div>
            </details>
          </div>
        </Modal>
      )}

      {contactCropSrc && (
        <PhotoCropModal
          src={contactCropSrc}
          onCancel={() => setContactCropSrc(null)}
          onSave={dataUrl => { setContactField('photoUrl', dataUrl); setContactCropSrc(null); }}
        />
      )}

      {selectedContact && (
        <PersonPageModal
          contact={selectedContact}
          interactions={interactions.filter(i => i.contactId === selectedContact.id).sort((a, b) => b.date.localeCompare(a.date))}
          status={statusByContact.get(selectedContact.id) ?? { status: contactStatus(selectedContact, undefined, today) }}
          today={today}
          onClose={() => setSelectedContactId(null)}
          onPatch={patch => void upsert('contacts', { ...selectedContact, ...patch })}
          onAddInteraction={patch => void addInteractionFromPerson(selectedContact.id, patch)}
          onDeleteInteraction={deleteInteraction}
          onEdit={() => startEditContact(selectedContact)}
        />
      )}

      {showQuickLog && (
        <Modal
          eyebrow="Life OS"
          title="Quick log"
          onClose={closeQuickLog}
          footer={<>
            <button type="button" className="btn ghost" onClick={closeQuickLog}>Cancel</button>
            <button type="button" className="btn teal" onClick={() => void saveQuickLog()} disabled={!quickLogContactId || !(quickLogForm.summary ?? '').trim()}>Save</button>
          </>}
        >
          {!quickLogContactId ? (
            <div className="crm-quicklog-picker">
              <div className="crm-search">
                <Search size={14} />
                <input type="text" autoFocus placeholder="Type a name…" value={quickLogSearch} onChange={e => setQuickLogSearch(e.target.value)} />
              </div>
              <div className="crm-quicklog-candidates">
                {quickLogCandidates.length ? quickLogCandidates.map(c => (
                  <button type="button" key={c.id} className="crm-quicklog-candidate" onClick={() => setQuickLogContactId(c.id)}>
                    <ContactAvatar contact={c} size="small" />
                    <span>{c.name}</span>
                  </button>
                )) : <EmptyState>No matching contacts.</EmptyState>}
              </div>
            </div>
          ) : (
            <div className="form-grid">
              <div className="field-full crm-quicklog-selected">
                <span>Logging for <b>{contacts.find(c => c.id === quickLogContactId)?.name}</b></span>
                <button type="button" className="text-btn" onClick={() => setQuickLogContactId(null)}>Change</button>
              </div>
              <label>
                <span>Type</span>
                <select value={quickLogForm.type ?? 'Check-in'} onChange={e => setQuickLogForm(prev => ({ ...prev, type: e.target.value as InteractionType }))}>
                  {INTERACTION_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label><span>Date</span><DatePicker value={quickLogForm.date} onChange={v => setQuickLogForm(prev => ({ ...prev, date: v }))} /></label>
              <label className="field-full">
                <span>What happened</span>
                <input
                  autoFocus
                  placeholder="One line is fine — e.g. Coffee, talked about her new job"
                  value={quickLogForm.summary ?? ''}
                  onChange={e => setQuickLogForm(prev => ({ ...prev, summary: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') void saveQuickLog(); }}
                />
              </label>
            </div>
          )}
        </Modal>
      )}

      {confirmDeleteContact && (
        <Modal
          eyebrow="Life OS"
          title="Delete contact"
          onClose={() => setConfirmDeleteContact(null)}
          footer={<>
            <button type="button" className="btn ghost" onClick={() => setConfirmDeleteContact(null)}>Cancel</button>
            <button type="button" className="btn danger" onClick={() => void confirmDeleteContactNow()}>Delete</button>
          </>}
        >
          <p>
            Delete {confirmDeleteContact.name}?
            {confirmDeleteContact.count > 0 && ` This also removes ${confirmDeleteContact.count} logged interaction${confirmDeleteContact.count === 1 ? '' : 's'}.`}
            {' '}This cannot be undone.
          </p>
        </Modal>
      )}

      {showBdayQuickAdd && (
        <Modal
          eyebrow="Personal CRM"
          title="Add birthdays"
          onClose={() => setShowBdayQuickAdd(false)}
          footer={<button type="button" className="btn primary" onClick={() => setShowBdayQuickAdd(false)}>Done</button>}
        >
          <p className="muted crm-bday-quick-hint">Pick a date for anyone you know. Each one saves as soon as it's set; skip the rest.</p>
          <div className="crm-bday-quick">
            {activeContacts.filter(c => !c.birthday || bdayQuickTouched.has(c.id)).sort((a, b) => a.name.localeCompare(b.name)).map(c => (
              <div className="crm-bday-quick-row" key={c.id}>
                <ContactAvatar contact={c} size="small" />
                <span>{c.name}</span>
                <DatePicker
                  value={c.birthday ? `${c.birthYear ?? 2000}-${c.birthday}` : undefined}
                  onChange={iso => {
                    const [y, m, d] = iso.split('-');
                    setBdayQuickTouched(prev => new Set(prev).add(c.id));
                    void upsert('contacts', { ...c, birthday: `${m}-${d}`, birthYear: Number(y) });
                  }}
                  placeholder="Birthday"
                />
              </div>
            ))}
          </div>
        </Modal>
      )}

      {showFilterSheet && (
        <Sheet title="Filter by category" onClose={() => setShowFilterSheet(false)}>
          <div className="crm-filter-sheet">
            {renderCategoryPicker(() => setShowFilterSheet(false))}
          </div>
          <div className="crm-filter-sheet-actions">
            <button type="button" className="btn ghost small" onClick={() => { setTagFilter('All'); setShowFilterSheet(false); }}>
              Clear filter
            </button>
            <button type="button" className="btn ghost small" onClick={() => { setShowFilterSheet(false); setShowManageCategories(true); }}>
              <Pencil size={13} /> Manage
            </button>
            <button type="button" className="btn ghost small" onClick={() => { setShowFilterSheet(false); jumpToNextBirthday(); }}>
              <Cake size={13} /> Birthdays
            </button>
            {missingBirthdays.length > 0 && (
              <button type="button" className="btn ghost small" onClick={() => { setShowFilterSheet(false); setShowBdayQuickAdd(true); }}>
                <Plus size={13} /> Add birthdays
              </button>
            )}
          </div>
        </Sheet>
      )}

      {showManageCategories && (
        <ListManagerModal
          title="Manage Categories"
          subtitle="Rename, remove, or reorder any category — built-in ones just start with a matching icon; renaming one swaps it for a generic icon."
          items={allCategories.map(cat => ({ id: cat, label: cat }))}
          onAdd={addCategory}
          onDelete={deleteCategory}
          onRename={renameCategory}
          onReorder={reorderCategories}
          onClose={() => setShowManageCategories(false)}
          addPlaceholder="e.g. Book Club"
        />
      )}
    </>
  );
}

// ---- Person Page (Memory Bank) ---------------------------------------------

function PersonPageModal({
  contact, interactions, status, today, onClose, onPatch, onAddInteraction, onDeleteInteraction, onEdit
}: {
  contact: Contact;
  interactions: ContactInteraction[];
  status: { status: ContactStatus; lastDate?: string };
  today: string;
  onClose: () => void;
  onPatch: (patch: Partial<Contact>) => void;
  onAddInteraction: (patch: Partial<ContactInteraction>) => void;
  onDeleteInteraction: (id: string) => void;
  onEdit: () => void;
}) {
  const isMobile = useIsMobile();
  // tel:/sms: want digits (and a leading +); stored numbers are free text like "(555) 123-4567".
  const dialable = contact.phone ? contact.phone.replace(/[^\d+]/g, '') : '';
  const [logForm, setLogForm] = useState<Partial<ContactInteraction>>(blankInteraction());
  const [photoPromptOpen, setPhotoPromptOpen] = useState(false);
  const [photoDraft, setPhotoDraft] = useState('');
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const photoFileRef = useRef<HTMLInputElement>(null);

  const submitLog = () => {
    if (isEmptyHtml(logForm.summary ?? '')) return;
    onAddInteraction(logForm);
    setLogForm(blankInteraction());
  };
  const [feedFilter, setFeedFilter] = useState<FeedFilter>('All');
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);
  // Folded months ("2026-08") and years ("2025") the user has opened.
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());
  const [feedQuery, setFeedQuery] = useState('');
  useEffect(() => { setFeedFilter('All'); setOpenEntryId(null); setOpenGroups(new Set()); setFeedQuery(''); }, [contact.id]);
  const toggleGroup = (key: string) => setOpenGroups(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const lifeEvents = interactions.filter(i => i.type === 'Life Event');
  const feedItems = feedFilter === 'Gifts' ? interactions.filter(i => i.type === 'Gift')
    : feedFilter === 'Life events' ? lifeEvents
    : interactions;
  const feedSearch = feedQuery.trim().toLowerCase();
  const feedHits = feedSearch
    ? feedItems.filter(i => `${i.type} ${plainText(i.summary)} ${formatDate(i.date)}`.toLowerCase().includes(feedSearch))
    : null;
  // Recent entries stay as rows: this month's, and at least the latest few.
  // Older ones fold into one line per month (this year) or per year (earlier years).
  const thisMonth = today.slice(0, 7);
  const thisYear = today.slice(0, 4);
  const firstOlder = feedItems.findIndex(i => i.date.slice(0, 7) < thisMonth);
  let recentCount = Math.max(firstOlder < 0 ? feedItems.length : firstOlder, Math.min(FEED_PREVIEW, feedItems.length));
  // Finish the last month shown rather than splitting it, within reason.
  while (recentCount < feedItems.length && recentCount < FEED_PREVIEW * 2
    && feedItems[recentCount].date.slice(0, 7) === feedItems[recentCount - 1].date.slice(0, 7)) recentCount++;
  const feedRecent = feedHits ?? feedItems.slice(0, recentCount);
  const feedOlder = feedHits ? [] : feedItems.slice(recentCount);
  const olderGroups = groupRuns(feedOlder, i => (i.date.slice(0, 4) === thisYear ? i.date.slice(0, 7) : i.date.slice(0, 4)));
  const showMonths = new Set(feedRecent.map(i => i.date.slice(0, 7))).size > 1;
  // One line per entry; click to read it in full. Only one is open at a time.
  const renderFeedEntry = (i: ContactInteraction) => (
    <li key={i.id} className={`crm-feed-item ${openEntryId === i.id ? 'open' : ''}`}>
      <button
        type="button"
        className="crm-feed-row"
        onClick={() => setOpenEntryId(id => (id === i.id ? null : i.id))}
        aria-expanded={openEntryId === i.id}
      >
        <b>{i.type === 'Gift' ? `Gift ${(i.giftDirection ?? 'Given').toLowerCase()}` : i.type}</b>
        <span className="crm-feed-date">{relativeDay(i.date, today)}</span>
        {openEntryId !== i.id && <span className="crm-feed-preview">{plainText(i.summary)}</span>}
        <ChevronRight size={14} className="crm-feed-chevron" />
      </button>
      {openEntryId === i.id && (
        <div className="crm-feed-open">
          <div className="crm-feed-body rte-display" dangerouslySetInnerHTML={{ __html: i.summary }} />
          <div className="crm-feed-open-actions">
            <span>{formatDate(i.date)}</span>
            <button type="button" className="text-btn danger" onClick={() => { onDeleteInteraction(i.id); setOpenEntryId(null); }}><Trash2 size={12} /> Delete</button>
          </div>
        </div>
      )}
    </li>
  );
  const gifts = interactions.filter(i => i.type === 'Gift');
  const age = ageFromBirthYear(contact.birthYear, contact.birthday, today);
  const socials: [string, string | undefined][] = [['LinkedIn', contact.linkedin], ['Instagram', contact.instagram], ['Facebook', contact.facebook]];

  const openPhotoPrompt = () => { setPhotoDraft(contact.photoUrl ?? ''); setPhotoPromptOpen(true); };
  const savePhoto = () => { onPatch({ photoUrl: photoDraft.trim() || undefined }); setPhotoPromptOpen(false); };
  // A freshly-picked file goes straight into the cropper (using the full working-resolution
  // copy, not yet the final small square) rather than being saved as-is — that's the whole
  // point of the crop feature, so it should apply to a new upload too, not only an existing photo.
  const uploadPhoto = async (file: File) => {
    try {
      setCropSrc(await fileToCompressedDataUrl(file));
    } catch {
      /* unreadable file — leave the prompt open so the URL field is still usable */
    }
  };

  return (
  <>
    <DetailPanel
      eyebrow="Personal CRM"
      title={contact.name}
      onClose={onClose}
      footer={<button type="button" className="btn ghost" onClick={onEdit}><Pencil size={14} /> Edit details</button>}
    >
      <div className="crm-person-head">
        <button type="button" className="crm-contact-avatar-edit" onClick={openPhotoPrompt} aria-label="Add or change photo" title="Add or change photo">
          <ContactAvatar contact={contact} size="large" />
          <span className="crm-contact-avatar-edit-badge"><Camera size={11} /></span>
        </button>
        <div className="crm-person-head-meta">
          <label className="crm-reminder-switch" title={contact.reachOut === undefined ? `Following the ${contact.category ?? 'uncategorized'} default` : 'Set for this contact'}>
            <input
              type="checkbox"
              checked={remindersOn(contact)}
              onChange={e => onPatch({ reachOut: e.target.checked === REACH_OUT_DEFAULT_CATEGORIES.has(contact.category ?? '') ? undefined : e.target.checked })}
            />
            <span className="crm-switch-track"><span /></span>
            <span>Remind me to stay in touch</span>
            {contact.reachOut === undefined && <small>{contact.category ?? 'Uncategorized'} default</small>}
          </label>
          {remindersOn(contact) && (
            <label className="crm-tier-picker">
              <span>Every</span>
              <select value={contact.tier} onChange={e => onPatch({ tier: e.target.value as ContactTier })}>
                {TIER_OPTIONS.map(o => <option key={o.tier} value={o.tier}>{o.label}</option>)}
              </select>
            </label>
          )}
          <div className="crm-person-head-line">
            {status.status !== 'Off' && <Badge tone={STATUS_BADGE_TONE[status.status]}>{status.status}</Badge>}
            {contact.nextCheckup
              ? <span className="crm-contact-tier">Next check-up {formatDate(contact.nextCheckup)}</span>
              : status.status !== 'Off' && <span className="crm-contact-tier">No check-up scheduled</span>}
            {status.lastDate && <span className="muted">Last contact {relativeDay(status.lastDate, today).toLowerCase()}</span>}
          </div>
          <div className="crm-person-head-facts">
            {(contact.company || contact.role) && <span><Briefcase size={13} /> {[contact.role, contact.company].filter(Boolean).join(' at ')}</span>}
            {contact.email && <span><Mail size={13} /> {contact.email}</span>}
            {contact.phone && <span><Phone size={13} /> {contact.phone}</span>}
            {(contact.address || contact.city || contact.region) && <span><MapPin size={13} /> {contact.address || [contact.city, contact.region].filter(Boolean).join(', ')}</span>}
            {contact.birthday && <span><Cake size={13} /> {formatBirthdayOnly(contact.birthday)}{age != null ? ` · ${age} years old` : ''}</span>}
            {socials.some(([, url]) => url) && (
              <span className="crm-person-socials">
                <Link2 size={13} />
                {socials.filter(([, url]) => url).map(([label, url], i) => (
                  <span key={label}>{i > 0 && ' · '}<a href={url} target="_blank" rel="noreferrer">{label}</a></span>
                ))}
              </span>
            )}
          </div>
          {(contact.tags ?? []).length > 0 && (
            <div className="crm-person-tags">
              {(contact.tags ?? []).map(t => <span className="sb-tag-chip static" key={t}>{t}</span>)}
            </div>
          )}
        </div>
      </div>

      {/* On a phone the point of opening a contact is usually to reach them — one tap into the
          dialer / messages / mail app, the same way the native Contacts app leads with these. */}
      {isMobile && (contact.phone || contact.email) && (
        <div className="crm-quick-actions">
          {dialable && <a className="crm-quick-action" href={`tel:${dialable}`}><Phone size={20} /><span>Call</span></a>}
          {dialable && <a className="crm-quick-action" href={`sms:${dialable}`}><MessageCircle size={20} /><span>Text</span></a>}
          {contact.email && <a className="crm-quick-action" href={`mailto:${contact.email}`}><Mail size={20} /><span>Email</span></a>}
        </div>
      )}

      {contact.howWeMet && (
        <div className="crm-person-section">
          <h3>How we met</h3>
          <p>{contact.howWeMet}</p>
        </div>
      )}

      {/* Composer: write first, then pick type/date and log (Ctrl+Enter works too). */}
      <div className="crm-person-section">
        <h3>Log an interaction</h3>
        <div
          className="crm-composer"
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitLog(); } }}
        >
          <RichTextEditor
            placeholder="What happened…"
            value={logForm.summary ?? ''}
            onChange={v => setLogForm(prev => ({ ...prev, summary: v }))}
            toolbar={false}
            compact
          />
          <div className="crm-composer-bar">
            <select className="crm-composer-select" value={logForm.type ?? 'Check-in'} onChange={e => setLogForm(prev => ({ ...prev, type: e.target.value as InteractionType }))} aria-label="Interaction type">
              {INTERACTION_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            {logForm.type === 'Gift' && (
              <select className="crm-composer-select" value={logForm.giftDirection ?? 'Given'} onChange={e => setLogForm(prev => ({ ...prev, giftDirection: e.target.value as 'Given' | 'Received' }))} aria-label="Given or received">
                <option value="Given">Given</option>
                <option value="Received">Received</option>
              </select>
            )}
            <DatePicker value={logForm.date} onChange={v => setLogForm(prev => ({ ...prev, date: v }))} displayLabel={logForm.date === today ? 'Today' : undefined} />
            <button type="button" className="btn teal small crm-composer-log" onClick={submitLog} disabled={isEmptyHtml(logForm.summary ?? '')} title="Log (Ctrl+Enter)">Log</button>
          </div>
        </div>
      </div>

      {/* One feed for everything; gifts and life events are filters, not separate lists. */}
      <div className="crm-person-section">
        <div className="crm-feed-title">
          <h3>Timeline <span className="crm-feed-count">{interactions.length}</span></h3>
          {(gifts.length > 0 || lifeEvents.length > 0) && (
            <div className="crm-feed-filters">
              {(['All', ...(gifts.length ? ['Gifts'] : []), ...(lifeEvents.length ? ['Life events'] : [])] as FeedFilter[]).map(f => (
                <button type="button" key={f} className={feedFilter === f ? 'on' : ''} onClick={() => setFeedFilter(f)}>{f}</button>
              ))}
            </div>
          )}
        </div>
        {interactions.length >= FEED_SEARCH_MIN && (
          <label className="crm-feed-search">
            <Search size={13} />
            <input
              type="search"
              placeholder={`Search ${interactions.length} entries…`}
              value={feedQuery}
              onChange={e => setFeedQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape' && feedQuery) { e.stopPropagation(); setFeedQuery(''); } }}
            />
            {feedQuery && <button type="button" className="icon-btn" onClick={() => setFeedQuery('')} aria-label="Clear search"><X size={12} /></button>}
          </label>
        )}
        {interactions.length ? (
          <>
            {feedHits && <p className="crm-feed-hits">{feedHits.length ? `${feedHits.length} match${feedHits.length === 1 ? '' : 'es'}` : 'No entries match.'}</p>}
            <ol className="crm-feed">
              {feedRecent.map((i, idx) => (
                <Fragment key={i.id}>
                {/* Month headings once the entries span more than one month. */}
                {showMonths && (idx === 0 || i.date.slice(0, 7) !== feedRecent[idx - 1].date.slice(0, 7)) && (
                  <li className="crm-feed-month">{monthLabel(i.date.slice(0, 7))}</li>
                )}
                {renderFeedEntry(i)}
                </Fragment>
              ))}
              {olderGroups.map(g => {
                const open = openGroups.has(g.key);
                const isYear = g.key.length === 4;
                return (
                  <li key={g.key} className={`crm-feed-group ${open ? 'open' : ''}`}>
                    <button type="button" className="crm-feed-group-row" onClick={() => toggleGroup(g.key)} aria-expanded={open}>
                      <b>{isYear ? g.key : `${monthLabel(g.key)}${g.key === feedRecent[feedRecent.length - 1]?.date.slice(0, 7) ? ' (earlier)' : ''}`}</b>
                      <span>{feedSummary(g.items)}</span>
                      <ChevronRight size={14} className="crm-feed-chevron" />
                    </button>
                    {open && (
                      <ol className="crm-feed-sub">
                        {isYear
                          ? groupRuns(g.items, i => i.date.slice(0, 7)).map(m => {
                            const mOpen = openGroups.has(m.key);
                            return (
                              <li key={m.key} className={`crm-feed-group ${mOpen ? 'open' : ''}`}>
                                <button type="button" className="crm-feed-group-row" onClick={() => toggleGroup(m.key)} aria-expanded={mOpen}>
                                  <b>{monthLabel(m.key).replace(/ \d{4}$/, '')}</b>
                                  <span>{feedSummary(m.items)}</span>
                                  <ChevronRight size={14} className="crm-feed-chevron" />
                                </button>
                                {mOpen && <ol className="crm-feed-sub">{m.items.map(renderFeedEntry)}</ol>}
                              </li>
                            );
                          })
                          : g.items.map(renderFeedEntry)}
                      </ol>
                    )}
                  </li>
                );
              })}
            </ol>
          </>
        ) : <p className="crm-feed-empty">Nothing logged yet. Your first check-in will show up here.</p>}
      </div>

      {/* Notes are reference material — folded away under the everyday actions, with a preview. */}
      <details className="crm-notes-fold" open={!isEmptyHtml(contact.personalNotes ?? '')}>
        <summary><span>Personal notes</span><small>{notePreview(contact.personalNotes) || 'Likes, family, anything personal'}</small></summary>
        <RichTextEditor
          value={contact.personalNotes ?? ''}
          onChange={v => onPatch({ personalNotes: v })}
          placeholder="Likes, dislikes, family details, anything personal…"
        />
      </details>
      <details className="crm-notes-fold" open={!isEmptyHtml(contact.businessNotes ?? '')}>
        <summary><span>Business notes</span><small>{notePreview(contact.businessNotes) || 'Deals, work history, context'}</small></summary>
        <RichTextEditor
          value={contact.businessNotes ?? ''}
          onChange={v => onPatch({ businessNotes: v })}
          placeholder="Deals, work history, professional context…"
        />
      </details>
    </DetailPanel>
    {photoPromptOpen && (
      <Modal
        eyebrow="Personal CRM"
        title="Contact photo"
        onClose={() => setPhotoPromptOpen(false)}
        footer={<>
          {contact.photoUrl && (
            <button type="button" className="btn ghost danger" onClick={() => { onPatch({ photoUrl: undefined }); setPhotoPromptOpen(false); }}>Remove photo</button>
          )}
          <button type="button" className="btn ghost" onClick={() => setPhotoPromptOpen(false)}>Cancel</button>
          <button type="button" className="btn teal" onClick={savePhoto}>Save</button>
        </>}
      >
        <label><span>Photo URL</span><input type="text" autoFocus value={photoDraft} onChange={e => setPhotoDraft(e.target.value)} placeholder="https://…" /></label>
        <div className="crm-photo-upload-row">
          <span className="muted">or</span>
          <input
            ref={photoFileRef} type="file" accept="image/*" hidden
            onChange={e => { const file = e.target.files?.[0]; if (file) void uploadPhoto(file); e.target.value = ''; }}
          />
          <button type="button" className="btn ghost small" onClick={() => photoFileRef.current?.click()}>
            <Upload size={13} /> Upload a photo
          </button>
          {contact.photoUrl && (
            <button type="button" className="btn ghost small" onClick={() => setCropSrc(contact.photoUrl!)}>
              Adjust crop
            </button>
          )}
        </div>
      </Modal>
    )}
    {cropSrc && (
      <PhotoCropModal
        src={cropSrc}
        onCancel={() => setCropSrc(null)}
        onSave={dataUrl => { onPatch({ photoUrl: dataUrl }); setCropSrc(null); setPhotoPromptOpen(false); }}
      />
    )}
  </>
  );
}
