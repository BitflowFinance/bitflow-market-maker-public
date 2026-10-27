import { useEffect, useRef, useState } from 'react';
import { Fleet } from './api';
import { Icon } from './ui';

const KEY = 'bitflow-notify';

const readPref = (): boolean => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};

const writePref = (on: boolean): void => {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // Private windows can refuse storage; the toggle then lasts for this visit only.
  }
};

const supported = (): boolean => typeof window !== 'undefined' && 'Notification' in window;

/** Puts the "Needs you" count in the tab title and, when allowed, notifies on each new item. */
export function useNeedAlerts(fleet: Fleet | null, enabled: boolean): void {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const count = fleet ? fleet.needs.length : 0;
    document.title = count ? `(${count}) Bitflow Market Maker` : 'Bitflow Market Maker';
  }, [fleet]);
  useEffect(() => {
    if (!fleet) return;
    const ids = new Set(fleet.needs.map((need) => need.id));
    // The first load is the current state, not news.
    if (seen.current && enabled && supported() && Notification.permission === 'granted') {
      for (const need of fleet.needs) {
        if (seen.current.has(need.id)) continue;
        try {
          new Notification(`Bitflow Market Maker: ${need.what}`, { body: need.detail, tag: need.id });
        } catch {
          // Some browsers (Android Chrome) only allow notifications from a service worker.
        }
      }
    }
    seen.current = ids;
  }, [fleet, enabled]);
}

export function NotifyButton({ on, setOn }: { on: boolean; setOn: (on: boolean) => void }) {
  if (!supported()) return null;
  const blocked = Notification.permission === 'denied';
  const toggle = async () => {
    if (on) {
      setOn(false);
      return;
    }
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    setOn(permission === 'granted');
  };
  const label = blocked ? 'Notifications are blocked in this browser' : on ? 'Notifications on: click to turn off' : 'Notify me when a bot needs attention';
  return (
    <button type="button" className={`ibtn${on ? ' on' : ''}`} onClick={() => void toggle()} disabled={blocked} aria-label={label} title={label} aria-pressed={on}>
      <Icon name={on ? 'bell' : 'bellOff'} size={16} />
    </button>
  );
}

export function useNotifyPref(): [boolean, (on: boolean) => void] {
  const [on, setOnState] = useState(() => readPref() && supported() && Notification.permission === 'granted');
  const setOn = (next: boolean) => {
    writePref(next);
    setOnState(next);
  };
  return [on, setOn];
}
