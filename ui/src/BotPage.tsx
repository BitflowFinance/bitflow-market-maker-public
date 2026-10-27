import { ReactNode, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { BotView, DecisionRow, HistoryRange, LogLine, ReasonKind, api, explorerAddress, explorerContract, explorerTx } from './api';
import type { Shared } from './App';
import { BinChart, ValueChart } from './charts';
import { ago, clock, countdown, pct, poolName, price, shortAddr, stx, tok, usd } from './format';
import { Card, CopyButton, Dot, Empty, Icon, Modal, ModeBadge, RiskConfirm, Seg, Stat, downloadFile, useToast } from './ui';
import { KeysCard } from './KeysCard';
import { BotTitle, StrategyCard } from './StrategyCard';
import { PoolCard } from './PoolCard';
import { WalletTab } from './WalletTab';

type Tab = 'overview' | 'activity' | 'wallet' | 'safety' | 'settings' | 'actions';

const poolContract = (bot: BotView): string | null => bot.poolContract || (bot.poolId.includes('.') ? bot.poolId : null);

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'activity', label: 'Activity' },
  { id: 'wallet', label: 'Wallet' },
  { id: 'safety', label: 'Safety' },
  { id: 'settings', label: 'Settings' },
  { id: 'actions', label: 'Actions' },
];

export function BotPage({ fleet, reload, now }: Shared) {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  // `manual` was this tab's old name; keep old links and bookmarks working.
  const asked = params.get('tab') === 'manual' ? 'actions' : params.get('tab');
  const tab = (TABS.find((item) => item.id === asked)?.id || 'overview') as Tab;
  useEffect(() => {
    if (params.get('tab') === 'manual') setParams({ tab: 'actions' }, { replace: true });
  }, [params, setParams]);
  const bot = fleet.bots.find((item) => item.id === id);
  if (!bot) {
    return (
      <div className="page">
        <Empty icon="bot" title="Bot not found">
          <Link to="/">Back</Link>
        </Empty>
      </div>
    );
  }
  return (
    <div className="page">
      <Header bot={bot} reload={reload} />
      <StatusLine bot={bot} now={now} />
      <nav className="tabs2" role="tablist">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? 'on' : ''}
            onClick={() => setParams(item.id === 'overview' ? {} : { tab: item.id }, { replace: true })}
          >
            {item.label}
            {item.id === 'wallet' && !bot.preview && !bot.keyBackedUp ? <span className="tab-dot" /> : null}
            {item.id === 'safety' && !bot.preview && bot.checklist.some((check) => !check.ok && check.id !== 'dry-run') ? <span className="tab-dot" /> : null}
          </button>
        ))}
      </nav>
      {tab === 'overview' ? <Overview bot={bot} now={now} /> : null}
      {tab === 'activity' ? <Activity bot={bot} /> : null}
      {tab === 'wallet' ? <WalletTab bot={bot} reload={reload} /> : null}
      {tab === 'safety' ? <Safety bot={bot} /> : null}
      {tab === 'settings' ? <Settings bot={bot} reload={reload} /> : null}
      {tab === 'actions' ? <Manual bot={bot} reload={reload} /> : null}
    </div>
  );
}

const useAction = (reload: () => Promise<void>) => {
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const run = async (name: string, path: string, done: string, body?: unknown): Promise<boolean> => {
    setBusy(name);
    try {
      await api(path, 'POST', body ?? {});
      toast('good', done);
      await reload();
      return true;
    } catch (err) {
      toast('bad', err instanceof Error ? err.message : 'That did not work.');
      return false;
    } finally {
      setBusy('');
    }
  };
  return { busy, run };
};

function Header({ bot, reload }: { bot: BotView; reload: () => Promise<void> }) {
  const { busy, run } = useAction(reload);
  const [confirm, setConfirm] = useState<'' | 'stop' | 'resume'>('');
  const base = `/api/bots/${encodeURIComponent(bot.id)}`;
  return (
    <header className="bot-h">
      <div className="bot-h-main">
        <div className="bot-title">
          <BotTitle bot={bot} reload={reload} />
        </div>
        <div className="bot-meta-clip">
        <dl className="bot-meta">
          <div>
            <dt>Pair</dt>
            <dd>{bot.pair}</dd>
          </div>
          <div>
            <dt>Mode</dt>
            <dd>
              <ModeBadge preview={bot.preview} mode={bot.mode} />
            </dd>
          </div>
          <div>
            <dt>Pool</dt>
            <dd className="mono">
              {/* Simulations carry no contract read; their pool id is already the contract principal. */}
              {poolContract(bot) ? (
                <a className="mono" href={explorerContract(poolContract(bot) || '')} target="_blank" rel="noreferrer" title={poolContract(bot) || ''}>
                  {poolName(bot.poolId)}
                </a>
              ) : (
                <span title={bot.poolId}>{poolName(bot.poolId)}</span>
              )}
            </dd>
          </div>
          {bot.preview || !bot.address ? (
            <div>
              <dt>Wallet</dt>
              <dd className="na">None</dd>
            </div>
          ) : (
            <div>
              <dt>Wallet</dt>
              <dd className="addr">
                <a className="mono" href={explorerAddress(bot.address)} target="_blank" rel="noreferrer" title={bot.address}>
                  {shortAddr(bot.address)}
                </a>
                <CopyButton text={bot.address} />
              </dd>
            </div>
          )}
        </dl>
        </div>
      </div>
      <div className="bot-actions">
        {bot.preview ? (
          <Link to="/new" className="btn primary">
            <Icon name="plus" />
            Create a real bot
          </Link>
        ) : null}
        {!bot.running ? (
          <button key="start" type="button" className={bot.preview ? 'btn' : 'btn primary'} disabled={!!busy} onClick={() => void run('start', `${base}/start`, 'Started.')}>
            <Icon name="play" />
            {busy === 'start' ? 'Starting…' : 'Start'}
          </button>
        ) : bot.paused ? (
          <button key="resume" type="button" className={bot.preview ? 'btn' : 'btn primary'} disabled={!!busy} onClick={() => (bot.mode === 'live' && !bot.preview ? setConfirm('resume') : void run('resume', `${base}/resume`, 'Resumed.'))}>
            <Icon name="play" />
            {busy === 'resume' ? 'Resuming…' : 'Resume'}
          </button>
        ) : (
          <button key="pause" type="button" className="btn" disabled={!!busy} onClick={() => void run('pause', `${base}/pause`, 'Paused.')} title="Stop trading, keep watching">
            <Icon name="pause" />
            {busy === 'pause' ? 'Pausing…' : 'Pause'}
          </button>
        )}
        {bot.running ? (
          <button key="stop" type="button" className="btn" disabled={!!busy} onClick={() => setConfirm('stop')}>
            <Icon name="stop" />
            Stop
          </button>
        ) : null}
      </div>
      {confirm === 'stop' ? (
        <Modal title={`Stop ${bot.pair}?`} onClose={() => setConfirm('')}>
          <p>Your liquidity stays in the pool, unmanaged, until you start the bot again.</p>
          <footer className="modal-f">
            {!bot.paused ? (
              <button type="button" className="btn ghost" onClick={() => void run('pause', `${base}/pause`, 'Paused.').then(() => setConfirm(''))}>
                Pause instead
              </button>
            ) : null}
            <span className="spacer" />
            <button type="button" className="btn ghost" onClick={() => setConfirm('')}>
              Cancel
            </button>
            <button type="button" className="btn danger" disabled={!!busy} onClick={() => void run('stop', `${base}/stop`, 'Stopped.').then(() => setConfirm(''))}>
              {busy === 'stop' ? 'Stopping…' : 'Stop'}
            </button>
          </footer>
        </Modal>
      ) : null}
      {confirm === 'resume' ? (
        <Modal title="Resume live trading?" onClose={() => setConfirm('')}>
          <p>The bot can trade with real funds again from the next check.</p>
          <footer className="modal-f">
            <span className="spacer" />
            <button type="button" className="btn ghost" onClick={() => setConfirm('')}>
              Cancel
            </button>
            <button type="button" className="btn primary" disabled={!!busy} onClick={() => void run('resume', `${base}/resume`, 'Resumed.').then(() => setConfirm(''))}>
              Resume
            </button>
          </footer>
        </Modal>
      ) : null}
    </header>
  );
}

