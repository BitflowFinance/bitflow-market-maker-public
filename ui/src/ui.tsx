import { ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Tone } from './api';

const PATHS: Record<string, ReactNode> = {
  home: <path d="M2.5 7.2 8 2.8l5.5 4.4V13a.5.5 0 0 1-.5.5H9.6V10H6.4v3.5H3a.5.5 0 0 1-.5-.5z" />,
  bot: (
    <>
      <rect x="2.5" y="4.5" width="11" height="8" rx="2" />
      <path d="M8 4.5V2.5M5.8 8.2h.01M10.2 8.2h.01M6 10.6h4" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  bridge: <path d="M1.8 10.5h12.4M3.5 10.5V7.8a4.5 4.5 0 0 1 9 0v2.7M6.2 10.5V8.4M9.8 10.5V8.4M2.5 5.5l2 1M13.5 5.5l-2 1" />,
  pause: <path d="M5.5 3.5v9M10.5 3.5v9" />,
  play: <path d="M5 3.2v9.6L12.5 8z" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1" />,
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V3.8a1.3 1.3 0 0 0-1.3-1.3H3.8a1.3 1.3 0 0 0-1.3 1.3v5.4a1.3 1.3 0 0 0 1.3 1.3h1.7" />
    </>
  ),
  check: <path d="M3.2 8.4 6.4 11.6 12.8 4.8" />,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  warn: <path d="M8 2.5 14 13H2zM8 6.5v3M8 11.3h.01" />,
  sun: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
    </>
  ),
  moon: <path d="M13 9.8A5.5 5.5 0 0 1 6.2 3a5.5 5.5 0 1 0 6.8 6.8z" />,
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.3" />
      <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
    </>
  ),
  arrow: <path d="M3 8h10M9 4l4 4-4 4" />,
  external: <path d="M9 2.8h4.2V7M13.2 2.8 7.5 8.5M11.5 9.5v3.2a.8.8 0 0 1-.8.8H3.3a.8.8 0 0 1-.8-.8V5.3a.8.8 0 0 1 .8-.8h3.2" />,
  eye: (
    <>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  download: <path d="M8 2.5v7.5M4.8 7 8 10.2 11.2 7M3 12.8h10" />,
  bell: <path d="M4.2 11.2V7.4a3.8 3.8 0 0 1 7.6 0v3.8l1.2 1.3H3zM6.6 13.6a1.5 1.5 0 0 0 2.8 0" />,
  bellOff: <path d="M4.2 11.2V7.4a3.8 3.8 0 0 1 6.6-2.6M11.8 7.6v3.6l1.2 1.3H5.4M3 12.5h1M6.6 13.6a1.5 1.5 0 0 0 2.8 0M2.5 2.5l11 11" />,
  edit: <path d="M10.8 2.7l2.5 2.5-7.6 7.6-3.2.7.7-3.2zM9.6 3.9l2.5 2.5" />,
  reset: <path d="M2.8 8a5.2 5.2 0 1 0 1.6-3.8M2.5 2.5v3h3" />,
  wallet: (
    <>
      <rect x="2" y="4" width="12" height="9" rx="1.5" />
      <path d="M2 6.5h12M10.5 9.5h1.5" />
    </>
  ),
  shield: <path d="M8 2 13 4v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z" />,
  info: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.2v3.8M8 5h.01" />
    </>
  ),
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg className="ico" viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

export const downloadFile = (name: string, text: string, type: string): void => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
};

export function Dot({ tone }: { tone: Tone }) {
  return <span className={`dot2 t-${tone}`} aria-hidden="true" />;
}

export function Status({ tone, label, title }: { tone: Tone; label: string; title?: string }) {
  return (
    <span className={`status t-${tone}`} title={title}>
      <Dot tone={tone} />
      {label}
    </span>
  );
}

export function ModeBadge({ preview, mode }: { preview: boolean; mode: 'dry_run' | 'live' }) {
  if (preview) return <span className="badge b-preview">Simulated</span>;
  if (mode === 'live') return <span className="badge b-live">Live</span>;
  return <span className="badge b-dry">Dry run</span>;
}

