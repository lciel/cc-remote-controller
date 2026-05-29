#!/usr/bin/env bun
/**
 * cc-remote-controller channel plugin.
 *
 * Bridges between the cc-remote-controller backend (HTTP) and a Claude Code
 * session running in interactive (= subscription-billed) mode with
 * `--channels server:ccctl-channel`.
 *
 *   ccctl-server ──POST /push──→ this plugin ──notification──→ claude
 *   ccctl-server ←──GET /events (SSE)── this plugin ←──reply tool── claude
 *
 * One plugin process per claude session. Port is per-session (env).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const PORT = Number(process.env.CCCTL_CHANNEL_PORT ?? 8789);

// Outbound (plugin → ccctl-server): writers attached to GET /events.
type Writer = (chunk: string) => void;
const sseWriters = new Set<Writer>();

function emit(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const w of sseWriters) w(payload);
}

const mcp = new Server(
  { name: 'ccctl-channel', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        // Opt in to permission relay: claude code forwards tool-approval
        // prompts here, we re-emit them on SSE so ccctl-server pushes them
        // to the PWA, and a verdict POST on /verdict returns the answer.
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions:
      'Messages from the cc-remote-controller PWA arrive as ' +
      '<channel source="ccctl-channel" chat_id="..." message_id="..."> tags. ' +
      'If a tag has a file_path attribute, Read that file — it is an upload ' +
      'from the user. The ccctl-server watcher tails this session\'s jsonl ' +
      'and streams your assistant text blocks (narration) to the PWA, so ' +
      '-p-style progress narration reaches the user directly. Use the reply ' +
      'tool to send the final answer for the turn (pass chat_id from the ' +
      'inbound tag). Keep narration at -p grade, send one reply per turn ' +
      'carrying only the final answer, and never repeat in reply what ' +
      'narration already said.',
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'Send a message back to the cc-remote-controller PWA. Pass chat_id ' +
        'from the inbound channel tag.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['chat_id', 'text'],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'reply') {
    const args = (req.params.arguments ?? {}) as { chat_id?: string; text?: string };
    const chat_id = String(args.chat_id ?? '');
    const text = String(args.text ?? '');
    emit('reply', { chat_id, text, ts: Date.now() });
    return {
      content: [{ type: 'text', text: `sent (chat_id=${chat_id})` }],
    };
  }
  return {
    content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
    isError: true,
  };
});

// Permission relay: when claude code wants tool approval, it sends this
// notification. We re-emit on SSE so ccctl-server can broadcast to the PWA.
// The PWA's verdict comes back via POST /verdict (below), which turns into
// the corresponding notifications/claude/channel/permission notification.
const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  process.stderr.write(
    `[ccctl-channel] permission_request request_id=${params.request_id} tool=${params.tool_name}\n`,
  );
  emit('permission_request', params);
});

await mcp.connect(new StdioServerTransport());

let nextChatId = 1;

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);

    // GET /events — SSE stream of reply tool invocations, consumed by ccctl-server.
    if (req.method === 'GET' && url.pathname === '/events') {
      const stream = new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(': connected\n\n');
          const w: Writer = (chunk) => ctrl.enqueue(chunk);
          sseWriters.add(w);
          req.signal.addEventListener('abort', () => sseWriters.delete(w));
        },
      });
      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        },
      });
    }

    // POST /push — ccctl-server delivers a user prompt to claude.
    if (req.method === 'POST' && url.pathname === '/push') {
      let body: { content?: string; chat_id?: string; file_path?: string };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return new Response('bad json', { status: 400 });
      }
      const content = String(body.content ?? '');
      const chat_id = String(body.chat_id ?? nextChatId++);
      const meta: Record<string, string> = { chat_id };
      if (body.file_path) meta.file_path = body.file_path;
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: { content, meta },
      });
      return new Response(JSON.stringify({ ok: true, chat_id }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    // POST /verdict — ccctl-server delivers the PWA's permission verdict.
    if (req.method === 'POST' && url.pathname === '/verdict') {
      let body: { request_id?: string; behavior?: string };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return new Response('bad json', { status: 400 });
      }
      const request_id = String(body.request_id ?? '');
      const behavior = body.behavior === 'allow' ? 'allow' : 'deny';
      if (!request_id) return new Response('missing request_id', { status: 400 });
      process.stderr.write(
        `[ccctl-channel] verdict request_id=${request_id} behavior=${behavior}\n`,
      );
      await mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id, behavior },
      });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    // GET /health — readiness probe for ccctl-server.
    if (url.pathname === '/health') {
      return new Response('ok');
    }

    return new Response('404', { status: 404 });
  },
});

process.stderr.write(`ccctl-channel: listening on http://127.0.0.1:${PORT}\n`);
