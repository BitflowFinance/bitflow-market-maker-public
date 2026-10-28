import { ReactNode, useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BotView, BridgeTransfer, BridgeView, api, botPath, explorerAddress, explorerTx, mempoolAddress, mempoolTx } from './api';
import type { Shared } from './App';
import { addressInput, ago, clock, decimalInput, shortAddr, tok } from './format';
import { QrCode } from './QrCode';
import { Card, CopyButton, Empty, Icon, RiskConfirm, useNow, useToast } from './ui';

const coins = (sats: number): string => (sats / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
const btc = (sats: number | null | undefined, unit = 'BTC'): string => (sats == null ? '—' : `${coins(sats)} ${unit}`);
// Fees are a few hundred sats, which read better as sats than as 0.00000339 BTC.
const satsText = (sats: number): string => `${sats.toLocaleString('en-US')} sats`;

const open = (transfer: BridgeTransfer): boolean => transfer.status !== 'done' && transfer.status !== 'failed';

// A bridge request costs a fraction of this in STX fees; below it the request would fail to send.
const MIN_STX_FOR_FEE = 0.05;

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
export function DepositPanel({ view }: { view: BridgeView }) {
  const deposit = view.deposit;
  if (!deposit) return <p className="muted">Getting a deposit address…</p>;
  return (
    <div className="dep">
      {view.demo ? <p className="dep-warn">Demo address. Do not send real BTC to it.</p> : null}
      {!view.tradesSbtc ? <p className="dep-warn">This bot does not trade sBTC.</p> : null}
      <div className="dep-main">
        <QrCode text={deposit.address} size={128} />
        <div className="dep-addr">
          <span className="field-l">Deposit address</span>
          <span className="mono dep-v">{deposit.address}</span>
          <CopyButton text={deposit.address} label="Copy" />
        </div>
      </div>
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

const STATUS: Record<BridgeTransfer['kind'], Record<BridgeTransfer['status'], string>> = {
  deposit: { sending: 'Detected', sent: 'Detected', processing: 'Minting', done: 'Done', failed: 'Failed' },
  withdraw: { sending: 'Signing', sent: 'Signing', processing: 'Sending BTC', done: 'Done', failed: 'Failed' },
};
const TONE: Record<BridgeTransfer['status'], string> = { sending: 't-info', sent: 't-info', processing: 't-info', done: 't-good', failed: 't-serious' };

function Activity({ transfers, bots }: { transfers: AnyTransfer[]; bots: BotView[] }) {
  const now = useNow(30_000);
  if (!transfers.length) return <p className="muted">No transfers yet.</p>;
  return (
    <ul className="act">
      {transfers.map((t) => (
        <li key={`${t.botId || ''}-${t.id}`}>
          <div className="act-main">
            <span className="act-dir">{t.kind === 'deposit' ? 'BTC → sBTC' : 'sBTC → BTC'}</span>
            <span className="act-amt num">{btc(t.amountSats)}</span>
            {(() => {
              const owner = bots.find((item) => item.id === t.botId);
              return owner ? (
                <span className="act-sub">
                  {botLabelOf(owner)} ·{' '}
                  <a className="mono" href={explorerAddress(owner.address || '')} target="_blank" rel="noreferrer" title={owner.address || ''}>
                    {shortAddr(owner.address)}
                  </a>
                  {t.kind === 'withdraw' && t.btcAddress ? (
                    <>
                      {' → '}
                      <a className="mono" href={mempoolAddress(t.btcAddress)} target="_blank" rel="noreferrer" title={t.btcAddress}>
                        {shortAddr(t.btcAddress)}
                      </a>
                    </>
                  ) : null}
                </span>
              ) : null;
            })()}
          </div>
          <span className={`tag ${TONE[t.status]}`}>{STATUS[t.kind][t.status]}</span>
          <span className="act-end">
            {t.btcTxid ? (
              <a href={mempoolTx(t.btcTxid)} target="_blank" rel="noreferrer" title="Bitcoin transaction">
                Bitcoin tx <Icon name="external" size={10} />
              </a>
            ) : null}
            {t.stacksTxid ? (
              <a href={explorerTx(t.stacksTxid)} target="_blank" rel="noreferrer" title="Stacks transaction">
                Stacks tx <Icon name="external" size={10} />
              </a>
            ) : null}
            <span className="act-t" title={clock(t.createdAt)}>
              {ago(t.createdAt, now)}
            </span>
          </span>
          {t.status === 'failed' ? <p className="act-why">{t.message}</p> : null}
        </li>
      ))}
    </ul>
  );
}

const PAGE = 5;

/**
 * The bot wallet. Only the chosen one shows; Change opens the list, a few at a
 * time, so ten bots do not fill the page.
 */
function WalletPick({ bots, bot, view, onPick }: { bots: BotView[]; bot: BotView; view: BridgeView | null; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const card = (item: BotView, end: ReactNode) => {
    // The chosen bot's figure comes from the bridge read, which is fresher (and is the demo's in demo mode).
    const chain = item.liveWallet ? (item.baseSymbol === 'sBTC' ? item.liveWallet.base : item.quoteSymbol === 'sBTC' ? item.liveWallet.quote : null) : null;
    const held = item.id === bot.id && view?.withdraw.heldSats != null ? view.withdraw.heldSats / 1e8 : chain;
    return (
      <>
        <span className="choice-body">
          <span className="choice-t">{botLabelOf(item)}</span>
          <span className="choice-s">
            {item.pair} ·{' '}
            <a className="mono" href={explorerAddress(item.address || '')} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              {shortAddr(item.address)}
            </a>
            {held != null ? ` · ${tok(held, 'sBTC')}` : ''}
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

  const pause = async () => {
    try {
      await api(`/api/bots/${encodeURIComponent(bot.id)}/pause`, 'POST', {});
      await reload();
    } catch (err) {
      toast('bad', err instanceof Error ? err.message : 'Could not pause the bot.');
    }
  };

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
      {w.blocked ? (
        <div className="banner2 info center">
          <Icon name="info" />
          <div className="grow">{w.blocked}</div>
          {w.blocked.startsWith('Pause') ? (
            <button type="button" className="btn sm" onClick={() => void pause()}>
              Pause
            </button>
          ) : null}
        </div>
      ) : null}
      <label className="field">
        <span className="field-row">
          <span className="field-l">Amount</span>
          <span className="field-aside">
            Balance {btc(w.heldSats, 'sBTC')}
            {max != null && max >= w.minSats ? (
              <button type="button" className="linkbtn" onClick={() => setAmount(coins(max))}>
                Max
              </button>
            ) : null}
          </span>
        </span>
        <span className="in-unit">
          <input className="in in-lg" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(decimalInput(e.target.value, 8))} />
          <span className="unit">sBTC</span>
        </span>
        {amountProblem ? <span className="sf-h bad">{amountProblem}</span> : null}
      </label>
      <label className="field">
        <span className="field-l">Bitcoin address</span>
        <input className="in mono" placeholder="bc1…" value={address} onChange={(e) => setAddress(addressInput(e.target.value))} spellCheck={false} autoComplete="off" />
        {addressProblem ? <span className="sf-h bad">{addressProblem}</span> : null}
      </label>
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
      {noStx ? (
        <p className="sf-h bad">
          The bot wallet needs a little STX for the network fee. <Link to={`${botPath(bot)}?tab=wallet`}>Add STX</Link>
        </p>
      ) : null}
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
            ['To', <span className="mono">{address.trim()}</span>],
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

const trades = (bot: BotView): boolean => bot.baseSymbol === 'sBTC' || bot.quoteSymbol === 'sBTC';
const holdsStraySbtc = (bot: BotView): boolean => bot.strayTokens.some((token) => token.symbol === 'sBTC' && token.amount > 0);

export function BridgePage({ fleet }: Shared) {
  const [params, setParams] = useSearchParams();
  // Bots that trade sBTC, plus any other bot holding sBTC sent to it by mistake, which can only bridge out.
  const bots = fleet.bots.filter((bot) => !bot.preview && bot.address && (trades(bot) || holdsStraySbtc(bot)));
  const asked = params.get('bot') || lastBot();
  const bot = bots.find((item) => item.id === asked) || bots.find(trades) || bots[0] || null;
  const [chosen, setDirection] = useState<Direction>(params.get('dir') === 'out' ? 'out' : 'in');
  const direction: Direction = bot && !trades(bot) ? 'out' : chosen;
  const { view, error, reload } = useBridge(bot ? bot.id : null, true, direction === 'in');
  const [all, setAll] = useState<AnyTransfer[]>([]);
  useEffect(() => {
    api<{ transfers: AnyTransfer[] }>('/api/bridge')
      .then((res) => setAll(res.transfers))
      .catch(() => undefined);
  }, [view]);

  if (!bot) {
    return (
      <div className="page narrow">
        <h1 className="page-t">Bridge</h1>
        <Card>
          <Empty icon="bridge" title="No sBTC bot yet">
            Bridging moves BTC in and out of an sBTC bot's wallet. <Link to="/new">Create one</Link> to start.
          </Empty>
        </Card>
      </div>
    );
  }

  const pick = (id: string): void => {
    rememberBot(id);
    setParams({ bot: id }, { replace: true });
  };
  const simulate = (): void => {
    void api(`/api/bots/${encodeURIComponent(bot.id)}/bridge-demo-send`, 'POST', {}).then(() => reload());
  };

  return (
    <div className="page narrow">
      <h1 className="page-t">Bridge</h1>
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
          {(
            [
              ['in', 'BTC → sBTC'],
              ['out', 'sBTC → BTC'],
            ] as const
          ).map(([value, text]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={direction === value}
              className={direction === value ? 'on' : ''}
              disabled={value === 'in' && !trades(bot)}
              title={value === 'in' && !trades(bot) ? 'This bot does not trade sBTC, so it can only bridge out.' : undefined}
              onClick={() => setDirection(value)}
            >
              {text}
            </button>
          ))}
        </div>
        <div className="field">
          <span className="field-l">{direction === 'in' ? 'To' : 'From'}</span>
          <WalletPick bots={bots} bot={bot} view={view} onPick={pick} />
        </div>
        {error ? <p className="form-err">{error}</p> : null}
        {!view ? <span className="spinner" /> : direction === 'in' ? <DepositPanel view={view} /> : <BridgeOut bot={bot} view={view} reload={reload} />}
      </Card>
      <Card title="Activity">
        <Activity transfers={all} bots={fleet.bots} />
      </Card>
    </div>
  );
}