export function Money({ value, title }: { value: string; title?: string }) {
  if (value === '—') {
    return (
      <span className="na" title={title || 'Not known yet'}>
        —
      </span>
    );
  }
  return <span className="num">{value}</span>;
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setDone(true);
      setTimeout(() => setDone(false), 1400);
    });
  };
  if (!label) {
    return (
      <button type="button" className={`ibtn sm${done ? ' done' : ''}`} onClick={copy} aria-label="Copy" title={done ? 'Copied' : 'Copy'}>
        <Icon name={done ? 'check' : 'copy'} size={13} />
      </button>
    );
  }
  return (
    <button type="button" className="btn sm" onClick={copy}>
      <Icon name={done ? 'check' : 'copy'} />
      {done ? 'Copied' : label}
    </button>
  );
}

export function Card({ title, aside, children, className = '' }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {title || aside ? (
        <header className="card-h">
          {title ? <h2>{title}</h2> : null}
          {aside ? <div className="card-aside">{aside}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'up' | 'down' }) {
  return (
    <div className="stat">
      <div className="stat-k">{label}</div>
      <div className={`stat-v ${tone ? `s-${tone}` : ''}`}>{value}</div>
      {sub ? <div className="stat-s">{sub}</div> : null}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty2">
      <span className="empty-ico">
        <Icon name={icon} size={18} />
      </span>
      <div>
        <div className="empty-t">{title}</div>
        {children ? <div className="empty-b">{children}</div> : null}
      </div>
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dlg = ref.current;
    if (dlg && !dlg.open) dlg.showModal();
    // A modal dialog does not stop the page behind it from scrolling.
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = before;
      if (dlg && dlg.open) dlg.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal${wide ? ' wide' : ''}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="modal-in">
        <header className="modal-h">
          <h2>{title}</h2>
          <button type="button" className="ibtn" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

/** The single confirm for anything that can move real funds: a checkbox and the exact pool name. */
export function RiskConfirm({
  title,
  lead,
  facts,
  poolName,
  confirmLabel,
  busy,
  disabled,
  error,
  children,
  onClose,
  onConfirm,
}: {
  title: string;
  lead: ReactNode;
  facts: Array<[string, ReactNode]>;
  poolName: string;
  confirmLabel: string;
  busy: boolean;
  /** Keeps the confirm button off for reasons other than being busy, such as nothing picked yet. */
  disabled?: boolean;
  error: string;
  children?: ReactNode;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [ack, setAck] = useState(false);
  const [typed, setTyped] = useState('');
  const ready = ack && typed.trim() === poolName && !busy && !disabled;
  return (
    <Modal title={title} onClose={onClose}>
      <div className="risk-lead">
        <Icon name="warn" size={16} />
        <div>{lead}</div>
      </div>
      <dl className="facts">
        {facts.map(([k, v]) => (
          <div key={k} className="fact-row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {children}
      <label className="check">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>I understand this uses real funds.</span>
      </label>
      <label className="field">
        <span className="field-l">
          Type <b>{poolName}</b> to confirm
        </span>
        <input className="in" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
      </label>
      {error ? <p className="form-err">{error}</p> : null}
      <footer className="modal-f">
        <button type="button" className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn danger" disabled={!ready} onClick={onConfirm}>
          {busy ? 'Working…' : confirmLabel}
        </button>
      </footer>
    </Modal>
  );
}

interface Toast {
  id: number;
  tone: 'good' | 'bad' | 'info';
  text: string;
}

const ToastContext = createContext<(tone: Toast['tone'], text: string) => void>(() => undefined);

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast['tone'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list, { id, tone, text }]);
    setTimeout(() => setToasts((list) => list.filter((item) => item.id !== id)), tone === 'bad' ? 7000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.tone}`}>
            <Icon name={toast.tone === 'bad' ? 'warn' : 'check'} />
            <span>{toast.text}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string; note?: string; disabled?: boolean }>; onChange: (value: T) => void }) {
  return (
    <div className="seg2" role="radiogroup">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={`${value === option.value ? 'on' : ''}${option.disabled ? ' soon' : ''}`}
          onClick={() => onChange(option.value)}
        >
          <span>{option.label}</span>
          {option.note ? <small>{option.note}</small> : null}
        </button>
      ))}
    </div>
  );
}
