import { ReactNode, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { EIP1193Provider, createPublicClient, createWalletClient, custom, isAddress, parseAbi, parseUnits } from 'viem';
import { mainnet } from 'viem/chains';
import { BotView, BridgeView, api, botPath, etherscanAddress } from './api';
import { addressInput, decimalInput, shortAddr } from './format';
import { BalanceFill, Icon, RiskConfirm, useToast } from './ui';

/** Micro-units as a USDC amount, money style: 2000000 -> "2.00 USDC". */
export const usdc = (micro: number | null | undefined, unit = 'USDC'): string =>
  micro == null ? '—' : `${(micro / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} ${unit}`;

const microOf = (text: string): number | null => (/^\d+(\.\d{1,6})?$/.test(text.trim()) ? Math.round(Number(text) * 1e6) : null);
const coinsOf = (micro: number): string => String(micro / 1e6);

// A bridge request costs a fraction of this in STX fees; below it the request would fail to send.
export const MIN_STX_FOR_FEE = 0.05;

/** Why bridging out cannot start right now, with a Pause button when that is the fix. */
export function OutBlocked({ bot, blocked, reload }: { bot: BotView; blocked: string | null; reload: () => Promise<void> }) {
  const toast = useToast();
  if (!blocked) return null;
  const pause = async () => {
    try {
      await api(`/api/bots/${encodeURIComponent(bot.id)}/pause`, 'POST', {});
      await reload();
    } catch (err) {
      toast('bad', err instanceof Error ? err.message : 'Could not pause the bot.');
    }
  };
  return (
    <div className="banner2 info center">
      <Icon name="info" />
      <div className="grow">{blocked}</div>
      {blocked.startsWith('Pause') ? (
        <button type="button" className="btn sm" onClick={() => void pause()}>
          Pause
        </button>
      ) : null}
    </div>
  );
}

export function NeedsStx({ bot }: { bot: BotView }) {
  return (
    <p className="sf-h bad">
      The bot wallet needs a little STX for the network fee. <Link to={`${botPath(bot)}?tab=wallet`}>Deposit STX</Link>
    </p>
  );
}

const ERC20 = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
]);
// Gas units from recent mainnet transactions (approve ~55.6k, depositToRemote ~125k), rounded up.
const APPROVE_GAS = BigInt(60_000);
const DEPOSIT_GAS = BigInt(135_000);
const GAS_REFRESH_MS = 30_000;

const gasText = (wei: bigint): string => `~${(Number(wei) / 1e18).toLocaleString('en-US', { maximumSignificantDigits: 2 })} ETH`;

const XRESERVE = parseAbi(['function depositToRemote(uint256 value, uint32 remoteDomain, bytes32 remoteRecipient, address localToken, uint256 maxFee, bytes hookData)']);

interface EthWallet {
  id: string;
  name: string;
  icon: string;
  provider: EIP1193Provider;
}

const CHOSEN_WALLET = 'mm.ethWallet';
const storedWallet = (): string => {
  try {
    return localStorage.getItem(CHOSEN_WALLET) || '';
  } catch {
    return '';
  }
};
const storeWallet = (id: string): void => {
  try {
    if (id) localStorage.setItem(CHOSEN_WALLET, id);
    else localStorage.removeItem(CHOSEN_WALLET);
  } catch {
    // Without storage the page just asks again after a reload.
  }
};

/**
 * Every Ethereum wallet installed (EIP-6963), so one is picked by name rather
 * than whichever extension won window.ethereum. Null until discovery has run.
 */
const useWallets = (): EthWallet[] | null => {
  const [list, setList] = useState<EthWallet[] | null>(null);
  useEffect(() => {
    const seen = new Map<string, EthWallet>();
    const onAnnounce = (event: Event) => {
      const { info, provider } = (event as CustomEvent<{ info: { uuid: string; name: string; icon: string; rdns?: string }; provider: EIP1193Provider }>).detail;
      // rdns is stable across reloads; the uuid is new on every page load.
      const id = info.rdns || info.uuid;
      seen.delete('injected');
      seen.set(id, { id, name: info.name, icon: info.icon, provider });
      setList([...seen.values()]);
    };
    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    // Wallets that predate EIP-6963 only set window.ethereum.
    const injected = (window as { ethereum?: EIP1193Provider }).ethereum;
    if (!seen.size && injected) seen.set('injected', { id: 'injected', name: 'Browser wallet', icon: '', provider: injected });
    setList([...seen.values()]);
    return () => window.removeEventListener('eip6963:announceProvider', onAnnounce);
  }, []);
  return list;
};

