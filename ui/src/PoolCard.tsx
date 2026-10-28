import { useEffect, useState } from 'react';
import { BotView, api, explorerContract } from './api';
import { poolName } from './format';
import { PoolList, usePoolCatalog } from './PoolList';
import { Card, Icon, RiskConfirm, useToast } from './ui';

function ChangePool({ bot, onClose, reload }: { bot: BotView; onClose: () => void; reload: () => Promise<void> }) {
  const toast = useToast();
  const { catalog, error: loadError } = usePoolCatalog(bot.profile);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const best = catalog?.pools.find((pool) => pool.ok && pool.poolId !== bot.poolId);
    setTarget(best ? best.poolId : '');
  }, [catalog, bot.poolId]);

  const submit = async () => {
    if (!target) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/bots/${encodeURIComponent(bot.id)}/pool`, 'POST', { poolId: target, acknowledged: true, poolName: bot.pair });
      toast('good', 'Pool change started.');
      onClose();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the pool change.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <RiskConfirm
      title={`Change ${bot.pair} pool`}
      lead={
        bot.mode === 'live'
          ? 'The bot pauses, withdraws everything from the current pool, and checks it is empty. Then it switches and stays paused until you resume.'
          : 'The bot pauses and checks the current pool holds none of this wallet’s liquidity. Then it switches and stays paused until you resume.'
      }
      facts={[
        ['From', <span className="mono">{poolName(bot.poolId)}</span>],
        ['To', target ? <span className="mono">{poolName(target)}</span> : <span className="muted">Pick a pool</span>],
      ]}
      poolName={bot.pair}
      confirmLabel="Change pool"
      busy={busy}
      disabled={!target}
      error={error || loadError}
      onClose={onClose}
      onConfirm={() => void submit()}
    >
      {catalog && !catalog.pools.some((pool) => pool.ok && pool.poolId !== bot.poolId) ? (
        <p className="note">No other {bot.pair} pool suits the bot right now{catalog.pools.some((pool) => pool.ok && pool.poolId === bot.poolId) ? '; it is already in the best one' : ''}.</p>
      ) : null}
      {catalog ? (
        <PoolList catalog={catalog} quote={bot.quoteSymbol} value={target} onChange={setTarget} currentPoolId={bot.poolId} />
      ) : loadError ? null : (
        <span className="spinner" aria-label="Loading pools" />
      )}
    </RiskConfirm>
  );
}

/** Which pool the bot trades, how close the price is to its edge, and the change flow. */
export function PoolCard({ bot, reload }: { bot: BotView; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const job = bot.poolSwitch;
  const running = job?.status === 'running' || bot.cashOut?.status === 'running';
  const near = bot.poolEdgeRoom != null && bot.curve != null && bot.poolEdgeRoom < bot.curve.width * 3;
  return (
    <Card
      title="Pool"
      aside={
        job ? (
          <span className={`tag ${job.status === 'done' ? 't-good' : job.status === 'failed' ? 't-warn' : 't-unknown'}`}>
            {job.status === 'done' ? 'Changed' : job.status === 'failed' ? 'Didn’t change' : 'Changing…'}
          </span>
        ) : near ? (
          <span className="tag t-warn">Near the edge</span>
        ) : null
      }
    >
      <div className="row-between">
        <div className="pool-now">
          <a className="mono" href={explorerContract(bot.poolContract || bot.poolId)} target="_blank" rel="noreferrer" title={bot.poolId}>
            {poolName(bot.poolId)}
          </a>
          <span className="note">
            {bot.poolEdgeRoom != null ? `The price is ${bot.poolEdgeRoom} bins from the end of this pool’s range.` : 'Each pair has several pools covering different price ranges.'}
          </span>
        </div>
        <button type="button" className="btn" disabled={bot.preview || running} onClick={() => setOpen(true)} title={bot.preview ? 'Preview bots have no pool to change.' : undefined}>
          <Icon name="arrow" />
          Change pool
        </button>
      </div>
      {job ? (
        <div className="logbox">
          {job.lines.map((line, i) => (
            <div key={i} className={`logl lv-${line.level}`}>
              <span className="lt">{line.t}</span>
              <span className="ll">{line.level}</span>
              <span className="lx">{line.text}</span>
            </div>
          ))}
        </div>
      ) : null}
      {open ? <ChangePool bot={bot} onClose={() => setOpen(false)} reload={reload} /> : null}
    </Card>
  );
}
