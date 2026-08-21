import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useLocalCollection } from '../hooks/useLocalCollection';
import { generateId } from '../utils/id';
import { Card, EmptyState, Modal, PageHeader } from '../components/UI';
import { DatePicker } from '../components/DatePicker';
import { RichTextEditor } from '../components/RichTextEditor';

const STORAGE_KEY = 'life-os-youtube-analytics-v1';

interface VideoSnapshot {
  id: string;
  date: string;
  title: string;
  views: number;
  subscribersDelta: number;
  notes?: string;
}

function blankSnapshot(): Omit<VideoSnapshot, 'id'> {
  return { date: new Date().toISOString().slice(0, 10), title: '', views: 0, subscribersDelta: 0 };
}

export function YouTubeAnalytics() {
  const { items, add, update, remove } = useLocalCollection<VideoSnapshot>(STORAGE_KEY);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<VideoSnapshot>>(blankSnapshot());

  const snapshots = items.slice().sort((a, b) => b.date.localeCompare(a.date));
  const totalViews = snapshots.reduce((sum, s) => sum + Number(s.views || 0), 0);
  const totalSubs = snapshots.reduce((sum, s) => sum + Number(s.subscribersDelta || 0), 0);

  const startAdd = () => { setForm(blankSnapshot()); setEditingId(null); setShowForm(true); };
  const startEdit = (snapshot: VideoSnapshot) => { setForm({ ...snapshot }); setEditingId(snapshot.id); setShowForm(true); };
  const cancel = () => { setShowForm(false); setEditingId(null); setForm(blankSnapshot()); };

  const save = () => {
    if (editingId) {
      update({ ...(form as VideoSnapshot), id: editingId });
    } else {
      add({ ...(form as Omit<VideoSnapshot, 'id'>), id: generateId() });
    }
    cancel();
  };

  const setField = <K extends keyof VideoSnapshot>(key: K, value: VideoSnapshot[K]) => setForm(prev => ({ ...prev, [key]: value }));

  return (
    <>
      <PageHeader
        title="YouTube Analytics"
        subtitle={`${snapshots.length} tracked uploads`}
        action={!showForm ? <button className="btn primary" onClick={startAdd}><Plus size={16} /> Log upload</button> : undefined}
      />
      <div className="kpi-grid three">
        <Card className="mini-kpi"><span>Uploads</span><strong>{snapshots.length}</strong></Card>
        <Card className="mini-kpi"><span>Total views</span><strong>{totalViews.toLocaleString('en-US')}</strong></Card>
        <Card className="mini-kpi"><span>Subscriber delta</span><strong className={totalSubs >= 0 ? 'positive' : 'negative'}>{totalSubs >= 0 ? '+' : ''}{totalSubs}</strong></Card>
      </div>
      {showForm && (
        <Modal
          eyebrow="Life OS"
          title={editingId ? 'Edit upload' : 'New upload'}
          onClose={cancel}
          footer={<>
            <button type="button" className="btn ghost" onClick={cancel}>Cancel</button>
            <button type="button" className="btn teal" onClick={save}>Save</button>
          </>}
        >
          <div className="form-grid">
            <label><span>Date</span><DatePicker value={form.date} onChange={v => setField('date', v)} /></label>
            <label><span>Title</span><input value={form.title ?? ''} onChange={e => setField('title', e.target.value)} /></label>
            <label><span>Views</span><input type="number" value={form.views ?? 0} onChange={e => setField('views', Number(e.target.value))} /></label>
            <label><span>Subscriber delta</span><input type="number" value={form.subscribersDelta ?? 0} onChange={e => setField('subscribersDelta', Number(e.target.value))} /></label>
            <label className="field-full"><span>Notes</span><RichTextEditor value={form.notes ?? ''} onChange={v => setField('notes', v)} /></label>
          </div>
        </Modal>
      )}
      <Card>
        {snapshots.length ? (
          <div className="record-list">
            {snapshots.map(snapshot => (
              <div className="record-row" key={snapshot.id}>
                <div onClick={() => startEdit(snapshot)}>
                  <b>{snapshot.title || 'Untitled upload'}</b>
                  <small>{snapshot.date} · {snapshot.views.toLocaleString('en-US')} views</small>
                </div>
                <b className={snapshot.subscribersDelta >= 0 ? 'positive' : 'negative'}>
                  {snapshot.subscribersDelta >= 0 ? '+' : ''}{snapshot.subscribersDelta}
                </b>
                <button className="icon-btn danger" onClick={() => remove(snapshot.id)} aria-label="Delete"><Trash2 size={15} /></button>
              </div>
            ))}
          </div>
        ) : <EmptyState>No uploads tracked yet.</EmptyState>}
      </Card>
    </>
  );
}
