import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Request extends IncomingMessage {
  body?: unknown;
  query: Record<string, string | string[] | undefined>;
}
export type Response = ServerResponse & {
  status(code: number): Response;
  json(body: unknown): void;
};

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Expected a JSON object');
  return value as Record<string, unknown>;
}

export function header(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
}

export function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new HttpError(400, `${name} is required`);
  return value;
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new HttpError(503, `Missing configuration: ${name}`);
  return value;
}

export async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new HttpError(502, `Upstream request failed (${response.status})`);
  try { return await response.json(); } catch { throw new HttpError(502, 'Upstream returned invalid JSON'); }
}

export function handler(method: string, run: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== method) {
      res.setHeader('Allow', method);
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    try { await run(req, res); }
    catch (error) {
      if (error instanceof HttpError) res.status(error.status).json({ error: error.message });
      else {
        console.error('Request failed:', error instanceof Error ? error.name : 'unknown error');
        res.status(503).json({ error: 'Service unavailable' });
      }
    }
  };
}
