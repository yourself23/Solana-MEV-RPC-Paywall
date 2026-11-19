import { type Request, type Response } from './_lib/http';
export default async function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: 'API route not found' });
}
