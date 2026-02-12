import { mkdirSync, existsSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createInterface } from "readline";
import { deriveKey, generateSalt, encrypt, decrypt } from "../core/crypto.js";
import { openDatabase, setMeta } from "../core/db.js";
import { deriveKeypairFromPhrase } from "../core/identity.js";
import { keychainStore } from "../core/keychain.js";
import { autoSetupDetectedClients } from "./setup.js";
import {
  generatePhrase,
  validatePhrase,
  phraseToString,
  PHRASE_WORD_COUNT,
} from "../core/passphrase.js";
import { pullAndReconstruct } from "../core/sync.js";
import { fetchIdentity } from "../core/arweave.js";

const SHARME_DIR = process.env.SHARME_HOME || join(homedir(), ".sharme");
const DB_PATH = join(SHARME_DIR, "sharme.db");
const SALT_PATH = join(SHARME_DIR, "salt");
const IDENTITY_PATH = join(SHARME_DIR, "identity.enc");

/**
 * Prompt for a single line of input (works in both interactive and piped mode).
 */
function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Initialize a new Sharme instance.
 * Generates a 12-word recovery phrase and derives everything from it.
 */
export async function initCommand(): Promise<void> {
  if (existsSync(DB_PATH)) {
    console.log("Sharme is already initialized at ~/.sharme/");
    console.log("To reinitialize, delete ~/.sharme/ first.");
    return;
  }

  console.log("Initializing Sharme...\n");

  // Create directories
  mkdirSync(SHARME_DIR, { recursive: true });
  mkdirSync(join(SHARME_DIR, "shards"), { recursive: true });

  // Generate 12-word recovery phrase
  const words = generatePhrase();

  // Show phrase on alternate screen (like vim/less — vanishes when done)
  const half = PHRASE_WORD_COUNT / 2;
  const idx1 = Math.floor(Math.random() * half); // word 1..6
  const idx2 = half + Math.floor(Math.random() * half); // word 7..12

  // Enter alternate screen buffer
  process.stderr.write("\x1b[?1049h");
  // Move cursor to top and clear
  process.stderr.write("\x1b[H\x1b[2J");

  process.stderr.write("\n  RECOVERY PHRASE — write this down, then confirm below.\n");
  process.stderr.write("  This screen will disappear after confirmation.\n\n");
  process.stderr.write(`  ${words.map((w, i) => `${i + 1}.${w}`).join("  ")}\n\n`);

  const answer = await prompt(
    `  Type word ${idx1 + 1} and ${idx2 + 1} to confirm: `
  );

  // Leave alternate screen — phrase is gone from terminal
  process.stderr.write("\x1b[?1049l");

  const parts = answer.split(/\s+/);
  if (
    parts.length < 2 ||
    parts[0].toLowerCase() !== words[idx1].toLowerCase() ||
    parts[1].toLowerCase() !== words[idx2].toLowerCase()
  ) {
    console.error("Confirmation failed. Please run `sharme init` again.");
    process.exit(1);
  }

  const phrase = phraseToString(words);

  // Derive deterministic identity from phrase
  console.log("\nDeriving identity from recovery phrase...");
  const keypair = deriveKeypairFromPhrase(phrase);

  // Generate random salt for AES key derivation (stored locally + on Arweave)
  const salt = generateSalt();
  writeFileSync(SALT_PATH, Buffer.from(salt));

  console.log("Deriving encryption key (this takes a few seconds)...");
  const key = deriveKey(phrase, salt);
  console.log(`Key derived. ${key.length * 8}-bit AES key ready.`);

  // Encrypt the identity private key with the derived AES key
  const encryptedPrivateKey = encrypt(keypair.privateKey, key);
  writeFileSync(IDENTITY_PATH, encryptedPrivateKey);

  // Create database
  const db = openDatabase(DB_PATH);
  setMeta(db, "current_version", "0");
  setMeta(db, "created", new Date().toISOString());
  setMeta(db, "wallet_address", keypair.address);
  db.close();

  // Store phrase in OS keychain
  try {
    keychainStore(phrase);
    console.log("Recovery phrase stored in system keychain.");
  } catch (err) {
    console.warn(
      "Could not store in keychain:",
      err instanceof Error ? err.message : String(err)
    );
    console.warn("Without keychain storage, background MCP startup will fail.");
  }

  console.log("\nSharme initialized at ~/.sharme/");
  console.log("  Database: ~/.sharme/sharme.db");
  console.log("  Shards:   ~/.sharme/shards/");
  console.log("  Identity: ~/.sharme/identity.enc");
  console.log(`\n  Wallet:   ${keypair.address}`);
  printAutoSetupSummary();
  console.log("\nStart `sharme serve` and use MCP tools to store and recall facts.");
}

/**
 * Restore Sharme from an existing recovery phrase.
 * Derives the wallet, queries Arweave for shards, and reconstructs local state.
 */
