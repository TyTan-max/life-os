import { useRef } from 'react';
import { Download, RotateCcw, Upload } from 'lucide-react';
import { useStore } from '../store';
import type { Theme } from '../types';
import { Card, PageHeader } from '../components/UI';

const THEMES: Theme[] = ['light', 'dark', 'system'];

export function Settings() {
  const { data, updateSettings, exportBackup, importBackup, reset } = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const settings = data.settings;

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
          <label><span>Currency</span><input value={settings.currency} onChange={e => void updateSettings({ currency: e.target.value })} /></label>
          <label><span>Daily brief time</span><input type="time" value={settings.dailyBriefTime} onChange={e => void updateSettings({ dailyBriefTime: e.target.value })} /></label>
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
