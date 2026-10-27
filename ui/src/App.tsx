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

const BOTS_KEY = 'mm.showBots';
const savedShowBots = (): boolean => {
  try {
    return localStorage.getItem(BOTS_KEY) !== '0';
  } catch {
    return true;
  }
};

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
        <span className="rl-t">{bot.name || bot.pair}</span>
        <span className="rl-s">{bot.state.label}</span>
      </span>
      {bot.preview ? null : bot.mode === 'live' ? <span className="mini live">LIVE</span> : <span className="mini dry">DRY</span>}
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

  const needCount = fleet.needs.length;
  const [showSims, setShowSims] = useState(false);
  const [showBots, setShowBotsState] = useState(savedShowBots);
  const setShowBots = (open: boolean) => {
    setShowBotsState(open);
    try {
      localStorage.setItem(BOTS_KEY, open ? '1' : '0');
    } catch {
      // Private windows may refuse storage; the fold still works for this visit.
    }
  };
  // A folded section still lists the bot being viewed, so the rail always shows where you are.
  const current = loc.pathname.startsWith('/bots/') ? decodeURIComponent(loc.pathname.slice('/bots/'.length)) : '';
  const shownBots = showBots ? real : real.filter((bot) => bot.id === current);
  const shownSims = !real.length || showSims ? previews : previews.filter((bot) => bot.id === current);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [loc.pathname]);
  const shared: Shared = { fleet, reload, now };
  return (
    <div className="shell">
      <header className="topbar">
        <NavLink to="/" end className="brand2">
          <span className="brand-mark" />
          <span>Bitflow Market Maker</span>
        </NavLink>
        <span className="spacer" />
        {offline ? (
          <span className="conn bad" title={offline}>
            <Dot tone="serious" />
            Offline
          </span>
        ) : connLabel ? (
          <span className={`conn t-${connTone}`} tabIndex={0} aria-describedby="conn-tip">
            <Dot tone={connTone} />
            {connLabel}
            {/* A native title never shows here: the label changes every second, which resets the browser's hover timer. */}
            <span className="tip" id="conn-tip" role="tooltip">
              <span className="tip-h">Running bots</span>
              {running.map((bot) => (
                <span key={bot.id} className="tip-row">
                  <Dot tone={bot.state.tone} />
                  <span>
                    <b>{bot.pair}</b> · {bot.state.label.toLowerCase()} · checked {ago(bot.lastCheckAt, now)}
                    {bot.reason ? <span className="tip-sub">{bot.reason.text}</span> : null}
                  </span>
                </span>
              ))}
            </span>
          </span>
        ) : null}
        <NotifyButton on={notify} setOn={setNotify} />
        <button type="button" className="ibtn" onClick={toggle} aria-label={mode === 'dark' ? 'Use light theme' : 'Use dark theme'} title="Theme">
          <Icon name={mode === 'dark' ? 'sun' : 'moon'} size={16} />
        </button>
      </header>
      <nav className="rail2" aria-label="Main">
        <NavLink to="/" end className={({ isActive }) => `rl rl-top${isActive ? ' on' : ''}`}>
          <Icon name="home" size={16} />
          <span className="rl-main">
            <span className="rl-t">Overview</span>
          </span>
          {needCount ? <span className="count">{needCount}</span> : null}
        </NavLink>
        {real.length ? (
          <button type="button" className="rail-h rail-toggle" onClick={() => setShowBots(!showBots)} aria-expanded={showBots}>
            Your bots
            <span className={`chev${showBots ? ' open' : ''}`}>
              <Icon name="chevron" size={12} />
            </span>
          </button>
        ) : (
          <div className="rail-h">Your bots</div>
        )}
        {real.length ? shownBots.map((bot) => <RailBot key={bot.id} bot={bot} />) : <div className="rail-empty">None yet</div>}
        <NavLink to="/new" className={({ isActive }) => `rl rl-top${isActive ? ' on' : ''}`}>
          <Icon name="plus" size={16} />
          <span className="rl-main">
            <span className="rl-t">New bot</span>
          </span>
        </NavLink>
        {real.length ? (
          // Once a real bot exists the simulations are reference, so they fold away.
          <button type="button" className="rail-h rail-toggle" onClick={() => setShowSims(!showSims)} aria-expanded={showSims}>
            Simulations
            <span className={`chev${showSims ? ' open' : ''}`}>
              <Icon name="chevron" size={12} />
            </span>
          </button>
        ) : (
          <div className="rail-h">Simulations</div>
        )}
        {shownSims.map((bot) => (
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
