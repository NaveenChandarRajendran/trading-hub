// Short-lived messages in the bottom-right corner (order filled / rejected, hotkey actions). Info closes after 4 s,
// errors after 8 s; at most 4 at a time; each can be closed.
import { useCallback, useState } from 'react';

export interface ToastItem {
  id: number;
  kind: 'info' | 'error';
  text: string;
}

let seq = 0;

export function useToasts(infoMs = 4000, errorMs = 8000) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const push = useCallback((kind: ToastItem['kind'], text: string) => {
    const id = ++seq;
    setItems((l) => [...l.slice(-3), { id, kind, text }]);
    setTimeout(() => dismiss(id), kind === 'error' ? errorMs : infoMs);
  }, [dismiss, infoMs, errorMs]);
  return { items, push, dismiss };
}

export function Toasts({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span>{t.text}</span>
          <button type="button" aria-label="Close" onClick={() => onDismiss(t.id)}>✕</button>
        </div>
      ))}
    </div>
  );
}
