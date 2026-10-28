import { ReactNode, useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BotView, BridgeAsset, BridgeTransfer, BridgeView, api, botPath, etherscanAddress, etherscanTx, explorerAddress, explorerTx, mempoolAddress, mempoolTx } from './api';
import type { Shared } from './App';
import { addressInput, ago, clock, decimalInput, shortAddr, tok } from './format';
import { QrCode } from './QrCode';
import { BalanceFill, Card, SHORT_LIST, CopyButton, Empty, Icon, RiskConfirm, useNow, useToast } from './ui';
import { MIN_STX_FOR_FEE, NeedsStx, OutBlocked, UsdcIn, UsdcOut, usdc } from './UsdcBridge';

const coins = (sats: number): string => (sats / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
const btc = (sats: number | null | undefined, unit = 'BTC'): string => (sats == null ? '—' : `${coins(sats)} ${unit}`);
// Fees are a few hundred sats, which read better as sats than as 0.00000339 BTC.
const satsText = (sats: number): string => `${sats.toLocaleString('en-US')} sats`;

const open = (transfer: BridgeTransfer): boolean => transfer.status !== 'done' && transfer.status !== 'failed';

/**
 * The bot's bridge state, refreshed while the page is open. With `ensureAddress`
 * a missing deposit address is made on first load; that is safe because nothing
 * leaves the wallet and the address only pays into it.
 */
export const useBridge = (botId: string | null, ensureAddress: boolean, watching = false): { view: BridgeView | null; error: string; reload: () => Promise<void> } => {
  const [view, setView] = useState<BridgeView | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    if (!botId) return;
    const base = `/api/bots/${encodeURIComponent(botId)}`;
    try {
      const next = await api<BridgeView>(`${base}/bridge`);
      setView(next);
      setError('');
      if (ensureAddress && !next.deposit) setView(await api<BridgeView>(`${base}/bridge-deposit`, 'POST', {}));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the bridge.');
    }
  }, [botId, ensureAddress]);
  // Quicker while a transfer is moving, or while a deposit address is on screen and BTC may land.
  const busy = watching || Boolean(view?.transfers.some(open));
  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), busy ? 8000 : 30_000);
    return () => clearInterval(timer);
  }, [reload, busy]);
  return { view, error, reload };
};

/** Where to send BTC so it arrives in the bot wallet as sBTC. Also used on the Fund step of a new bot. */
export function DepositPanel({ view, target }: { view: BridgeView; target?: ReactNode }) {
  const deposit = view.deposit;
  if (!deposit) {
    return (
      <div className="dep">
        <p className="muted">Getting a deposit address…</p>
        {target}
      </div>
    );
  }
  return (
    <div className="dep">
      {view.demo ? <p className="dep-warn">Demo address. Do not send real BTC to it.</p> : null}
      {!view.tradesSbtc ? <p className="dep-warn">This bot does not trade sBTC.</p> : null}
      <div className="field">
        <span className="field-l">From</span>
        <div className="dep-main">
          <QrCode text={deposit.address} size={128} />
          <div className="dep-addr">
            <span className="field-l">Deposit address</span>
            <span className="mono dep-v">{deposit.address}</span>
            <CopyButton text={deposit.address} label="Copy" />
          </div>
        </div>
      </div>
      {target}
      <dl className="kv">
        <div>
          <dt>Minimum</dt>
          <dd>{btc(deposit.minSats)}</dd>
        </div>
        <div>
          <dt>Fee</dt>
          <dd>{deposit.feeSats != null ? `~${satsText(deposit.feeSats)}` : '—'}</dd>
        </div>
        <div>
          <dt>Arrives in</dt>
          <dd>1–2 hours</dd>
        </div>
      </dl>
      <p className="note">Keep this app running until it arrives.</p>
    </div>
  );
}

const LAST_BOT = 'mm.lastBot';

/** Remembers the bot last opened, so the Bridge page starts on it. */
export const rememberBot = (id: string): void => {
  try {
    localStorage.setItem(LAST_BOT, id);
  } catch {
    // Private windows can refuse storage; the page then starts on the first sBTC bot.
  }
};

const lastBot = (): string => {
  try {
    return localStorage.getItem(LAST_BOT) || '';
  } catch {
    return '';
  }
};

const botLabelOf = (bot: BotView): string => bot.name || bot.pair;

