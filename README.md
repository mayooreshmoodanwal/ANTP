# ANTP — Decentralized Edge-Compute Orchestration Platform

A fully distributed compute platform that harnesses idle device CPU/GPU power through a work-stealing queue architecture with Byzantine fault-tolerant 2-of-3 consensus verification.

## Architecture

```
Client → REST API → Orchestrator (Node.js + uWebSockets.js)
                         │
                    ┌────┴────┐
                    │  3-Tier │
                    │  Queues │
                    └────┬────┘
                         │ WebSocket (MessagePack)
              ┌──────────┼──────────┐
              ▼          ▼          ▼
         Edge Daemon  Edge Daemon  Edge Daemon
         (Rust+Tauri) (Rust+Tauri) (Rust+Tauri)
                         │
                    ┌────┴────┐
                    │ Neon.tech│
                    │PostgreSQL│
                    └─────────┘
```

## Components

| Component | Tech Stack | Description |
|-----------|-----------|-------------|
| **Orchestrator** | Node.js 22 + uWebSockets.js | Work-stealing queues, consensus engine, RAG pipeline, SLA monitor |
| **Database** | Neon.tech + Drizzle ORM | PostgreSQL with pgvector, type-safe schemas, 7 tables |
| **Edge Daemon** | Rust + Tauri v2 | Hardware profiling, WASM sandbox executor, RAM monitor |
| **Mock Cloud** | Express.js | Dev-only SLA fallback server for testing REQ-SLA-02 |

## Prerequisites

