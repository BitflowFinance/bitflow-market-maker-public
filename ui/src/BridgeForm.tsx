// Parked: not imported while bridging is off. See docs/ROADMAP.md.
import { useEffect, useState } from 'react';
import { BotView, BridgeJob, api } from './api';
import { shortAddr } from './format';
import { CopyButton, Icon, RiskConfirm, Seg, useToast } from './ui';

type Direction = 'btc_to_sbtc' | 'sbtc_to_btc' | 'usdc_to_usdcx' | 'usdcx_to_usdc';

const DIRECTIONS: Array<{ value: Direction; label: string; from: string; to: string }> = [
  { value: 'btc_to_sbtc', label: 'BTC → sBTC', from: 'BTC', to: 'sBTC' },
  { value: 'sbtc_to_btc', label: 'sBTC → BTC', from: 'sBTC', to: 'BTC' },
  { value: 'usdc_to_usdcx', label: 'USDC → USDCx', from: 'USDC', to: 'USDCx' },
  { value: 'usdcx_to_usdc', label: 'USDCx → USDC', from: 'USDCx', to: 'USDC' },
];

const NOT_YET: Record<string, string> = {
  sbtc_to_btc: 'Not built yet. Withdrawing sBTC needs a transaction signed by the bot wallet.',
  usdc_to_usdcx: 'Not built yet. USDCx is minted via Circle xReserve from an Ethereum wallet (min 10 USDC), which the page can’t connect to yet.',
  usdcx_to_usdc: 'Not built yet.',
};