/** The Ethereum wallet this page is connected to, remembered across reloads until Disconnect. */
const useEthWallet = () => {
  const wallets = useWallets();
  const [chosenId, setChosenId] = useState(storedWallet);
  const wallet = wallets?.find((item) => item.id === chosenId) || null;
  const provider = wallet?.provider || null;
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  useEffect(() => {
    setAccount(null);
    if (!provider) return;
    const onAccounts = (list: string[]) => setAccount((list[0] as `0x${string}`) || null);
    const onChain = (id: string) => setChainId(Number(id));
    // eth_accounts never prompts; it only restores a wallet already connected to this page.
    void provider.request({ method: 'eth_accounts' }).then(onAccounts).catch(() => undefined);
    void provider.request({ method: 'eth_chainId' }).then(onChain).catch(() => undefined);
    provider.on('accountsChanged', onAccounts);
    provider.on('chainChanged', onChain);
    return () => {
      provider.removeListener('accountsChanged', onAccounts);
      provider.removeListener('chainChanged', onChain);
    };
  }, [provider]);
  const connect = async (next: EthWallet) => {
    const list = await next.provider.request({ method: 'eth_requestAccounts' });
    storeWallet(next.id);
    setChosenId(next.id);
    setAccount((list[0] as `0x${string}`) || null);
  };
  const disconnect = async () => {
    const was = provider;
    storeWallet('');
    setChosenId('');
    setAccount(null);
    // Not every wallet supports revoking; the stored choice is gone either way, so a reload stays disconnected.
    if (was) await was.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] } as never).catch(() => undefined);
  };
  const toMainnet = async () => {
    if (provider) await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
  };
  return { wallets, wallet, provider, account, chainId, connect, disconnect, toMainnet };
};

