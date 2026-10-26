import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BotView, Strategy, api } from './api';
import { Card, Icon, Modal, downloadFile, useToast } from './ui';

/** Share this bot's strategy as a file, or start a new bot from it with a new wallet. */
export function StrategyCard({ bot }: { bot: BotView }) {
  const toast = useToast();
  const navigate = useNavigate();
  const exportStrategy = async () => {
    try {
      const strategy = await api<Strategy>(`/api/bots/${encodeURIComponent(bot.id)}/strategy`);
      const slug = (bot.name || bot.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || bot.id;
      downloadFile(`${slug}-strategy.json`, `${JSON.stringify(strategy, null, 2)}\n`, 'application/json');
    } catch (err) {
      toast('bad', err instanceof Error ? err.message : 'Could not export the strategy.');
    }
  };
  return (
    <Card title="Strategy">
      <div className="row-between">
        <p className="muted">The pair, pool and settings. Never the wallet or any key.</p>
        <span className="btnrow">
          <button type="button" className="btn sm" onClick={() => void exportStrategy()}>
            <Icon name="download" />
            Export
          </button>
          <button type="button" className="btn sm" onClick={() => navigate(`/new?from=${encodeURIComponent(bot.id)}`)}>
            <Icon name="copy" />
            Duplicate
          </button>
        </span>
      </div>
    </Card>
  );
}

/** The bot's name, with a small dialog to change it. */
export function BotTitle({ bot, reload }: { bot: BotView; reload: () => Promise<void> }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/bots/${encodeURIComponent(bot.id)}/name`, 'POST', { name: draft });
      setOpen(false);
      await reload();
    } catch (err) {
      toast('bad', err instanceof Error ? err.message : 'Could not rename the bot.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h1>{bot.name || bot.pair}</h1>
      {bot.preview ? null : (
        <button type="button" className="ibtn" onClick={() => { setDraft(bot.name || ''); setOpen(true); }} aria-label="Rename this bot" title="Rename">
          <Icon name="edit" size={15} />
        </button>
      )}
      {open ? (
        <Modal title="Rename bot" onClose={() => setOpen(false)}>
          <form
            className="explain"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label className="field">
              <span className="field-l">Name</span>
              <input className="in" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={40} placeholder={bot.pair} autoFocus />
              <span className="sf-h">Leave empty to use the pair name.</span>
            </label>
            <footer className="modal-f">
              <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="btn primary" disabled={busy}>
                Save
              </button>
            </footer>
          </form>
        </Modal>
      ) : null}
    </>
  );
}
