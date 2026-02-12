# Sharme: Sovereign Portable LLM Context

## Quick Start (3 Minutes)

1. Initialize identity and local storage:

```bash
sharme init
```

2. Start background sync + MCP tools:

```bash
sharme serve
```

3. Use MCP memory tools while `sharme serve` is running:

```bash
sharme serve
```

4. On a new machine:

```bash
sharme init --existing
```

Enter your 12-word phrase to restore state from Arweave.

## Why This Exists

LLM conversations are stateless by default. Project decisions, preferences, and technical context are easy to lose across sessions, machines, and tools.

Sharme exists to make that context:

- durable across time
- portable across devices
- usable from MCP-capable clients
- encrypted at rest and before network upload

The goal is practical developer memory ownership: your context remains yours, not tied to one chat thread or one machine.

## What Sharme Is (Current Implementation)

Sharme is a TypeScript CLI + MCP server with:

- local structured-memory cache in SQLite
- encrypted shard uploads to Arweave (via Turbo backend)
- deterministic wallet identity derived from a recovery phrase
- MCP tools for storing and recalling facts
- conversation synchronization from local Cursor / Claude Code transcript files

Primary source code lives under `src/`:

- `src/core/` - data model, crypto, identity, storage/sync, parsers
- `src/cli/` - command-line workflows
- `src/mcp/server.ts` - stdio MCP server and tools

## Core Values in Practice

- **Sovereignty:** data is encrypted locally before upload.
- **Portability:** restore on another machine from wallet + phrase.
- **Pragmatism:** local SQLite provides fast reads; Arweave provides durable remote copy.
- **Interoperability:** MCP tools let clients recall/store memory during normal workflows.

## Architecture

1. Facts are stored in local SQLite (`facts`, `pending_deletes`, `meta`).
2. Dirty changes are transformed into delta shard operations.
3. Shards are serialized, encrypted (AES-GCM), signed (secp256k1), and uploaded.
4. Arweave tags are used as index metadata (wallet, type, version, etc.).
5. New device restores by querying tags, downloading blobs, verifying signatures, decrypting, and replaying.

## Data Model

### Facts

Each fact includes:

- `scope` (`global` or `project:<name>`)
- `key`, `value`, `tags`
- timestamps (`created`, `last_confirmed`)
- `access_count`, confidence metadata

### Shards

Shards are append-only events:

- `upsert` operations
- `delete` operations
- replay order defines current state

Encrypted shard chunk target is `90 KiB` max at creation, with pull guardrails enforcing a `100 KiB` download cap for data shards.

### Conversation Segments

Conversation sync uploads delta segments with tags:

- `Type=conversation`
- `Client`, `Project`, `Session`
- `Offset`, `Count`
- `Chunk` (`n/total`)
- `Signature`

Only newly appended messages are uploaded on each sync run.

## Identity and Recovery Phrase

Sharme currently uses a 12-word phrase format:

- BIP39 English word list
- 128-bit entropy + checksum validation
- deterministic secp256k1 identity derivation from phrase text

Checksum validation detects many input typos during restore.

## How Saving Works

Sharme has two save pipelines: one for structured facts and one for conversation history.

### Structured Fact Save Pipeline (Step by Step)

1. A fact is created through MCP tool `store_fact(...)`.
2. The fact is written to SQLite (`facts` table) with `dirty=1`.
3. MCP auto-sync loop (every 60 seconds while `sharme serve` runs) reads:
   - dirty facts (`getDirtyFacts`)
   - pending deletes (`getPendingDeletes`)
4. Those changes are converted to shard operations:
   - `upsert` for modified/new facts
   - `delete` for removed facts
5. Operations are chunked into shard-sized groups (`createChunkedShards`) so encrypted payloads stay under free-tier limits.
6. Each shard is serialized to JSON bytes.
7. Shard bytes are encrypted locally (AES-256-GCM).
8. Encrypted blob is signed with the wallet private key (secp256k1 signature in tags).
9. Blob is uploaded through Turbo backend with tags such as:
   - `App-Name=sharme`
   - `Wallet=<address>`
   - `Type=delta`
   - `Version=<n>`
   - `Signature=<sig>`
10. On success, local dirty state is cleared and local versions are advanced in SQLite `meta`.

### Conversation Save Pipeline (Step by Step)

1. `ConversationWatcher` polls local transcript files every 30 seconds:
   - `~/.cursor/projects/*/agent-transcripts/*.txt`
   - `~/.claude/projects/*/*.jsonl`
2. Changed files are parsed into normalized `Conversation` objects.
3. For each session, Sharme reads last synced cursor from SQLite meta:
   - key format: `conversation_offset:<client>:<session>`
4. It slices only new messages after that offset.
5. If there are no new messages, nothing is uploaded.
6. If there are new messages:
   - segment payload is encrypted
   - payload is chunked to fit `MAX_SHARD_BYTES`
   - each chunk is signed and uploaded with conversation tags:
     - `Type=conversation`
     - `Client`, `Project`, `Session`
     - `Offset`, `Count`, `Chunk`, `Signature`
