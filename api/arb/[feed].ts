import { arb, feedArguments } from '../_lib/engines';
import { handler, text } from '../_lib/http';
import { authorize, HIGH } from '../_lib/x402';

export default handler('GET', async (req, res) => {
  const feed = text(req.query.feed, 'feed');
  feedArguments(feed, req.query);
  if (!await authorize(req, res, HIGH)) return;
  res.status(200).json(await arb(feed, req.query));
});
