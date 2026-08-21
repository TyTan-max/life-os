import { useMemo, useState } from 'react';
import {
  Archive, Briefcase, Cake, CalendarCheck, CalendarDays, ChevronLeft, ChevronRight, CircleSlash, Gift, GraduationCap,
  Handshake, Home, LayoutGrid, Link2, Mail, MapPin, Medal, MessageCircle, Pencil, Phone,
  Plus, Search, Send, SlidersHorizontal, Sparkles, Star, Table2, Tag as TagIcon, Trash2, UserPlus, Users, Wrench, X
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
import { SortableTh, toggleSort } from '../components/SortableTh';
import type { SortState } from '../components/SortableTh';
import type { Contact, ContactInteraction, ContactCategory, InteractionType } from '../types';
import { CONTACT_CATEGORIES, INTERACTION_TYPES } from '../types';
import {
  lastContactedDate, contactStatus, daysBetween, daysUntilNextBirthday, ageFromBirthYear,
  STATUS_PRIORITY, STATUS_BADGE_TONE
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

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

const AVATAR_PALETTE = ['#4f5bd5', '#0f9488', '#c47a05', '#e5484d', '#7c4fd6', '#2563eb', '#1a8a53', '#d6409f'];
function avatarColorFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
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
const CRM_VIEWS: { key: CrmView; icon: typeof LayoutGrid }[] = [
  { key: 'Overview', icon: LayoutGrid },
  { key: 'Details', icon: Table2 },
  { key: 'Calendar', icon: CalendarDays },
  { key: 'Reach out', icon: Send }
];

type DetailsSortKey = 'name' | 'email' | 'socialProfiles' | 'address' | 'category' | 'lastContact';

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
  // "All" shows the full fixed preset roster (even 0-count tags) plus any ad-hoc tags in use;
  // "Used" shows that same set ranked by actual usage, busiest first.
  // Defaults to "Used" on a phone: a sheet listing 14 categories where most read 0 is mostly
  // scrolling. The toggle is right there if the full taxonomy is wanted.
  const [tagViewMode, setTagViewMode] = useState<'All' | 'Used'>(
    () => (typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches ? 'Used' : 'All')
  );
  const [detailsSort, setDetailsSort] = useState<SortState<DetailsSortKey>>({ key: 'name', dir: 'asc' });

  const now = new Date();
  const [bdayMonth, setBdayMonth] = useState(now.getMonth());
  const [bdayYear, setBdayYear] = useState(now.getFullYear());

  const [showContactForm, setShowContactForm] = useState(false);
  const [editingContactId, setEditingContactId] = useState<string | null>(null);
  const [contactForm, setContactForm] = useState<Partial<Contact>>(blankContact());
  const [locationDraft, setLocationDraft] = useState('');
  const [showLocationSuggest, setShowLocationSuggest] = useState(false);
  const [tagDraft, setTagDraft] = useState('');

  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);

  const [showQuickLog, setShowQuickLog] = useState(false);
  const [quickLogContactId, setQuickLogContactId] = useState<string | null>(null);
  const [quickLogSearch, setQuickLogSearch] = useState('');
  const [quickLogForm, setQuickLogForm] = useState<Partial<ContactInteraction>>(blankInteraction());

  const [confirmDeleteContact, setConfirmDeleteContact] = useState<{ id: string; name: string; count: number } | null>(null);

  // ---- Derived data -------------------------------------------------------

  const activeContacts = contacts.filter(c => !c.archived);

  const statusByContact = useMemo(() => {
    const map = new Map<string, { status: ContactStatus; lastDate?: string }>();
    for (const c of activeContacts) {
      const lastDate = lastContactedDate(c.id, interactions);
      map.set(c.id, { status: contactStatus(c, lastDate, today), lastDate });
    }
    return map;
  }, [activeContacts, interactions, today]);

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
  // multi-tag grouping, where one contact could land in several buckets at once).
  const groupedByTag = useMemo(() => {
    const map = new Map<string, Contact[]>();
    for (const c of tagFilteredContacts) {
      const cat = c.category ?? 'Uncategorized';
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(c);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [tagFilteredContacts]);

  const sortedDetailsContacts = useMemo(() => {
    return tagFilteredContacts.slice().sort((a, b) => {
      let cmp: number;
      switch (detailsSort.key) {
        case 'name': cmp = a.name.localeCompare(b.name); break;
        case 'email': cmp = (a.email ?? '').localeCompare(b.email ?? ''); break;
        case 'socialProfiles': cmp = socialCountOf(a) - socialCountOf(b); break;
        case 'address': cmp = addressOf(a).localeCompare(addressOf(b)); break;
        case 'category': cmp = (a.category ?? '').localeCompare(b.category ?? ''); break;
        case 'lastContact': cmp = (statusByContact.get(a.id)?.lastDate ?? '').localeCompare(statusByContact.get(b.id)?.lastDate ?? ''); break;
      }
      return detailsSort.dir === 'asc' ? cmp : -cmp;
    });
  }, [tagFilteredContacts, detailsSort, statusByContact]);

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
        checkups: activeContacts.filter(c => c.nextCheckup === dateStr)
      };
    });
    const weeks: typeof cells[] = [];
    for (let i = 0; i < 42; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
  }, [bdayMonth, bdayYear, activeContacts, today]);

  const jumpToNextBirthday = () => {
    if (!upcomingBirthdays.length) { setView('Calendar'); return; }
    const target = new Date(`${today}T00:00:00`);
    target.setDate(target.getDate() + upcomingBirthdays[0].days);
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
            className={`crm-tag-row ${tagFilter === tag ? 'active' : ''}`}
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

  return (
    <>
      <PageHeader
        title="Personal CRM"
        subtitle="Keep track of the people in your life — birthdays, last contact, notes."
      />

      <div className="crm-layout">
        {/* The rail costs nothing beside a wide canvas, but stacked on a phone it is a full
            viewport of filter chrome before the first contact — there it becomes a sheet. */}
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
            <button type="button" className="crm-sidebar-btn" onClick={jumpToNextBirthday}>
              <Cake size={15} /> {upcomingBirthdays.length ? `Next — ${upcomingBirthdays[0].contact.name}` : 'Next'}
            </button>
          </div>
        </aside>
        )}

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

          <div className="segmented crm-view-tabs">
            {CRM_VIEWS.map(({ key, icon: Icon }) => (
              <button type="button" key={key} className={view === key ? 'on' : ''} onClick={() => setView(key)}>
                <Icon size={14} /> {key}
              </button>
            ))}
          </div>

          {view === 'Overview' && (
            groupedByTag.length ? (
              <div className="crm-overview">
                {groupedByTag.map(([tag, list]) => {
                  const Icon = categoryIcon(tag);
                  return (
                    <div className="crm-group" key={tag}>
                      <div className="crm-group-head">
                        <Icon size={14} />
                        <b>{tag}</b>
                        <span className="crm-group-count">{list.length}</span>
                      </div>
                      <div className="crm-card-grid">
                        {list.map(c => (
                          <div className="crm-card" key={c.id}>
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
                                <span className="crm-card-avatar" style={{ background: avatarColorFor(c.id) }}>{initials(c.name)}</span>
                                <b>{c.name}</b>
                                {c.email && <small>{c.email}</small>}
                                {c.phone && <small>{c.phone}</small>}
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
                  trailing={c => statusByContact.get(c.id)?.status ?? ''}
                  fields={[
                    { label: 'Last contact', value: c => {
                      const d = statusByContact.get(c.id)?.lastDate;
                      return d ? formatDate(d) : 'Never';
                    } },
                    { label: 'Reach', value: c => c.email || c.phone || '—' }
                  ]}
                  onOpen={c => setSelectedContactId(c.id)}
                  onDelete={requestDeleteContact}
                  deleteLabel={c => `Delete ${c.name}`}
                  empty={contacts.length ? 'No contacts match your filters.' : 'No contacts yet — add your first one.'}
                />
              ) : sortedDetailsContacts.length ? (
                <div className="grid-table-wrap grid-table-scroll">
                  <table className="grid-table">
                    <thead>
                      <tr>
                        <SortableTh label="Name" sortKey="name" state={detailsSort} onSort={k => setDetailsSort(s => toggleSort(s, k))} />
                        <SortableTh label="Email" sortKey="email" state={detailsSort} onSort={k => setDetailsSort(s => toggleSort(s, k))} />
                        <th>Phone</th>
                        <SortableTh label="Social profiles" sortKey="socialProfiles" state={detailsSort} onSort={k => setDetailsSort(s => toggleSort(s, k, 'desc'))} />
                        <SortableTh label="Address" sortKey="address" state={detailsSort} onSort={k => setDetailsSort(s => toggleSort(s, k))} />
                        <SortableTh label="Category" sortKey="category" state={detailsSort} onSort={k => setDetailsSort(s => toggleSort(s, k))} />
                        <th>Status<br /><small>Computed</small></th>
                        <SortableTh label="Last contact" sortKey="lastContact" state={detailsSort} onSort={k => setDetailsSort(s => toggleSort(s, k, 'desc'))} />
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {sortedDetailsContacts.map(c => {
                        const info = statusByContact.get(c.id)!;
                        const socials: [string, string | undefined][] = [['LinkedIn', c.linkedin], ['Instagram', c.instagram], ['Facebook', c.facebook]];
                        return (
                          <tr key={c.id}>
                            <td><button type="button" className="text-btn" onClick={() => setSelectedContactId(c.id)}>{c.name}</button></td>
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
                            <td className="crm-social-cell">
                              {socials.some(([, url]) => url) ? socials.filter(([, url]) => url).map(([label, url]) => (
                                <a key={label} href={url} target="_blank" rel="noreferrer"><Link2 size={11} /> {label}</a>
                              )) : <span className="grid-static-cell">—</span>}
                            </td>
                            <td>{c.address || [c.city, c.region].filter(Boolean).join(', ') || <span className="grid-static-cell">—</span>}</td>
                            <td className="grid-td-compact">
                              <select className="grid-cell-select select-wide" value={c.category ?? ''} onChange={e => patchContact(c, { category: e.target.value || undefined })}>
                                <option value="">—</option>
                                {allCategories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                              </select>
                            </td>
                            <td><Badge tone={STATUS_BADGE_TONE[info.status]}>{info.status}</Badge></td>
                            <td>{info.lastDate ? formatDate(info.lastDate) : <span className="grid-static-cell">Never</span>}</td>
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
              ) : <EmptyState><Users size={22} /> {contacts.length ? 'No contacts match your filters.' : 'No contacts yet — add your first one.'}</EmptyState>}
            </Card>
          )}

          {view === 'Calendar' && (
            <Card>
              <div className="week-card-header">
                <div className="week-card-title"><CalendarDays size={17} /><h2>{MONTH_NAMES[bdayMonth]} {bdayYear}</h2></div>
                <div className="calendar-nav">
                  <button type="button" className="icon-btn" onClick={() => setBdayMonth(m => { if (m === 0) { setBdayYear(y => y - 1); return 11; } return m - 1; })} aria-label="Previous month"><ChevronLeft size={16} /></button>
                  <button type="button" className="btn ghost small" onClick={() => { setBdayMonth(now.getMonth()); setBdayYear(now.getFullYear()); }}>Today</button>
                  <button type="button" className="icon-btn" onClick={() => setBdayMonth(m => { if (m === 11) { setBdayYear(y => y + 1); return 0; } return m + 1; })} aria-label="Next month"><ChevronRight size={16} /></button>
                </div>
              </div>
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
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {view === 'Reach out' && (
            <>
              <div className="kpi-grid four">
                <Kpi label="Contacts" value={activeContacts.length} caption="tracked" tone="default" />
                <Kpi label="Overdue" value={overdueCount} caption="past their cadence" tone={overdueCount ? 'red' : 'green'} />
                <Kpi label="Due Soon" value={dueSoonCount} caption="within the next stretch" tone={dueSoonCount ? 'amber' : 'green'} />
                <Kpi label="Never Contacted" value={neverCount} caption="no interactions logged" tone={neverCount ? 'red' : 'green'} />
              </div>
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
                                <small>{info.lastDate ? `Last contact ${formatDate(info.lastDate)}` : 'Never contacted'}</small>
                              </button>
                              <Badge tone={STATUS_BADGE_TONE[info.status]}>{info.status}</Badge>
                              <button type="button" className="btn ghost small" onClick={() => openQuickLog(c.id)}>Log</button>
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
                ) : <EmptyState>You're all caught up — nobody's overdue or due soon.</EmptyState>}
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
            <button type="button" className="btn ghost" onClick={cancelContactForm}>Cancel</button>
            <button type="button" className="btn teal" onClick={() => void saveContact()}>Save</button>
          </>}
        >
          <div className="contact-form-layout">
            <nav className="contact-category-nav">
              <div className="contact-category-nav-title">Category</div>
              <button
                type="button"
                className={`contact-category-nav-item ${!contactForm.category ? 'active' : ''}`}
                onClick={() => setContactField('category', undefined)}
              >
                <CircleSlash size={14} />
                <span className="ccn-label">Uncategorized</span>
              </button>
              {tagCounts.map(([cat, count]) => {
                const Icon = categoryIcon(cat);
                const active = contactForm.category === cat;
                return (
                  <button
                    type="button"
                    key={cat}
                    className={`contact-category-nav-item ${active ? 'active' : ''}`}
                    onClick={() => setContactField('category', (active ? undefined : cat) as ContactCategory | undefined)}
                  >
                    <Icon size={14} />
                    <span className="ccn-label">{cat}</span>
                    <span className="ccn-count">{count}</span>
                  </button>
                );
              })}
            </nav>

            <div className="form-grid">
              <label className="field-full"><span>Name</span><input value={contactForm.name ?? ''} onChange={e => setContactField('name', e.target.value)} /></label>

              <label>
                <span>Check up</span>
                <DatePicker
                  value={contactForm.nextCheckup}
                  onChange={v => setContactField('nextCheckup', v)}
                  placeholder="Pick a date"
                />
              </label>
              <label><span>Company</span><input value={contactForm.company ?? ''} onChange={e => setContactField('company', e.target.value)} /></label>
              <label>
                <span>Date of birth</span>
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
              <label><span>Role</span><input value={contactForm.role ?? ''} onChange={e => setContactField('role', e.target.value)} /></label>

              <div className="field-full form-section-title">Contact &amp; Social Channels</div>
              <label><span>Email</span><input type="email" value={contactForm.email ?? ''} onChange={e => setContactField('email', e.target.value)} /></label>
              <label><span>Phone</span><input type="tel" value={contactForm.phone ?? ''} onChange={e => setContactField('phone', formatPhoneInput(e.target.value))} /></label>
              <label><span>LinkedIn URL</span><input value={contactForm.linkedin ?? ''} onChange={e => setContactField('linkedin', e.target.value)} /></label>
              <label><span>Instagram URL</span><input value={contactForm.instagram ?? ''} onChange={e => setContactField('instagram', e.target.value)} /></label>
              <label className="field-full"><span>Facebook URL</span><input value={contactForm.facebook ?? ''} onChange={e => setContactField('facebook', e.target.value)} /></label>

              <div className="field-full form-section-title">Location</div>
              <label className="field-full crm-location-field">
                <span>Address, city, region</span>
                <input
                  value={locationDraft}
                  placeholder="e.g. 221B Baker St, London, UK"
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

              <div className="field-full form-section-title">Tags</div>
              <label className="field-full">
                <span>Specific context — not another category</span>
                <div className="tag-pill-input">
                  {(contactForm.tags ?? []).map(tag => (
                    <span className="tag-pill" key={tag}>
                      {tag}
                      <button type="button" onClick={() => removeTagFromForm(tag)} aria-label={`Remove ${tag}`}><X size={11} /></button>
                    </span>
                  ))}
                  <input
                    value={tagDraft}
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
              </label>

              <div className="field-full form-section-title">Notes</div>
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
          </div>
        </Modal>
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
                    <span className="crm-contact-avatar small" style={{ background: avatarColorFor(c.id) }}>{initials(c.name)}</span>
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
  const [logForm, setLogForm] = useState<Partial<ContactInteraction>>(blankInteraction());

  const submitLog = () => {
    if (isEmptyHtml(logForm.summary ?? '')) return;
    onAddInteraction(logForm);
    setLogForm(blankInteraction());
  };

  const lifeEvents = interactions.filter(i => i.type === 'Life Event');
  const gifts = interactions.filter(i => i.type === 'Gift');
  const age = ageFromBirthYear(contact.birthYear, contact.birthday, today);
  const socials: [string, string | undefined][] = [['LinkedIn', contact.linkedin], ['Instagram', contact.instagram], ['Facebook', contact.facebook]];

  return (
    <Modal
      eyebrow="Personal CRM"
      title={contact.name}
      onClose={onClose}
      footer={<button type="button" className="btn ghost" onClick={onEdit}><Pencil size={14} /> Edit details</button>}
    >
      <div className="crm-person-head">
        <span className="crm-contact-avatar large" style={{ background: avatarColorFor(contact.id) }}>{initials(contact.name)}</span>
        <div className="crm-person-head-meta">
          <div className="crm-person-head-line">
            <Badge tone={STATUS_BADGE_TONE[status.status]}>{status.status}</Badge>
            <span className="crm-contact-tier">{contact.nextCheckup ? `Next check-up ${formatDate(contact.nextCheckup)}` : 'No check-up scheduled'}</span>
            {status.lastDate && <span className="muted">Last contact {formatDate(status.lastDate)} ({daysBetween(status.lastDate, today)}d ago)</span>}
          </div>
          <div className="crm-person-head-facts">
            {(contact.company || contact.role) && <span><Briefcase size={13} /> {[contact.role, contact.company].filter(Boolean).join(' at ')}</span>}
            {contact.email && <span><Mail size={13} /> {contact.email}</span>}
            {contact.phone && <span><Phone size={13} /> {contact.phone}</span>}
            {(contact.address || contact.city || contact.region) && <span><MapPin size={13} /> {contact.address || [contact.city, contact.region].filter(Boolean).join(', ')}</span>}
            {contact.birthday && <span><Cake size={13} /> {contact.birthday}{age != null ? ` · ${age} years old` : ''}</span>}
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

      {contact.howWeMet && (
        <div className="crm-person-section">
          <h3>How we met</h3>
          <p>{contact.howWeMet}</p>
        </div>
      )}

      <div className="crm-person-section">
        <h3>Personal notes</h3>
        <RichTextEditor
          value={contact.personalNotes ?? ''}
          onChange={v => onPatch({ personalNotes: v })}
          placeholder="Likes, dislikes, family details, anything personal…"
        />
      </div>

      <div className="crm-person-section">
        <h3>Business notes</h3>
        <RichTextEditor
          value={contact.businessNotes ?? ''}
          onChange={v => onPatch({ businessNotes: v })}
          placeholder="Deals, work history, professional context…"
        />
      </div>

      <div className="crm-person-section">
        <h3>Log an interaction</h3>
        <div className="crm-log-form">
          <select value={logForm.type ?? 'Check-in'} onChange={e => setLogForm(prev => ({ ...prev, type: e.target.value as InteractionType }))}>
            {INTERACTION_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <DatePicker value={logForm.date} onChange={v => setLogForm(prev => ({ ...prev, date: v }))} />
          <RichTextEditor
            placeholder="What happened…"
            value={logForm.summary ?? ''}
            onChange={v => setLogForm(prev => ({ ...prev, summary: v }))}
            toolbar={false}
            compact
          />
          {logForm.type === 'Gift' && (
            <select value={logForm.giftDirection ?? 'Given'} onChange={e => setLogForm(prev => ({ ...prev, giftDirection: e.target.value as 'Given' | 'Received' }))}>
              <option value="Given">Given</option>
              <option value="Received">Received</option>
            </select>
          )}
          <button type="button" className="btn teal small" onClick={submitLog}><Plus size={14} /> Log</button>
        </div>
      </div>

      {gifts.length > 0 && (
        <div className="crm-person-section">
          <h3><Gift size={14} /> Gift Log</h3>
          <div className="crm-timeline">
            {gifts.map(g => (
              <div className="crm-timeline-row" key={g.id}>
                <span className="crm-timeline-date">{formatDate(g.date)}</span>
                <div className="crm-timeline-body">
                  <b>{g.giftDirection ?? 'Given'}:</b> <span className="rte-display" dangerouslySetInnerHTML={{ __html: g.summary }} />
                </div>
                <button type="button" className="icon-btn danger" onClick={() => onDeleteInteraction(g.id)} aria-label="Delete"><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      {lifeEvents.length > 0 && (
        <div className="crm-person-section">
          <h3><Sparkles size={14} /> Life Events</h3>
          <div className="crm-timeline">
            {lifeEvents.map(e => (
              <div className="crm-timeline-row" key={e.id}>
                <span className="crm-timeline-date">{formatDate(e.date)}</span>
                <div className="crm-timeline-body rte-display" dangerouslySetInnerHTML={{ __html: e.summary }} />
                <button type="button" className="icon-btn danger" onClick={() => onDeleteInteraction(e.id)} aria-label="Delete"><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="crm-person-section">
        <h3>Interaction Timeline ({interactions.length})</h3>
        {interactions.length ? (
          <div className="crm-timeline crm-timeline-scroll">
            {interactions.map(i => (
              <div className="crm-timeline-row" key={i.id}>
                <span className="crm-timeline-date">{formatDate(i.date)}</span>
                <span className="crm-timeline-type">{i.type}</span>
                <div className="crm-timeline-body rte-display" dangerouslySetInnerHTML={{ __html: i.summary }} />
                <button type="button" className="icon-btn danger" onClick={() => onDeleteInteraction(i.id)} aria-label="Delete"><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
        ) : <EmptyState>No interactions logged yet.</EmptyState>}
      </div>
    </Modal>
  );
}