export async function initExistingCommand(): Promise<void> {
  if (existsSync(DB_PATH)) {
    console.log("Sharme is already initialized at ~/.sharme/");
    console.log("To reinitialize, delete ~/.sharme/ first.");
    return;
  }

  console.log("Restore Sharme from recovery phrase.\n");

  const input = await prompt(`Enter your ${PHRASE_WORD_COUNT}-word recovery phrase: `);
  const words = input.split(/\s+/).map((w) => w.toLowerCase());

  const validation = validatePhrase(words);
  if (!validation.valid) {
    console.error(`Invalid phrase: ${validation.error}`);
    process.exit(1);
  }

  const phrase = phraseToString(words);

  // Derive deterministic identity from phrase
  console.log("Deriving identity...");
  const keypair = deriveKeypairFromPhrase(phrase);
  console.log(`Wallet: ${keypair.address}`);

  // Create directories
  mkdirSync(SHARME_DIR, { recursive: true });
  mkdirSync(join(SHARME_DIR, "shards"), { recursive: true });

  console.log("\nQuerying Arweave and reconstructing local state...");

  try {
    const result = await pullAndReconstruct(keypair.address, phrase, DB_PATH);

    // Persist identity material locally so normal CLI flows work after restore.
    const identity = await fetchIdentity(keypair.address);
    if (!identity) {
      throw new Error(
        "Recovery failed: identity transaction not found on Arweave."
      );
    }
    writeFileSync(SALT_PATH, Buffer.from(identity.salt));
    writeFileSync(IDENTITY_PATH, identity.encryptedPrivateKey);

    // Sanity check: recovered encrypted key must decrypt to phrase-derived identity key.
    const key = deriveKey(phrase, identity.salt);
    const recoveredPrivateKey = decrypt(identity.encryptedPrivateKey, key);
    if (Buffer.compare(Buffer.from(recoveredPrivateKey), Buffer.from(keypair.privateKey)) !== 0) {
      throw new Error(
        "Recovered identity does not match the provided recovery phrase."
      );
    }

    console.log(`Recovered ${result.factCount} fact(s), version ${result.version}.`);
  } catch (err) {
    const { rmSync } = await import("fs");
    rmSync(SHARME_DIR, { recursive: true, force: true });
    throw err;
  }

  // Store phrase in keychain
  try {
    keychainStore(phrase);
    console.log("Recovery phrase stored in system keychain.");
  } catch (err) {
    console.warn(
      "Could not store in keychain:",
      err instanceof Error ? err.message : String(err)
    );
  }

  console.log("\nSharme restored at ~/.sharme/");
  console.log(`  Wallet: ${keypair.address}`);
  printAutoSetupSummary();
}

/**
 * Load the encryption key from salt + passphrase.
 */
export function loadKey(passphrase: string): Uint8Array {
  if (!existsSync(SALT_PATH)) {
    console.error("Sharme not initialized. Run `sharme init` first.");
    process.exit(1);
  }
  const salt = new Uint8Array(readFileSync(SALT_PATH));
  return deriveKey(passphrase, salt);
}

/**
 * Load the identity private key (decrypts identity.enc with the derived key).
 */
export function loadIdentityPrivateKey(key: Uint8Array): Uint8Array {
  if (!existsSync(IDENTITY_PATH)) {
    console.error("No identity found. Run `sharme init` first.");
    process.exit(1);
  }
  const encrypted = new Uint8Array(readFileSync(IDENTITY_PATH));
  return decrypt(encrypted, key);
}

export function getSharmeDir(): string {
  return SHARME_DIR;
}

export function getDbPath(): string {
  return DB_PATH;
}

export function getShardsDir(): string {
  return join(SHARME_DIR, "shards");
}

export function getSaltPath(): string {
  return SALT_PATH;
}

export function getIdentityPath(): string {
  return IDENTITY_PATH;
}

function printAutoSetupSummary(): void {
  const result = autoSetupDetectedClients();

  if (result.detected.length === 0) {
    console.log("\nNo supported MCP client detected (Cursor, Claude Desktop/CLI, Codex).");
    console.log("Run `sharme setup --cursor|--claude|--claude-cli|--codex` after installing your client.");
    return;
  }

  if (result.configured.length > 0) {
    console.log(
      `\nMCP configured automatically for: ${result.configured.map(formatTarget).join(", ")}.`
    );
    console.log("Restart your client app so it reloads MCP configuration.");
  }

  for (const failure of result.failed) {
    console.warn(`Could not configure ${formatTarget(failure.target)}: ${failure.reason}`);
  }

  if (result.failed.length > 0) {
    const commands = result.failed.map((item) => `sharme setup --${item.target}`).join("  ");
    console.warn(`Run manually if needed: ${commands}`);
  }
}

function formatTarget(target: "cursor" | "claude" | "claude-cli" | "codex"): string {
  if (target === "cursor") return "Cursor";
  if (target === "claude") return "Claude";
  if (target === "claude-cli") return "Claude CLI";
  return "Codex";
}