/** One row per installed wallet; picking one asks it to connect. */
function WalletChoices({ wallets, current, account, onPick, onCancel }: { wallets: EthWallet[]; current: string; account: string | null; onPick: (wallet: EthWallet) => void; onCancel?: () => void }) {
  return (
    <div className="choices" role="radiogroup" aria-label="Ethereum wallet">
      {wallets.map((item) => (
        <button key={item.id} type="button" role="radio" aria-checked={item.id === current} className={`choice${item.id === current ? ' on' : ''}`} onClick={() => onPick(item)}>
          {item.icon ? <img className="wallet-ic" src={item.icon} alt="" /> : <Icon name="wallet" size={20} />}
          <span className="choice-body">
            <span className="choice-t">{item.name}</span>
            {item.id === current && account ? <span className="choice-s">Connected · {shortAddr(account)}</span> : null}
          </span>
        </button>
      ))}
      {onCancel ? (
        <div className="pick-more">
          <span className="spacer" />
          <button type="button" className="btn sm ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}

type Stage = 'idle' | 'approve' | 'approving' | 'deposit';

/**
 * USDC -> USDCx: the user's own Ethereum wallet approves xReserve and calls
 * depositToRemote, naming the bot's Stacks address. The console never sees the
 * Ethereum key; it is told the transaction hash and follows it from there.
 */
export function UsdcIn({ bot, view, reload, target }: { bot: BotView; view: BridgeView; reload: () => Promise<void>; target?: ReactNode }) {
  const toast = useToast();
  const eth = useEthWallet();
  const [amount, setAmount] = useState('');
  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState('');
  const [held, setHeld] = useState<{ usdc: bigint; eth: bigint; allowance: bigint } | null>(null);
  const [picking, setPicking] = useState(false);
  const [gasPrice, setGasPrice] = useState<bigint | null>(null);
  const u = view.usdc;
  const onMainnet = eth.chainId === 1;

  const readBalances = useCallback(async () => {
    if (!eth.provider || !eth.account || !onMainnet) return setHeld(null);
    const client = createPublicClient({ chain: mainnet, transport: custom(eth.provider) });
    try {
      const [usdcBal, ethBal, allowance] = await Promise.all([
        client.readContract({ address: u.token as `0x${string}`, abi: ERC20, functionName: 'balanceOf', args: [eth.account] }),
        client.getBalance({ address: eth.account }),
        client.readContract({ address: u.token as `0x${string}`, abi: ERC20, functionName: 'allowance', args: [eth.account, u.xReserve as `0x${string}`] }),
      ]);
      setHeld({ usdc: usdcBal, eth: ethBal, allowance });
    } catch {
      setHeld(null);
    }
  }, [eth.provider, eth.account, onMainnet, u.token, u.xReserve]);
  useEffect(() => {
    void readBalances();
  }, [readBalances]);
  useEffect(() => {
    if (!eth.provider || !onMainnet) return setGasPrice(null);
    const client = createPublicClient({ chain: mainnet, transport: custom(eth.provider) });
    const read = () => void client.getGasPrice().then(setGasPrice).catch(() => setGasPrice(null));
    read();
    const timer = setInterval(read, GAS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [eth.provider, onMainnet]);

  if (!eth.wallets) return <span className="spinner" />;
  if (!eth.wallets.length) {
    return (
      <div className="dep">
        <p className="muted">
          No Ethereum wallet found in this browser. Install MetaMask, Rabby or Coinbase Wallet, then reload this page.
        </p>
        {target}
      </div>
    );
  }

  const micro = microOf(amount);
  const heldMicro = held ? Number(held.usdc) : null;
  const amountProblem = !amount.trim()
    ? ''
    : micro == null || micro <= 0
      ? 'Enter an amount.'
      : micro < u.depositMin
        ? `Minimum ${usdc(u.depositMin)}.`
        : heldMicro != null && micro > heldMicro
          ? 'More than this wallet holds.'
          : '';
  const needsApproval = held == null || micro == null || held.allowance < BigInt(micro);
  const gasWei = gasPrice == null ? null : gasPrice * (DEPOSIT_GAS + (needsApproval ? APPROVE_GAS : BigInt(0)));
  const noGas = held != null && (held.eth === BigInt(0) || (gasWei != null && held.eth < gasWei));
  // The bytes32 must be 11 zero bytes, a version byte and a hash160, or the mint fails on Stacks.
  const recipientOk = /^0x0{22}[0-9a-f]{42}$/.test(u.recipient);
  const busy = stage !== 'idle';
  const ready = Boolean(eth.account) && onMainnet && micro != null && !amountProblem && !noGas && recipientOk && !view.demo && !busy;

  const send = async () => {
    if (!eth.provider || !eth.account || micro == null) return;
    setError('');
    const value = parseUnits(amount.trim(), 6);
    const pub = createPublicClient({ chain: mainnet, transport: custom(eth.provider) });
    const wallet = createWalletClient({ account: eth.account, chain: mainnet, transport: custom(eth.provider) });
    const token = u.token as `0x${string}`;
    const reserve = u.xReserve as `0x${string}`;
    try {
      const allowed = await pub.readContract({ address: token, abi: ERC20, functionName: 'allowance', args: [eth.account, reserve] });
      if (allowed < value) {
        // Exactly this amount, so no standing allowance is left behind.
        setStage('approve');
        const approval = await wallet.writeContract({ address: token, abi: ERC20, functionName: 'approve', args: [reserve, value] });
        setStage('approving');
        await pub.waitForTransactionReceipt({ hash: approval });
      }
      setStage('deposit');
      const hash = await wallet.writeContract({
        address: reserve,
        abi: XRESERVE,
        functionName: 'depositToRemote',
        // maxFee 0: Stacks' relayer mints for free, as the official bridge app sends it.
        args: [value, u.domain, u.recipient as `0x${string}`, token, BigInt(0), '0x'],
      });
      // The USDC has left the wallet from here on, so a failure to record it must
      // never read as a failed deposit, or the user may send it again.
      setAmount('');
      try {
        await api(`/api/bots/${encodeURIComponent(bot.id)}/bridge-usdc-deposit`, 'POST', { ethTxid: hash, amount: amount.trim() });
        toast('good', 'Deposit sent. Follow it under Activity.');
      } catch {
        setError(`Deposit sent (${shortAddr(hash)}), but this app could not start tracking it. Do not send it again; it still arrives as USDCx in about 15 minutes.`);
      }
      // A failed refresh must not replace that warning with its own error.
      await reload().catch(() => undefined);
      void readBalances();
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setError(/rejected|denied/i.test(text) ? 'Cancelled in the wallet.' : text.split('\n')[0]);
    } finally {
      setStage('idle');
    }
  };

  const label =
    stage === 'approve'
      ? 'Approve in your wallet (1 of 2)…'
      : stage === 'approving'
        ? 'Waiting for the approval…'
        : stage === 'deposit'
          ? 'Confirm the deposit in your wallet…'
          : 'Bridge to USDCx';

  return (
    <div className="bout">
      {view.demo ? <p className="dep-warn">Demo mode. Use Simulate a deposit; nothing is sent from your wallet.</p> : null}
      <div className="field">
        <span className="field-l">From</span>
        {picking || (!eth.account && eth.wallets.length > 1) ? (
          <WalletChoices
            wallets={eth.wallets}
            current={eth.account ? eth.wallet?.id || '' : ''}
            account={eth.account}
            onPick={(item) => {
              setError('');
              if (item.id === eth.wallet?.id && eth.account) return setPicking(false);
              void eth
                .connect(item)
                .then(() => setPicking(false))
                .catch((err: Error) => setError(/rejected|denied/i.test(err.message) ? 'Cancelled in the wallet.' : err.message.split('\n')[0]));
            }}
            onCancel={eth.account ? () => setPicking(false) : undefined}
          />
        ) : eth.account ? (
          <>
            <div className="choice static">
              {eth.wallet?.icon ? <img className="wallet-ic" src={eth.wallet.icon} alt="" /> : null}
              <span className="choice-body">
                <span className="choice-t">{eth.wallet?.name || 'Ethereum wallet'}</span>
                <span className="choice-s">
                  <a className="mono" href={etherscanAddress(eth.account)} target="_blank" rel="noreferrer">
                    {shortAddr(eth.account)}
                  </a>
                  {heldMicro != null ? ` · ${usdc(heldMicro)}` : ''}
                </span>
              </span>
              <span className="choice-acts">
                {eth.wallets.length > 1 ? (
                  <button type="button" className="linkbtn choice-act" disabled={busy} onClick={() => setPicking(true)}>
                    Change
                  </button>
                ) : null}
                <button type="button" className="linkbtn choice-act" disabled={busy} onClick={() => void eth.disconnect()}>
                  Disconnect
                </button>
              </span>
            </div>
            {/* The page cannot open a wallet's account list; it follows whichever account the wallet switches to. */}
            <span className="sf-h">To use another account, switch it in {eth.wallet?.name || 'your wallet'}.</span>
          </>
        ) : (
          <button
            type="button"
            className="btn wide"
            onClick={() => void eth.connect(eth.wallets![0]).catch((err: Error) => setError(/rejected|denied/i.test(err.message) ? 'Cancelled in the wallet.' : err.message.split('\n')[0]))}
          >
            Connect {eth.wallets[0].name === 'Browser wallet' ? 'Ethereum wallet' : eth.wallets[0].name}
          </button>
        )}
      </div>
      {target}
      {eth.account && !onMainnet ? (
        <div className="banner2 info center">
          <Icon name="info" />
          <div className="grow">Switch your wallet to Ethereum.</div>
          <button type="button" className="btn sm" onClick={() => void eth.toMainnet().catch((err: Error) => setError(err.message))}>
            Switch
          </button>
        </div>
      ) : null}
      {eth.account && onMainnet ? (
        <>
          <div className="field">
            <span className="field-row">
              <span className="field-l">Amount</span>
              <span className="field-aside">
                <BalanceFill text={usdc(heldMicro)} onFill={heldMicro && !busy ? () => setAmount(coinsOf(heldMicro)) : null} />
              </span>
            </span>
            <span className="in-unit">
              <input className="in in-lg" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} onChange={(e) => setAmount(decimalInput(e.target.value, 6))} disabled={busy} />
              <span className="unit">USDC</span>
            </span>
            {amountProblem ? <span className="sf-h bad">{amountProblem}</span> : null}
          </div>
          <dl className="kv">
            <div>
              <dt>You receive</dt>
              <dd>{micro != null && !amountProblem ? usdc(micro, 'USDCx') : '—'}</dd>
            </div>
            <div>
              <dt>Network fee</dt>
              <dd>{gasWei == null ? '—' : gasText(gasWei)}</dd>
            </div>
            <div>
              <dt>Arrives in</dt>
              <dd>About 15 minutes</dd>
            </div>
          </dl>
          {noGas ? <p className="sf-h bad">This wallet does not have enough ETH for gas.</p> : null}
          {!recipientOk ? <p className="form-err">Could not encode the bot address. Reload the page.</p> : null}
          {error ? <p className="form-err">{error}</p> : null}
          <button type="button" className="btn primary wide" disabled={!ready} onClick={() => void send()}>
            {label}
          </button>
          <p className="note">Your wallet asks you to approve the USDC, then to send it. The bot wallet needs no STX to receive.</p>
        </>
      ) : error ? (
        <p className="form-err">{error}</p>
      ) : null}
    </div>
  );
}

/** USDCx -> USDC: the bot burns USDCx on Stacks and Circle pays USDC out on Ethereum, less its fee. */
export function UsdcOut({ bot, view, reload }: { bot: BotView; view: BridgeView; reload: () => Promise<void> }) {
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [address, setAddress] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const u = view.usdc;
  const micro = microOf(amount);
  const amountProblem = !amount.trim()
    ? ''
    : micro == null || micro <= 0
      ? 'Enter an amount.'
      : micro < u.withdrawMin
        ? `Minimum ${usdc(u.withdrawMin, 'USDCx')}.`
        : u.held != null && micro > u.held
          ? u.held < u.withdrawMin
            ? 'Not enough USDCx.'
            : `Maximum ${usdc(u.held, 'USDCx')}.`
          : '';
  const typed = address.trim();
  const addressProblem = !typed ? '' : !/^0x[0-9a-fA-F]{40}$/.test(typed) ? 'Not an Ethereum address.' : !isAddress(typed) ? 'This address has a typo (checksum mismatch).' : '';
  const noStx = view.stx != null && view.stx < MIN_STX_FOR_FEE;
  const ready = micro != null && !amountProblem && Boolean(typed) && !addressProblem && !view.withdraw.blocked && !noStx;
  const receive = micro != null ? Math.max(0, micro - u.withdrawFee) : null;

  const send = async () => {
    setBusy(true);
    setError('');
    try {
      await api(`/api/bots/${encodeURIComponent(bot.id)}/bridge-usdc-withdraw`, 'POST', { amount: amount.trim(), ethAddress: typed, acknowledged: true, poolName: bot.pair });
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
      <OutBlocked bot={bot} blocked={view.withdraw.blocked} reload={reload} />
      <label className="field">
        <span className="field-l">To</span>
        <input className="in mono" placeholder="Your Ethereum address (0x…)" value={address} onChange={(e) => setAddress(addressInput(e.target.value))} spellCheck={false} autoComplete="off" />
        {addressProblem ? <span className="sf-h bad">{addressProblem}</span> : null}
      </label>
      <div className="field">
        <span className="field-row">
          <span className="field-l">Amount</span>
          <span className="field-aside">
            <BalanceFill text={usdc(u.held, 'USDCx')} onFill={u.held ? () => setAmount(coinsOf(u.held || 0)) : null} />
          </span>
        </span>
        <span className="in-unit">
          <input className="in in-lg" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} onChange={(e) => setAmount(decimalInput(e.target.value, 6))} />
          <span className="unit">USDCx</span>
        </span>
        {amountProblem ? <span className="sf-h bad">{amountProblem}</span> : null}
      </div>
      <dl className="kv">
        <div>
          <dt>You receive</dt>
          <dd>{receive != null && !amountProblem ? usdc(receive) : '—'}</dd>
        </div>
        <div>
          <dt>Fee</dt>
          <dd title="Circle's fee for paying out on Ethereum">{usdc(u.withdrawFee)}</dd>
        </div>
        <div>
          <dt>Arrives in</dt>
          <dd>About an hour</dd>
        </div>
      </dl>
      {noStx ? <NeedsStx bot={bot} /> : null}
      {error && !confirm ? <p className="form-err">{error}</p> : null}
      <button type="button" className="btn primary wide" disabled={!ready} onClick={() => setConfirm(true)}>
        Bridge to USDC
      </button>
      {confirm && micro != null && receive != null ? (
        <RiskConfirm
          title="Bridge USDCx to USDC"
          lead="Ethereum transfers cannot be undone. Send to a wallet you control."
          facts={[
            ['You receive', usdc(receive)],
            [
              'To',
              <a className="mono" href={etherscanAddress(typed)} target="_blank" rel="noreferrer">
                {typed}
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
