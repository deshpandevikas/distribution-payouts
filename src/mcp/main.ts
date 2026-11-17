/**
 * stdio entry point: `npm run mcp:server`.
 *
 * Opens the same SQLite file the worker writes to and serves the four read-only
 * tools over stdio. It never writes: the store is only read, and the server
 * exposes no mutating tool.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SqliteStore } from "../store/sqliteStore.js";
import { createReadOnlyServer } from "./server.js";

const path = process.env.SQLITE_PATH ?? "payouts.db";
const store = new SqliteStore(path);
const server = createReadOnlyServer(store);

await server.connect(new StdioServerTransport());

// stdout belongs to the protocol; diagnostics go to stderr.
console.error(`read-only MCP server on stdio, reading ${path}`);
