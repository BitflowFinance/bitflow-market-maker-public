import { useEffect, useState } from 'react';
import { PoolCatalog, PoolOption, api } from './api';
import { price, usd } from './format';
import { Icon } from './ui';

/** Loads the pools of a pair, best first. Null while loading; an error string if it failed. */
export const usePoolCatalog = (profile: string | null): { catalog: PoolCatalog | null; error: string } => {
  const [catalog, setCatalog] = useState<PoolCatalog | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!profile) return;
    let live = true;
    setCatalog(null);
    setError('');
    api<PoolCatalog>(`/api/pools?profile=${encodeURIComponent(profile)}`)
      .then((res) => {
        if (live) setCatalog(res);
      })
      .catch((err: Error) => {
        if (live) setError(err.message);
      });
    return () => {
      live = false;
    };
  }, [profile]);
  return { catalog, error };
};

const compact = (value: number | null): string => {
  if (value == null) return '—';
  if (value >= 1000) return `$${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return usd(value);
};

function Row({ pool, quote, selected, current, onPick }: { pool: PoolOption; quote: string; selected: boolean; current: boolean; onPick?: () => void }) {
  const body = (
    <>
      <span className="pl-h">
        <span className="mono pl-name">{pool.name}</span>
        {pool.recommended ? <span className="tag t-good">Recommended</span> : null}
        {current ? <span className="tag">Current</span> : null}
      </span>
      <span className="pl-facts">
        <span title="Liquidity within 10 bins of the price">{compact(pool.depth)} near price</span>
        <span>
          Range {price(pool.rangeLow, '').trim()} – {price(pool.rangeHigh, quote)}
        </span>
        <span>{pool.binStepBps} bps bins</span>
        {pool.feeBps != null ? <span>{(pool.feeBps / 100).toFixed(2)}% fee</span> : null}
      </span>
      {pool.reasons.length ? <span className="pl-why">{pool.reasons[0]}</span> : null}
    </>
  );
  if (!onPick || !pool.ok || current) {
    return <div className={`pl-row${pool.ok ? '' : ' off'}${current ? ' cur' : ''}`}>{body}</div>;
  }
  return (
    <button type="button" role="radio" aria-checked={selected} className={`pl-row${selected ? ' on' : ''}`} onClick={onPick}>
      {body}
    </button>
  );
}

/** The pools of one pair: usable ones to pick from, the rest folded away with the reason they were skipped. */
export function PoolList({
  catalog,
  quote,
  value,
  onChange,
  currentPoolId,
}: {
  catalog: PoolCatalog;
  quote: string;
  value: string;
  onChange: (poolId: string) => void;
  currentPoolId?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const usable = catalog.pools.filter((pool) => pool.ok);
  const skipped = catalog.pools.filter((pool) => !pool.ok);
  if (!catalog.pools.length) return <p className="muted">No pools found for this pair right now.</p>;
  return (
    <div className="pl" role="radiogroup">
      {catalog.market != null ? (
        <p className="note">
          Market price {price(catalog.market, quote)}. Pools are ranked by liquidity near that price.
        </p>
      ) : null}
      {usable.map((pool) => (
        <Row key={pool.poolId} pool={pool} quote={quote} selected={pool.poolId === value} current={pool.poolId === currentPoolId} onPick={() => onChange(pool.poolId)} />
      ))}
      {!usable.length ? <p className="form-err">No pool of this pair suits the bot right now.</p> : null}
      {skipped.length ? (
        <>
          <button type="button" className="btn sm ghost pl-more" onClick={() => setShowAll(!showAll)} aria-expanded={showAll}>
            <Icon name={showAll ? 'x' : 'plus'} size={12} />
            {showAll ? 'Hide' : 'Show'} {skipped.length} other pool{skipped.length === 1 ? '' : 's'}
          </button>
          {showAll
            ? skipped.map((pool) => <Row key={pool.poolId} pool={pool} quote={quote} selected={false} current={pool.poolId === currentPoolId} />)
            : null}
        </>
      ) : null}
    </div>
  );
}
