import { existsSync } from "fs";
import { randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { TurboBackend } from "../core/backends/turbo.js";
import { encrypt } from "../core/crypto.js";
import { addressFromPublicKey, publicKeyFromPrivate, signShard } from "../core/identity.js";
import { getIdentityPath, loadIdentityPrivateKey, loadKey } from "./init.js";
import { keychainLoad } from "../core/keychain.js";
import { discoverConversations } from "./list.js";
import type { Conversation } from "../types.js";
import type { Tag } from "../core/storage.js";

const SHARE_URL_PREFIX = "sharme://share/";

export interface ShareCommandOptions {
  client?: "cursor" | "claude-code";
  verbose?: boolean;
}

interface ShareTokenV1 {
  v: 1;
  sid: string;
  k: string; // base64url-encoded 32-byte key
  t?: string; // optional Arweave tx id for index-free retrieval
}

export interface DecodedShareToken {
  shareId: string;
  key: Uint8Array;
  txId?: string;
}

export interface ConversationSharePayload {
  v: 1;
  createdAt: string;
  conversation: Conversation;
}

export async function shareCommand(
  conversationId: string,
  options: ShareCommandOptions = {}
): Promise<void> {
  const selected = await resolveConversation(conversationId, options.client);

  const passphrase = keychainLoad();
  if (!passphrase) {
    throw new Error(
      "No passphrase found in system keychain. Run `sharme init` again to store it."
    );
  }
  if (!existsSync(getIdentityPath())) {
    throw new Error("No local identity found. Run `sharme init` first.");
  }

  const encryptionKey = loadKey(passphrase);
  const identityKey = loadIdentityPrivateKey(encryptionKey);
  const shareKey = new Uint8Array(randomBytes(32));
  const shareId = uuidv4();

  const payload: ConversationSharePayload = {
    v: 1,
    createdAt: new Date().toISOString(),
    conversation: selected,
  };
  const serialized = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = encrypt(serialized, shareKey);

  const signature = signShard(encrypted, identityKey);
  const walletAddress = addressFromPublicKey(publicKeyFromPrivate(identityKey));
  const tags: Tag[] = [
    { name: "App-Name", value: "sharme" },
    { name: "Type", value: "conversation-share" },
    { name: "Share-Id", value: shareId },
    { name: "Wallet", value: walletAddress },
    { name: "Timestamp", value: String(Math.floor(Date.now() / 1000)) },
    { name: "Signature", value: signature },
    { name: "Content-Type", value: "application/octet-stream" },
  ];

  const backend = new TurboBackend({
    privateKeyHex: Buffer.from(identityKey).toString("hex"),
    testnet: process.env.SHARME_TESTNET === "true",
  });
  const result = await backend.upload(encrypted, tags);

  const token = encodeShareToken({
    v: 1,
    sid: shareId,
    k: Buffer.from(shareKey).toString("base64url"),
    t: result.txId,
  });
  const url = `${SHARE_URL_PREFIX}${token}`;

  console.log("Conversation shared.");
  console.log(`Link: ${url}`);
  console.log("\nImport on another device:");
  console.log(`sharme sync ${url}`);

  if (options.verbose) {
    console.log("\nDetails:");
    console.log(`  Conversation: ${selected.id} (${selected.client})`);
    console.log(`  Share ID:     ${shareId}`);
    console.log(`  Tx ID:        ${result.txId}`);
    console.log(`  Token:        ${token}`);
  }
}

export function encodeShareToken(token: ShareTokenV1): string {
  return Buffer.from(JSON.stringify(token), "utf-8").toString("base64url");
}

export function decodeShareToken(token: string): DecodedShareToken {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf-8")) as unknown;
  } catch {
    throw new Error("Invalid share token format.");
  }
  if (!isShareTokenV1(parsed)) {
    throw new Error("Invalid share token payload.");
  }

  const keyBytes = Buffer.from(parsed.k, "base64url");
  if (keyBytes.length !== 32) {
    throw new Error("Invalid share token key length.");
  }

  return {
    shareId: parsed.sid,
    key: new Uint8Array(keyBytes),
    txId: parsed.t,
  };
}

export function extractToken(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new Error("Missing share token.");
  }

  if (!trimmed.includes("://")) {
    return trimmed;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Invalid share URL.");
  }

  const fromQuery = url.searchParams.get("token");
  if (fromQuery) return fromQuery;

  const parts = url.pathname.split("/").filter(Boolean);
  const last = parts[parts.length - 1];
  if (last) return last;

  throw new Error("Could not extract token from URL.");
}

async function resolveConversation(
  conversationId: string,
  client?: "cursor" | "claude-code"
): Promise<Conversation> {
  const all = await discoverConversations();
  const byId = all.filter(
    (conversation) =>
      conversation.id === conversationId && (!client || conversation.client === client)
  );

  if (byId.length === 0) {
    throw new Error(
      "Conversation not found. Run `sharme list conversations` and use an existing ID."
    );
  }
  if (byId.length > 1 && !client) {
    throw new Error(
      "Multiple conversations found with that ID. Re-run with `--client cursor|claude-code`."
    );
  }
  return byId[0];
}

function isShareTokenV1(value: unknown): value is ShareTokenV1 {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === 1 &&
    typeof v.sid === "string" &&
    v.sid.length > 0 &&
    typeof v.k === "string" &&
    v.k.length > 0 &&
    (v.t === undefined || typeof v.t === "string")
  );
}
