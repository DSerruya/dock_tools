import express from 'express';
import * as path from 'path';
import scriptsRouter  from './routes/scripts';
import schedulesRouter from './routes/schedules';
import webhooksRouter from './routes/webhooks';
import logsRouter     from './routes/logs';
import auditRouter    from './routes/audit';
import adminRouter    from './routes/admin';
import exportRouter   from './routes/export';
import importRouter   from './routes/import';
import backupRouter   from './routes/backup';
import { authenticate } from './middleware/auth';
import * as configService from './services/configService';
import * as cronService   from './services/cronService';
import * as logService    from './services/logService';
import * as userService   from './services/userService';
import * as uiHealthCheckService from './services/uiHealthCheckService';

const app  = express();
const PORT = parseInt(process.env.PORT || '3000');

// Trust the nginx reverse-proxy so req.ip is the real client IP (used for rate limiting)
app.set('trust proxy', 1);

// ── Security headers on every response ──────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;"
  );
  next();
});

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
// Mounted before adminRouter so it doesn't fall through /api/admin's router first.
app.use('/api/admin/backup', backupRouter);
app.use('/api/admin',    adminRouter);
app.use('/api/export',   exportRouter);
app.use('/api/import',   importRouter);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Boot ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`[manager] Listening on port ${PORT}`);

  if (!process.env.WEBHOOK_SECRET) {
    console.warn('[security] WARNING: WEBHOOK_SECRET is not set — webhook endpoint is disabled and repoTokens cannot be encrypted at rest. Set WEBHOOK_SECRET in your .env file.');
  } else if (process.env.WEBHOOK_SECRET === 'changeme_secret') {
    console.warn('[security] WARNING: WEBHOOK_SECRET is set to the default placeholder "changeme_secret". Change it to a strong random value.');
  }

  await userService.initializeFromEnv();

  if (userService.listUsers().length === 0) {
    console.warn('[security] WARNING: No users are configured — the UI is publicly accessible without authentication. Set UI_PASSWORD in your .env file.');
  }

  logService.recoverStaleRuns();
  const configs = configService.loadAll();
  cronService.initAll(configs);
  uiHealthCheckService.init();
});
