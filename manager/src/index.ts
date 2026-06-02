import express from 'express';
import * as path from 'path';
import scriptsRouter from './routes/scripts';
import schedulesRouter from './routes/schedules';
import webhooksRouter from './routes/webhooks';
import { basicAuth } from './middleware/auth';
import * as configService from './services/configService';
import * as cronService from './services/cronService';

const app = express();
const PORT = parseInt(process.env.PORT || '3000');

// ── Webhooks: capture raw body for HMAC, no auth required ──────────────────
app.use('/webhook', (req, _res, next) => {
  const chunks: Buffer[] = [];
  req.on('data', chunk => chunks.push(Buffer.from(chunk)));
  req.on('end', () => {
    (req as any).rawBody = Buffer.concat(chunks);
    next();
  });
});
app.use('/webhook', webhooksRouter);

// ── Public health check — no auth, used by k8s liveness/readiness probes ───
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ── Everything else requires Basic Auth (when UI_PASSWORD is set) ───────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(basicAuth);

app.use('/api/scripts', scriptsRouter);
app.use('/api', schedulesRouter);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[manager] Listening on port ${PORT}`);
  const configs = configService.loadAll();
  cronService.initAll(configs);
});