type AnyTransfer = BridgeTransfer & { botId?: string };

// One word per state; the tracker's own message (on hover) says which step it is on.
const STATUS: Record<BridgeTransfer['status'], string> = { sending: 'Processing', sent: 'Processing', processing: 'Processing', done: 'Success', failed: 'Failed' };
const DIRECTION: Record<BridgeAsset, Record<BridgeTransfer['kind'], string>> = {
  btc: { deposit: 'BTC → sBTC', withdraw: 'sBTC → BTC' },
  usdc: { deposit: 'USDC → USDCx', withdraw: 'USDCx → USDC' },
};
const amountOf = (t: BridgeTransfer): string => (t.asset === 'usdc' ? usdc(t.amount, t.kind === 'deposit' ? 'USDC' : 'USDCx') : btc(t.amount));
const TONE: Record<BridgeTransfer['status'], string> = { sending: 't-info', sent: 't-info', processing: 't-info', done: 't-good', failed: 't-serious' };

/** The transfer's transactions in the order they happen: the sending chain's first. */
const txLinks = (t: BridgeTransfer): Array<{ label: string; href: string }> => {
  const outside = [
    t.btcTxid ? { label: 'Bitcoin', href: mempoolTx(t.btcTxid) } : null,
    t.ethTxid ? { label: 'Ethereum', href: etherscanTx(t.ethTxid) } : null,
  ].filter((link): link is { label: string; href: string } => link != null);
  const stacks = t.stacksTxid ? [{ label: 'Stacks', href: explorerTx(t.stacksTxid) }] : [];
  return t.kind === 'deposit' ? [...outside, ...stacks] : [...stacks, ...outside];
};

function Activity({ transfers, bots }: { transfers: AnyTransfer[]; bots: BotView[] }) {
  const now = useNow(30_000);
  const [showAll, setShowAll] = useState(false);
  if (!transfers.length) return <p className="muted">No transfers yet.</p>;
  const rows = showAll ? transfers : transfers.slice(0, SHORT_LIST);
  return (
    <>
      <ul className="act">
        {rows.map((t) => (
          <li key={`${t.botId || ''}-${t.id}`}>
            <div className="act-main">
              <span className="act-dir">{DIRECTION[t.asset][t.kind]}</span>
              <span className="act-amt num">{amountOf(t)}</span>
              {(() => {
                const owner = bots.find((item) => item.id === t.botId);
                if (!owner) return null;
                const botEnd = (
                  <>
                    <Link to={botPath(owner)}>{botLabelOf(owner)}</Link> (
                    <a className="mono" href={explorerAddress(owner.address || '')} target="_blank" rel="noreferrer" title={owner.address || ''}>
                      {shortAddr(owner.address)}
                    </a>
                    )
                  </>
                );
                const outside = t.depositAddress
                  ? { href: mempoolAddress(t.depositAddress), text: t.depositAddress }
                  : t.btcAddress
                    ? { href: mempoolAddress(t.btcAddress), text: t.btcAddress }
                    : t.ethAddress
                      ? { href: etherscanAddress(t.ethAddress), text: t.ethAddress }
                      : null;
                const outsideEnd = outside ? (
                  <a className="mono" href={outside.href} target="_blank" rel="noreferrer" title={outside.text}>
                    {shortAddr(outside.text)}
                  </a>
                ) : null;
                // Written in the direction the money moves: deposits arrive at the bot, withdrawals leave it.
                const [from, to] = t.kind === 'deposit' ? [outsideEnd, botEnd] : [botEnd, outsideEnd];
                return (
                  <span className="act-sub">
                    {from ? (
                      <>
                        {from}
                        {' → '}
                      </>
                    ) : (
                      '→ '
                    )}
                    {to}
                  </span>
                );
              })()}
            </div>
            <span className={`tag ${TONE[t.status]}`} title={t.status === 'failed' ? undefined : t.message || undefined}>
              {STATUS[t.status]}
            </span>
            <span className="act-end">
              {txLinks(t).map((link) => (
                <a key={link.href} href={link.href} target="_blank" rel="noreferrer" title={`${link.label} transaction`}>
                  {link.label} tx <Icon name="external" size={10} />
                </a>
              ))}
              <span className="act-t" title={clock(t.createdAt)}>
                {ago(t.createdAt, now)}
              </span>
            </span>
            {t.status === 'failed' ? <p className="act-why">{t.message}</p> : null}
          </li>
        ))}
      </ul>
      {transfers.length > SHORT_LIST ? (
        <div className="tbl-more">
          <button type="button" className="btn sm ghost" onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Show fewer' : `Show all ${transfers.length}`}
          </button>
        </div>
      ) : null}
    </>
  );
}

