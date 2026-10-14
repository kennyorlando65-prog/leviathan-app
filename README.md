# Leviathan

On-chain whale intelligence. Watches large wallet movements across Ethereum, Base and Solana, scores them, and delivers alerts through Telegram on a tiered access model.

Live: https://leviathan-app.vercel.app

## What it does

- Polls multiple chains on a schedule and ingests large transfers into Postgres.
- Scores each event into a signal with a confidence value.
- Delivers alerts to Telegram, rate-limited per tier (free tier gets a capped daily volume and a delay; premium gets real-time).
- Lets premium users track specific wallets and receive alerts when those wallets move.
- Accepts USDT on Solana for upgrades, matched against registered payment intents.

## Architecture

| Layer | Choice |
| --- | --- |
| Ingestion | Scheduled GitHub Actions job running a Node poller against chain RPC endpoints |
| Compute | Supabase Edge Functions (Deno) for fan-out, bot handling, payment polling and daily summaries |
| Database | Supabase Postgres |
| Delivery | Telegram Bot API |
| Secrets | GitHub Actions secrets and Supabase Edge Function secrets. Never in the repo. |

The poller writes raw events; the fan-out function decides who should be told. Keeping ingestion and delivery separate means a delivery failure never loses the underlying event.

## Repository layout

```
scripts/poll.js                          Scheduled poller (Node)
supabase/functions/poll-whales/          Ingestion function
supabase/functions/telegram-fanout/      Tiered alert delivery
supabase/functions/telegram-bot/         Bot command handling
supabase/functions/solana-payment-poller/ Payment intent matching
supabase/functions/telegram-daily-summary/ Daily digest
.github/workflows/main.yml               Deploy + scheduled poll
.github/workflows/secret-scan.yml        gitleaks on every push and PR
```

## Getting started

```bash
git clone https://github.com/kennyorlando65-prog/leviathan-app.git
cd leviathan-app
cp .env.example .env        # then fill in real values locally
npm install
node scripts/poll.js        # run the poller once
```

Edge functions are deployed with the Supabase CLI:

```bash
supabase link --project-ref <PROJECT_REF>
supabase functions deploy poll-whales --no-verify-jwt
```

## Environment variables

Every variable is documented as a placeholder in [`.env.example`](.env.example). Nothing in that file is a secret.

Set production values in **GitHub -> Settings -> Secrets and variables -> Actions** for the workflow, and in **Supabase -> Project Settings -> Edge Functions -> Secrets** for the functions.

`SUPABASE_SERVICE_KEY` bypasses Row Level Security. It is server-only and must never reach a browser.

## Security

This repository previously contained live credentials in a committed workflow file. They have been removed from the current tree, replaced with secret references, and a gitleaks scan now runs on every push and pull request. The historical values remain in git history and must be treated as compromised until rotated.

## Status

Working prototype. Ingestion, scoring, tiered delivery and payment matching are implemented. Not yet hardened for scale: no backfill for missed windows, and alert deduplication is per-event rather than per-cluster.
