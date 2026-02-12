import { existsSync, readFileSync } from "fs";
import { ConversationWatcher } from "../core/watcher.js";
import { parseCursorTranscript } from "../core/parsers/cursor.js";
import { parseClaudeCodeJSONL } from "../core/parsers/claude-code.js";
import { pullConversations } from "../core/sync.js";
import { keychainLoad } from "../core/keychain.js";
import { loadKey, loadIdentityPrivateKey, getDbPath, getIdentityPath } from "./init.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../core/identity.js";
import {
  getAllFacts,
  getFactsByScope,
  getSharedConversationImports,
  openDatabase,
} from "../core/db.js";
import type { Conversation } from "../types.js";

interface ListConversationsOptions {
  client?: "cursor" | "claude-code" | "any";
  project?: string;
  limit?: string;
  localOnly?: boolean;
}

interface ListContextOptions {
  scope?: string;
}

export type ConversationSource = "local" | "remote" | "both" | "shared";

export interface DiscoveredConversation extends Conversation {
  source: ConversationSource;
}

export async function listConversationsCommand(
  options: ListConversationsOptions
): Promise<void> {
  const allConversations = await discoverConversations({ localOnly: options.localOnly });

  const clientFilter = options.client ?? "any";
  const projectFilter = options.project?.trim().toLowerCase();
  const requestedLimit = Number.parseInt(options.limit ?? "30", 10);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 30;

  const items = allConversations
    .filter((conversation) => {
      if (clientFilter !== "any" && conversation.client !== clientFilter) return false;
      if (projectFilter && conversation.project.toLowerCase() !== projectFilter) return false;
      return true;
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);

  if (items.length === 0) {
    console.log("No conversations found.");
    return;
  }

  console.log(
    "Conversations (use the ID with future share commands):\n"
  );
  for (const conversation of items) {
    const preview = getPreview(conversation);
    console.log(`- ID:      ${conversation.id}`);
    console.log(`  Client:  ${conversation.client}`);
    console.log(`  Project: ${conversation.project}`);
    console.log(`  Updated: ${conversation.updatedAt}`);
    console.log(`  Msgs:    ${conversation.messages.length}`);
    console.log(`  Source:  ${conversation.source}`);
    if (preview) console.log(`  Preview: ${preview}`);
    console.log();
  }
}

export function listContextCommand(options: ListContextOptions): void {
  const dbPath = getDbPath();
  if (!existsSync(dbPath)) {
    console.error("Sharme not initialized. Run `sharme init` first.");
    process.exit(1);
  }

  const db = openDatabase(dbPath);
  const facts = options.scope ? getFactsByScope(db, options.scope) : getAllFacts(db);
  db.close();

  if (facts.length === 0) {
    console.log("No context facts found.");
    return;
  }

  console.log("Context facts:\n");
  for (const fact of facts) {
    console.log(`- ${fact.key}`);
    console.log(`  Scope:   ${fact.scope}`);
    console.log(`  Updated: ${fact.last_confirmed}`);
    console.log(`  Tags:    ${fact.tags.join(", ")}`);
    console.log();
  }
}

export async function discoverConversations(options?: {
  localOnly?: boolean;
}): Promise<DiscoveredConversation[]> {
  const local = loadLocalConversations();
  const remote = options?.localOnly ? [] : await loadRemoteConversations();
  const shared = loadSharedConversations();

  const combined = new Map<string, DiscoveredConversation>();

  for (const conversation of local) {
    const key = `${conversation.client}:${conversation.id}`;
    combined.set(key, { ...conversation, source: "local" });
  }

  for (const conversation of remote) {
    const key = `${conversation.client}:${conversation.id}`;
    const existing = combined.get(key);
    if (!existing) {
      combined.set(key, { ...conversation, source: "remote" });
      continue;
    }

    const existingUpdated = Date.parse(existing.updatedAt);
    const incomingUpdated = Date.parse(conversation.updatedAt);
    const keepIncoming =
      Number.isFinite(incomingUpdated) &&
      (!Number.isFinite(existingUpdated) || incomingUpdated > existingUpdated);

    const merged = keepIncoming ? { ...conversation, source: "both" as const } : existing;
    merged.source = "both";
    combined.set(key, merged);
  }

  for (const conversation of shared) {
    const key = `${conversation.client}:${conversation.id}`;
    if (!combined.has(key)) {
      combined.set(key, conversation);
    }
  }

  return Array.from(combined.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function loadLocalConversations(): Conversation[] {
  const watcher = new ConversationWatcher(() => {}, 999999);
  const files = watcher.discoverAllConversationFiles();
  const conversations: Conversation[] = [];

  for (const file of files) {
    try {
      const text = readFileSync(file.path, "utf-8");
      const conversation =
        file.client === "cursor"
          ? parseCursorTranscript(text, file.fileId, file.project)
          : parseClaudeCodeJSONL(text, file.fileId, file.project);
      if (conversation.messages.length > 0) {
        conversations.push(conversation);
      }
    } catch {
      // Skip unreadable files.
    }
  }

  return conversations;
}

async function loadRemoteConversations(): Promise<Conversation[]> {
  const passphrase = keychainLoad();
  if (!passphrase || !existsSync(getIdentityPath())) {
    return [];
  }

  try {
    const encryptionKey = loadKey(passphrase);
    const identityKey = loadIdentityPrivateKey(encryptionKey);
    const pubKey = publicKeyFromPrivate(identityKey);
    const walletAddress = addressFromPublicKey(pubKey);
    return await pullConversations(walletAddress, encryptionKey);
  } catch {
    return [];
  }
}

function loadSharedConversations(): DiscoveredConversation[] {
  const dbPath = getDbPath();
  if (!existsSync(dbPath)) {
    return [];
  }

  try {
    const db = openDatabase(dbPath);
    const imports = getSharedConversationImports(db);
    db.close();
    return imports.map((row) => ({ ...row.conversation, source: "shared" as const }));
  } catch {
    return [];
  }
}

function getPreview(conversation: Conversation): string {
  const firstUser = conversation.messages.find((m) => m.role === "user");
  const source = firstUser?.content ?? conversation.messages[0]?.content ?? "";
  const oneLine = source.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 100) return oneLine;
  return `${oneLine.slice(0, 97)}...`;
}
