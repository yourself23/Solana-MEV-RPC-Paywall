import { relay, relayArguments } from '../_lib/engines';
import { handler } from '../_lib/http';
import { authorize, MICRO } from '../_lib/x402';

export default handler('POST', async (req, res) => {
  relayArguments(req.body);
  if (!await authorize(req, res, MICRO)) return;
  res.status(200).json(await relay(req.body));
});
