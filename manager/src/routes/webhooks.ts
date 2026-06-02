import { Router, Request, Response } from 'express';
import * as crypto from 'crypto';
import * as configService from '../services/configService';
import * as gitService from '../services/gitService';
import * as dockerService from '../services/dockerService';

const router = Router();

function verifySignature(payload: Buffer, signature: string, secret: string): boolean {
  if (!signature) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

router.post('/:name', (req: Request, res: Response) => {
  const { name } = req.params;
  const config = configService.get(name);
  if (!config) return res.status(404).json({ error: 'Script not found' });

  const signature = req.headers['x-hub-signature-256'] as string;
  const secret = process.env.WEBHOOK_SECRET || '';
  const rawBody = (req as any).rawBody as Buffer | undefined;

  if (!rawBody) return res.status(400).json({ error: 'Missing request body' });
  if (!verifySignature(rawBody, signature, secret)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const pushedBranch = (req.body?.ref as string | undefined)?.replace('refs/heads/', '');
  if (pushedBranch && pushedBranch !== config.branch) {
    return res.status(200).json({
      message: `Push to "${pushedBranch}", watching "${config.branch}" — ignored`,
    });
  }

  res.status(200).json({ message: 'Webhook received, syncing...' });

  setImmediate(async () => {
    try {
      await gitService.pull(config);
      const updated = { ...config, lastSync: new Date().toISOString() };
      configService.save(updated);

      if (config.runMode === 'persistent') {
        await dockerService.restart(updated);
        console.log(`[webhook] Restarted "${name}"`);
      } else {
        console.log(`[webhook] Pulled "${name}" — new code will run on next scheduled tick`);
      }
    } catch (err) {
      console.error(`[webhook] Error processing "${name}":`, err);
    }
  });
});

export default router;
