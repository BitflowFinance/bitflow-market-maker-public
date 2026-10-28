import { useState } from 'react';
import { BotView, api } from './api';
import { Card, useToast } from './ui';

const KEYS: Array<{ name: string; label: string; help: string }> = [
  { name: 'STACKS_NODE_KEY', label: 'Hiro API key', help: 'Balances, nonces and transactions.' },
  { name: 'BFF_API_KEY', label: 'Bitflow API key', help: 'Pool and position reads.' },
  { name: 'COINGECKO_API_KEY', label: 'CoinGecko API key', help: 'The market price the bot compares the pool against.' },
];

/** Optional provider keys. Written to the bot's env file, never shown again. */
export function KeysCard({ bot, reload }: { bot: BotView; reload: () => Promise<void> }) {
  const toast = useToast();
  const [editing, setEditing] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async (name: string, next: string) => {
    setBusy(true);
    setError('');
    try {
      await api(`/api/bots/${encodeURIComponent(bot.id)}/api-key`, 'POST', { name, value: next });
      toast('good', next ? 'Key saved.' : 'Key removed.');
      setEditing('');
      setValue('');
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the key.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="API keys" aside={<span className="muted">Optional</span>}>
      <p className="muted">The bot works without these. Add one if a provider starts rate-limiting it.</p>
      <div className="keys">
        {KEYS.map((key) => {
          const set = Boolean(bot.keysSet?.[key.name]);
          return (
            <div key={key.name} className="keyrow">
              <div className="keyrow-l">
                <b>{key.label}</b>
                <span className="sf-h">{key.help}</span>
              </div>
              {editing === key.name ? (
                <form
                  className="keyrow-f"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save(key.name, value);
                  }}
                >
                  <input className="in mono" type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" spellCheck={false} placeholder="Paste the key" autoFocus />
                  <button type="button" className="btn sm ghost" onClick={() => setEditing('')}>
                    Cancel
                  </button>
                  <button type="submit" className="btn sm primary" disabled={busy || !value.trim()}>
                    Save
                  </button>
                </form>
              ) : (
                <div className="keyrow-f">
                  <span className={`tag ${set ? 't-good' : ''}`}>{set ? 'Set' : 'Not set'}</span>
                  <button type="button" className="btn sm" onClick={() => { setEditing(key.name); setValue(''); setError(''); }}>
                    {set ? 'Replace' : 'Add'}
                  </button>
                  {set ? (
                    <button type="button" className="btn sm ghost" disabled={busy} onClick={() => void save(key.name, '')}>
                      Remove
                    </button>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {error ? <p className="form-err">{error}</p> : null}
    </Card>
  );
}
