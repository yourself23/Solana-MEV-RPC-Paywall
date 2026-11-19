import { blockPrep, jitoTip } from '../_lib/engines';
import { handler, HttpError, text } from '../_lib/http';
import { authorize, MICRO } from '../_lib/x402';

export default handler('POST', async (req, res) => {
  const action = text(req.query.action, 'action');
  if (action !== 'jito-tip' && action !== 'block-prep') throw new HttpError(404, 'Unknown MEV action');
  if (!await authorize(req, res, MICRO)) return;
  res.status(200).json(await (action === 'jito-tip' ? jitoTip() : blockPrep()));
});
