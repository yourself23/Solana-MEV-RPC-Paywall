import { handler } from '../_lib/http';
import { authorize, HIGH } from '../_lib/x402';

export default handler('POST', async (req, res) => {
  await authorize(req, res, HIGH, true);
});