const PAGE = 5;

/** A fixed "To" for one bot, where there is nothing to pick (the new-bot Fund step). */
export function BotTo({ bot, view, symbol }: { bot: BotView; view: BridgeView | null; symbol: string }) {
  return (
    <div className="field">
      <span className="field-l">To</span>
      <WalletPick bots={[bot]} bot={bot} view={view} symbol={symbol} onPick={() => undefined} />
    </div>
  );
}

/**
 * The bot wallet. Only the chosen one shows; Change opens the list, a few at a
 * time, so ten bots do not fill the page.
 */
function WalletPick({ bots, bot, view, symbol, onPick }: { bots: BotView[]; bot: BotView; view: BridgeView | null; symbol: string; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const card = (item: BotView, end: ReactNode) => {
    // The chosen bot's figure comes from the bridge read, which is fresher (and is the demo's in demo mode).
    const chain = item.liveWallet ? (item.baseSymbol === symbol ? item.liveWallet.base : item.quoteSymbol === symbol ? item.liveWallet.quote : null) : null;
    const fresh = symbol === 'sBTC' ? (view?.withdraw.heldSats != null ? view.withdraw.heldSats / 1e8 : null) : view?.usdc.held != null ? view.usdc.held / 1e6 : null;
    const held = item.id === bot.id && fresh != null ? fresh : chain;
    return (
      <>
        <span className="choice-body">
          <span className="choice-t">{botLabelOf(item)}</span>
          <span className="choice-s">
            {item.pair} ·{' '}
            <a className="mono" href={explorerAddress(item.address || '')} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              {shortAddr(item.address)}
            </a>
            {held != null ? ` · ${tok(held, symbol)}` : ''}
          </span>
        </span>
        {end}
      </>
    );
  };
  if (!open || bots.length < 2) {
    return (
      <div className="choice static">
        {card(
          bot,
          bots.length > 1 ? (
            <button type="button" className="linkbtn choice-act" onClick={() => setOpen(true)}>
              Change
            </button>
          ) : null,
        )}
      </div>
    );
  }
  const list = bots.slice(0, shown);
  return (
    <div className="choices" role="radiogroup" aria-label="Bot wallet">
      {list.map((item) => (
        <button
          key={item.id}
          type="button"
          role="radio"
          aria-checked={item.id === bot.id}
          className={`choice${item.id === bot.id ? ' on' : ''}`}
          onClick={() => {
            onPick(item.id);
            setOpen(false);
            setShown(PAGE);
          }}
        >
          {card(item, null)}
        </button>
      ))}
      <div className="pick-more">
        {shown < bots.length ? (
          <button type="button" className="btn sm ghost" onClick={() => setShown(shown + PAGE)}>
            Show {Math.min(PAGE, bots.length - shown)} more
          </button>
        ) : null}
        {shown > PAGE ? (
          <button type="button" className="btn sm ghost" onClick={() => setShown(PAGE)}>
            Show fewer
          </button>
        ) : null}
        <span className="spacer" />
        <button type="button" className="btn sm ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function BridgeOut({ bot, view, reload }: { bot: BotView; view: BridgeView; reload: () => Promise<void> }) {
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [address, setAddress] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const w = view.withdraw;
  const fee = w.feeSats;
  const max = w.heldSats != null && fee != null ? Math.max(0, w.heldSats - fee) : null;
  const sats = /^\d+(\.\d{1,8})?$/.test(amount.trim()) ? Math.round(Number(amount) * 1e8) : null;
  const amountProblem = !amount.trim()
    ? ''
    : sats == null || sats <= 0
      ? 'Enter an amount.'
      : sats < w.minSats
        ? `Minimum ${btc(w.minSats)}.`
        : max != null && sats > max
          ? max < w.minSats
            ? 'Not enough sBTC.'
            : `Maximum ${btc(max)} after the fee.`
          : w.maxSats != null && sats > w.maxSats
            ? `The bridge takes at most ${btc(w.maxSats)} right now.`
            : '';
  const addressProblem = address.trim() && !/^(bc1|1|3)[a-zA-HJ-NP-Z0-9]{20,90}$/.test(address.trim()) ? 'Not a Bitcoin address.' : '';
  const noStx = view.stx != null && view.stx < MIN_STX_FOR_FEE;
  const ready = sats != null && !amountProblem && Boolean(address.trim()) && !addressProblem && !w.blocked && !noStx;

  const send = async () => {
    setBusy(true);
    setError('');
    try {
      await api(`/api/bots/${encodeURIComponent(bot.id)}/bridge-withdraw`, 'POST', { amount: amount.trim(), btcAddress: address.trim(), acknowledged: true, poolName: bot.pair });
      setConfirm(false);
      setAmount('');
      setAddress('');
      toast('good', 'Bridge started. Follow it under Activity.');
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the bridge.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bout">
      <OutBlocked bot={bot} blocked={w.blocked} reload={reload} />
      <label className="field">
        <span className="field-l">To</span>
        <input className="in mono" placeholder="Your Bitcoin address (bc1…)" value={address} onChange={(e) => setAddress(addressInput(e.target.value))} spellCheck={false} autoComplete="off" />
        {addressProblem ? <span className="sf-h bad">{addressProblem}</span> : null}
      </label>
      <div className="field">
        <span className="field-row">
          <span className="field-l">Amount</span>
          <span className="field-aside">
            <BalanceFill text={btc(w.heldSats, 'sBTC')} onFill={max ? () => setAmount(coins(max)) : null} />
          </span>
        </span>
        <span className="in-unit">
          <input className="in in-lg" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} onChange={(e) => setAmount(decimalInput(e.target.value, 8))} />
          <span className="unit">sBTC</span>
        </span>
        {amountProblem ? <span className="sf-h bad">{amountProblem}</span> : null}
      </div>
      <dl className="kv">
        <div>
          <dt>You receive</dt>
          <dd>{sats != null && !amountProblem ? btc(sats) : '—'}</dd>
        </div>
        <div>
          <dt>Network fee</dt>
          <dd title={fee != null ? `Up to ${btc(fee, 'sBTC')} is set aside; the unused part comes back.` : undefined}>{w.costSats != null ? `~${satsText(w.costSats)}` : '—'}</dd>
        </div>
        <div>
          <dt>Arrives in</dt>
          <dd>About an hour</dd>
        </div>
      </dl>
      {noStx ? <NeedsStx bot={bot} /> : null}
      {error && !confirm ? <p className="form-err">{error}</p> : null}
      <button type="button" className="btn primary wide" disabled={!ready} onClick={() => setConfirm(true)}>
        Bridge to BTC
      </button>
      {confirm && sats != null ? (
        <RiskConfirm
          title="Bridge sBTC to BTC"
          lead="Bitcoin transfers cannot be undone. Check the address."
          facts={[
            ['You receive', btc(sats)],
            [
              'To',
              <a className="mono" href={mempoolAddress(address.trim())} target="_blank" rel="noreferrer">
                {address.trim()}
              </a>,
            ],
          ]}
          poolName={bot.pair}
          confirmLabel="Bridge"
          busy={busy}
          error={error}
          onClose={() => setConfirm(false)}
          onConfirm={() => void send()}
        />
      ) : null}
    </div>
  );
}

type Direction = 'in' | 'out';

/** Per asset: the token a bot holds, and the two directions. */
const ASSETS: Record<BridgeAsset, { symbol: string; label: string; dirs: [string, string] }> = {
  btc: { symbol: 'sBTC', label: 'BTC', dirs: ['BTC → sBTC', 'sBTC → BTC'] },
  usdc: { symbol: 'USDCx', label: 'USDC', dirs: ['USDC → USDCx', 'USDCx → USDC'] },
};

const trades = (bot: BotView, symbol: string): boolean => bot.baseSymbol === symbol || bot.quoteSymbol === symbol;
const holdsStray = (bot: BotView, symbol: string): boolean => bot.strayTokens.some((token) => token.symbol === symbol && token.amount > 0);

export function BridgePage({ fleet }: Shared) {
  const [params, setParams] = useSearchParams();
  const asset: BridgeAsset = params.get('asset') === 'usdc' ? 'usdc' : 'btc';
  const { symbol, label, dirs } = ASSETS[asset];
  // Bots that trade the token, plus any other bot holding it by mistake, which can only bridge out.
  const bots = fleet.bots.filter((bot) => !bot.preview && bot.address && (trades(bot, symbol) || holdsStray(bot, symbol)));
  const asked = params.get('bot') || lastBot();
  const bot = bots.find((item) => item.id === asked) || bots.find((item) => trades(item, symbol)) || bots[0] || null;
  const chosen: Direction = params.get('dir') === 'out' ? 'out' : 'in';
  const direction: Direction = bot && !trades(bot, symbol) ? 'out' : chosen;
  // Only BTC deposits need an address made and watched; USDC deposits are reported by the page.
  const { view, error, reload } = useBridge(bot ? bot.id : null, asset === 'btc', direction === 'in');
  const [all, setAll] = useState<AnyTransfer[]>([]);
  useEffect(() => {
    api<{ transfers: AnyTransfer[] }>('/api/bridge')
      .then((res) => setAll(res.transfers))
      .catch(() => undefined);
  }, [view]);

  const set = (patch: Record<string, string | null>): void => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value == null) next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  };
  const pick = (id: string): void => {
    rememberBot(id);
    set({ bot: id });
  };
  const assetPick = (
    <div className="asset-pick" role="tablist" aria-label="Asset">
      {(Object.keys(ASSETS) as BridgeAsset[]).map((key) => (
        <button key={key} type="button" role="tab" aria-selected={asset === key} className={asset === key ? 'on' : ''} onClick={() => set({ asset: key === 'btc' ? null : key, dir: null })}>
          {ASSETS[key].label}
        </button>
      ))}
    </div>
  );

  if (!bot) {
    return (
      <div className="page narrow">
        <div className="bridge-h">
          <h1 className="page-t">Bridge</h1>
          {assetPick}
        </div>
        <Card>
          <Empty icon="bridge" title={`No ${symbol} bot yet`}>
            Bridging moves {label} in and out of a bot wallet. <Link to="/new">Create a bot</Link> to start.
          </Empty>
        </Card>
      </div>
    );
  }

  const botField = (
    <div className="field">
      <span className="field-l">{direction === 'in' ? 'To' : 'From'}</span>
      <WalletPick bots={bots} bot={bot} view={view} symbol={symbol} onPick={pick} />
    </div>
  );
  const simulate = (): void => {
    void api(`/api/bots/${encodeURIComponent(bot.id)}/bridge-demo-send`, 'POST', { asset }).then(() => reload());
  };

  return (
    <div className="page narrow">
      <div className="bridge-h">
        <h1 className="page-t">Bridge</h1>
        {assetPick}
      </div>
      {view?.demo ? (
        <div className="banner2 serious center">
          <Icon name="warn" />
          <div className="grow">
            <b>Demo mode.</b> Made-up data; nothing is sent.
          </div>
          {direction === 'in' ? (
            <button type="button" className="btn sm" onClick={simulate}>
              Simulate a deposit
            </button>
          ) : null}
        </div>
      ) : null}
      <Card>
        <div className="dirs" role="tablist">
          {(['in', 'out'] as const).map((value, i) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={direction === value}
              className={direction === value ? 'on' : ''}
              disabled={value === 'in' && !trades(bot, symbol)}
              title={value === 'in' && !trades(bot, symbol) ? `This bot does not trade ${symbol}, so it can only bridge out.` : undefined}
              onClick={() => set({ dir: value === 'out' ? 'out' : null })}
            >
              {dirs[i]}
            </button>
          ))}
        </div>
        {direction === 'in' && view ? null : botField}
        {error ? <p className="form-err">{error}</p> : null}
        {!view ? (
          <span className="spinner" />
        ) : asset === 'usdc' ? (
          direction === 'in' ? (
            // From the user's Ethereum wallet comes first, so the bot goes below it.
            <UsdcIn bot={bot} view={view} reload={reload} target={botField} />
          ) : (
            <UsdcOut key={bot.id} bot={bot} view={view} reload={reload} />
          )
        ) : direction === 'in' ? (
          <DepositPanel view={view} target={botField} />
        ) : (
          <BridgeOut key={bot.id} bot={bot} view={view} reload={reload} />
        )}
      </Card>
      <Card title="Activity">
        <Activity transfers={all} bots={fleet.bots} />
      </Card>
    </div>
  );
}
