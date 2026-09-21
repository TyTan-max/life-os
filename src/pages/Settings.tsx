import { useRef } from 'react';
import { Download, RotateCcw, Upload } from 'lucide-react';
import { useStore } from '../store';
import type { PhotoQuality, Theme } from '../types';
import { DEFAULT_PHOTO_QUALITY, PHOTO_QUALITY_PRESETS } from '../lib/photoQuality';
import { Card, PageHeader } from '../components/UI';

const THEMES: Theme[] = ['light', 'dark', 'system'];

// A dropdown of real ISO 4217 codes rather than free text — formatCurrency feeds this straight
// into Intl.NumberFormat, which throws on an invalid code, and that function runs on nearly every
// page. Constraining the input here means a bad value can never reach it in the first place.
const CURRENCIES: { code: string; label: string }[] = [
  { code: 'USD', label: 'US Dollar' },
  { code: 'EUR', label: 'Euro' },
  { code: 'GBP', label: 'British Pound' },
  { code: 'CAD', label: 'Canadian Dollar' },
  { code: 'AUD', label: 'Australian Dollar' },
  { code: 'JPY', label: 'Japanese Yen' },
  { code: 'CNY', label: 'Chinese Yuan' },
  { code: 'INR', label: 'Indian Rupee' },
  { code: 'MXN', label: 'Mexican Peso' },
  { code: 'BRL', label: 'Brazilian Real' },
  { code: 'CHF', label: 'Swiss Franc' },
  { code: 'SEK', label: 'Swedish Krona' },
  { code: 'NZD', label: 'New Zealand Dollar' },
  { code: 'SGD', label: 'Singapore Dollar' },
  { code: 'KRW', label: 'South Korean Won' },
  { code: 'VND', label: 'Vietnamese Dong' }
];

// Read-only — Life OS never stores a timezone, it always asks the OS "what's today, right now,
// wherever I currently am," so this is purely a display for reassurance that detection (including
// Daylight Saving Time) is working, not a setting that changes any behavior.
function detectTimezone(): { name: string; abbreviation: string; offset: string } {
  const name = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(now);
  const abbreviation = parts.find(p => p.type === 'timeZoneName')?.value ?? '';
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  const offset = `UTC${sign}${hours}${minutes ? ':' + String(minutes).padStart(2, '0') : ''}`;
  return { name, abbreviation, offset };
}

export function Settings() {
  const { data, updateSettings, exportBackup, importBackup, reset } = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const settings = data.settings;
  const timezone = detectTimezone();

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    try {
      await importBackup(file);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Import failed.');
    }
  };

  const onReset = async () => {
    if (window.confirm('Reset all data back to the sample seed? This cannot be undone.')) {
      await reset();
    }
  };

  return (
    <>
      <PageHeader title="Settings" />
      <Card className="collection-form">
        <div className="form-grid">
          <label><span>Name</span><input value={settings.userName} onChange={e => void updateSettings({ userName: e.target.value })} /></label>
          <label>
            <span>Theme</span>
            <select value={settings.theme} onChange={e => void updateSettings({ theme: e.target.value as Theme })}>
              {THEMES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label>
            <span>Currency</span>
            <select value={settings.currency} onChange={e => void updateSettings({ currency: e.target.value })}>
              {!CURRENCIES.some(c => c.code === settings.currency) && (
                <option value={settings.currency}>{settings.currency}</option>
              )}
              {CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.code} — {c.label}</option>)}
            </select>
          </label>
          <label>
            <span>Daily brief time</span>
            <input
              type="time"
              value={settings.dailyBriefTime}
              onChange={e => void updateSettings({ dailyBriefTime: e.target.value })}
              title="Sends a browser notification with your daily brief at this time each day. Requires 'Enable browser notifications' below."
            />
          </label>
          <label>
            <span>Note photo quality</span>
            <select
              value={settings.photoQuality ?? DEFAULT_PHOTO_QUALITY}
              onChange={e => void updateSettings({ photoQuality: e.target.value as PhotoQuality })}
              title="How much photos pasted or uploaded into Second Brain notes are shrunk. Higher keeps small text readable but uses more storage. Only applies to photos added from now on — existing ones keep the quality they were saved at."
            >
              {(Object.keys(PHOTO_QUALITY_PRESETS) as PhotoQuality[]).map(q => (
                <option key={q} value={q}>{PHOTO_QUALITY_PRESETS[q].label} — {PHOTO_QUALITY_PRESETS[q].hint}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Time Zone</span>
            <input type="text" value={`${timezone.name} — ${timezone.abbreviation} (${timezone.offset})`} disabled title="Detected from your device — adjusts for Daylight Saving Time automatically, no need to change it here." />
          </label>
          <label className="inline">
            <input type="checkbox" checked={settings.notificationsEnabled} onChange={e => void updateSettings({ notificationsEnabled: e.target.checked })} />
            <span>Enable browser notifications</span>
          </label>
          <label className="inline">
            <input type="checkbox" checked={settings.launchAtLogin} onChange={e => void updateSettings({ launchAtLogin: e.target.checked })} />
            <span>Launch at login</span>
          </label>
        </div>
      </Card>
      <Card>
        <h2 className="section-title">Backup</h2>
        <p className="muted">Your data lives entirely in this browser's local storage. Export a backup regularly.</p>
        <div className="form-actions">
          <button className="btn primary" onClick={exportBackup}><Download size={16} /> Export backup</button>
          <button className="btn ghost" onClick={() => fileRef.current?.click()}><Upload size={16} /> Import backup</button>
          <input ref={fileRef} type="file" accept="application/json" hidden onChange={e => void onImport(e.target.files?.[0])} />
          <button className="btn ghost danger" onClick={() => void onReset()}><RotateCcw size={16} /> Reset to sample data</button>
        </div>
      </Card>
    </>
  );
}
