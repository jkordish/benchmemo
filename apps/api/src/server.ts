import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import {
  ApiErrorSchema,
  CreateDecisionAcceptedSchema,
  DecisionBriefSchema,
} from '@benchmemo/shared';
import { ZodError } from 'zod';
import { DecisionExecutor } from './decision-executor.js';
import { DecisionService } from './decision-service.js';
import { DuplicateDecisionError, FileDecisionStore } from './store/decision-store.js';

export interface BenchMemoServerOptions {
  dataDir?: string;
  executor?: DecisionExecutor;
  service?: DecisionService;
}

export function createBenchMemoServer(options: BenchMemoServerOptions = {}) {
  const service =
    options.service ??
    new DecisionService({
      store: new FileDecisionStore(options.dataDir),
      executor: options.executor,
    });

  const server = createServer((req, res) => {
    void handleRequest(req, res, service).catch((error) => {
      sendError(res, error);
    });
  });

  return { server, service };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  service: DecisionService
) {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));

  if (segments.length === 1 && segments[0] === 'decisions') {
    if (method !== 'POST') {
      sendMethodNotAllowed(res, ['POST']);
      return;
    }

    const payload = await readJsonBody(req);
    const brief = DecisionBriefSchema.parse(payload);
    const accepted = CreateDecisionAcceptedSchema.parse(await service.createDecision(brief));

    sendJson(res, 202, accepted, {
      Location: accepted.location,
    });
    return;
  }

  if (segments.length === 2 && segments[0] === 'decisions') {
    if (method !== 'GET') {
      sendMethodNotAllowed(res, ['GET']);
      return;
    }

    const record = await service.getDecision(segments[1]);
    if (!record) {
      throw new HttpError(404, 'Decision not found');
    }

    sendJson(res, 200, record);
    return;
  }

  throw new HttpError(404, 'Not found');
}

async function readJsonBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;

    if (size > 1_000_000) {
      throw new HttpError(413, 'Request body too large');
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    throw new HttpError(400, 'Request body is required');
  }

  const body = Buffer.concat(chunks).toString('utf8');

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {}
) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

function sendMethodNotAllowed(res: ServerResponse, methods: string[]) {
  res.writeHead(405, {
    Allow: methods.join(', '),
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(`${JSON.stringify(ApiErrorSchema.parse({ error: 'Method not allowed' }), null, 2)}\n`);
}

function sendError(res: ServerResponse, error: unknown) {
  if (res.headersSent) {
    res.end();
    return;
  }

  if (error instanceof DuplicateDecisionError) {
    sendJson(res, 409, ApiErrorSchema.parse({ error: error.message }));
    return;
  }

  if (error instanceof HttpError) {
    sendJson(res, error.statusCode, ApiErrorSchema.parse({ error: error.message }));
    return;
  }

  if (error instanceof ZodError) {
    sendJson(res, 400, ApiErrorSchema.parse({ error: formatZodError(error) }));
    return;
  }

  const message = error instanceof Error ? error.message : 'Internal server error';
  sendJson(res, 500, ApiErrorSchema.parse({ error: message }));
}

function formatZodError(error: ZodError) {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${path}${issue.message}`;
    })
    .join('; ');
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export type BenchMemoServer = {
  server: Server;
  service: DecisionService;
};
