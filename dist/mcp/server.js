import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { existsSync } from "fs";
import { openDatabase, upsertFact, deleteFact, getFact, getAllFacts, getDirtyFacts, getPendingDeletes, clearDirtyState, getMeta, setMeta, incrementAccessCount, } from "../core/db.js";
import { recallContext, formatContext } from "../core/engine.js";
import { createChunkedShards, serializeShard, factToUpsertOp } from "../core/shard.js";
import { encrypt } from "../core/crypto.js";
import { pushShard, pushConversationDelta, pullConversations } from "../core/sync.js";
import { publicKeyFromPrivate, addressFromPublicKey, } from "../core/identity.js";
import { TurboBackend } from "../core/backends/turbo.js";
import { loadKey, loadIdentityPrivateKey, getDbPath, getIdentityPath } from "../cli/init.js";
import { keychainLoad } from "../core/keychain.js";
import { ConversationWatcher } from "../core/watcher.js";
const SYNC_INTERVAL_MS = 60_000; // 1 minute
let db;
/**
 * Start the Sharme MCP server.
 * Communicates over stdio. Cursor spawns this as a child process.
 */
export async function startMcpServer() {
    // Load passphrase from keychain (required for MCP background mode).
    const keychainPassphrase = keychainLoad();
    const passphrase = keychainPassphrase ?? null;
    if (!passphrase) {
        process.stderr.write("Sharme: no passphrase found in system keychain. Run `sharme init` first.\n");
        process.exit(1);
    }
    process.stderr.write("Sharme: passphrase loaded from system keychain\n");
    const dbPath = getDbPath();
    db = openDatabase(dbPath);
    // Detect current project scope from working directory
    const cwd = process.cwd();
    const projectName = cwd.split("/").pop() ?? "unknown";
    const defaultScope = `project:${projectName}`;
    const server = new McpServer({
        name: "sharme",
        version: "0.1.1",
    });
    // ── store_fact ────────────────────────────────────────
    server.tool("store_fact", "Store an important fact for long-term memory. Call this when the user expresses a preference, makes a project decision, shares architectural context, or provides information that should be remembered across sessions.", {
        key: z
            .string()
            .describe("Unique identifier for the fact, using colons as separators. Examples: 'auth:strategy', 'database:orm', 'coding_style'"),
        value: z
            .string()
            .describe("The fact content. Be concise but complete. Include the reasoning behind decisions."),
        tags: z
            .array(z.string())
            .describe("Tags describing the topic. Examples: ['auth', 'jwt', 'decision'], ['preference', 'code-style']"),
        scope: z
            .string()
            .optional()
            .describe("Scope: 'global' for facts useful everywhere (preferences, general knowledge). Use 'project:<name>' only for facts specific to the current project (tech stack, architecture decisions). Defaults to global."),
    }, async ({ key, value, tags, scope }) => {
        const factScope = scope ?? "global";
        // Prefix key with scope if not already namespaced
        const fullKey = key.startsWith("global:") || key.startsWith("project:")
            ? key
            : `${factScope}:${key}`;
        const now = new Date().toISOString();
        const fact = {
            id: uuidv4(),
            scope: factScope,
            key: fullKey,
            value,
            tags,
            confidence: 1.0,
            source_session: null,
            created: now,
            last_confirmed: now,
            access_count: 0,
        };
        upsertFact(db, fact);
        return {
            content: [
                {
                    type: "text",
                    text: `Stored: ${fullKey}`,
                },
            ],
        };
    });
    // ── recall_context ────────────────────────────────────
    server.tool("recall_context", "Recall relevant facts from long-term memory. Call this at the start of a conversation or when you need context about a topic. Returns facts ranked by relevance.", {
        topic: z
            .string()
            .describe("What to recall. Use keywords: 'database auth', 'project architecture', 'coding preferences'"),
        scope: z
            .string()
            .optional()
            .describe("Scope to search. Defaults to current project + global."),
    }, async ({ topic, scope }) => {
        const searchScope = scope ?? defaultScope;
        const allFacts = getAllFacts(db);
        const results = recallContext(topic, searchScope, allFacts);
        // Increment access counts
        for (const fact of results) {
            incrementAccessCount(db, fact.key);
        }
        if (results.length === 0) {
            return {
                content: [
                    { type: "text", text: "No matching facts in memory." },
                ],
            };
        }
        return {
            content: [
                {
                    type: "text",
                    text: formatContext(results),
                },
            ],
        };
    });
    // ── delete_fact ───────────────────────────────────────
    server.tool("delete_fact", "Delete a fact from memory. Use when information is no longer accurate or relevant.", {
        key: z.string().describe("The fact key to delete."),
    }, async ({ key }) => {
        const existing = getFact(db, key);
        if (!existing) {
            return {
                content: [
                    {
                        type: "text",
                        text: `No fact found with key: ${key}`,
                    },
                ],
            };
        }
        deleteFact(db, key);
        return {
            content: [
                { type: "text", text: `Deleted: ${key}` },
            ],
        };
    });
    // ── recall_conversation ─────────────────────────────
    server.tool("recall_conversation", "Retrieve a previous conversation from another AI client (Cursor, Claude Code). Use this when the user says 'continue the conversation about X' or 'what did we discuss about Y'. Sharme watches local conversation files and syncs them to Arweave.", {
        topic: z
            .string()
            .describe("What the conversation was about. Keywords like 'keyboard layout', 'auth setup', 'database migration'."),
        client: z
            .enum(["cursor", "claude-code", "any"])
            .optional()
            .describe("Which client the conversation was in. Defaults to 'any'."),
        project: z
            .string()
            .optional()
            .describe("Project name to filter by."),
    }, async ({ topic, client, project }) => {
        const conversations = [];
        const encryptionKey = loadKey(passphrase);
        // Pull historical conversations from Arweave first.
        if (existsSync(getIdentityPath())) {
            try {
                const identityKey = loadIdentityPrivateKey(encryptionKey);
                const pubKey = publicKeyFromPrivate(identityKey);
                const walletAddress = addressFromPublicKey(pubKey);
                const remote = await pullConversations(walletAddress, encryptionKey);
                for (const conv of remote) {
                    conversations.push({
                        id: conv.id,
                        client: conv.client,
                        project: conv.project,
                        messages: conv.messages,
                        startedAt: conv.startedAt,
                        updatedAt: conv.updatedAt,
                    });
                }
            }
            catch {
                // If remote pull fails, continue with local fallback.
            }
        }
        // Local fallback: parse conversation files directly.
        const watcher = new ConversationWatcher(() => { }, 999999);
        const local = watcher.discoverAllConversationFiles();
        const { readFileSync } = await import("fs");
        const { parseCursorTranscript } = await import("../core/parsers/cursor.js");
        const { parseClaudeCodeJSONL } = await import("../core/parsers/claude-code.js");
        for (const f of local) {
            if (client && client !== "any" && client !== f.client)
                continue;
            if (project && f.project !== project)
                continue;
            try {
                const text = readFileSync(f.path, "utf-8");
                if (f.client === "cursor") {
                    conversations.push(parseCursorTranscript(text, f.fileId, f.project));
                }
                else {
                    conversations.push(parseClaudeCodeJSONL(text, f.fileId, f.project));
                }
            }
            catch {
                // Skip unreadable local files.
            }
        }
        if (conversations.length === 0) {
            return {
                content: [{ type: "text", text: "No conversations found." }],
            };
        }
        // Simple keyword search across conversations
        const keywords = topic.toLowerCase().split(/\s+/);
        const scored = conversations.map((conv) => {
            const allText = conv.messages.map((m) => m.content).join(" ").toLowerCase();
            const score = keywords.reduce((s, kw) => s + (allText.includes(kw) ? 1 : 0), 0);
            return { conv, score };
        });
        scored.sort((a, b) => b.score - a.score);
        const best = scored[0];
        if (best.score === 0) {
            return {
                content: [{ type: "text", text: `No conversations matching "${topic}" found.` }],
            };
        }
        // Budget-based truncation: ~19,200 tokens ≈ 77,000 chars (default model budget)
        const CHARS_PER_TOKEN = 4;
        const TOKEN_BUDGET = 128_000 * 0.15; // 19,200 tokens
        const charBudget = TOKEN_BUDGET * CHARS_PER_TOKEN; // ~77,000 chars
        // Fill from the end, most recent messages first
        const msgs = [];
        let totalChars = 0;
        for (let i = best.conv.messages.length - 1; i >= 0; i--) {
            const msg = best.conv.messages[i];
            const msgChars = msg.content.length + msg.role.length + 10; // overhead for formatting
            if (totalChars + msgChars > charBudget)
                break;
            msgs.unshift(msg);
            totalChars += msgChars;
        }
        const formatted = msgs.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");
        const header = `[CONVERSATION from ${best.conv.client}, project: ${best.conv.project}, ${best.conv.messages.length} total messages, showing last ${msgs.length}]`;
        return {
            content: [{ type: "text", text: `${header}\n\n${formatted}` }],
        };
    });
    // ── Background sync to Arweave ──────────────────────
    let syncTimer = null;
    try {
        const encryptionKey = loadKey(passphrase);
        if (existsSync(getIdentityPath())) {
            const identityKey = loadIdentityPrivateKey(encryptionKey);
            const pubKey = publicKeyFromPrivate(identityKey);
            const walletAddress = addressFromPublicKey(pubKey);
            const useTestnet = process.env.SHARME_TESTNET === "true";
            const backend = new TurboBackend({
                privateKeyHex: Buffer.from(identityKey).toString("hex"),
                testnet: useTestnet,
            });
            syncTimer = setInterval(() => {
                syncDirtyFacts(db, encryptionKey, identityKey, walletAddress, backend);
            }, SYNC_INTERVAL_MS);
            // Start conversation watcher (polls every 30s)
            const watcher = new ConversationWatcher(async (conversation) => {
                try {
                    const stateKey = `conversation_offset:${conversation.client}:${conversation.id}`;
                    const lastSyncedRaw = getMeta(db, stateKey);
                    const lastSynced = Number.parseInt(lastSyncedRaw ?? "0", 10);
                    const txIds = await pushConversationDelta(conversation, encryptionKey, walletAddress, identityKey, backend, Number.isFinite(lastSynced) ? lastSynced : 0);
                    if (txIds.length === 0)
                        return;
                    setMeta(db, stateKey, String(conversation.messages.length));
                    process.stderr.write(`Sharme: conversation synced [${conversation.client}/${conversation.project}] ${txIds.length} chunk(s), cursor=${conversation.messages.length}\n`);
                }
                catch (err) {
                    process.stderr.write(`Sharme: conversation sync failed: ${err instanceof Error ? err.message : String(err)}\n`);
                }
            }, 30_000);
            watcher.start();
            process.stderr.write(`Sharme: auto-sync every ${SYNC_INTERVAL_MS / 1000}s → Arweave (${useTestnet ? "testnet" : "mainnet"})\n`);
            process.stderr.write("Sharme: conversation watcher active (Cursor + Claude Code)\n");
        }
        else {
            process.stderr.write("Sharme: no identity found, auto-sync disabled. Run `sharme init` first.\n");
        }
    }
    catch (err) {
        process.stderr.write(`Sharme: auto-sync disabled (${err instanceof Error ? err.message : "key error"}). Facts are stored locally only.\n`);
    }
    // ── Connect stdio transport ───────────────────────────
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Clean up on exit
    function shutdown() {
        if (syncTimer)
            clearInterval(syncTimer);
        db.close();
        process.exit(0);
    }
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}
/**
 * Check for dirty facts and push them to Arweave as a delta shard.
 * Runs on a timer. No-op if nothing changed.
 */
