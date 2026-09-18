# stack-sats-market-maker-skill

> **Mainnet, real funds.** This skill operates the bot in this repository. The notice at the top of the root README applies in full: as is, no warranty, not financial advice, you are responsible for your keys, positions and losses.

This folder is an Agent Skill in the open Agent Skills format (agentskills.io). Claude Code and Codex both read it. Everything the agent needs is in `SKILL.md`; this file only says how to install the folder and what the agent is allowed to do.

## The boundary

The boundary is: the skill turns the agent into the bot's operator, never into the bot. The repo is the bot. The skill installs it, configures it, gates it, and reads it. The loop runs as its own process and makes every trading decision on its own. The agent never places a trade by its own judgment.

The agent never sees, prints or derives a private key or seed phrase, never sets `EXECUTION_MODE=live` without the owner's explicit go, never changes the bot's strategy, never creates a wallet, and never drives the owner's wallet or browser.

## Install

One copy of this folder, placed where each product looks:

| Product | Project scope | User scope | Invoke |
|---|---|---|---|
| Claude Code | `.claude/skills/stack-sats-market-maker-skill/` | `~/.claude/skills/stack-sats-market-maker-skill/` | `/stack-sats-market-maker-skill` |
| Codex | `.agents/skills/stack-sats-market-maker-skill/` | `~/.agents/skills/stack-sats-market-maker-skill/` | `$stack-sats-market-maker-skill` |

Both products also trigger the skill on their own from the `description` in `SKILL.md`. Codex follows symlinks, so one folder can serve both:

```bash
mkdir -p ~/.agents/skills && ln -s ~/.claude/skills/stack-sats-market-maker-skill ~/.agents/skills/stack-sats-market-maker-skill
```

## Requirements

Node.js 20 or newer, git, curl, python3, internet access. The scripts in `scripts/` are bash and must be run, not read.

## Layout

- `SKILL.md`: the procedure the agent follows (required by the spec).
- `scripts/`: the deterministic steps; run them.
- `references/campaign-rules.md`: the campaign page's rules and FAQ, quoted verbatim.
- `evals/evals.json`: test prompts and pass/fail checks.
- `agents/openai.yaml`: Codex and ChatGPT desktop metadata (display name, brand color, implicit-invocation policy); Claude Code ignores it.
- `AGENTS.md`: this file. `CLAUDE.md` imports it so Claude Code reads the same text.

## License

MIT, under the repository's root `LICENSE`.
