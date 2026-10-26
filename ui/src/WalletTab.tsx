import { useState } from 'react';
import { BotView, KeyBackup as KeyBackupBody, api, explorerAddress, explorerTx } from './api';
import { clock, shortAddr, tok } from './format';
import { Link } from 'react-router-dom';
import { QrCode } from './QrCode';
import { Card, CopyButton, Empty, Icon, Modal, RiskConfirm, downloadFile, useToast } from './ui';

const TAIL = 4;

const downloadBackup = (backup: KeyBackupBody): void => {
  const text = [
    'Bitflow MM wallet backup',
    '',
    `Pool:        ${backup.pair}`,
    `Address:     ${backup.address}`,
    `Private key: ${backup.key}`,
    `Saved:       ${new Date().toISOString()}`,
    '',
    'Anyone with this key controls the wallet and everything in it.',
    'Keep this file offline or in a password manager. Never paste the key into a chat or give it to an agent.',
    '',
    'To restore: import the private key into a Stacks wallet that accepts private keys,',
    `or put it back as SIGNER_KEY in ${backup.file}.`,
    '',
  ].join('\n');
  downloadFile(`bitflow-mm-${backup.address.slice(-6)}-key.txt`, text, 'text/plain');
};

/** Shows the key once, offers copy and download, then asks for the last characters to prove it was saved. */
export function KeyBackup({ bot, onDone }: { bot: BotView; onDone: () => void }) {
  const toast = useToast();
  const [ack, setAck] = useState(false);
  const [backup, setBackup] = useState<KeyBackupBody | null>(null);
  const [visible, setVisible] = useState(false);
  const [tail, setTail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = `/api/bots/${encodeURIComponent(bot.id)}`;

  const show = async () => {
    setBusy(true);
    setError('');
    try {
      setBackup(await api<KeyBackupBody>(`${base}/key-backup`, 'POST', { acknowledged: true }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the key.');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      await api(`${base}/key-saved`, 'POST', { keyTail: tail.trim() });
      setBackup(null);
      toast('good', 'Backup recorded.');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not match.');
    } finally {
      setBusy(false);
    }
  };

  if (!backup) {
    return (
      <div className="explain">
        <p>
          This app made the wallet, so the key exists only in <code>.env.{bot.profile}</code> on this computer. If that file is lost, so are the funds. Save a copy now.
        </p>
        <label className="check">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>No one else can see my screen.</span>
        </label>
        {error ? <p className="form-err">{error}</p> : null}
        <div>
          <button type="button" className="btn primary" disabled={!ack || busy} onClick={() => void show()}>
            <Icon name="eye" />
            {busy ? 'Loading…' : 'Show key'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="explain">
      <div className="warnline">
        <Icon name="warn" />
        <span>Anyone with this key controls the wallet. Keep it in a password manager or offline. Never paste it into a chat or give it to an agent.</span>
      </div>
      <div className="addrbox">
        <div className="addrbox-k">Private key for {shortAddr(backup.address)}</div>
        <div className="addrbox-v mono">{visible ? backup.key : '•'.repeat(32)}</div>
        <span className="keybtns">
          <button type="button" className="btn sm ghost" onClick={() => setVisible(!visible)}>
            {visible ? 'Hide' : 'Reveal'}
          </button>
          <CopyButton text={backup.key} label="Copy" />
          <button type="button" className="btn sm" onClick={() => downloadBackup(backup)}>
            <Icon name="wallet" />
            Download
          </button>
        </span>
      </div>
      <label className="field">
        <span className="field-l">Type the last {TAIL} characters of the key you saved</span>
        <input className="in mono" value={tail} onChange={(e) => setTail(e.target.value)} maxLength={TAIL} autoComplete="off" spellCheck={false} />
      </label>
      {error ? <p className="form-err">{error}</p> : null}
      <div>
        <button type="button" className="btn primary" disabled={tail.trim().length !== TAIL || busy} onClick={() => void confirm()}>
          {busy ? 'Checking…' : 'I saved it'}
        </button>
      </div>
    </div>
  );
}

function KeyCard({ bot, reload }: { bot: BotView; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const imported = bot.keySource === 'import';
  return (
    <Card
      title="Key backup"
      aside={bot.keyBackedUp ? <span className="tag t-good">{imported ? 'Imported' : 'Saved'}</span> : <span className="tag t-warn">Not saved</span>}
    >
      {imported ? (
        <p className="muted">You imported this key, so you already have it.</p>
      ) : bot.keyBackedUp ? (
        <p className="muted">Saved {clock(bot.keyBackupAt)}.</p>
      ) : (
        <p>The key exists only on this computer. Save a copy before you fund the wallet.</p>
      )}
      <div>
        <button type="button" className={bot.keyBackedUp ? 'btn' : 'btn primary'} onClick={() => setOpen(true)}>
          <Icon name="lock" />
          {bot.keyBackedUp ? 'Show key again' : 'Back up key'}
        </button>
      </div>
      {open ? (
        <Modal title="Back up the wallet key" onClose={() => setOpen(false)}>
          <KeyBackup
            bot={bot}
            onDone={() => {
              setOpen(false);
              void reload();
            }}
          />
        </Modal>
      ) : null}
    </Card>
  );
}

function PayoutCard({ bot, reload }: { bot: BotView; reload: () => Promise<void> }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [address, setAddress] = useState('');
  const [memo, setMemo] = useState('');
  const [tail, setTail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const locked = bot.cashOut?.status === 'running';

  const startEdit = () => {
    setAddress(bot.payoutAddress || '');
    setMemo(bot.payoutMemo || '');
    setTail('');
    setError('');
    setEditing(true);
  };

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api(`/api/bots/${encodeURIComponent(bot.id)}/payout`, 'POST', { address: address.trim(), memo: memo.trim(), addressTail: tail.trim() });
      toast('good', 'Payout address saved.');
      setEditing(false);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the address.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Payout address" className="span2">
      <p className="muted">Cash out only ever sends here. Changing it is only possible on this page, so an agent can cash out but cannot send funds anywhere else.</p>
      {bot.payoutAddress ? (
        <div className="addrbox">
          <div className="addrbox-v mono">{bot.payoutAddress}</div>
          <a className="btn sm ghost" href={explorerAddress(bot.payoutAddress)} target="_blank" rel="noreferrer">
            <Icon name="external" />
          </a>
          {bot.payoutMemo ? <div className="addrbox-k">Memo: {bot.payoutMemo}</div> : null}
        </div>
      ) : null}
      <div>
        <button type="button" className={bot.payoutAddress ? 'btn' : 'btn primary'} disabled={locked} onClick={startEdit}>
          {bot.payoutAddress ? 'Change' : 'Set payout address'}
        </button>
      </div>
      {editing ? (
        <Modal title="Payout address" onClose={() => setEditing(false)}>
          <div className="explain">
            <label className="field">
              <span className="field-l">Your Stacks address</span>
              <input className="in mono" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="SP…" spellCheck={false} autoComplete="off" />
              <span className="sf-h">A wallet you control, not this bot's wallet. Check it character by character.</span>
            </label>
            <label className="field">
              <span className="field-l">
                Memo <span className="muted">(optional)</span>
              </span>
              <input className="in mono" value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={34} spellCheck={false} autoComplete="off" />
              <span className="sf-h">Exchanges often need one to credit a deposit. Up to 34 characters.</span>
            </label>
            <label className="field">
              <span className="field-l">Type the last {TAIL} characters of the address</span>
              <input className="in mono" value={tail} onChange={(e) => setTail(e.target.value)} maxLength={TAIL} spellCheck={false} autoComplete="off" />
            </label>
            {error ? <p className="form-err">{error}</p> : null}
          </div>
          <footer className="modal-f">
            <span className="spacer" />
            <button type="button" className="btn ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy || !address.trim() || tail.trim().toUpperCase() !== address.trim().slice(-TAIL).toUpperCase()}
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </footer>
        </Modal>
      ) : null}
    </Card>
  );
}

function CashOutCard({ bot, reload }: { bot: BotView; reload: () => Promise<void> }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const job = bot.cashOut;
  const running = job?.status === 'running';
  const why = !bot.payoutAddress ? 'Set a payout address first.' : running ? 'Cash out is running.' : '';

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await api(`/api/bots/${encodeURIComponent(bot.id)}/cash-out`, 'POST', { acknowledged: true, poolName: bot.pair });
      toast('good', 'Cash out started.');
      setOpen(false);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the cash out.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Cash out"
      className="span2"
      aside={
        job ? (
          <span className={`tag ${job.status === 'done' ? 't-good' : job.status === 'failed' ? 't-warn' : 't-unknown'}`}>
            {job.status === 'done' ? 'Done' : job.status === 'failed' ? 'Didn’t finish' : 'Running'}
          </span>
        ) : null
      }
    >
      <p>
        Pauses and stops the bot, withdraws everything from the pool, then sends all {bot.baseSymbol}, {bot.quoteSymbol}
        {bot.baseSymbol === 'STX' ? '' : ', and STX'} to your payout address. Works in dry run too. Each step waits for its transaction, so it takes a few minutes.
      </p>
      {job ? (
        <div className="logbox">
          {job.lines.length ? (
            job.lines.map((line, i) => (
              <div key={i} className={`logl lv-${line.level}`}>
                <span className="lt">{line.t}</span>
                <span className="ll">{line.level}</span>
                <span className="lx">
                  <CashOutText text={line.text} />
                </span>
              </div>
            ))
          ) : (
            <div className="logl">
              <span className="lt" />
              <span className="ll">info</span>
              <span className="lx">Starting…</span>
            </div>
          )}
        </div>
      ) : null}
      {job?.status === 'failed' ? <p className="note">Nothing is lost. Each step reads live balances, so running cash out again finishes what is left.</p> : null}
      <div className="row-between">
        <span className="muted">{why}</span>
        <button type="button" className="btn danger" disabled={!!why} onClick={() => setOpen(true)}>
          <Icon name="wallet" />
          {job?.status === 'failed' ? 'Run cash out again' : 'Cash out'}
        </button>
      </div>
      {open && bot.payoutAddress ? (
        <RiskConfirm
          title={`Cash out ${bot.pair}`}
          lead="The bot stops and every token in its wallet and in the pool goes to your payout address. This can’t be undone."
          facts={[
            ['To', <span className="mono">{bot.payoutAddress}</span>],
            ...(bot.payoutMemo ? ([['Memo', bot.payoutMemo]] as Array<[string, string]>) : []),
            ['In wallet', `${tok(bot.walletBase, bot.baseSymbol)} · ${tok(bot.walletQuote, bot.quoteSymbol)}`],
            ['In pool', `${tok(bot.ownedBase, bot.baseSymbol)} · ${tok(bot.ownedQuote, bot.quoteSymbol)}`],
          ]}
          poolName={bot.pair}
          confirmLabel="Cash out"
          busy={busy}
          error={error}
          onClose={() => setOpen(false)}
          onConfirm={() => void submit()}
        />
      ) : null}
    </Card>
  );
}

/** Turns a `[cashout] step=… tx=0x…` line into readable text with an explorer link. */
function CashOutText({ text }: { text: string }) {
  const tx = text.match(/tx=(0x[0-9a-fA-F]{64})/);
  const body = text.replace(/^\[cashout\]\s*/, '');
  if (!tx) return <>{body}</>;
  return (
    <>
      {body.replace(tx[0], '')}
      <a href={explorerTx(tx[1])} target="_blank" rel="noreferrer">
        {shortAddr(tx[1])}
      </a>
    </>
  );
}

export function WalletTab({ bot, reload }: { bot: BotView; reload: () => Promise<void> }) {
  if (bot.preview) {
    return (
      <Card>
        <Empty icon="wallet" title="Previews have no wallet">
          A real bot shows its balances, key backup, and cash out here. <Link to="/new">Create one</Link> to see it.
        </Empty>
      </Card>
    );
  }
  return (
    <div className="grid2">
      <Card title="Bot wallet">
        {bot.address ? (
          <div className="fundaddr">
            <QrCode text={bot.address} size={120} />
            <div className="addrbox">
              <div className="addrbox-v mono">{bot.address}</div>
              <CopyButton text={bot.address} label="Copy" />
            </div>
          </div>
        ) : null}
        <dl className="facts">
          <div className="fact-row">
            <dt>In wallet</dt>
            <dd>
              {tok(bot.liveWallet ? bot.liveWallet.base : bot.walletBase, bot.baseSymbol)} · {tok(bot.liveWallet ? bot.liveWallet.quote : bot.walletQuote, bot.quoteSymbol)}
            </dd>
          </div>
          <div className="fact-row">
            <dt>In pool</dt>
            <dd>
              {tok(bot.ownedBase, bot.baseSymbol)} · {tok(bot.ownedQuote, bot.quoteSymbol)}
            </dd>
          </div>
        </dl>
        <p className="note">
          {bot.liveWallet ? `Wallet read from the chain at ${clock(bot.liveWallet.asOf)}. ` : ''}
          {bot.holdingsAsOf ? `Pool as of the bot's check at ${clock(bot.holdingsAsOf)}.` : 'The pool shows after the bot\'s first check.'}
        </p>
      </Card>
      <KeyCard bot={bot} reload={reload} />
      {bot.strayTokens.length ? (
        <Card title="Other tokens in this wallet" className="span2" aside={<span className="tag t-warn">Not traded</span>}>
          <p className="muted">
            This bot only trades {bot.baseSymbol} and {bot.quoteSymbol}. These were probably sent here by mistake. Cash out sends the ones Bitflow lists to your
            payout address; any others need a wallet app that can import this bot's key.
          </p>
          <dl className="facts">
            {bot.strayTokens.map((token) => (
              <div key={token.contract} className="fact-row">
                <dt title={token.contract}>{token.symbol}</dt>
                <dd className="num">
                  {token.known ? tok(token.amount, token.symbol) : `${token.amount} (raw units)`}
                  {token.known ? null : <span className="muted"> · not listed on Bitflow</span>}
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      ) : null}
      <PayoutCard bot={bot} reload={reload} />
      <CashOutCard bot={bot} reload={reload} />
    </div>
  );
}
