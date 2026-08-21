import {
  BookOpen, Brain, Calendar as CalendarIcon, Clapperboard, Flame, Gamepad2, HeartPulse,
  LayoutDashboard, Microscope, Plane, Settings as SettingsIcon, TrendingUp, Users, Video, Wallet
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavItem { page: string; icon: LucideIcon; }
export interface NavSection { label: string; items: NavItem[]; }

// Single source of truth for both the desktop sidebar and the mobile More sheet, so the two
// can't drift apart as pages are added or removed.
export const NAV_SECTIONS: NavSection[] = [
  { label: 'Overview', items: [
    { page: 'Dashboard', icon: LayoutDashboard },
    { page: 'Research', icon: Microscope },
    { page: 'Second Brain', icon: Brain }
  ] },
  { label: 'Plan', items: [
    { page: 'Habits', icon: Flame },
    { page: 'Health', icon: HeartPulse },
    { page: 'Finance', icon: Wallet },
    { page: 'Calendar', icon: CalendarIcon }
  ] },
  { label: 'Backlog', items: [
    { page: 'Movies', icon: Clapperboard },
    { page: 'Videogames', icon: Gamepad2 },
    { page: 'Books', icon: BookOpen },
    { page: 'Travel & Bucket List', icon: Plane }
  ] },
  { label: 'Trackers', items: [
    { page: 'Trading Journal', icon: TrendingUp },
    { page: 'YouTube Analytics', icon: Video },
    { page: 'Personal CRM', icon: Users }
  ] },
  { label: '', items: [{ page: 'Settings', icon: SettingsIcon }] }
];

// Destinations with a permanent slot in the mobile tab bar; everything else is one tap away
// under More. The bar sizes its columns from however many entries this holds, so adding or
// removing one needs no CSS change — but past four the labels start truncating at 375px.
export const MOBILE_TABS = ['Dashboard', 'Habits', 'Health', 'Second Brain'];

// Shorter labels for the tab bar, where a full page name would wrap or truncate at ~72px.
export const MOBILE_TAB_LABELS: Record<string, string> = {
  'Second Brain': 'Notes'
};

export const ALL_NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap(section => section.items);

export function navIconFor(page: string): LucideIcon | undefined {
  return ALL_NAV_ITEMS.find(item => item.page === page)?.icon;
}
