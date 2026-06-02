import express from 'express';
import * as path from 'path';
import scriptsRouter  from './routes/scripts';
import schedulesRouter from './routes/schedules';
import webhooksRouter from './routes/webhooks';
import logsRouter     from './routes/logs';
import auditRouter    from './routes/audit';
import adminRouter    from './routes/admin';
import { authenticate } from './middleware/auth';
import * as configService from './services/configService';
import * as cronService   from './services/cronService';
import * as logService    from './services/logService';
import * as userService   from './services/userService';

const app  = express();
const PORT = parseInt(process.env.PORT || '3000');

// ── Public: webhooks (capture raw body for HMAC) ─────────────────────────────
app.use('/webhook', (req, _res, next) => {
  const chunks: Buffer[] = [];
  req.on('data', chunk => chunks.push(Buffer.from(chunk)));
  req.on('end', () => { (req as any).rawBody = Buffer.concat(chunks); next(); });
});
app.use('/webhook', webhooksRouter);

// ── Public: health check (k8s probes) ───────────────────────────────────────
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ── Parse body ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Auth required for everything below ──────────────────────────────────────
app.use(authenticate);

// ── /api/me — returns current user info (role-aware UI) ─────────────────────
app.get('/api/me', (req, res) => {
  const u = (req as any).currentUser as userService.User | undefined;
  res.json({ username: u?.username ?? 'anonymous', role: u?.role ?? 'admin' });
});

app.use('/api/scripts',  scriptsRouter);
app.use('/api',          schedulesRouter);
app.use('/api/logs',     logsRouter);
app.use('/api/audit',    auditRouter);
app.use('/api/admin',    adminRouter);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Boot ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`[manager] Listening on port ${PORT}`);
  await userService.initializeFromEnv();
  logService.recoverStaleRuns();
  const configs = configService.loadAll();
  cronService.initAll(configs);
});
