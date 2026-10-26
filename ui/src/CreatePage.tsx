import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BotView, ProfileInfo, Strategy, api } from './api';
import type { Shared } from './App';
import { poolName, tok } from './format';
import { PoolList, usePoolCatalog } from './PoolList';
import { QrCode } from './QrCode';
import { Card, CopyButton, Icon, Seg, useToast } from './ui';
import { KeyBackup } from './WalletTab';

// A generated key exists only in the env file, so its backup is a step of its
// own before funding. An imported key is already in the user's wallet app.
const stepsFor = (wallet: 'create' | 'import'): string[] =>
  wallet === 'create' ? ['Pair', 'Wallet', 'Review', 'Back up', 'Fund'] : ['Pair', 'Wallet', 'Review', 'Fund'];

export function CreatePage({ fleet, reload }: Shared) {
  const toast = useToast();
  const navigate = useNavigate();
  const [profiles, setProfiles] = useState<ProfileInfo[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [step, setStep] = useState(0);
  const [poolId, setPoolId] = useState('');
  const [wallet, setWallet] = useState<'create' | 'import'>('create');
  const [key, setKey] = useState('');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [createdId, setCreatedId] = useState('');
  // Which pool of the chosen pair; empty means the server's default for that pair.
  const [contract, setContract] = useState('');
  const [name, setName] = useState('');
  // A strategy to start from: imported from a file, or copied from a bot (?from=<id>).
  const [strategy, setStrategy] = useState<Strategy | null>(null);
  // Where the strategy came from, said plainly on the first step.
  const [source, setSource] = useState('');
  const [params] = useSearchParams();
  const from = params.get('from');

  const applyStrategy = (next: Strategy, label: string) => {
    setStrategy(next);
    setPoolId(next.pair);
    setName(label);
  };

  useEffect(() => {
    api<{ profiles: ProfileInfo[] }>('/api/profiles')
      .then((res) => {
        setProfiles(res.profiles);
        if (res.profiles[0]) setPoolId((current) => current || res.profiles[0].id);
      })
      .catch((err: Error) => setLoadError(err.message));
  }, []);

  useEffect(() => {
    if (!from) return;
    api<Strategy>(`/api/bots/${encodeURIComponent(from)}/strategy`)
      .then((res) => {
        const label = res.name || fleet.bots.find((bot) => bot.id === from)?.pair || 'this bot';
        applyStrategy(res, `${label} copy`);
        setSource(`Duplicating strategy from ${label}`);
      })
      .catch((err: Error) => setLoadError(err.message));
    // Load the source once; the fleet refreshing must not reset what the user edits.
  }, [from]);

  const importFile = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as Partial<Strategy>;
      if (parsed.kind !== 'bitflow-mm-strategy' || !parsed.pair || !parsed.settings) throw new Error('That file is not a Bitflow MM strategy.');
      if (!profiles?.some((item) => item.id === parsed.pair)) throw new Error(`This app does not know the pair "${parsed.pair}".`);
      applyStrategy(parsed as Strategy, parsed.name || '');
      setSource(`Imported strategy${parsed.name ? ` "${parsed.name}"` : ''} from ${file.name}`);
      toast('good', 'Strategy loaded.');
    } catch (err) {
      toast('bad', err instanceof Error ? err.message : 'Could not read that file.');
    }
  };

  const pool = profiles?.find((item) => item.id === poolId) || null;
  const keyOk = /^(0x)?[0-9a-fA-F]{64}(01)?$/.test(key.trim());
  const created = fleet.bots.find((bot) => bot.id === createdId);
  const steps = stepsFor(wallet);
  const fundStep = steps.length - 1;
  const { catalog, error: catalogError } = usePoolCatalog(pool ? pool.id : null);
  useEffect(() => {
    // A strategy's own pool wins when it is still usable; otherwise the recommendation.
    const own = strategy && strategy.pair === pool?.id ? catalog?.pools.find((item) => item.poolId === strategy.poolId && item.ok) : null;
    setContract(own ? own.poolId : catalog?.recommended || '');
  }, [catalog, strategy]);
  const chosen = catalog?.pools.find((item) => item.poolId === contract) || null;
  const contractId = contract || pool?.poolId || '';

  const create = async () => {
    if (!pool) return;
    setBusy(true);
    setError('');
    try {
      const res = await api<{ bot: BotView }>('/api/bots', 'POST', {
        profile: pool.id,
        wallet,
        signerKey: wallet === 'import' ? key.trim().replace(/^0x/, '') : undefined,
        signerAddress: wallet === 'import' && address.trim() ? address.trim() : undefined,
        poolId: contract || undefined,
        name: name.trim() || undefined,
        settings: strategy && strategy.pair === pool.id ? strategy.settings : undefined,
      });
      setKey('');
      setCreatedId(res.bot.id);
      setStep(3);
      toast('good', 'Bot created.');
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the bot.');
    } finally {
      setBusy(false);
    }
  };

  if (loadError) return <div className="page narrow"><p className="form-err">{loadError}</p></div>;
  if (!profiles) return <div className="page narrow"><span className="spinner" /></div>;


  return (
    <div className="page narrow">
      <h1 className="page-t">New bot</h1>
      <ol className="stepper">
        {steps.map((label, i) => (
          <li key={label} className={i < step ? 'done' : i === step ? 'now' : ''}>
            <span className="jn">{i < step ? <Icon name="check" size={11} /> : i + 1}</span>
            {label}
          </li>
        ))}
      </ol>

      {step === 0 ? (
        <Card
          title="Pair"
          aside={
            <label className="btn sm ghost">
              <Icon name="download" />
              Import strategy
              <input
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void importFile(file);
                  e.target.value = '';
                }}
              />
            </label>
          }
        >
          {strategy ? (
            <div className="banner2 info center">
              <Icon name="copy" />
              <div className="grow">
                <b>{source || 'Using a saved strategy'}</b>
                <div className="muted">
                  Its pool and {Object.keys(strategy.settings).length} settings carry over; the new bot gets its own wallet. You can change any of it later.
                </div>
              </div>
            </div>
          ) : null}
          <div className="poolpick">
            {profiles.map((item) => {
              const body = (
                <>
                  <span className="po-h">
                    <b>{item.pair}</b>
                  </span>
                </>
              );
              return (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={poolId === item.id}
                  className={`poolopt${poolId === item.id ? ' on' : ''}`}
                  onClick={() => setPoolId(item.id)}
                >
                  {body}
                </button>
              );
            })}
          </div>
          {pool ? (
            <div className="pickpool">
              <div className="field-l">Pool</div>
              {catalogError ? (
                <p className="note">Could not load the pool list ({catalogError}). The bot will use the standard {pool.pair} pool.</p>
              ) : catalog ? (
                <PoolList catalog={catalog} quote={pool.quoteSymbol} value={contract} onChange={setContract} />
              ) : (
                <span className="spinner" aria-label="Loading pools" />
              )}
            </div>
          ) : null}
          <footer className="card-f">
            <span className="spacer" />
            <button type="button" className="btn primary" disabled={!pool || (catalog != null && catalog.pools.length > 0 && !chosen)} onClick={() => setStep(1)}>
              Continue
              <Icon name="arrow" />
            </button>
          </footer>
        </Card>
      ) : null}

      {step === 1 && pool ? (
        <Card title="Wallet">
          <Seg
            value={wallet}
            onChange={setWallet}
            options={[
              { value: 'create', label: 'New wallet' },
              { value: 'import', label: 'Import key' },
            ]}
          />
          {wallet === 'create' ? (
            <p className="muted">
              The key is saved in <code>.env.{pool.id}</code>. The next steps show it once so you can save a copy.
            </p>
          ) : (
            <div className="explain">
              <label className="field">
                <span className="field-l">Stacks private key</span>
                <input
                  className="in mono"
                  type="password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="64 hex characters, optionally ending in 01"
                  autoComplete="off"
                  spellCheck={false}
                />
                <span className={`sf-h${key && !keyOk ? ' bad' : ''}`}>
                  Saved in <code>.env.{pool.id}</code>. Use a wallet nothing else spends from.
                </span>
              </label>
              <label className="field">
                <span className="field-l">
                  Address <span className="muted">(optional)</span>
                </span>
                <input className="in mono" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="SP…" spellCheck={false} />
              </label>
            </div>
          )}
          <footer className="card-f">
            <button type="button" className="btn ghost" onClick={() => setStep(0)}>
              Back
            </button>
            <span className="spacer" />
            <button type="button" className="btn primary" disabled={wallet === 'import' && !keyOk} onClick={() => setStep(2)}>
              Continue
              <Icon name="arrow" />
            </button>
          </footer>
        </Card>
      ) : null}

      {step === 2 && pool ? (
        <Card title="Review">
          <label className="field">
            <span className="field-l">
              Name <span className="muted">(optional)</span>
            </span>
            <input className="in" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder={pool.pair} />
          </label>
          <dl className="facts">
            <div className="fact-row">
              <dt>Pool</dt>
              <dd>
                {pool.pair} <span className="muted mono">{poolName(contractId)}</span>
              </dd>
            </div>
            <div className="fact-row">
              <dt>Wallet</dt>
              <dd>{wallet === 'create' ? 'New' : 'Imported'}</dd>
            </div>
            <div className="fact-row">
              <dt>Strategy</dt>
              <dd>{strategy && strategy.pair === pool.id ? `${strategy.name || 'Saved strategy'} (${Object.keys(strategy.settings).length} settings)` : 'Default for this pair'}</dd>
            </div>
            <div className="fact-row">
              <dt>Mode</dt>
              <dd>
                <span className="badge b-dry">Dry run</span>
              </dd>
            </div>
          </dl>
          {error ? <p className="form-err">{error}</p> : null}
          <footer className="card-f">
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setStep(1)}>
              Back
            </button>
            <span className="spacer" />
            <button type="button" className="btn primary" disabled={busy} onClick={() => void create()}>
              {busy ? 'Creating…' : 'Create bot'}
            </button>
          </footer>
        </Card>
      ) : null}

      {step === 3 && step < fundStep && pool ? (
        <Card title="Back up the key">
          {created ? <KeyBackup bot={created} onDone={() => setStep(fundStep)} /> : <span className="spinner" />}
        </Card>
      ) : null}

      {step === fundStep && pool ? (
        <>
          <Card title="Fund the wallet">
            {created?.startError ? <p className="form-err">{created.startError}</p> : null}
            <p className="muted">Send tokens to this bot's wallet from any Stacks wallet. Any amount works; the table suggests a start that lets the bot place liquidity on both sides.</p>
            {created?.address ? (
              <div className="fundaddr">
                <QrCode text={created.address} />
                <div className="addrbox">
                  <div className="addrbox-k">Bot wallet address</div>
                  <div className="addrbox-v mono">{created.address}</div>
                  <CopyButton text={created.address} label="Copy" />
                </div>
              </div>
            ) : (
              <p className="muted">Loading address…</p>
            )}
            <table className="tbl fund">
              <thead>
                <tr>
                  <th>Token</th>
                  <th className="n">Suggested</th>
                  <th className="n">In wallet</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                <FundRow symbol={pool.baseSymbol} suggested={pool.suggest.base} have={created ? (created.liveWallet ? created.liveWallet.base : created.walletBase) : null} />
                <FundRow symbol={pool.quoteSymbol} suggested={pool.suggest.quote} have={created ? (created.liveWallet ? created.liveWallet.quote : created.walletQuote) : null} />
                {pool.baseSymbol !== 'STX' ? (
                  <tr>
                    <td>STX (fees)</td>
                    <td className="n">{pool.suggest.gas}</td>
                    <td className="n muted">—</td>
                    <td />
                  </tr>
                ) : null}
              </tbody>
            </table>
            {pool.baseSymbol === 'STX' ? <p className="note">{pool.suggest.gas}</p> : null}
          </Card>
          <div className="row-between">
            <span className="spacer" />
            <button type="button" className="btn primary" onClick={() => navigate(`/bots/${pool.id}`)}>
              Open the bot
              <Icon name="arrow" />
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function FundRow({ symbol, suggested, have }: { symbol: string; suggested: string; have: number | null }) {
  const enough = have != null && have >= Number(suggested);
  return (
    <tr>
      <td>{symbol}</td>
      <td className="n">{tok(Number(suggested), symbol)}</td>
      <td className="n">{have == null ? <span className="muted">—</span> : tok(have, symbol)}</td>
      <td>{enough ? <span className="tag t-good">Enough</span> : have != null ? <span className="tag t-unknown">Short</span> : null}</td>
    </tr>
  );
}
