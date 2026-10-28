import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BotView, PhraseAccount, ProfileInfo, Strategy, WalletInfo, api, botPath } from './api';
import { DepositPanel, useBridge } from './BridgePage';
import type { Shared } from './App';
import { addressInput, hexInput, poolName, tok } from './format';
import { PoolList, usePoolCatalog } from './PoolList';
import { QrCode } from './QrCode';
import { Card, CopyButton, Icon, Seg, useToast } from './ui';
import { KeyBackup } from './WalletTab';

type WalletChoice = 'create' | 'phrase' | 'import';

// The app's phrase exists only in .mm-wallet, so backing it up is a step of its
// own before funding, until it has been saved once (it covers every later bot).
// An imported phrase or key is already in the user's wallet app.
const stepsFor = (backup: boolean): string[] => (backup ? ['Pair', 'Wallet', 'Review', 'Back up', 'Fund'] : ['Pair', 'Wallet', 'Review', 'Fund']);

const wordCount = (text: string): number => (text.trim() ? text.trim().split(/\s+/).length : 0);

export function CreatePage({ fleet, reload }: Shared) {
  const toast = useToast();
  const navigate = useNavigate();
  const [profiles, setProfiles] = useState<ProfileInfo[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [step, setStep] = useState(0);
  const [poolId, setPoolId] = useState('');
  const [wallet, setWallet] = useState<WalletChoice>('create');
  const [walletInfo, setWalletInfo] = useState<WalletInfo | null>(null);
  const [phrase, setPhrase] = useState('');
  const [accounts, setAccounts] = useState<PhraseAccount[] | null>(null);
  const [account, setAccount] = useState<number | null>(null);
  const [finding, setFinding] = useState(false);
  const [phraseError, setPhraseError] = useState('');
  const [backupNeeded, setBackupNeeded] = useState(false);
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
    api<WalletInfo>('/api/wallet')
      .then(setWalletInfo)
      .catch(() => undefined);
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
      if (parsed.kind !== 'bitflow-mm-strategy' || !parsed.pair || !parsed.settings) throw new Error('That file is not a Bitflow Market Maker strategy.');
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
  const steps = stepsFor(createdId ? backupNeeded : wallet === 'create' && !walletInfo?.backedUp);
  const words = wordCount(phrase);
  const walletOk = (wallet === 'create' && !walletInfo?.problem) || (wallet === 'import' ? keyOk : account != null && !accounts?.find((item) => item.account === account)?.bot);

  const findAccounts = async () => {
    setFinding(true);
    setPhraseError('');
    setAccounts(null);
    setAccount(null);
    try {
      const res = await api<{ accounts: PhraseAccount[] }>('/api/wallet/accounts', 'POST', { phrase });
      setAccounts(res.accounts);
      // Default to the first account no bot here uses yet.
      const free = res.accounts.find((item) => !item.bot);
      setAccount(free ? free.account : null);
    } catch (err) {
      setPhraseError(err instanceof Error ? err.message : 'Could not read that phrase.');
    } finally {
      setFinding(false);
    }
  };
  const fundStep = steps.length - 1;
  const { catalog, error: catalogError } = usePoolCatalog(pool ? pool.id : null);
  useEffect(() => {
    // A strategy's own pool wins when it is still usable; otherwise the recommendation.
    const own = strategy && strategy.pair === pool?.id ? catalog?.pools.find((item) => item.poolId === strategy.poolId && item.ok) : null;
    setContract(own ? own.poolId : catalog?.recommended || '');
  }, [catalog, strategy]);
  const chosen = catalog?.pools.find((item) => item.poolId === contract) || null;
  const contractId = contract || pool?.poolId || '';
  // sBTC pairs can also be funded with plain BTC through the sBTC bridge.
  const canBridge = Boolean(created?.address && pool && (pool.baseSymbol === 'sBTC' || pool.quoteSymbol === 'sBTC'));
  const [fundWith, setFundWith] = useState<'stacks' | 'btc'>('stacks');
  const { view: bridgeView, error: bridgeError } = useBridge(canBridge && fundWith === 'btc' && step === fundStep && created ? created.id : null, true);

  const create = async () => {
    if (!pool) return;
    setBusy(true);
    setError('');
    try {
      const res = await api<{ bot: BotView; backupNeeded: boolean }>('/api/bots', 'POST', {
        profile: pool.id,
        wallet,
        phrase: wallet === 'phrase' ? phrase : undefined,
        account: wallet === 'phrase' ? account : undefined,
        signerKey: wallet === 'import' ? key.trim().replace(/^0x/, '') : undefined,
        signerAddress: wallet === 'import' && address.trim() ? address.trim() : undefined,
        poolId: contract || undefined,
        name: name.trim() || undefined,
        settings: strategy && strategy.pair === pool.id ? strategy.settings : undefined,
      });
      setKey('');
      setPhrase('');
      setAccounts(null);
      setBackupNeeded(res.backupNeeded);
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
              <h2 className="sub-h">Pool</h2>
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
              { value: 'create', label: walletInfo?.hasPhrase ? 'App wallet' : 'New wallet' },
              { value: 'phrase', label: 'Recovery phrase' },
              { value: 'import', label: 'Private key' },
            ]}
          />
          {wallet === 'create' ? (
            walletInfo?.problem ? (
              <p className="form-err">{walletInfo.problem}</p>
            ) : walletInfo?.hasPhrase ? (
              <div className="banner2 info center">
                <Icon name="wallet" />
                <div className="grow">
                  <b>Uses the wallet this app already made, account {walletInfo.nextAccount + 1}</b>
                  <div className="muted">
                    Same recovery phrase as your other bots, but its own account and address, so the bots never share funds.
                    {walletInfo.backedUp ? ' You already saved the phrase, so there is nothing new to back up.' : ' The next steps show the phrase so you can save a copy.'}
                  </div>
                </div>
              </div>
            ) : (
              <p className="muted">
                The app makes a recovery phrase, saved in <code>.mm-wallet</code> on this computer. This bot gets account 1; later bots get accounts 2, 3 and on, so one
                saved phrase covers them all. The next steps show it once so you can save a copy.
              </p>
            )
          ) : wallet === 'phrase' ? (
            <div className="explain">
              <label className="field">
                <span className="field-l">Recovery phrase</span>
                <textarea
                  className="in mono"
                  rows={3}
                  value={phrase}
                  onChange={(e) => {
                    setPhrase(e.target.value);
                    setAccounts(null);
                    setAccount(null);
                  }}
                  placeholder="12 or 24 words"
                  autoComplete="off"
                  spellCheck={false}
                />
                <span className="sf-h">
                  Only the chosen account's key is saved, in this bot's env file; the phrase is not stored. Use an account nothing else spends from.
                </span>
              </label>
              <div>
                <button type="button" className="btn" disabled={(words !== 12 && words !== 24) || finding} onClick={() => void findAccounts()}>
                  {finding ? 'Finding…' : 'Find accounts'}
                </button>
              </div>
              {phraseError ? <p className="form-err">{phraseError}</p> : null}
              {accounts ? (
                <div className="pl" role="radiogroup">
                  {accounts.map((item) => (
                    <button
                      key={item.account}
                      type="button"
                      role="radio"
                      aria-checked={account === item.account}
                      disabled={Boolean(item.bot)}
                      className={`pl-row${account === item.account ? ' on' : ''}${item.bot ? ' off' : ''}`}
                      onClick={() => setAccount(item.account)}
                    >
                      <span className="pl-h">
                        <b>Account {item.account + 1}</b>
                        {item.bot ? <span className="tag">Bot {item.bot}</span> : item.used ? <span className="tag t-warn">In use</span> : item.used === false ? <span className="tag t-good">Unused</span> : null}
                      </span>
                      <span className="pl-facts mono">{item.address}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              {account != null && accounts?.find((item) => item.account === account)?.used ? (
                <div className="banner2 warn">
                  <Icon name="warn" />
                  <div className="grow">This account holds funds or has sent transactions. If anything else spends from it, the bot's nonces and balances will clash.</div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="explain">
              <label className="field">
                <span className="field-l">Stacks private key</span>
                <input
                  className="in mono"
                  type="password"
                  value={key}
                  onChange={(e) => setKey(hexInput(e.target.value))}
                  placeholder="64 hex characters, optionally ending in 01"
                  autoComplete="off"
                  spellCheck={false}
                />
                <span className={`sf-h${key && !keyOk ? ' bad' : ''}`}>
                  Saved in this bot's env file. Use a wallet nothing else spends from.
                </span>
              </label>
              <label className="field">
                <span className="field-l">
                  Address <span className="muted">(optional)</span>
                </span>
                <input className="in mono" value={address} onChange={(e) => setAddress(addressInput(e.target.value))} placeholder="SP…" spellCheck={false} />
              </label>
            </div>
          )}
          <footer className="card-f">
            <button type="button" className="btn ghost" onClick={() => setStep(0)}>
              Back
            </button>
            <span className="spacer" />
            <button type="button" className="btn primary" disabled={!walletOk} onClick={() => setStep(2)}>
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
              <dd>
                {wallet === 'create'
                  ? `${walletInfo?.hasPhrase ? 'App wallet' : 'New app wallet'}, account ${(walletInfo?.nextAccount ?? 0) + 1}`
                  : wallet === 'phrase'
                    ? `Your phrase, account ${(account ?? 0) + 1}`
                    : 'Imported key'}
              </dd>
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
        <Card title={created?.keySource === 'app-phrase' ? 'Back up the recovery phrase' : 'Back up the key'}>
          {created ? <KeyBackup bot={created} onDone={() => setStep(fundStep)} /> : <span className="spinner" />}
        </Card>
      ) : null}

      {step === fundStep && pool ? (
        <>
          <Card title="Fund the wallet">
            {created?.startError ? <p className="form-err">{created.startError}</p> : null}
            <p className="muted">Send tokens to this bot's wallet. Any amount works; the table suggests a start that lets the bot place liquidity on both sides.</p>
            {canBridge ? (
              <Seg
                value={fundWith}
                onChange={setFundWith}
                options={[
                  { value: 'stacks', label: 'Send from a Stacks wallet' },
                  { value: 'btc', label: 'Send BTC (arrives as sBTC)' },
                ]}
              />
            ) : null}
            {canBridge && fundWith === 'btc' ? (
              bridgeView ? (
                <>
                  {bridgeError ? <p className="form-err">{bridgeError}</p> : null}
                  <DepositPanel view={bridgeView} />
                  <p className="note">
                    {pool.quoteSymbol} and STX for fees still come from a Stacks wallet.
                  </p>
                </>
              ) : bridgeError ? (
                <p className="form-err">{bridgeError}</p>
              ) : (
                <span className="spinner" />
              )
            ) : created?.address ? (
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
            {pool.quoteSymbol === 'USDCx' ? (
              <p className="note">
                Have USDC on Ethereum? Bridge it at{' '}
                <a href="https://bridge.stacks.co/usdc/eth/stx" target="_blank" rel="noreferrer">
                  bridge.stacks.co <Icon name="external" size={11} />
                </a>{' '}
                and send the USDCx to the bot's address.
              </p>
            ) : null}
          </Card>
          <div className="row-between">
            <span className="spacer" />
            <button type="button" className="btn primary" onClick={() => navigate(created ? botPath(created) : `/bots/${createdId || pool.id}`)}>
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
