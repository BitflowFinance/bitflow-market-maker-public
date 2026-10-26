import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BotView, NeedItem, api } from './api';
import type { Shared } from './App';
import { RangeStrip, Sparkline, ValueChart, mergeSeries } from './charts';
import { ago, pct, usd } from './format';
import { Card, Dot, Icon, ModeBadge, Stat, Status, useToast } from './ui';

export function HomePage({ fleet, now, reload }: Shared) {
  const real = fleet.bots.filter((bot) => !bot.preview);
  const previews = fleet.bots.filter((bot) => bot.preview);
  const book = fleet.book.real;
  const [showSims, setShowSims] = useState(false);
  const [showBots, setShowBots] = useState(true);
  return (
    <div className="page">
      {real.length === 0 ? (
        <Welcome />
      ) : (
        <>
          <div className="page-h">
            <h1 className="page-t">Overview</h1>
            {fleet.canCreate ? (
              <Link to="/new" className="btn sm">
                <Icon name="plus" />
                New bot
              </Link>
            ) : null}
          </div>
          <NeedsList needs={fleet.needs} reload={reload} />
          {book.value != null ? (
            <Card className="book">
              <div className="stats">
                <Stat label="Total value" value={usd(book.value)} sub={!book.valueComplete ? 'Partial' : undefined} />
                <Stat label="In pool" value={usd(book.inPool)} sub={book.value && book.inPool != null ? `${pct(book.inPool / book.value)} of value` : undefined} />
                <Stat
                  label="Vs. holding"
                  value={usd(book.vsHolding, true)}
                  tone={book.vsHolding == null || book.vsHolding === 0 ? undefined : book.vsHolding > 0 ? 'up' : 'down'}
                />
              </div>
              <ValueChart points={mergeSeries(real.map((bot) => bot.history))} height={160} />
            </Card>
          ) : null}
          <section className="sec">
            <div className="sec-row">
              <button type="button" className="sec-h sec-toggle" onClick={() => setShowBots(!showBots)} aria-expanded={showBots}>
                Your bots
                <span className={`chev${showBots ? ' open' : ''}`}>
                  <Icon name="chevron" size={14} />
                </span>
              </button>
            </div>
            {showBots ? (
            <div className="cards">
              {real.map((bot) => (
                <BotCard key={bot.id} bot={bot} now={now} />
              ))}
              <Link to="/new" className="bcard bcard-new">
                <span className="bcard-new-i">
                  <Icon name="plus" size={18} />
                </span>
                <b>New bot</b>
                <span className="muted">Same pair or a different one. Each bot gets its own wallet.</span>
              </Link>
            </div>
            ) : null}
          </section>
        </>
      )}
      <section className="sec">
        <div className="sec-row">
          {real.length ? (
            // With real bots the heading folds the section; without them it is always open.
            <button type="button" className="sec-h sec-toggle" onClick={() => setShowSims(!showSims)} aria-expanded={showSims}>
              Simulations
              <span className={`chev${showSims ? ' open' : ''}`}>
                <Icon name="chevron" size={14} />
              </span>
            </button>
          ) : (
            <h2 className="sec-h">Simulations</h2>
          )}
        </div>
        {!real.length || showSims ? <p className="muted sec-sub">Simulated funds, to see how a bot behaves.</p> : null}
        {!real.length || showSims ? (
          <div className="cards">
            {previews.map((bot) => (
              <BotCard key={bot.id} bot={bot} now={now} />
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function Welcome() {
  return (
    <section className="hero">
      <div className="hero-copy">
        <h1>Market-make on Bitflow.</h1>
        <p>The bot keeps your liquidity near the price in a Bitflow pool.</p>
        <div className="hero-cta">
          <Link to="/new" className="btn primary lg">
            Create a bot
            <Icon name="arrow" />
          </Link>
          <Link to="/bots/preview-sbtc" className="btn lg ghost">
            Try a simulation
          </Link>
        </div>
      </div>
    </section>
  );
}

function NeedsList({ needs, reload }: { needs: NeedItem[]; reload: () => Promise<void> }) {
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const start = (need: NeedItem) => {
    setBusy(need.id);
    api(`/api/bots/${encodeURIComponent(need.botId)}/start`, 'POST', {})
      .then(() => {
        toast('good', 'Started.');
        return reload();
      })
      .catch((err: Error) => toast('bad', err.message))
      .finally(() => setBusy(''));
  };
  if (!needs.length) return null;
  return (
    <Card title="Needs attention" className="needs-card">
      <ul className="needs">
        {needs.map((need) => (
          <li key={need.id} className={`need t-${need.tone}`}>
            <Dot tone={need.tone} />
            <div className="need-body">
              <div className="need-what">{need.what}</div>
              {need.id.endsWith(':stopped') ? null : <div className="need-detail">{need.detail}</div>}
            </div>
            {need.id.endsWith(':stopped') ? (
              <button type="button" className="btn sm primary" disabled={busy === need.id} onClick={() => start(need)}>
                <Icon name="play" size={12} />
                {busy === need.id ? 'Starting…' : 'Start'}
              </button>
            ) : (
              <Link className="btn sm" to={`/bots/${need.botId}`}>
                Open
              </Link>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function BotCard({ bot, now }: { bot: BotView; now: number }) {
  const hasNumbers = bot.portfolioValue != null;
  return (
    <Link to={`/bots/${bot.id}`} className={`bcard${bot.preview ? ' is-preview' : ''}`}>
      <div className="bcard-h">
        <span className="bcard-pair" title={bot.name || bot.pair}>{bot.name || bot.pair}</span>
        {bot.preview ? null : <ModeBadge preview={false} mode={bot.mode} />}
        <span className="spacer" />
        <Status tone={bot.state.tone} label={bot.state.label} title={bot.reason?.text || bot.state.detail} />
      </div>
      {!hasNumbers ? (
        <div className="bcard-empty">
          {!bot.running
            ? bot.startError || 'Off. Liquidity stays in the pool. Open it to start.'
            : bot.lastCheckAt
              ? bot.reason?.text || bot.state.detail
              : 'Starting. Numbers appear after the first check.'}
        </div>
      ) : (
        <>
      <div className="bcard-nums">
        <div>
          <div className="k">Value</div>
          <div className="v num">{usd(bot.portfolioValue)}</div>
        </div>
        <div>
          <div className="k">Vs. holding</div>
          <div className={`v num ${bot.pnlVsHodl == null ? '' : bot.pnlVsHodl >= 0 ? 's-up' : 's-down'}`}>{usd(bot.pnlVsHodl, true)}</div>
        </div>
        <div className="bcard-spark">
          <Sparkline points={bot.history} width={112} height={30} />
        </div>
      </div>
      <div className="bcard-f">
        <RangeStrip bins={bot.bins} width={96} />
        <span className="spacer" />
        <span className="muted">{bot.running ? ago(bot.lastCheckAt, now) : 'stopped'}</span>
      </div>
        </>
      )}
    </Link>
  );
}
