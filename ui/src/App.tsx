import { useCallback, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { BotView, Fleet, Tone, api } from './api';
import { BotPage } from './BotPage';
import { CreatePage } from './CreatePage';
import { HomePage } from './HomePage';
import { NotifyButton, useNeedAlerts, useNotifyPref } from './alerts';
import { ago } from './format';
import { Dot, Icon, ToastHost, useNow } from './ui';

type ThemeMode = 'light' | 'dark';

const savedMode = (): ThemeMode => {
  const saved = localStorage.getItem('bitflow-mode');
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

export interface Shared {
  fleet: Fleet;
  reload: () => Promise<void>;
  now: number;
}

export function App() {
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [offline, setOffline] = useState('');
  const [mode, setMode] = useState<ThemeMode>(savedMode);

  useEffect(() => {
    document.documentElement.dataset.mode = mode;
  }, [mode]);

  const [notify, setNotify] = useNotifyPref();
  useNeedAlerts(fleet, notify);

  const load = useCallback(async () => {
    try {
      const next = await api<Fleet>('/api/fleet');
      setFleet(next);
      setOffline('');
    } catch (err) {
      setOffline(err instanceof Error ? err.message : 'Lost connection.');
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 4000);
    return () => clearInterval(id);
  }, [load]);

  const toggle = () => {
    const next = mode === 'dark' ? 'light' : 'dark';
    localStorage.setItem('bitflow-mode', next);
    setMode(next);
  };

  return (
    <div className="nx">
      <ToastHost>
        {!fleet ? (
          <div className="boot">{offline ? <p className="form-err">{offline}</p> : <span className="spinner" aria-label="Loading" />}</div>
        ) : (
          <Shell fleet={fleet} reload={load} offline={offline} mode={mode} toggle={toggle} notify={notify} setNotify={setNotify} />
        )}
      </ToastHost>
    </div>
  );
}

function RailBot({ bot }: { bot: BotView }) {
  return (
    <NavLink to={`/bots/${bot.id}`} className={({ isActive }) => `rl${isActive ? ' on' : ''}`} title={bot.state.detail}>
      <Dot tone={bot.state.tone} />
      <span className="rl-main">
        <span className="rl-t">{bot.pair}</span>
        <span className="rl-s">{bot.state.label}</span>
      </span>
      {bot.preview ? null : bot.mode === 'live' ? <span className="mini live">LIVE</span> : <span className="mini">DRY</span>}
    </NavLink>
  );
}

function Shell({
  fleet,
  reload,
  offline,
  mode,
  toggle,
  notify,
  setNotify,
}: {
  fleet: Fleet;
  reload: () => Promise<void>;
  offline: string;
  mode: ThemeMode;
  toggle: () => void;
  notify: boolean;
  setNotify: (on: boolean) => void;
}) {
  const now = useNow();
  const loc = useLocation();
  const real = fleet.bots.filter((bot) => !bot.preview);
  const previews = fleet.bots.filter((bot) => bot.preview);
  const running = real.filter((bot) => bot.running);
  const newest = running.reduce<string | null>((acc, bot) => (bot.lastCheckAt && (!acc || bot.lastCheckAt > acc) ? bot.lastCheckAt : acc), null);
  const connLabel = !running.length ? '' : newest ? `Checked ${ago(newest, now)}` : 'Starting';
  // The chip takes the worst state among running bots, so a failing read can't hide behind a recent check.
  const RANK: Record<Tone, number> = { good: 0, info: 1, unknown: 2, warn: 3, serious: 4 };
  const connTone = running.reduce<Tone>((worst, bot) => (RANK[bot.state.tone] > RANK[worst] ? bot.state.tone : worst), 'good');
  const connTitle = running
    .map((bot) => `${bot.pair}: ${bot.state.label.toLowerCase()}, checked ${ago(bot.lastCheckAt, now)}${bot.reason ? `. ${bot.reason.text}` : ''}`)
    .join('\n');
  const needCount = fleet.needs.length;
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [loc.pathname]);
  const shared: Shared = { fleet, reload, now };
  return (
    <div className="shell">
      <header className="topbar">
        <NavLink to="/" end className="brand2">
          <span className="brand-mark" />
          <span>Bitflow MM</span>
        </NavLink>
        <span className="spacer" />
        {offline ? (
          <span className="conn bad" title={offline}>
            <Dot tone="serious" />
            Offline
          </span>
        ) : connLabel ? (
          <span className={`conn t-${connTone}`} title={connTitle}>
            <Dot tone={connTone} />
            {connLabel}
          </span>
        ) : null}
        <NotifyButton on={notify} setOn={setNotify} />
        <button type="button" className="ibtn" onClick={toggle} aria-label={mode === 'dark' ? 'Use light theme' : 'Use dark theme'} title="Theme">
          <Icon name={mode === 'dark' ? 'sun' : 'moon'} />
        </button>
      </header>
      <nav className="rail2" aria-label="Main">
        <NavLink to="/" end className={({ isActive }) => `rl rl-top${isActive ? ' on' : ''}`}>
          <Icon name="home" />
          <span className="rl-main">
            <span className="rl-t">Overview</span>
          </span>
          {needCount ? <span className="count">{needCount}</span> : null}
        </NavLink>
        <div className="rail-h">Your bots</div>
        {real.length ? real.map((bot) => <RailBot key={bot.id} bot={bot} />) : <div className="rail-empty">None yet</div>}
        <NavLink to="/new" className={({ isActive }) => `rl rl-top${isActive ? ' on' : ''}`}>
          <Icon name="plus" />
          <span className="rl-main">
            <span className="rl-t">New bot</span>
          </span>
        </NavLink>
        <div className="rail-h">Previews</div>
        {previews.map((bot) => (
          <RailBot key={bot.id} bot={bot} />
        ))}
      </nav>
      <main className="main2">
        {offline ? (
          <div className="page-top banner2 serious">
            <Icon name="warn" />
            <div>
              <b>Offline.</b> Showing the last numbers. Is <code>npm run ui</code> still running?
            </div>
          </div>
        ) : real.some((bot) => bot.mode === 'live' && bot.running) ? (
          <div className="page-top banner2 info">
            <Icon name="info" />
            <div>
              <b>Keep this running.</b> Live bots stop when <code>npm run ui</code> stops: closing its terminal, restarting, or letting the computer sleep all stop them.
            </div>
          </div>
        ) : null}
        <Routes>
          <Route path="/" element={<HomePage {...shared} />} />
          <Route path="/bots/:id" element={<BotPage {...shared} />} />
          <Route path="/new" element={<CreatePage {...shared} />} />
          <Route path="*" element={<HomePage {...shared} />} />
        </Routes>
      </main>
    </div>
  );
}