7. After successful upload, the cursor in SQLite meta is updated to total message count.

### Why This Save Design Is Fast

- Reads are local-first (SQLite), so normal recall avoids network latency.
- Writes are append-only deltas, so sync sends only changed data.
- Conversation sync is incremental (offset-based), not full-history re-upload.

## How Retrieval Works

### Fact Retrieval (`recall_context`)

When `recall_context(topic, scope?)` is called:

1. Sharme loads facts from local SQLite.
2. Scope filter keeps:
   - `global`
   - plus selected project scope (current project by default in MCP and CLI)
3. Topic keywords are extracted and used to score facts by:
   - tag match
   - key match
   - recency
   - access frequency
4. Facts are sorted by score.
5. Result is trimmed to model context budget.
6. Access count is incremented for returned facts.
7. Facts are formatted into the lean `[MEMORY] ... [/MEMORY]` block returned to client.

### Full Restore on New Device (`init --existing` or `pull`)

When reconstructing from Arweave:

1. Query identity transaction(s) by wallet tags.
2. Pick newest valid identity tx and read:
   - `Salt` tag
   - encrypted identity payload
3. Derive encryption key from entered passphrase + salt.
4. Validate passphrase by decrypting identity payload.
5. Query all shard txs by wallet tags (cursor-paginated).
6. Filter to `delta` / `snapshot` data shards.
7. Download each candidate shard with pull-time size cap.
8. Verify shard signature before decryption.
9. Decrypt valid shards and deserialize JSON.
10. Replay shards by version to reconstruct final fact state.
11. Write reconstructed facts to local SQLite.
12. Persist local metadata and identity material (`salt`, `identity.enc`) for normal runtime.

If a shard is malformed, oversized, unsigned, or has invalid signature, it is skipped.

### Conversation Retrieval (`recall_conversation`)

When `recall_conversation(topic, client?, project?)` runs:

1. Try remote history first:
   - query Arweave conversation chunks by wallet
   - group chunks by session+offset+timestamp
   - verify signatures
   - decrypt and parse segment payloads
   - merge segments in offset order
2. Add local fallback conversations by re-parsing transcript files.
3. Apply optional filters (`client`, `project`).
4. Score conversations by keyword presence in message text.
5. Select top match.
6. Truncate to response budget (fills from most recent messages backward).
7. Return formatted conversation block.

## Multi-Device Flow

### First Device

1. `sharme init`
2. store facts and/or run MCP server
3. keep `sharme serve` running to auto-sync

### New Device (preferred)

1. `sharme init --existing`
2. enter 12-word phrase
3. Sharme reconstructs SQLite from Arweave and persists local identity material (`salt`, `identity.enc`)
4. run `sharme serve`

## Security Model (Implemented)

- **Encryption:** AES-256-GCM (`nonce + ciphertext + tag`)
- **Key derivation:** Argon2id from phrase + salt
- **Signing:** shard/conversation blobs signed via secp256k1
- **Verification on pull:** invalid/missing signatures are rejected
- **Tamper handling:** malformed or invalid blobs are skipped during pull
- **Key storage:** passphrase is loaded from OS keychain for MCP background mode

## Arweave Access and Reliability

Sharme now supports multi-gateway failover:

- GraphQL endpoints default:
  - `https://arweave.net/graphql`
  - `https://g8way.io/graphql`
- Data endpoints default:
  - `https://arweave.net`
  - `https://g8way.io`

Custom gateway lists can be set via:

- `SHARME_ARWEAVE_GQLS`
- `SHARME_ARWEAVE_DATAS`

`queryShards` and `queryConversationChunks` are cursor-paginated (not capped at one 1000-item page).

## Example Workflows

### Save + Auto-Sync Example (Facts)

1. Start server:

```bash
sharme serve
```

2. During work, store facts via MCP tool calls.
3. Within the next sync tick (60s), dirty facts are encrypted and pushed automatically.

### Save + Auto-Sync Example (Conversations)

1. Keep `sharme serve` running.
2. Continue chatting in Cursor or Claude Code.
3. Every 30s, watcher detects transcript file changes.
4. Only new messages are uploaded as signed encrypted segments.

### Recall current project context

Use the MCP tool `recall_context(topic, scope?)`. Without `scope`, it defaults to current project scope + global facts.

### New Device Restore Example

```bash
sharme init --existing
```

Then enter your 12-word phrase. Sharme restores local state from Arweave and writes local identity artifacts so `sharme serve` can run normally.

## Current Scope and Limitations

- This is a developer-focused system, not end-user consumer UX.
- Conflict resolution is replay/order based; no advanced merge semantics.
- Recall ranking is heuristic (keyword/tag based), not semantic embedding search.
- Conversation retrieval quality depends on local transcript format stability and available synced segments.

## Summary

Sharme currently provides an operational path for encrypted developer memory portability:

- capture context locally
- sync encrypted deltas to Arweave
- restore and recall across devices
- integrate into MCP-capable workflows

It is usable today for personal/project memory continuity and is structured to evolve further without changing its core ownership model.
