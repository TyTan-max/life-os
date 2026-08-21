import { useCallback, useEffect, useState } from 'react';

function readLocal<T>(key: string): T[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as T[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function useLocalCollection<T extends { id: string }>(key: string) {
  const [items, setItems] = useState<T[]>(() => readLocal<T>(key));

  useEffect(() => {
    window.localStorage.setItem(key, JSON.stringify(items));
  }, [key, items]);

  const add = useCallback((item: T) => setItems(prev => [...prev, item]), []);
  const update = useCallback((item: T) => setItems(prev => prev.map(i => (i.id === item.id ? item : i))), []);
  const remove = useCallback((id: string) => setItems(prev => prev.filter(i => i.id !== id)), []);

  return { items, add, update, remove };
}
