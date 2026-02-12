import { existsSync } from "fs";
import { decrypt } from "../core/crypto.js";
import { downloadShard, queryConversationShare } from "../core/arweave.js";
import {
  hasSharedConversationImport,
  openDatabase,
  saveSharedConversationImport,
} from "../core/db.js";
import { verifySignature } from "../core/identity.js";
import { getDbPath } from "./init.js";
import {
  decodeShareToken,
  extractToken,
  type ConversationSharePayload,
} from "./share.js";
import type { Conversation } from "../types.js";

const MAX_SHARE_BYTES = 2 * 1024 * 1024;

export async function syncCommand(urlOrToken: string): Promise<void> {
  const dbPath = getDbPath();
  if (!existsSync(dbPath)) {
    console.error("Sharme not initialized. Run `sharme init` first.");
    process.exit(1);
  }

  const token = extractToken(urlOrToken);
  const decoded = decodeShareToken(token);
  let shareInfo = null as Awaited<ReturnType<typeof queryConversationShare>>;
  let txId = decoded.txId;
  let encrypted: Uint8Array | null = null;

  if (txId) {
    try {
      encrypted = await downloadShard(txId, MAX_SHARE_BYTES);
    } catch {
      // Fall back to Share-Id lookup for eventual consistency or stale tx references.
      encrypted = null;
    }
  }

  if (!encrypted) {
    shareInfo = await queryConversationShare(decoded.shareId);
    if (!shareInfo) {
      throw new Error(`No share found for id: ${decoded.shareId}`);
    }
    txId = shareInfo.txId;
    encrypted = await downloadShard(txId, MAX_SHARE_BYTES);
  }

  if (shareInfo?.signature && shareInfo.wallet) {
    const valid = verifySignature(encrypted, shareInfo.signature, shareInfo.wallet);
    if (!valid) {
      throw new Error("Share signature verification failed.");
    }
  }

  let payload: ConversationSharePayload;
  try {
    const decrypted = decrypt(encrypted, decoded.key);
    payload = JSON.parse(new TextDecoder().decode(decrypted)) as ConversationSharePayload;
  } catch {
    throw new Error("Could not decrypt shared payload. Token may be invalid.");
  }

  const conversation = validatePayload(payload);
  const db = openDatabase(dbPath);
  const alreadyImported = hasSharedConversationImport(db, decoded.shareId);
  if (alreadyImported) {
    db.close();
    console.log("Share already imported.");
    return;
  }

  saveSharedConversationImport(db, {
    shareId: decoded.shareId,
    txId: txId ?? "unknown",
    conversation,
  });
  db.close();

  console.log("Conversation imported.\n");
  console.log(`  Share ID:     ${decoded.shareId}`);
  console.log(`  Conversation: ${conversation.id} (${conversation.client})`);
  console.log(`  Project:      ${conversation.project}`);
  console.log(`  Messages:     ${conversation.messages.length}`);
}

function validatePayload(payload: ConversationSharePayload): Conversation {
  if (payload.v !== 1 || !payload.conversation) {
    throw new Error("Invalid share payload version.");
  }
  const conversation = payload.conversation;
  if (
    typeof conversation.id !== "string" ||
    (conversation.client !== "cursor" && conversation.client !== "claude-code") ||
    typeof conversation.project !== "string" ||
    !Array.isArray(conversation.messages) ||
    typeof conversation.startedAt !== "string" ||
    typeof conversation.updatedAt !== "string"
  ) {
    throw new Error("Invalid conversation payload.");
  }
  return conversation;
}