/** One sentence for the status card that never just repeats its label. */
const statusText = (bot: BotView): string => {
  if (!bot.running) return bot.startError || 'The bot is off. Liquidity stays in the pool, unmanaged.';
  if (bot.paused) return 'Watching, not trading. Liquidity stays in the pool.';
  if (!bot.lastCheckAt) return 'Waiting for the first check.';
  if (bot.reasonRaw === 'kill_switch') return bot.state.detail;
  return bot.reason?.text || bot.state.detail;
};

function StatusLine({ bot, now }: { bot: BotView; now: number }) {
  const text = statusText(bot);
  const tone = bot.startError ? 'serious' : bot.state.tone;
  const next = bot.running && !bot.paused && bot.lastCheckAt ? countdown(new Date(bot.lastCheckAt).getTime() + bot.tickIntervalMs, now) : null;
  const checked = bot.lastCheckAt ? `${bot.running ? 'checked' : 'last check'} ${ago(bot.lastCheckAt, now)}` : bot.running ? 'starting…' : '';
  const when = bot.running && !bot.paused && bot.lastCheckAt ? `${checked} · ${next ? `next in ${next}` : 'checking…'}` : checked;
  const chips: string[] = [];
  if (bot.running && bot.wouldSend && !bot.preview && bot.mode === 'dry_run') chips.push('Would trade if live');
  if (bot.readFailures) chips.push(`${bot.readFailures.count} failed read${bot.readFailures.count === 1 ? '' : 's'} in a row · halts at ${bot.readFailures.max}`);
  if (bot.holdingsCarried && bot.holdingsAsOf) chips.push(`Balances from the last good read, ${ago(bot.holdingsAsOf, now)}`);
  return (
    <section className={`statusline t-${tone}`}>
      <Dot tone={tone} />
      <div className="sl-body">
        <div className="sl-head">
          <span className={`sl-label t-${tone}`}>{bot.startError ? 'Didn’t start' : bot.state.label}</span>
          {when ? <span className="sl-when">{when}</span> : null}
        </div>
        <div className="sl-text">{text}</div>
        {chips.length ? (
          <div className="sl-sub">
            {chips.map((chip) => (
              <span key={chip} className="chip">
                {chip}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

const PLAN_LABEL: Record<string, string> = { reposition: 're-centre', derisk: 'sell-down', add: 'add', withdraw: 'withdraw' };

const planLabel = (type: string | null): string => (type ? PLAN_LABEL[type] || type : 'trade');

function Overview({ bot, now }: { bot: BotView; now: number }) {
  const vs = bot.pnlVsHodl;
  const walletValue = bot.portfolioValue != null && bot.inPoolValue != null ? bot.portfolioValue - bot.inPoolValue : null;
  if (bot.portfolioValue == null && bot.price == null && bot.walletBase == null && !bot.bins.length) {
    return (
      <Card>
        <Empty icon="bot" title="No data yet">
          {bot.running ? 'Numbers appear after the first check.' : 'Start the bot to see value, liquidity and holdings.'}
        </Empty>
      </Card>
    );
  }
  const stxPool = bot.baseSymbol === 'STX' || bot.quoteSymbol === 'STX';
  return (
    <div className="grid2 even">
      <Card className="span2">
        <div className="stats">
          <Stat label="Value" value={usd(bot.portfolioValue)} />
          <Stat label="Vs. holding" value={usd(vs, true)} tone={vs == null || vs === 0 ? undefined : vs > 0 ? 'up' : 'down'} />
          <Stat label="In pool" value={usd(bot.inPoolValue)} sub={bot.portfolioValue && bot.inPoolValue != null ? `${pct(bot.inPoolValue / bot.portfolioValue)} of value` : undefined} />
          <Stat
            label={`${bot.baseSymbol} price (${bot.quoteSymbol})`}
            value={price(bot.price, '').trim()}
            sub={bot.market ? `Market ${price(bot.market.refPrice, '').trim()}` : undefined}
          />
        </div>
        <FactStrip bot={bot} now={now} />
        <HistoryChart bot={bot} />
      </Card>
      <div className="split span2">
        <Card
          title="Liquidity"
          aside={
            <span className="legend">
              {bot.binsHavePoolDepth ? (
                <span>
                  <i className="sw pool" /> Pool
                </span>
              ) : null}
              {bot.bins.some((bar) => bar.ours > 0) ? (
                <span>
                  <i className="sw ours" /> {bot.binsOursExact ? 'Yours' : 'Your bins'}
                </span>
              ) : null}
              <span>
                <i className="sw act" /> Price
              </span>
            </span>
          }
        >
          {bot.curve ? (
            <p className="note">
              ±{bot.curve.width} bins · {pct(bot.curve.sizeFraction)} of funds deployed · re-centres after {bot.curve.repoDrift} bins
            </p>
          ) : null}
          <BinChart bins={bot.bins} havePoolDepth={bot.binsHavePoolDepth} />
        </Card>
        <Card title="Holdings">
          <table className="tbl">
            <thead>
              <tr>
                <th />
                <th className="n">Wallet</th>
                <th className="n">In pool</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{bot.baseSymbol}</td>
                <td className="n">{tok(bot.walletBase, bot.baseSymbol)}</td>
                <td className="n">{tok(bot.ownedBase, bot.baseSymbol)}</td>
              </tr>
              <tr>
                <td>{bot.quoteSymbol}</td>
                <td className="n">{tok(bot.walletQuote, bot.quoteSymbol)}</td>
                <td className="n">{tok(bot.ownedQuote, bot.quoteSymbol)}</td>
              </tr>
              {!stxPool ? (
                <tr>
                  <td>
                    STX <span className="muted">(fees)</span>
                  </td>
                  <td className={`n${bot.gasTxLeft != null && bot.gasTxLeft < 20 ? ' s-warn' : ''}`} title={bot.gasTxLeft != null ? `About ${bot.gasTxLeft} transactions` : undefined}>
                    {stx(bot.walletStx)}
                  </td>
                  <td className="n muted">—</td>
                </tr>
              ) : null}
              <tr className="tot">
                <td>Value</td>
                <td className="n">{usd(walletValue)}</td>
                <td className="n">{usd(bot.inPoolValue)}</td>
              </tr>
            </tbody>
          </table>
          {bot.liveWallet && (Math.abs(bot.liveWallet.base - (bot.walletBase ?? 0)) > 1e-9 || Math.abs(bot.liveWallet.quote - (bot.walletQuote ?? 0)) > 1e-6) ? (
            <p className="note">
              The wallet holds {tok(bot.liveWallet.base, bot.baseSymbol)} · {tok(bot.liveWallet.quote, bot.quoteSymbol)} on chain now; the table updates at the bot's next check.
            </p>
          ) : null}
          {!stxPool && bot.gasTxLeft != null ? (
            <p className="note">STX pays every transaction fee. Enough for about {bot.gasTxLeft} more.</p>
          ) : stxPool ? (
            <p className="note">STX is also the fee token here; the bot keeps {stx(Number(bot.settings.STX_GAS_RESERVE_USTX || '5000000') / 1e6)} aside.</p>
          ) : null}
        </Card>
      </div>
      <MarketCard bot={bot} />
      <InventoryCard bot={bot} />
    </div>
  );
}

/** One line of the numbers a market maker checks first, under the headline stats. */
function FactStrip({ bot, now }: { bot: BotView; now: number }) {
  const ins = bot.insights;
  if (!ins) return null;
  const live = bot.mode === 'live' && !bot.preview;
  const last = ins.lastTrade;
  return (
    <dl className="factstrip">
      {ins.inRange24h != null ? (
        <div title="Share of checks in the last 24 hours where the price sat inside your bins">
          <dt>In range</dt>
          <dd>{pct(ins.inRange24h)}</dd>
        </div>
      ) : null}
      <div>
        <dt>{live ? 'Trades' : 'Would-trades'}</dt>
        <dd>
          {live ? ins.trades24h : ins.wouldTrades24h} <span className="muted">· 24h</span>
        </dd>
      </div>
      <div>
        <dt>Last {live ? 'trade' : 'would-trade'}</dt>
        <dd>
          {last ? (
            <>
              {planLabel(last.planType)} {ago(last.t, now)}
              {last.sent && last.txIds[0] ? (
                <a href={explorerTx(last.txIds[0])} target="_blank" rel="noreferrer" aria-label="View transaction">
                  <Icon name="external" size={11} />
                </a>
              ) : null}
            </>
          ) : (
            <span className="muted">None yet</span>
          )}
        </dd>
      </div>
      {live || ins.gasStxAll > 0 ? (
        <div title={ins.since ? `Since ${clock(ins.since)}` : undefined}>
          <dt>Gas spent</dt>
          <dd>
            {stx(ins.gasStxAll)} <span className="muted">· {stx(ins.gasStx24h)} 24h</span>
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

const RANGES: Array<{ value: HistoryRange; label: string }> = [
  { value: '1d', label: '1D' },
  { value: '7d', label: '7D' },
  { value: 'all', label: 'All' },
];

function HistoryChart({ bot }: { bot: BotView }) {
  const [range, setRange] = useState<HistoryRange>('1d');
  const [points, setPoints] = useState<Array<{ t: string; value: number }> | null>(null);
  const lastCheck = bot.lastCheckAt;
  useEffect(() => {
    let live = true;
    api<{ points: Array<{ t: string; value: number }> }>(`/api/bots/${encodeURIComponent(bot.id)}/history?range=${range}`)
      .then((res) => {
        if (live) setPoints(res.points);
      })
      .catch(() => {
        if (live) setPoints(null);
      });
    return () => {
      live = false;
    };
    // Refetch on each new check so the line keeps up without its own timer.
  }, [bot.id, range, lastCheck]);
  const shown = points && points.length > 1 ? points : bot.history;
  if (shown.length < 2) return null;
  return (
    <div className="hchart">
      <div className="hchart-h">
        <span className="muted">Value over time</span>
        <Seg value={range} onChange={setRange} options={RANGES} />
      </div>
      <ValueChart points={shown} height={170} />
    </div>
  );
}

function MarketCard({ bot }: { bot: BotView }) {
  const m = bot.market;
  if (!m) {
    return (
      <Card title="Price check">
        <Empty icon="info" title="No market price yet">
          The bot compares the pool with the market price on each check.
        </Empty>
      </Card>
    );
  }
  const used = m.haltBps > 0 ? Math.min(1, m.gapBps / m.haltBps) : 0;
  const tone = used >= 1 ? 'serious' : used >= 0.6 ? 'warn' : 'good';
  return (
    <Card title="Price check" aside={<span className={`tag t-${tone}`}>{used >= 1 ? 'Halted' : used >= 0.6 ? 'Near limit' : 'In line'}</span>}>
      <dl className="facts">
        <div className="fact-row">
          <dt>Pool</dt>
          <dd className="num">{price(m.poolPrice, bot.quoteSymbol)}</dd>
        </div>
        <div className="fact-row">
          <dt>Market</dt>
          <dd className="num">
            {price(m.refPrice, bot.quoteSymbol)}
            {m.refAgeMs != null ? <span className="muted"> · {Math.round(m.refAgeMs / 1000)}s old</span> : null}
          </dd>
        </div>
        <div className="fact-row">
          <dt>Gap</dt>
          <dd>
            <div className="meter-row">
              <span className="num">
                {m.gapBps} <span className="muted">/ {m.haltBps} bps</span>
              </span>
              <span className={`meter t-${tone}`} role="img" aria-label={`${m.gapBps} of ${m.haltBps} bps; the bot halts at ${m.haltBps}`}>
                <i style={{ width: `${used * 100}%` }} />
              </span>
            </div>
          </dd>
        </div>
      </dl>
    </Card>
  );
}

function InventoryCard({ bot }: { bot: BotView }) {
  const inv = bot.inventory;
  if (!inv) {
    return (
      <Card title="Inventory">
        <Empty icon="info" title="No balance yet">
          Shows how your value splits between {bot.baseSymbol} and {bot.quoteSymbol} after the first check.
        </Empty>
      </Card>
    );
  }
  const state = inv.share > inv.hard ? 'serious' : inv.share > inv.soft ? 'warn' : 'good';
  const mark = (at: number, label: string) => (
    <span className="inv-mark" style={{ left: `${at * 100}%` }} title={`${label} ${pct(at)}`}>
      <i />
      <small>{label}</small>
    </span>
  );
  return (
    <Card title="Inventory" aside={<span className={`tag t-${state}`}>{state === 'serious' ? 'Selling down' : state === 'warn' ? 'Not buying' : 'Normal'}</span>}>
      <div className="inv">
        <div className="inv-bar">
          <span className={`inv-fill t-${state}`} style={{ width: `${Math.min(1, inv.share) * 100}%` }} />
          {mark(inv.target, 'Target')}
          {mark(inv.soft, 'Soft')}
          {mark(inv.hard, 'Hard')}
        </div>
      </div>
      <p className="note">
        {pct(inv.share)} of value is in {bot.baseSymbol}. Above {pct(inv.soft)} the bot stops buying; above {pct(inv.hard)} it sells some
        {bot.settings.ENABLE_SWAP === 'false' ? ' (auto-sell is off)' : ''}.
      </p>
    </Card>
  );
}

const KIND_LABEL: Record<ReasonKind, string> = {
  paused: 'Paused',
  holding: 'Holding',
  rebuild: 'Moved range',
  derisk: 'Sold down',
  defensive: 'Defensive',
  gas: 'Gas',
  stuck: 'Stuck',
  data: 'Data',
  halt: 'Halted',
  pool: 'Pool',
  other: 'Other',
};

const KIND_TONE: Record<ReasonKind, string> = {
  paused: 'info',
  holding: 'good',
  rebuild: 'good',
  derisk: 'warn',
  defensive: 'warn',
  gas: 'warn',
  stuck: 'warn',
  data: 'warn',
  halt: 'serious',
  pool: 'warn',
  other: 'unknown',
};

function Outcome({ row }: { row: DecisionRow }) {
  const plan = row.planType ? `${planLabel(row.planType)}, ${row.planSteps} step${row.planSteps === 1 ? '' : 's'}` : '';
  if (row.sent) {
    return (
      <span className="outcome sent" title={plan ? `Sent: ${plan}` : undefined}>
        Sent
        {row.txIds.map((tx) => (
          <a key={tx} href={explorerTx(tx)} target="_blank" rel="noreferrer" title={tx}>
            {tx.slice(0, 8)}…<Icon name="external" size={11} />
          </a>
        ))}
      </span>
    );
  }
  if (row.wouldSend) {
    return (
      <span className="outcome would" title={plan ? `Would send: ${plan}` : undefined}>
        Would trade
      </span>
    );
  }
  return <span className="outcome none">No trade</span>;
}

interface DecisionRun {
  row: DecisionRow;
  count: number;
  oldest: string;
}

const outcomeKey = (row: DecisionRow) => (row.sent ? 'sent' : row.wouldSend ? 'would' : 'none');

/** Rows arrive newest first; fold back-to-back repeats of the same unsent decision into one line. */
const runsOf = (rows: DecisionRow[]): DecisionRun[] => {
  const out: DecisionRun[] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last && !row.sent && last.row.kind === row.kind && last.row.text === row.text && outcomeKey(last.row) === outcomeKey(row)) {
      last.count += 1;
      last.oldest = row.t;
      continue;
    }
    out.push({ row, count: 1, oldest: row.t });
  }
  return out;
};

const SHORT_LIST = 10;

function Activity({ bot }: { bot: BotView }) {
  const [filter, setFilter] = useState<'all' | 'changes'>('all');
  const [logFilter, setLogFilter] = useState<'all' | 'warn'>('all');
  const [showAll, setShowAll] = useState(false);
  const allRows = runsOf(filter === 'all' ? bot.decisions : bot.decisions.filter((row) => row.kind !== 'holding'));
  const rows = showAll ? allRows : allRows.slice(0, SHORT_LIST);
  const logs = logFilter === 'all' ? bot.logs : bot.logs.filter((line) => line.level === 'warn' || line.level === 'error' || line.level === 'fatal');
  return (
    <div className="stack">
      <Card
        title="Decisions"
        aside={
          <>
            <Seg
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'All' },
                { value: 'changes', label: 'Changes' },
              ]}
            />
            <ExportButton disabled={!bot.decisions.length} onClick={() => (bot.preview ? exportDecisions(bot) : downloadUrl(`/api/bots/${encodeURIComponent(bot.id)}/decisions.csv`))} />
          </>
        }
      >
        {rows.length ? (
          <div className="tbl-wrap">
            <table className="tbl decisions">
              <thead>
                <tr>
                  <th className="shrink">Time</th>
                  <th>Decision</th>
                  <th className="shrink">Result</th>
                  <th className="n shrink">Value</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ row, count, oldest }, i) => (
                  <tr key={`${row.t}-${i}`}>
                    <td className="mono nowrap">
                      {clock(row.t)}
                      {count > 1 ? <div className="since">since {clock(oldest)}</div> : null}
                    </td>
                    <td className="grow" title={row.raw ? `${row.text}\n\nBot log: ${row.raw}` : row.text}>
                      <div className="dec-line">
                        <span className={`tag t-${KIND_TONE[row.kind]}`}>{KIND_LABEL[row.kind]}</span>
                        {count > 1 ? <span className="times">×{count}</span> : null}
                        <span className="dec-text">{row.text}</span>
                      </div>
                    </td>
                    <td>
                      <Outcome row={row} />
                    </td>
                    <td className="n nowrap">{usd(row.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {allRows.length > SHORT_LIST ? (
              <div className="tbl-more">
                <button type="button" className="btn sm ghost" onClick={() => setShowAll(!showAll)}>
                  {showAll ? 'Show fewer' : `Show all ${allRows.length}`}
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <Empty icon="bot" title={bot.decisions.length ? 'No changes yet' : 'No decisions yet'}>
            {bot.decisions.length
              ? 'Every check so far kept the position as it was. Switch to All to see them.'
              : bot.running
                ? `The bot records one decision per check, every ${Math.round(bot.tickIntervalMs / 1000)}s.`
                : 'Start the bot. It records one decision per check.'}
          </Empty>
        )}
      </Card>
      <Card
        title="Log"
        aside={
          <>
            <Seg
              value={logFilter}
              onChange={setLogFilter}
              options={[
                { value: 'all', label: 'All' },
                { value: 'warn', label: 'Warnings' },
              ]}
            />
            <ExportButton disabled={!bot.logs.length} onClick={() => exportLog(bot)} />
          </>
        }
      >
        <LogView lines={logs} filtered={logFilter === 'warn' && bot.logs.length > 0} running={bot.running} />
      </Card>
    </div>
  );
}

// The helper answers with a file, so the browser saves it without loading it into the page.
const downloadUrl = (url: string): void => {
  const link = document.createElement('a');
  link.href = url;
  link.click();
};

const fileStamp = (): string => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

const csvCell = (value: string | number | null): string => {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const exportDecisions = (bot: BotView): void => {
  const header = ['time', 'kind', 'decision', 'summary', 'bot_reason', 'result', 'tx_ids', 'value_usd'];
  const rows = bot.decisions.map((row) => [
    row.t,
    row.kind,
    row.decision,
    row.text,
    row.raw,
    row.sent ? 'sent' : row.wouldSend ? 'would_trade' : 'no_trade',
    row.txIds.join(' '),
    row.value == null ? null : row.value.toFixed(2),
  ]);
  const csv = [header, ...rows].map((cells) => cells.map(csvCell).join(',')).join('\n');
  downloadFile(`${bot.id}-decisions-${fileStamp()}.csv`, `${csv}\n`, 'text/csv');
};

const exportLog = (bot: BotView): void => {
  // The page holds the log newest first; a log file reads oldest first.
  const text = [...bot.logs].reverse().map((line) => `${line.t} ${line.level.toUpperCase().padEnd(5)} ${line.text}`).join('\n');
  downloadFile(`${bot.id}-log-${fileStamp()}.txt`, `${text}\n`, 'text/plain');
};

function ExportButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" className="btn sm ghost" disabled={disabled} onClick={onClick} title="Download what is shown here">
      <Icon name="download" />
      Export
    </button>
  );
}

function LogView({ lines, filtered, running }: { lines: LogLine[]; filtered: boolean; running: boolean }) {
  if (!lines.length) {
    if (filtered) return <Empty icon="check" title="No warnings">Nothing went wrong in the recent log.</Empty>;
    return (
      <Empty icon="info" title="Nothing logged yet">
        {running ? 'Lines appear here as the bot works.' : 'Start the bot to see what it does, line by line.'}
      </Empty>
    );
  }
  return (
    <div className="logbox" role="log">
      {lines.map((line, i) => (
        <div key={i} className={`logl lv-${line.level}`}>
          <span className="lt">{line.t}</span>
          <span className="ll">{line.level}</span>
          <span className="lx">{line.text}</span>
        </div>
      ))}
    </div>
  );
}

function Safety({ bot }: { bot: BotView }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const blocking = bot.checklist.filter((check) => !check.ok && check.id !== 'dry-run');
  return (
    <div className="grid2">
      <Card
        title="Before going live"
        aside={
          bot.preview ? null : blocking.length ? (
            <span className="tag t-warn">{blocking.length} left</span>
          ) : bot.mode === 'live' ? (
            <span className="tag t-good">Live</span>
          ) : (
            <span className="tag t-good">Ready</span>
          )
        }
      >
        {bot.preview ? (
          <Empty icon="lock" title="Simulations can’t go live">
            A real bot shows its checklist here. <Link to="/new">Create one</Link> to see it.
          </Empty>
        ) : (
        <ul className="checks">
          {bot.checklist.map((check) => (
            <li key={check.id} className={check.ok ? 'ok' : check.id === 'dry-run' ? 'info' : 'no'}>
              <span className="ck">
                <Icon name={check.ok ? 'check' : check.id === 'dry-run' ? 'eye' : 'x'} size={12} />
              </span>
              <div title={check.ok ? check.detail : undefined}>
                <div className="ck-l">{check.label}</div>
                {!check.ok ? <div className="ck-d">{check.detail}</div> : null}
              </div>
            </li>
          ))}
        </ul>
        )}
      </Card>
      <Card title="Limits">
        <dl className="facts limits">
          {bot.limits.map((row) => (
            <div key={row.label} className="fact-row" title={row.note || undefined}>
              <dt>{row.label}</dt>
              <dd className="num">{row.value}</dd>
            </div>
          ))}
        </dl>
      </Card>
      {!bot.preview ? (
        <Card title="Profit baseline" className="span2">
          <div className="row-between">
            <p className="muted">Reset after you add or remove funds.</p>
            <button type="button" className="btn" onClick={() => setConfirm(true)}>
              <Icon name="reset" />
              Reset baseline
            </button>
          </div>
        </Card>
      ) : null}
      {confirm ? (
        <Modal title="Reset the profit baseline?" onClose={() => setConfirm(false)}>
          <p>"Vs. holding" starts again from zero. No funds move.</p>
          <footer className="modal-f">
            <span className="spacer" />
            <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                api(`/api/bots/${encodeURIComponent(bot.id)}/baseline-reset`, 'POST', {})
                  .then(() => {
                    toast('good', 'Baseline reset.');
                    setConfirm(false);
                  })
                  .catch((err: Error) => toast('bad', err.message))
                  .finally(() => setBusy(false));
              }}
            >
              Reset
            </button>
          </footer>
        </Modal>
      ) : null}
    </div>
  );
}

interface FieldDef {
  key: string;
  label: string;
  help: string;
  unit?: string;
  kind?: 'number' | 'bool';
  scale?: number;
}

/** What the bot uses when the env file leaves a key out (src/config.ts). */
const BOT_DEFAULTS: Record<string, string> = {
  TICK_INTERVAL_MS: '30000',
  CURVE_HALF_WIDTH_BINS: '5',
  CURVE_DECAY: '0.6',
  CURVE_SIZE_FRACTION: '0.6',
  CURVE_REPOSITION_DRIFT_BINS: '3',
  F_STAR: '0.38',
  F_SOFT: '0.44',
  F_HARD: '0.5',
  DERISK_MAX_FRACTION: '0.4',
  ENABLE_SWAP: 'true',
  DIVERGENCE_HALT_BPS: '150',
  MAX_POSITION_USTX: '0',
  BREAKER_WITHDRAW_ALL: 'false',
  STX_GAS_RESERVE_USTX: '5000000',
  MIN_TX_FEE_USTX: '10000',
  MAX_TX_FEE_USTX: '3000000',
};

const GROUPS: Array<{ title: string; fields: FieldDef[] }> = [
  {
    title: 'Timing',
    fields: [{ key: 'TICK_INTERVAL_MS', label: 'Check every', help: '10 seconds to 1 hour. Shorter reacts faster but pays more fees.', unit: 'seconds', scale: 1000 }],
  },
  {
    title: 'Curve shape',
    fields: [
      { key: 'CURVE_HALF_WIDTH_BINS', label: 'Bins each side', help: 'Price bins with liquidity on each side of the price.', unit: 'bins' },
      { key: 'CURVE_DECAY', label: 'Falloff', help: '1 spreads evenly. Lower puts more near the price.' },
      { key: 'CURVE_SIZE_FRACTION', label: 'Funds deployed', help: 'Share of the wallet put in the pool.', unit: '%', scale: 0.01 },
      { key: 'CURVE_REPOSITION_DRIFT_BINS', label: 'Move after', help: 'How far the price moves before the bot re-centers.', unit: 'bins' },
    ],
  },
  {
    title: 'Inventory',
    fields: [
      { key: 'F_STAR', label: 'Target', help: 'Share of value the bot aims to hold in the base token.', unit: '%', scale: 0.01 },
      { key: 'F_SOFT', label: 'Soft limit', help: 'Above this, the bot stops buying.', unit: '%', scale: 0.01 },
      { key: 'F_HARD', label: 'Hard limit', help: 'Above this, the bot sells down (if auto-sell is on).', unit: '%', scale: 0.01 },
      { key: 'DERISK_MAX_FRACTION', label: 'Max sell per check', help: 'Largest single sell-down.', unit: '%', scale: 0.01 },
      { key: 'ENABLE_SWAP', label: 'Auto-sell', help: 'Off means the bot only stops buying.', kind: 'bool' },
    ],
  },
  {
    title: 'Safety',
    fields: [
      { key: 'DIVERGENCE_HALT_BPS', label: 'Price gap halt', help: 'Pause when the pool and market prices differ by more than this. 100 bps = 1%.', unit: 'bps' },
      { key: 'MAX_POSITION_USTX', label: 'Max position', help: 'Cap on value in the pool, in STX. 0 = no cap.', unit: 'STX', scale: 1_000_000 },
      { key: 'BREAKER_WITHDRAW_ALL', label: 'Withdraw on halt', help: 'On a halt, withdraw everything instead of holding.', kind: 'bool' },
    ],
  },
  {
    title: 'Fees',
    fields: [
      { key: 'STX_GAS_RESERVE_USTX', label: 'STX reserve', help: 'Never put in the pool, so fees can always be paid.', unit: 'STX', scale: 1_000_000 },
      { key: 'MIN_TX_FEE_USTX', label: 'Min fee', help: 'Per transaction.', unit: 'STX', scale: 1_000_000 },
      { key: 'MAX_TX_FEE_USTX', label: 'Max fee', help: 'Per transaction.', unit: 'STX', scale: 1_000_000 },
    ],
  },
];

const ALL_FIELDS = GROUPS.flatMap((group) => group.fields);

const tidy = (n: number) => String(Number(n.toPrecision(12)));

const toDisplay = (field: FieldDef, raw: string | undefined): string => {
  if (raw == null || raw === '') return '';
  if (field.kind === 'bool') return raw === 'true' ? 'true' : 'false';
  const n = Number(raw);
  if (!Number.isFinite(n) || !field.scale) return raw;
  return tidy(n / field.scale);
};

const fromDisplay = (field: FieldDef, shown: string): string => {
  if (field.kind === 'bool' || !field.scale) return shown.trim();
  const n = Number(shown);
  if (shown.trim() === '' || !Number.isFinite(n)) return shown.trim();
  const raw = n * field.scale;
  return field.scale >= 1 ? String(Math.round(raw)) : tidy(raw);
};

function Settings({ bot, reload }: { bot: BotView; reload: () => Promise<void> }) {
  const toast = useToast();
  const initial = useMemo(() => {
    const out: Record<string, string> = {};
    for (const field of ALL_FIELDS) {
      const raw = bot.settings[field.key];
      out[field.key] = toDisplay(field, field.kind === 'bool' && !raw ? BOT_DEFAULTS[field.key] : raw);
    }
    return out;
  }, [bot.settings]);
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [modeDialog, setModeDialog] = useState<'' | 'live' | 'dry'>('');
  // Compare as saved values, so typing 0.10 where 0.1 is stored is not a change.
  const isDirty = (field: FieldDef): boolean => fromDisplay(field, draft[field.key] ?? '') !== fromDisplay(field, initial[field.key] ?? '');
  const changed = ALL_FIELDS.filter(isDirty);

  useEffect(() => {
    if (!changed.length) setDraft(initial);
  }, [initial]);

  const save = async (updates: Record<string, string>, extra: Record<string, unknown> = {}): Promise<boolean> => {
    setBusy(true);
    setError('');
    try {
      await api(`/api/bots/${encodeURIComponent(bot.id)}/settings`, 'POST', { settings: updates, ...extra });
      toast('good', bot.running ? 'Saved. Bot restarted.' : 'Saved. Takes effect when you start the bot.');
      await reload();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const blocking = bot.checklist.filter((check) => !check.ok && check.id !== 'dry-run');
  const ro = bot.preview;

  return (
    <div className="stack">
      <Card>
        <div className="moderow">
          <div className="moderow-l">
            <ModeBadge preview={bot.preview} mode={bot.mode} />
            <span className="muted">
              {bot.preview ? 'Never trades.' : bot.mode === 'live' ? 'Trading with real funds.' : 'Watching only. No trades.'}
            </span>
          </div>
          {ro ? null : bot.mode === 'live' ? (
            <button type="button" className="btn" onClick={() => setModeDialog('dry')}>
              Switch to dry run
            </button>
          ) : blocking.length ? (
            <span className="muted">
              <Link to="?tab=safety">Finish the checks</Link> to go live.
            </span>
          ) : (
            <button type="button" className="btn danger" onClick={() => setModeDialog('live')}>
              Go live…
            </button>
          )}
        </div>
      </Card>
      {ro ? null : <PoolCard bot={bot} reload={reload} />}
      {ro ? null : <StrategyCard bot={bot} />}
      {ro ? null : <KeysCard bot={bot} reload={reload} />}
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          const updates: Record<string, string> = {};
          for (const field of changed) updates[field.key] = fromDisplay(field, draft[field.key]);
          void save(updates);
        }}
      >
        {GROUPS.map((group) => (
          <Card key={group.title} title={group.title}>
            <div className="fields">
              {group.fields.map((field) => {
                const dirty = isDirty(field);
                return (
                  <label key={field.key} className={`sfield${dirty ? ' dirty' : ''}`}>
                    <span className="sf-l">
                      {field.label}
                      {dirty ? <span className="dirty-dot" title="Changed" /> : null}
                    </span>
                    {field.kind === 'bool' ? (
                      <span className="toggle">
                        <input
                          type="checkbox"
                          disabled={ro}
                          checked={draft[field.key] === 'true'}
                          onChange={(e) => setDraft({ ...draft, [field.key]: e.target.checked ? 'true' : 'false' })}
                        />
                        <span>{draft[field.key] === 'true' ? 'On' : 'Off'}</span>
                      </span>
                    ) : (
                      <span className="in-unit">
                        <input
                          className="in"
                          inputMode="decimal"
                          disabled={ro}
                          placeholder={`${toDisplay(field, BOT_DEFAULTS[field.key])} (default)`}
                          value={draft[field.key]}
                          onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}
                        />
                        {field.unit ? <span className="unit">{field.unit}</span> : null}
                      </span>
                    )}
                    <span className="sf-h">{field.help}</span>
                  </label>
                );
              })}
            </div>
          </Card>
        ))}
        {!ro && (changed.length || error) ? (
          <div className="savebar show">
            <span>
              {changed.length ? `${changed.length} unsaved${bot.running ? ' · saving restarts the bot' : ''}` : ''}
            </span>
            {error ? <span className="form-err">{error}</span> : null}
            <span className="spacer" />
            <button type="button" className="btn ghost" disabled={!changed.length || busy} onClick={() => setDraft(initial)}>
              Discard
            </button>
            <button type="submit" className="btn primary" disabled={!changed.length || busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        ) : null}
      </form>
      {modeDialog === 'live' ? (
        <RiskConfirm
          title={`Take ${bot.pair} live`}
          lead={
            <>
              {bot.running ? 'The bot restarts and trades with real funds from the next check.' : 'The bot trades with real funds once you start it.'} Pause stops new trades; it doesn't withdraw. The bot
              only runs while <code>npm run ui</code> is running and this computer is awake.
            </>
          }
          facts={[
            ['Wallet', bot.address ? shortAddr(bot.address) : '—'],
            ['Value', usd(bot.portfolioValue)],
            ['Funds deployed', `${initial.CURVE_SIZE_FRACTION || Number(BOT_DEFAULTS.CURVE_SIZE_FRACTION) * 100}%`],
            ['Auto-sell', initial.ENABLE_SWAP === 'true' ? 'On' : 'Off'],
          ]}
          poolName={bot.pair}
          confirmLabel="Go live"
          busy={busy}
          error={error}
          onClose={() => {
            setModeDialog('');
            setError('');
          }}
          onConfirm={() => {
            void save({ EXECUTION_MODE: 'live' }, { confirmLive: true, poolName: bot.pair }).then((ok) => {
              if (ok) setModeDialog('');
            });
          }}
        />
      ) : null}
      {modeDialog === 'dry' ? (
        <Modal title="Switch back to dry run?" onClose={() => setModeDialog('')}>
          <p>{bot.running ? 'The bot restarts and stops trading.' : 'The bot will practice instead of trading.'} Liquidity stays in the pool.</p>
          {error ? <p className="form-err">{error}</p> : null}
          <footer className="modal-f">
            <span className="spacer" />
            <button type="button" className="btn ghost" onClick={() => setModeDialog('')}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => {
                void save({ EXECUTION_MODE: 'dry_run' }).then((ok) => {
                  if (ok) setModeDialog('');
                });
              }}
            >
              Switch to dry run
            </button>
          </footer>
        </Modal>
      ) : null}
    </div>
  );
}

type ManualKind = 'swap' | 'add' | 'withdraw';

function Manual({ bot, reload }: { bot: BotView; reload: () => Promise<void> }) {
  const toast = useToast();
  const [open, setOpen] = useState<ManualKind | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [output, setOutput] = useState('');
  const [side, setSide] = useState<'base' | 'quote'>('base');
  const [amount, setAmount] = useState('');
  const [xAmount, setXAmount] = useState('');
  const [yAmount, setYAmount] = useState('');
  const [withdrawPct, setWithdrawPct] = useState('100');

  const [pausing, setPausing] = useState(false);
  const pause = async () => {
    setPausing(true);
    try {
      await api(`/api/bots/${encodeURIComponent(bot.id)}/pause`, 'POST', {});
      toast('good', 'Paused.');
      await reload();
    } catch (err) {
      toast('bad', err instanceof Error ? err.message : 'Could not pause.');
    } finally {
      setPausing(false);
    }
  };

  // Every action needs the same conditions, so one reason covers all three cards.
  const shared = bot.preview ? 'Not available in simulations.' : bot.mode !== 'live' ? 'Only available when live.' : bot.running && !bot.paused ? 'Pause the bot first.' : '';

  const submit = async () => {
    if (!open) return;
    setBusy(true);
    setError('');
    const body: Record<string, unknown> = { action: open, acknowledged: true, poolName: bot.pair };
    if (open === 'swap') Object.assign(body, { side, amount });
    if (open === 'add') Object.assign(body, { xAmount, yAmount });
    if (open === 'withdraw') body.pct = Number(withdrawPct);
    try {
      const res = await api<{ ok: true; output: string }>(`/api/bots/${encodeURIComponent(bot.id)}/manual`, 'POST', body);
      setOutput(res.output || '(no output)');
      toast('good', 'Sent and confirmed.');
      setOpen('');
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  const wallet = `${tok(bot.walletBase, bot.baseSymbol)} · ${tok(bot.walletQuote, bot.quoteSymbol)}`;
  // Balances from the last check; null means unknown, which leaves the action open.
  const nothingInPool = bot.ownedBase === 0 && bot.ownedQuote === 0;
  const walletEmpty = bot.liveWallet ? bot.liveWallet.base === 0 && bot.liveWallet.quote === 0 : bot.walletBase === 0 && bot.walletQuote === 0;
  const blockedFor = (kind: ManualKind): string => {
    if (shared) return shared;
    if (busy) return 'Another action is still running.';
    if (kind === 'withdraw' && nothingInPool) return 'Nothing in the pool to withdraw.';
    if (kind !== 'withdraw' && walletEmpty) return 'The wallet is empty.';
    return '';
  };
  const items: Array<{ kind: ManualKind; title: string; body: string; detail: string; icon: 'arrow' | 'plus' | 'wallet' }> = [
    { kind: 'swap', title: 'Swap', body: `Trade ${bot.baseSymbol} for ${bot.quoteSymbol}, or back, in this pool.`, detail: `Wallet: ${wallet}`, icon: 'arrow' },
    { kind: 'add', title: 'Add liquidity', body: 'Move tokens from the wallet into the pool.', detail: `Wallet: ${wallet}`, icon: 'plus' },
    { kind: 'withdraw', title: 'Withdraw', body: 'Move liquidity from the pool back to the wallet.', detail: `In pool: ${usd(bot.inPoolValue)}`, icon: 'wallet' },
  ];

  return (
    <div className="stack">
      {!bot.preview && bot.mode === 'live' && bot.running && !bot.paused ? (
        <div className="banner2 warn center">
          <Icon name="pause" />
          <div className="grow">Pause the bot first, so its next check doesn't undo a manual action. Liquidity stays in the pool while it's paused.</div>
          <button type="button" className="btn sm" disabled={pausing} onClick={() => void pause()}>
            <Icon name="pause" />
            {pausing ? 'Pausing…' : 'Pause bot'}
          </button>
        </div>
      ) : (
        <div className={`banner2 ${shared ? 'info' : 'warn'}`}>
          <Icon name={shared ? 'lock' : 'warn'} />
          <div className="grow">
            {bot.preview ? (
              'Simulations have no wallet, so there is nothing to move.'
            ) : bot.mode !== 'live' ? (
              <>
                Manual actions move real funds, so they're off in dry run. <Link to="?tab=settings">Go live in Settings</Link> to use them.
              </>
            ) : (
              `The bot is ${bot.running ? 'paused' : 'stopped'}. These send a transaction from the bot wallet right away.`
            )}
          </div>
        </div>
      )}
      <div className="cards three">
        {items.map((item) => {
          const why = blockedFor(item.kind);
          return (
            <button
              key={item.kind}
              type="button"
              className="mcard"
              disabled={!!why}
              title={why || undefined}
              onClick={() => {
                setError('');
                setOpen(item.kind);
              }}
            >
              <span className="mcard-i">
                <Icon name={item.icon} />
              </span>
              <span>
                <b>{item.title}</b>
                <small>{item.body}</small>
                <small className="mcard-d">{why && why !== shared ? why : item.detail}</small>
              </span>
            </button>
          );
        })}
      </div>
      {output ? (
        <Card title="Last result" aside={<button type="button" className="btn sm ghost" onClick={() => setOutput('')}>Clear</button>}>
          <pre className="outbox">{output}</pre>
        </Card>
      ) : null}
      {open ? (
        <RiskConfirm
          title={open === 'swap' ? 'Swap now' : open === 'add' ? 'Add liquidity now' : 'Withdraw now'}
          lead={
            <>
              {open === 'withdraw' ? 'Moves liquidity back to the wallet. It stays there until you resume.' : 'Sends one transaction from the bot wallet now.'}{' '}
              It waits for the transaction to confirm, usually a few seconds.
            </>
          }
          facts={[
            ['Pool', `${bot.pair} (${poolName(bot.poolId)})`],
            ['Wallet', bot.address ? shortAddr(bot.address) : '—'],
            ['Price', price(bot.price, bot.quoteSymbol)],
          ]}
          poolName={bot.pair}
          confirmLabel={open === 'swap' ? 'Swap' : open === 'add' ? 'Add' : 'Withdraw'}
          busy={busy}
          error={error}
          onClose={() => setOpen('')}
          onConfirm={() => void submit()}
        >
          <ManualInputs
            kind={open}
            bot={bot}
            side={side}
            setSide={setSide}
            amount={amount}
            setAmount={setAmount}
            xAmount={xAmount}
            setXAmount={setXAmount}
            yAmount={yAmount}
            setYAmount={setYAmount}
            pct={withdrawPct}
            setPct={setWithdrawPct}
          />
        </RiskConfirm>
      ) : null}
    </div>
  );
}

function ManualInputs(props: {
  kind: ManualKind;
  bot: BotView;
  side: 'base' | 'quote';
  setSide: (side: 'base' | 'quote') => void;
  amount: string;
  setAmount: (v: string) => void;
  xAmount: string;
  setXAmount: (v: string) => void;
  yAmount: string;
  setYAmount: (v: string) => void;
  pct: string;
  setPct: (v: string) => void;
}): ReactNode {
  const { kind, bot } = props;
  if (kind === 'swap') {
    const sym = props.side === 'base' ? bot.baseSymbol : bot.quoteSymbol;
    const have = props.side === 'base' ? bot.walletBase : bot.walletQuote;
    return (
      <div className="minputs">
        <Seg
          value={props.side}
          onChange={props.setSide}
          options={[
            { value: 'base', label: `Sell ${bot.baseSymbol}` },
            { value: 'quote', label: `Sell ${bot.quoteSymbol}` },
          ]}
        />
        <label className="field">
          <span className="field-l">Amount</span>
          <span className="in-unit">
            <input className="in" inputMode="decimal" value={props.amount} onChange={(e) => props.setAmount(e.target.value)} placeholder="0.0" />
            <span className="unit">{sym}</span>
          </span>
          <span className="sf-h">Wallet: {tok(have, sym)}</span>
        </label>
      </div>
    );
  }
  if (kind === 'add') {
    return (
      <div className="minputs two">
        <label className="field">
          <span className="field-l">{bot.baseSymbol}</span>
          <span className="in-unit">
            <input className="in" inputMode="decimal" value={props.xAmount} onChange={(e) => props.setXAmount(e.target.value)} placeholder="0" />
            <span className="unit">{bot.baseSymbol}</span>
          </span>
          <span className="sf-h">Wallet: {tok(bot.walletBase, bot.baseSymbol)}</span>
        </label>
        <label className="field">
          <span className="field-l">{bot.quoteSymbol}</span>
          <span className="in-unit">
            <input className="in" inputMode="decimal" value={props.yAmount} onChange={(e) => props.setYAmount(e.target.value)} placeholder="0" />
            <span className="unit">{bot.quoteSymbol}</span>
          </span>
          <span className="sf-h">Wallet: {tok(bot.walletQuote, bot.quoteSymbol)}</span>
        </label>
      </div>
    );
  }
  return (
    <div className="minputs">
      <label className="field">
        <span className="field-l">Amount</span>
        <span className="pctrow">
          <input type="range" min={1} max={100} value={props.pct} onChange={(e) => props.setPct(e.target.value)} />
          <span className="num pctv">{props.pct}%</span>
        </span>
        <span className="sf-h">In pool: {usd(bot.inPoolValue)}</span>
      </label>
    </div>
  );
}
