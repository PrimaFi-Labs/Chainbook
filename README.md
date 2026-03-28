# 🔗 Chainbook: The Social Network for Blockchain Activity

![Chainbook Logo](apps/web/public/assets/chainbook-logo-transparent-bg.png)

> **Blockchain events become posts. Wallets become profiles. Transactions become conversations.**

Chainbook is a revolutionary real-time social layer for on-chain activity on **Somnia Testnet**. It transforms raw blockchain events into an engaging, Twitter-like feed where both humans and AI agents can interact with on-chain activity in real time.

[![GitHub Stars](https://img.shields.io/github/stars/PrimaFi-Labs/somnia-chainbook)](https://github.com/PrimaFi-Labs/Chainbook)
[![License](https://img.shields.io/badge/License-All%20Rights%20Reserved-red)](LICENSE)
[![Built with Next.js](https://img.shields.io/badge/Built%20with-Next.js-black?logo=next.js)](https://nextjs.org/)
[![Powered by Somnia](https://img.shields.io/badge/Powered%20by-Somnia-blue)](https://somnia.network/)

---

## ✨ Key Features

- **📰 Live Feed** — Real-time blockchain activity rendered as social posts
- **🔥 Trending** — Discover trending tokens, contracts, and activities
- **📊 Pulse Analytics** — Track network metrics and whale movements
- **👥 Social Interactions** — Like, comment, and follow wallet addresses
- **🐋 Whale Alerts** — Stay informed about large transactions
- **🏆 Reputation Engine** — Build reputation across the network
- **⚡ Reactive Smart Contracts** — On-chain event processing with WhaleWatcher
- **💾 Real-time Sync** — PostgreSQL subscriptions for instant updates
- **🎯 Multi-Modal Events** — ERC-20, ERC-1155, DAO votes, NFT trades, and more

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│           Somnia Blockchain (Testnet)                   │
│  Logs • Transactions • Reactive Streams • Smart Events  │
└─────────────────┬───────────────────────────────────────┘
                  │
          ┌───────▼──────────┐
          │  Event Listener  │
          │  (apps/listener) │
          │  • Decodes logs  │
          │  • Processes RPC │
          │  • Computes sig. │
          └───────┬──────────┘
                  │
          ┌───────▼──────────────┐
          │  Supabase / PostgreSQL│
          │  • posts             │
          │  • trending          │
          │  • subscriptions     │
          └───────┬──────────────┘
                  │
          ┌───────▼──────────┐
          │   Web Frontend   │
          │   (apps/web)     │
          │   • Feed UI       │
          │   • Real-time     │
          │   • Interactions  │
          └──────────────────┘
```

---

## 📦 What's Included

### **apps/web** — Modern Next.js Frontend
- **Feed** — Real-time activity stream with infinite scroll
- **Trending** — Trending tokens and contracts with chart integrations
- **Pulse** — Network analytics and statistics dashboard
- **Wallet Pages** — Comprehensive profile views with activity history
- **Notifications** — Real-time alerts for important events
- **Social Features** — Likes, comments, follows, and reposts
- **Sound System** — Audio feedback for user interactions

### **apps/listener** — Event Ingestion & Indexing
- Reads blocks and logs from Somnia testnet
- Supports **Reactivity Streams** (`reactivity_wildcard`, `reactivity_spotlight`)
- HTTP fallback with `getLogs` for reliability
- Decodes and normalizes events into social posts
- Computes significance scoring (whale alerts, trending)
- Writes to Supabase with real-time change notifications
- Handles metadata enrichment and token price feeds

### **contracts/** — Smart Contracts & Reactivity
- **WhaleWatcher.sol** — Detects and tracks large transactions
- **ReputationEngine.sol** — On-chain reputation tracking
- **ActivityRegistry.sol** — Records and aggregates activities
- **FollowGraph.sol** — Manages social follow relationships
- **PostRegistry.sol** — Stores and indexes posts on-chain
- **Hardhat** deployment scripts and utilities

### **packages/shared** — Shared Types & Utils
- TypeScript type definitions used across all apps
- Common utilities and helpers
- Standardized interfaces for events and API responses

---

## 🚀 Quick Start

### Prerequisites
- **Node.js** 18+ 
- **pnpm** 8+
- **Somnia Testnet** access
- **Supabase** project configured

### Installation

```bash
# Clone the repository
git clone https://github.com/PrimaFi-Labs/somnia-chainbook.git
cd somnia-chainbook

# Install dependencies
pnpm install

# Configure environment variables
cp .env.example .env
# Edit .env with your Somnia RPC, Supabase, and other credentials
```

### Running the Applications

```bash
# Development mode (all apps)
pnpm dev

# Web app only
cd apps/web && pnpm dev

# Listener/Indexer only
cd apps/listener && pnpm dev

# Deploy contracts
cd contracts && pnpm hardhat run scripts/deploy.ts --network somnia_testnet
```

---

## 📁 Repository Structure

```
chainbook/
├── apps/
│   ├── web/                          # Next.js frontend application
│   │   ├── src/
│   │   │   ├── app/                  # Routes and layouts
│   │   │   ├── components/           # React components
│   │   │   │   ├── feed/             # Feed & post components
│   │   │   │   ├── layout/           # Sidebar, shell
│   │   │   │   ├── notifications/    # Alert system
│   │   │   │   ├── providers/        # Context & state
│   │   │   │   └── wallet/           # Account components
│   │   │   ├── lib/
│   │   │   │   ├── api/              # API clients
│   │   │   │   ├── hooks/            # React hooks
│   │   │   │   ├── sounds/           # Audio system
│   │   │   │   └── supabase/         # Database client
│   │   │   └── styles/               # Tailwind CSS
│   │   ├── public/
│   │   │   └── assets/               # Images, sounds, favicon
│   │   ├── db/
│   │   │   └── migrations/           # SQL migrations
│   │   └── next.config.ts
│   │
│   └── listener/                     # Event listener & indexer
│       ├── src/
│       │   ├── index.ts              # Main service
│       │   ├── config/               # Configuration
│       │   ├── lib/
│       │   │   ├── eventDecoder.ts  # Log decoding
│       │   │   ├── eventProcessor.ts # Processing logic
│       │   │   ├── priceFeed.ts     # Price data
│       │   │   ├── trendingEngine.ts # Trending calc
│       │   │   └── walletHelper.ts  # Wallet utilities
│       │   └── scripts/              # Utility scripts
│       └── tsconfig.json
│
├── contracts/                        # Smart contracts
│   ├── contracts/
│   │   ├── WhaleWatcher.sol
│   │   ├── ReputationEngine.sol
│   │   ├── ActivityRegistry.sol
│   │   ├── FollowGraph.sol
│   │   ├── PostRegistry.sol
│   │   └── ChainbookReactivityShowcase.sol
│   ├── scripts/
│   │   ├── deploy.ts
│   │   └── deploy-whale-watcher.ts
│   ├── hardhat.config.ts
│   └── tsconfig.json
│
├── packages/
│   └── shared/                       # Shared types & utils
│       └── src/
│           ├── types.ts              # TypeScript interfaces
│           └── index.ts              # Exports
│
├── .env.example                      # Environment template
├── .gitignore
├── LICENSE                           # Proprietary license
├── README.md                         # This file
├── package.json                      # Workspace root
└── pnpm-workspace.yaml              # pnpm configuration
```

---

## 🔌 Supported Blockchain Events

The listener automatically detects and processes:

| Event Type | Standard | Purpose |
|-----------|----------|---------|
| `Transfer` | ERC-20 | Token transfers |
| `Approval` | ERC-20 | Token approvals |
| `TransferSingle` | ERC-1155 | NFT/SFT transfers |
| `TransferBatch` | ERC-1155 | Batch NFT transfers |
| `Swap` | Uniswap V2/V3 | DEX swaps |
| `Mint` | Various | Token minting |
| `Burn` | Various | Token burning |
| `VoteCast` | DAO | Governance votes |
| `Transfer (ETH)` | Core | Native transfers |
| `ContractDeployed` | Custom | New contracts |

---

## 🛠️ Technology Stack

### Frontend
- **Next.js 14** — React framework with App Router
- **TypeScript** — Type-safe development
- **Tailwind CSS** — Utility-first styling
- **Framer Motion** — Smooth animations
- **Wagmi** — Ethereum wallet integration
- **Privy** — Authentication and smart accounts
- **Supabase JS** — Real-time database client

### Backend
- **Node.js** — JavaScript runtime
- **TypeScript** — Type safety
- **Supabase** — PostgreSQL database & auth
- **Hardhat** — Smart contract development
- **Solidity** — Contract development
- **Howler.js** — Audio playback

### Infrastructure
- **Somnia Testnet** — Blockchain network
- **Railway** — Deployment platform
- **Vercel** — Frontend hosting
- **Docker** — Containerization

---

## 🔑 Environment Configuration

Create a `.env` file based on `.env.example`:

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# Somnia RPC
NEXT_PUBLIC_SOMNIA_RPC_URL=https://testnet-rpc.somnia.network

# Privy Auth
NEXT_PUBLIC_PRIVY_APP_ID=your_privy_app_id

# Application
NEXT_PUBLIC_APP_URL=http://localhost:3000

# Contracts
NEXT_PUBLIC_WHALE_WATCHER_ADDRESS=0x...
NEXT_PUBLIC_REPUTATION_ENGINE_ADDRESS=0x...
```

---

## 📈 Trending Algorithm

The trending engine scores events based on:
- **Frequency** — How many similar events in the window
- **Volume** — Token amounts and transaction values
- **Uniqueness** — New tokens or emerging patterns
- **Velocity** — Rate of activity change
- **Market Impact** — Weighted by price and liquidity

---

## 🔐 Security & Privacy

- All user data is encrypted at rest in Supabase
- Wallet addresses are public (on-chain is public)
- No private keys are stored
- Smart contracts are auditable on-chain
- Environment secrets are never committed to git

---

## 📝 License

This project is licensed under an **All Rights Reserved** license. See the [LICENSE](LICENSE) file for full terms.

© 2026 **PrimaFi Labs**. All rights reserved.

---

## 🤝 Contributing

Chainbook is a proprietary project and currently closed for external contributions. For collaboration inquiries, please contact PrimaFi Labs.

---

## 🙋 Support & Feedback

Have questions or feedback? 
- 📧 Email: contact@primafi.xyz
- 🐦 Twitter: [@PrimaFi_Labs](https://twitter.com/primafilabs)


---

## 🎯 Roadmap

- [ ] Mainnet deployment
- [ ] Advanced analytics dashboard
- [ ] Mobile app
- [ ] AI agent integration
- [ ] Governance token launch
- [ ] Cross-chain support

---

<div align="center">

**Built with ❤️ by [PrimaFi Labs](https://primafi.xyz)**

[Website](https://primafi.xyz) • [Twitter](https://twitter.com/primafilabs) • [GitHub](https://github.com/PrimaFi-Labs)

</div>
- Uniswap-like `Swap` (V2 and V3 shapes)
- Liquidity `Mint` / `Burn`
- Governance `VoteCast`
- `WhaleDetected(address,address,uint256,address)` from `WhaleWatcher.sol`
- Native transfers and contract deployments (transaction-level scan)

Output post types:
- `TRANSFER`
- `SWAP`
- `MINT`
- `DAO_VOTE`
- `LIQUIDITY_ADD`
- `LIQUIDITY_REMOVE`
- `CONTRACT_DEPLOY`
- `NFT_TRADE`

## Reactivity + Fallback Ingestion Model

The listener intentionally supports dual-path ingestion:

- **Reactivity path** (optional): low-latency push model.
- **Fallback path** (always on): per-block `getLogs` and tx scans.

When the same event arrives from multiple sources, write conflicts are resolved by source priority:
- `reactivity_spotlight` > `reactivity_wildcard` > `legacy_unknown` > `unknown` > `log_fallback`

This keeps reliability high while still preferring richer reactivity payloads.

## WhaleWatcher (On-Chain Whale Alerts)

Chainbook supports on-chain whale alerting using `contracts/contracts/WhaleWatcher.sol`.

Behavior:
- Watches ERC-20 transfers from configured token emitters.
- Emits `WhaleDetected` only when amount >= on-chain threshold.
- Listener decodes this event and sets `isWhaleEvent=true`.
- Event processor treats on-chain whale signal as authoritative:
  - `is_whale_alert = decoded.isWhaleEvent === true || amountUsd >= WHALE_THRESHOLD_USD`

This gives on-chain-first detection with existing off-chain threshold logic as fallback.

## Smart Contracts

From `contracts/contracts`:
- `ActivityRegistry.sol`
- `TrackerRegistry.sol`
- `FollowGraph.sol`
- `PostRegistry.sol`
- `ReputationEngine.sol`
- `ChainbookReactivityShowcase.sol`
- `WhaleWatcher.sol`

Useful scripts:
- `contracts/scripts/deploy.ts` deploys core Chainbook contracts and updates `.env`.
- `contracts/scripts/deploy-whale-watcher.ts` deploys `WhaleWatcher`, creates Somnia subscriptions, prints required env outputs.

## Database Schema and Migrations

Migrations live in `apps/web/db/migrations` and are ordered:
- `001`–`012`: core schema, functions, indexes, likes/comments, reputation/wallet token logic.
- `013_reactivity_showcase.sql`: `reactivity_spotlight_posts` and `reactivity_showcase_events`.
- `014_reactivity_source_backfill.sql`: source metadata backfill in `posts`.

For current features (including WhaleWatcher + spotlight/showcase), run through **014**.

## Prerequisites

- Node.js **22.x LTS recommended** (Hardhat warns on Node 25).
- `pnpm` (workspace uses pnpm).
- Supabase project (URL + keys).
- Somnia Testnet RPC/WS endpoints.
- Wallet private key for contract deployment and subscription creation.

## Environment Variables

Copy `.env.example` to `.env` and set required values.

Critical listener/web variables:
- `SOMNIA_RPC_HTTP`
- `SOMNIA_RPC_WS`
- `SOMNIA_REACTIVITY_WS` (optional but recommended for Reactivity path)
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_ACTIVITY_REGISTRY_ADDRESS`
- `NEXT_PUBLIC_REPUTATION_ENGINE_ADDRESS`
- `NEXT_PUBLIC_POST_REGISTRY_ADDRESS`
- `NEXT_PUBLIC_FOLLOW_GRAPH_ADDRESS`
- `NEXT_PUBLIC_TRACKER_REGISTRY_ADDRESS`
- `NEXT_PUBLIC_PRIVY_APP_ID`

WhaleWatcher variables:
- `DEPLOYER_PRIVATE_KEY`
- `WHALE_WATCHER_BYTECODE`
- `WHALE_WATCHER_ADDRESS` (after deployment)

Optional showcase coupling:
- `REACTIVITY_SHOWCASE_HANDLER_ADDRESS`
- `REACTIVITY_SHOWCASE_TOPIC0`

If you do not want WhaleWatcher events to be treated as showcase events, leave showcase vars empty.

## Quickstart (Local)

1. Install dependencies

```bash
pnpm install
```

2. Configure environment

```bash
cp .env.example .env
# Fill required values
```

3. Run SQL migrations (`001`..`014`) in Supabase.

4. Deploy contracts

```bash
pnpm -C contracts run compile
pnpm -C contracts exec hardhat run scripts/deploy.ts --network somniaTestnet
```

5. Deploy WhaleWatcher (optional but recommended for on-chain whale priority)

```bash
pnpm -C contracts run compile
pnpm -C contracts run deploy
```

6. Start services

```bash
# terminal 1
pnpm run dev:web

# terminal 2
pnpm run dev:listener
```

## Runtime Scripts

Root:
- `pnpm run dev:web`
- `pnpm run dev:listener`
- `pnpm run build:web`
- `pnpm run build:contracts`

Contracts workspace:
- `pnpm -C contracts run compile`
- `pnpm -C contracts run deploy`
- `pnpm -C contracts run verify`
- `pnpm -C contracts run test`

Listener workspace:
- `pnpm -C apps/listener run dev`
- `pnpm -C apps/listener run build`
- `pnpm -C apps/listener run start`
- `pnpm -C apps/listener run reactivity:showcase-subscribe`

## Feed Visibility and Significance

Chainbook intentionally filters low-value noise.

Listener-side significance:
- `SIGNIFICANT_MIN_USD`
- `SIGNIFICANT_MIN_SCORE`
- `WHALE_THRESHOLD_USD`

Web-side feed thresholds:
- `NEXT_PUBLIC_MIN_FEED_USD`
- `NEXT_PUBLIC_MIN_FEED_SCORE`

If events appear in listener logs but not in UI, check these first.

## Sounds and UI System

Web app uses:
- `react-sounds` + `howler`
- local sound assets under `apps/web/public/sounds`

Brand assets under:
- `apps/web/public/assets`

Current design:
- light/dark support
- high-contrast palette
- glassmorph shell/cards
- responsive mobile layout with profile-avatar sidebar trigger

## API Endpoints (Web)

Key API routes in `apps/web/src/app/api`:
- likes
- follows
- comments

These routes synchronize social interactions with Supabase and optionally on-chain actions from the client.

## Troubleshooting

### I only see mints in feed

Common cause is filtering:
- listener significance thresholds are too high
- web minimum feed thresholds are too high

Adjust:
- `SIGNIFICANT_MIN_SCORE`
- `NEXT_PUBLIC_MIN_FEED_USD`
- `NEXT_PUBLIC_MIN_FEED_SCORE`

### Metrics show `reactivity_* = 0`, `log_fallback > 0`

Expected when `LISTENER_USE_WS=false`.  
This means fallback ingestion is active and Reactivity WS is disabled.

### Native transfer logs appear in listener but not in UI

Likely filtered out by significance/feed thresholds.  
Confirm `is_significant` and feed env thresholds.

### Hardhat deployment failures with modern Node

Hardhat currently warns/errors on non-LTS combinations.  
Use Node 22 LTS.

### `privateKeyToAccount` import errors

Use:
- `import { privateKeyToAccount } from 'viem/accounts'`

### `@somnia-chain/reactivity` not found in contracts deploy script

Ensure dependency exists in `contracts/package.json` and run `pnpm install`.

## Security Notes

- `SUPABASE_SERVICE_ROLE_KEY` must never be exposed to browsers.
- Keep deployment keys out of client bundles.
- Rotate any leaked credentials immediately.
- Store secrets in secure vaults for production environments.

## Production Checklist

- Node 22 LTS pinned in CI/runtime.
- `.env` secrets rotated and managed securely.
- Supabase migrations fully applied to 014.
- Listener process supervised (pm2/systemd/container).
- Alerting configured on listener failures and ingestion lag.
- RPC provider redundancy for HTTP/WS.
- Reorg/duplication tolerance verified via post hash idempotency.

## License

No license file is currently declared in this repository.  
Add one before public distribution.
