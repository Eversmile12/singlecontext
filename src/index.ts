#!/usr/bin/env node

import { Command } from "commander";
import { initCommand, initExistingCommand } from "./cli/init.js";
import { deleteCommand } from "./cli/delete.js";
import { inspectCommand } from "./cli/inspect.js";
import { identityCommand } from "./cli/identity.js";
import { setupCommand } from "./cli/setup.js";
import { startMcpServer } from "./mcp/server.js";
import { listConversationsCommand, listContextCommand } from "./cli/list.js";
import { shareCommand } from "./cli/share.js";
import { syncCommand } from "./cli/sync.js";

const program = new Command();

program
  .name("sharme")
  .description("Sovereign, portable LLM context layer")
  .version("0.1.1");

program
  .command("init")
  .description("Initialize Sharme with a new 12-word recovery phrase")
  .option("--existing", "Restore from an existing recovery phrase")
  .action(async (options) => {
    if (options.existing) {
      await initExistingCommand();
    } else {
      await initCommand();
    }
  });

program
  .command("delete")
  .description("Delete a fact by key")
  .requiredOption("-k, --key <key>", "Fact key to delete")
  .action((options) => {
    deleteCommand(options);
  });

program
  .command("inspect")
  .description("List all stored facts")
  .option("-s, --scope <scope>", "Filter by scope")
  .action((options) => {
    inspectCommand(options);
  });

program
  .command("identity")
  .description("Show wallet address, balance, and sync status")
  .option("--testnet", "Check balance on testnet")
  .action(async (options) => {
    await identityCommand({ testnet: options.testnet });
  });

program
  .command("serve")
  .description("Start the MCP server (used by Cursor, Claude, and Codex)")
  .action(async () => {
    await startMcpServer();
  });

program
  .command("setup")
  .description("Configure MCP client settings for Cursor, Claude Desktop/CLI, or Codex")
  .option("--cursor", "Write/update Cursor MCP config")
  .option("--claude", "Write/update Claude Desktop MCP config")
  .option("--claude-cli", "Write/update Claude CLI MCP config (~/.claude.json)")
  .option("--codex", "Write/update Codex MCP config")
  .action((options) => {
    setupCommand(options);
  });

const list = program
  .command("list")
  .description("List conversations and context available for sharing");

list
  .command("conversations")
  .description("List discovered conversations (local + remote)")
  .option("--client <client>", "Filter by client: cursor | claude-code | any", "any")
  .option("--project <project>", "Filter by project name")
  .option("--limit <n>", "Maximum rows to show", "30")
  .option("--local-only", "Only list local conversations, skip remote pull")
  .action(async (options) => {
    await listConversationsCommand(options);
  });

list
  .command("context")
  .description("List stored context facts")
  .option("-s, --scope <scope>", "Filter by scope")
  .action((options) => {
    listContextCommand(options);
  });

program
  .command("share <conversationId>")
  .description("Create a share URL/token for a conversation")
  .option("--client <client>", "Disambiguate duplicate IDs: cursor | claude-code")
  .option("--verbose", "Show debug details (share ID, tx ID, token)")
  .action(async (conversationId, options) => {
    await shareCommand(conversationId, options);
  });

program
  .command("sync <urlOrToken>")
  .description("Import a shared conversation from URL/token")
  .action(async (urlOrToken) => {
    await syncCommand(urlOrToken);
  });

program.parse();
