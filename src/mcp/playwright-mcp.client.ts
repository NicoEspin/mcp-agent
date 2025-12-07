// playwright-mcp.client.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

export async function createPlaywrightMcpClient() {
  const client = new Client({ name: "andeshire-linkedin", version: "0.1.0" });

  const base = "http://localhost:8931";

  let TransportCtor: any;
  let url: URL;

  // Preferir Streamable HTTP (endpoint /mcp)
  try {
    const mod = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    TransportCtor = mod.StreamableHTTPClientTransport;
    url = new URL(`${base}/mcp`);
  } catch {
    // Fallback SSE (endpoint /sse)
    const mod = await import("@modelcontextprotocol/sdk/client/sse.js");
    TransportCtor = mod.SSEClientTransport;
    url = new URL(`${base}/sse`);
  }

  const transport = new TransportCtor(url);
  await client.connect(transport);

  return client;
}
