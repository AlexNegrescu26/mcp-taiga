/**
 * Streamable HTTP transport: serves the same MCP server at http://<host>:<port>/mcp
 * instead of stdio when TAIGA_HTTP_PORT is set.
 *
 * The v2 handler serves both the 2026-07-28 protocol and legacy clients statelessly.
 * Node host/origin validation stays in front of the handler for DNS-rebinding protection.
 */

import http from 'node:http';
import type { RequestListener, Server } from 'node:http';
import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  originValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { MAX_ATTACHMENT_BYTES } from './constants.js';

const MCP_PATH = '/mcp';

/**
 * Start the HTTP server and resolve once it is listening.
 * @param port TCP port to bind
 * @param host bind host (TAIGA_HTTP_HOST or 127.0.0.1)
 * @param createServer shared factory building a fully registered server per request
 */
export async function startHttpServer(port: number, host: string, createServer: () => McpServer): Promise<Server> {
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!isLoopback) {
    console.error(`WARNING: TAIGA_HTTP_HOST "${host}" is not a loopback address. The endpoint is reachable by other hosts on the network without TLS.`);
  }

  const hostHeader = host.includes(':') ? `[${host}]` : host;
  // Base64 and JSON expand a 10 MiB attachment; keep the HTTP cap finite but above that payload.
  const mcpHandler = createMcpHandler(createServer, { maxRequestBodySize: MAX_ATTACHMENT_BYTES * 2 });
  const nodeHandler = toNodeHandler(mcpHandler, { maxRequestBodySize: MAX_ATTACHMENT_BYTES * 2 });
  const validateHost = isLoopback ? localhostHostValidation() : hostHeaderValidation([hostHeader]);
  const validateOrigin = isLoopback ? localhostOriginValidation() : originValidation([hostHeader]);

  const handler: RequestListener = (req, res) => {
    if (new URL(req.url ?? '/', `http://${hostHeader}:${port}`).pathname !== MCP_PATH) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;

    void nodeHandler(req, res).catch(() => {
      if (res.destroyed || res.writableEnded) return;
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal MCP HTTP handler error' },
        id: null,
      }));
    });
  };

  const server = http.createServer(handler);
  server.once('close', () => {
    void mcpHandler.close();
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
  return server;
}