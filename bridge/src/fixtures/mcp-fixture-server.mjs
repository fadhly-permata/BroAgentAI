// Fixture MCP server for tests and e2e. Not shipped with the bridge.
//   node mcp-fixture-server.mjs                -> stdio transport
//   node mcp-fixture-server.mjs --http <port>  -> Streamable HTTP on 127.0.0.1:<port>/mcp
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const text = (value) => ({ content: [{ type: "text", text: value }] });
const noArgs = { type: "object", properties: {} };

const TOOLS = [
  {
    name: "echo",
    description: "Return the given text.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    annotations: { readOnlyHint: true },
    run: (args) => text(`echo: ${args.text}`),
  },
  {
    name: "env_value",
    description: "Return FIXTURE_VALUE from the server environment.",
    inputSchema: noArgs,
    annotations: { readOnlyHint: true },
    run: () => text(`value: ${process.env.FIXTURE_VALUE ?? "(unset)"}`),
  },
  { name: "write_note", description: "Pretend to write a note.", inputSchema: noArgs, run: () => text("note written") },
  {
    name: "wipe",
    description: "Pretend to delete everything.",
    inputSchema: noArgs,
    annotations: { destructiveHint: true },
    run: () => text("wiped"),
  },
  {
    name: "slow",
    description: "Answer after 5 seconds.",
    inputSchema: noArgs,
    annotations: { readOnlyHint: true },
    run: () => new Promise((resolve) => setTimeout(() => resolve(text("finally")), 5000)),
  },
  {
    name: "big",
    description: "Return 1 MB of text.",
    inputSchema: noArgs,
    annotations: { readOnlyHint: true },
    run: () => text("x".repeat(1024 * 1024)),
  },
  {
    name: "fail",
    description: "Always fails.",
    inputSchema: noArgs,
    annotations: { readOnlyHint: true },
    run: () => { throw new Error("fixture failure"); },
  },
];

function buildServer() {
  const server = new Server({ name: "broagentai-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ run, ...tool }) => tool),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS.find((t) => t.name === request.params.name);
    if (!tool) return { isError: true, ...text(`unknown tool: ${request.params.name}`) };
    return tool.run(request.params.arguments ?? {});
  });
  return server;
}

const httpIndex = process.argv.indexOf("--http");
if (httpIndex === -1) {
  process.stderr.write("fixture server starting on stdio\n");
  await buildServer().connect(new StdioServerTransport());
} else {
  const port = Number(process.argv[httpIndex + 1]);
  const requiredAuth = process.env.FIXTURE_REQUIRE_AUTH; // e.g. "Bearer secret"
  const http = createServer(async (req, res) => {
    if (!req.url?.startsWith("/mcp")) { res.writeHead(404).end(); return; }
    if (requiredAuth && req.headers.authorization !== requiredAuth) { res.writeHead(401).end("unauthorized"); return; }
    // Stateless mode: a fresh server + transport per request.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); });
    let body = "";
    for await (const chunk of req) body += chunk;
    await buildServer().connect(transport);
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  });
  http.listen(port, "127.0.0.1", () => process.stdout.write(`listening ${port}\n`));
}