export function BridgeForm({ bots, botId, available, onJob }: { bots: BotView[]; botId?: string; available: string[]; onJob?: (job: BridgeJob) => void }) {
  const toast = useToast();
  const targets = bots.filter((bot) => !bot.preview && bot.address);
  const [direction, setDirection] = useState<Direction>('btc_to_sbtc');
  const [target, setTarget] = useState(botId || targets.find((bot) => bot.baseSymbol === 'sBTC')?.id || targets[0]?.id || '');
  const [amount, setAmount] = useState('');
  const [reclaimKey, setReclaimKey] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [job, setJob] = useState<BridgeJob | null>(null);
  const [txid, setTxid] = useState('');

  useEffect(() => {
    if (botId) setTarget(botId);
  }, [botId]);

  const bot = targets.find((item) => item.id === target);
  const ready = direction === 'btc_to_sbtc' && available.indexOf(direction) >= 0;
  const amountOk = /^\d+(\.\d+)?$/.test(amount.trim()) && Number(amount) >= 0.001;
  const keyOk = /^(0x)?((02|03)[0-9a-fA-F]{64}|[0-9a-fA-F]{64})$/.test(reclaimKey.trim());

  if (!targets.length) {
    return <p className="muted">Create a bot first. Bridged funds go straight to a bot's wallet.</p>;
  }

  if (job) return <JobView job={job} txid={txid} setTxid={setTxid} setJob={setJob} onReset={() => setJob(null)} />;

  const start = async () => {
    if (!bot) return;
    setBusy(true);
    setError('');
    try {
      const next = await api<BridgeJob>('/api/bridge', 'POST', {
        botId: bot.id,
        direction,
        amount: amount.trim(),
        acknowledged: true,
        poolName: bot.pair,
        reclaimPublicKey: reclaimKey.trim(),
      });
      if (next.status === 'failed') {
        setError(next.message);
        return;
      }
      setConfirm(false);
      setJob(next);
      onJob?.(next);
      toast('good', 'Deposit address ready.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the deposit.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bridge">
      <Seg
        value={direction}
        onChange={setDirection}
        options={DIRECTIONS.map((item) => ({
          value: item.value,
          label: item.label,
          note: available.indexOf(item.value) >= 0 ? undefined : 'not yet',
          disabled: available.indexOf(item.value) < 0,
        }))}
      />
      {!ready ? (
        <div className="banner2 info">
          <Icon name="bridge" />
          <div>{NOT_YET[direction] || 'This direction is not built into the page yet.'}</div>
        </div>
      ) : (
        <div className="bridge-form">
          <div className="flow">
            <span>
              <b>1</b> Get address
            </span>
            <Icon name="arrow" size={12} />
            <span>
              <b>2</b> Send BTC
            </span>
            <Icon name="arrow" size={12} />
            <span>
              <b>3</b> Paste tx id
            </span>
            <Icon name="arrow" size={12} />
            <span>
              <b>4</b> sBTC arrives
            </span>
          </div>
          {!botId ? (
            <label className="field">
              <span className="field-l">Send to</span>
              <select className="in" value={target} onChange={(e) => setTarget(e.target.value)}>
                {targets.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.pair} bot · {shortAddr(item.address)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="field">
            <span className="field-l">Amount</span>
            <span className="in-unit">
              <input className="in" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <span className="unit">BTC</span>
            </span>
            <span className={`sf-h${amount && !amountOk ? ' bad' : ''}`}>Minimum 0.001 BTC. Fee up to 80,000 sats.</span>
          </label>
          <label className="field">
            <span className="field-l">Your Bitcoin wallet's public key</span>
            <input
              className="in mono"
              placeholder="02… or 03… (66 characters)"
              value={reclaimKey}
              onChange={(e) => setReclaimKey(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            <span
              className={`sf-h${reclaimKey && !keyOk ? ' bad' : ''}`}
              title="If the deposit is never processed, this wallet can reclaim the BTC after a waiting period. Most wallets show it under account details."
            >
              Public key (not private) of the wallet you'll send from. Used for refunds.
            </span>
          </label>
          {error && !confirm ? <p className="form-err">{error}</p> : null}
          <div>
            <button type="button" className="btn primary" disabled={!bot || !amountOk || !keyOk} onClick={() => setConfirm(true)}>
              Get deposit address
            </button>
          </div>
        </div>
      )}
      {confirm && bot ? (
        <RiskConfirm
          title="Start an sBTC deposit"
          lead="The page builds a deposit address tied to this bot's Stacks wallet. Nothing is sent until you send BTC from your own wallet."
          facts={[
            ['Amount', `${amount} BTC`],
            ['sBTC goes to', `${bot.pair} bot · ${shortAddr(bot.address)}`],
            ['Refund key', `${reclaimKey.trim().slice(0, 10)}…`],
          ]}
          poolName={bot.pair}
          confirmLabel="Get address"
          busy={busy}
          error={error}
          onClose={() => setConfirm(false)}
          onConfirm={() => void start()}
        />
      ) : null}
    </div>
  );
}

function JobView({
  job,
  txid,
  setTxid,
  setJob,
  onReset,
}: {
  job: BridgeJob;
  txid: string;
  setTxid: (v: string) => void;
  setJob: (job: BridgeJob) => void;
  onReset: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const step = job.status === 'pending' ? 3 : 2;
  const send = async () => {
    setBusy(true);
    setError('');
    try {
      const next = await api<BridgeJob>(`/api/bridge/${encodeURIComponent(job.id)}/txid`, 'POST', { txid: txid.trim() });
      setJob(next);
      if (next.status === 'pending') toast('good', 'The signers have your deposit.');
      else setError(next.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the signers.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="job">
      <ol className="jsteps">
        {['Address ready', 'Send BTC', 'Signers have it', 'sBTC arrives'].map((label, i) => (
          <li key={label} className={i < step ? 'done' : i === step ? 'now' : ''}>
            <span className="jn">{i < step ? <Icon name="check" size={11} /> : i + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      <p>{job.message}</p>
      {job.depositAddress ? (
        <div className="addrbox">
          <div className="addrbox-k">Send exactly {job.amount} BTC to</div>
          <div className="addrbox-v mono">{job.depositAddress}</div>
          <CopyButton text={job.depositAddress} label="Copy address" />
        </div>
      ) : null}
      {job.status !== 'pending' ? (
        <div className="txrow">
          <label className="field grow">
            <span className="field-l">Bitcoin transaction id</span>
            <input className="in mono" value={txid} onChange={(e) => setTxid(e.target.value)} placeholder="64 hex characters, from your wallet after sending" spellCheck={false} />
          </label>
          <button type="button" className="btn primary" disabled={busy || !/^[0-9a-fA-F]{64}$/.test(txid.trim())} onClick={() => void send()}>
            {busy ? 'Telling the signers…' : 'I sent it'}
          </button>
        </div>
      ) : (
        <p className="muted">
          You can leave this page. Watch the bot's wallet balance; sBTC shows up there.{' '}
          <a href={`https://mempool.space/tx/${txid.trim()}`} target="_blank" rel="noreferrer">
            Track the Bitcoin transaction <Icon name="external" size={11} />
          </a>
        </p>
      )}
      {error ? <p className="form-err">{error}</p> : null}
      <button type="button" className="btn ghost sm" onClick={onReset}>
        Start another deposit
      </button>
    </div>
  );
}