- **Node.js 22 LTS** (via nvm) — **NOT Node 24** (uWebSockets.js has no prebuilt binaries for Node 24)
- **Rust** toolchain (`rustup` — https://rustup.rs)
- **Neon.tech** PostgreSQL account (free tier: https://neon.tech)
- **macOS**: Xcode Command Line Tools (`xcode-select --install`)
- **Linux**: `build-essential`, `libssl-dev`, `libgtk-3-dev`, `libwebkit2gtk-4.1-dev`

---

## Step-by-Step Setup (Bash)

### Step 1: Switch to Node.js 22 LTS

```bash
# Install Node 22 if not already installed
nvm install 22

# Switch to Node 22 (the .nvmrc file will also do this automatically)
nvm use 22

# Verify — MUST show v22.x.x
node --version
```

> ⚠️ **IMPORTANT**: You MUST use Node 22. Node 24 is too new — uWebSockets.js
> does not have prebuilt binaries for Node 24's ABI yet. Node 20 also works.

### Step 2: Setup Neon.tech Database

1. Go to [neon.tech](https://neon.tech) and create a free project
2. Go to **Dashboard → Connection Details**
3. Copy the connection string (looks like: `postgresql://user:pass@ep-xxx.region.aws.neon.tech/neondb?sslmode=require`)
4. Open `.env.local` in the project root and replace the `DATABASE_URL` value:

```bash
# Edit the .env.local file
nano .env.local

# Set DATABASE_URL to your Neon connection string
# DATABASE_URL=postgresql://your_user:your_pass@your-host.neon.tech/neondb?sslmode=require
```

### Step 3: Install All Dependencies

```bash
# From the project root: /Users/ayushkumarsingh/Downloads/ANTP

# Install root dependencies (concurrently)
npm install

# Install database dependencies
cd database && npm install && cd ..

# Install orchestrator dependencies
cd orchestrator && npm install && cd ..

# Install mock cloud dependencies
cd mock-cloud && npm install && cd ..
```

### Step 4: Push Database Schema to Neon

```bash
# This creates all 7 tables + indexes + enums in your Neon database
npm run db:push
```

You should see output like:
```
Reading config file...
Using '@neondatabase/serverless' driver
[✓] Changes applied
```

### Step 5: Seed Test Data (Optional)

```bash
npm run db:seed
```

### Step 6: Start the System

```bash
# Terminal 1 — Start orchestrator + mock cloud together
npm run dev

# OR start them separately:
# Terminal 1: npm run orch:dev
# Terminal 2: npm run mock:cloud
```

### Step 7: Verify It's Running

```bash
# Health check
curl http://localhost:8080/api/health | python3 -m json.tool

# Check tier rates
curl http://localhost:8080/api/tiers | python3 -m json.tool

# Check queue stats
curl http://localhost:8080/api/queue/stats | python3 -m json.tool

# Check SLA monitor status
curl http://localhost:8080/api/sla/status | python3 -m json.tool
```

### Step 8: Build Edge Daemon (requires Rust)

```bash
# Install Rust if not already installed
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# Build the edge daemon
cd edge-daemon/src-tauri
cargo build

# Run tests
cargo test
```

---

## REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/task` | Submit a compute task |
| `GET` | `/api/task/:id/status` | Poll task status |
| `GET` | `/api/node/:id/stats` | Node statistics & earnings |
| `GET` | `/api/queue/stats` | Queue depth & throughput per tier |
| `POST` | `/api/rag/process` | Submit document for RAG pipeline |
| `GET` | `/api/rag/:id/status` | RAG pipeline status |
| `GET` | `/api/system/stats` | Overall system statistics |
| `GET` | `/api/tiers` | Tier rate information |
| `GET` | `/api/sla/status` | SLA monitor status |
| `GET` | `/api/health` | Health check |

### Example: Submit a Task

```bash
curl -X POST http://localhost:8080/api/task \
  -H "Content-Type: application/json" \
  -d '{
    "tier": "TIER_1",
    "wasmBytes": "",
    "input": "aGVsbG8gd29ybGQ=",
    "timeoutMs": 2000
  }'
```

---

## Key Features

### Work Stealing Queues (Section 3)
- **Pull-based**: Nodes fetch work when idle — no centralized push scheduling
- **3 Tiers**: TIER_1 (basic), TIER_2 (GPU), TIER_3 (VIP) with isolated queues
- **Anti-affinity**: One node cannot steal >1 clone from the same task family

### 2-of-3 Consensus (REQ-ORC-03)
- Every task spawns 3 independent clones executed by 3 different nodes
- Results are hash-compared — 2-of-3 majority is accepted
- Correct nodes are paid; dissenting node gets reputation slashed

### SLA Fallback (REQ-SLA-02)
- Tasks monitored every 100ms for SLA breaches (default: 2.0s timeout)
- Breached tasks forwarded to Cloud Shadow Server (AWS/GCP)
- Cloud compute is the **only** scenario where cloud is used

### Proof-of-Work Economics (Section 5)
- `User_Reward = Base_Rate[Tier] × Verified_Tasks`
- Tier 1: $0.001 | Tier 2: $0.020 | Tier 3: $0.500 per verified task
- Passive presence earns nothing — payout requires verified completion

### Edge Daemon Security
- Deterministic node ID from hardware (SHA-256 of CPU serial + MAC + machine ID)
- WASM tasks execute in Wasmtime sandbox (no FS, no network, memory-capped)
- Aggressive RAM monitor triggers instant task eviction under memory pressure

---

## Project Structure

```
ANTP/
├── .nvmrc                     # Pins Node.js 22 LTS
├── .env.local                 # Environment configuration
├── PAYLOAD_SPEC.md            # WASM payload contract
├── package.json               # Root workspace scripts
├── database/                  # Drizzle ORM + Neon
│   ├── schema.ts              # 7 tables with pgvector
│   ├── db.ts                  # Drizzle client
│   ├── queries.ts             # Type-safe query functions
│   ├── seed.ts                # Test data seeder
│   ├── migrate.ts             # Migration runner
│   └── drizzle.config.ts      # Drizzle Kit config
├── orchestrator/              # Node.js + uWebSockets.js
│   └── src/
│       ├── index.ts           # Entry point
│       ├── config.ts          # Centralized config
│       ├── state/task-store.ts # Shared task state
│       ├── ws/                # WebSocket server + protocol
│       ├── queue/             # 3-tier work stealing queues
│       ├── consensus/         # 2-of-3 majority engine
│       ├── rag/               # RAG pipeline (Map/Search/Reduce)
│       ├── sla/               # SLA monitor + cloud fallback
│       ├── economics/         # Payout engine
│       └── api/               # REST endpoints
├── mock-cloud/                # Dev-only cloud shadow server
│   └── server.ts
└── edge-daemon/               # Rust + Tauri v2
    ├── src/                   # Frontend dashboard
    └── src-tauri/src/
        ├── lib.rs             # Tauri app setup
        ├── profiler/          # CPU, GPU, RAM profiling
        ├── crypto/            # Hardware-bound node ID
        ├── ws/                # WebSocket client
        ├── executor/          # Wasmtime WASM sandbox
        └── monitor/           # Aggressive RAM watchdog
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `Cannot find module 'uws_darwin_arm64_131.node'` | You're on Node 24. Run `nvm use 22` |
| `require is not defined in ES module scope` | Run drizzle-kit via `npm run db:push` (not `npx drizzle-kit push` directly) |
| `EADDRINUSE: address already in use :::8080` | Another copy is running. Kill it: `lsof -ti:8080 \| xargs kill` |
| `EADDRINUSE: address already in use :::3001` | Kill the old mock cloud: `lsof -ti:3001 \| xargs kill` |
| `DATABASE_URL is missing` | Edit `.env.local` and add your Neon.tech connection string |
