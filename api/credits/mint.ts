import { handler } from '../_lib/http.js';
import { authorize, HIGH } from '../_lib/x402.js';

export default handler('POST', async (req, res) => {
  await authorize(req, res, HIGH, true);
});