async function syncDirtyFacts(db, encryptionKey, identityKey, walletAddress, backend) {
    try {
        const dirtyFacts = getDirtyFacts(db);
        const pendingDeletes = getPendingDeletes(db);
        if (dirtyFacts.length === 0 && pendingDeletes.length === 0)
            return;
        const operations = [
            ...dirtyFacts.map(factToUpsertOp),
            ...pendingDeletes.map((key) => ({ op: "delete", key })),
        ];
        const currentVersion = parseInt(getMeta(db, "current_version") ?? "0", 10);
        const startVersion = currentVersion + 1;
        const shards = createChunkedShards(operations, startVersion, uuidv4());
        let lastVersion = currentVersion;
        for (const shard of shards) {
            const serialized = serializeShard(shard);
            const encrypted = encrypt(serialized, encryptionKey);
            const txId = await pushShard(encrypted, shard.shard_version, "delta", walletAddress, identityKey, backend);
            lastVersion = shard.shard_version;
            process.stderr.write(`Sharme: synced v${shard.shard_version} (${operations.length} ops, ${encrypted.length}B) → ${txId}\n`);
        }
        clearDirtyState(db);
        setMeta(db, "current_version", String(lastVersion));
        setMeta(db, "last_pushed_version", String(lastVersion));
    }
    catch (err) {
        process.stderr.write(`Sharme: sync failed, will retry: ${err instanceof Error ? err.message : String(err)}\n`);
    }
}
//# sourceMappingURL=server.js.map