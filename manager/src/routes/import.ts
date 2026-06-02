import { Router } from 'express';
import * as configService from '../services/configService';
import * as gitService    from '../services/gitService';
import * as dockerService from '../services/dockerService';
import * as cronService   from '../services/cronService';
import * as logService    from '../services/logService';
import * as auditService  from '../services/auditService';
import { requireRole }    from '../middleware/auth';
import { getUser }        from '../utils/getUser';
import { ScriptConfig }   from '../types';

const router = Router();

// POST /api/import
// Body: { scripts: ScriptConfig[] }
// Returns: { imported, skipped, errors }
router.post('/', requireRole('admin', 'agent'), async (req, res) => {
  const { scripts } = req.body as { scripts: Partial<ScriptConfig>[] };

  if (!Array.isArray(scripts) || scripts.length === 0)
    return res.status(400).json({ error: 'No scripts provided' });

  const user     = getUser(req);
  const imported: string[]                         = [];
  const skipped:  string[]                         = [];
  const errors:   { name: string; error: string }[] = [];

  for (const raw of scripts) {
    if (!raw.name) { errors.push({ name: '?', error: 'Missing name' }); continue; }

    // Reject if a script with this name already exists
    if (configService.get(raw.name)) {
      skipped.push(raw.name);
      continue;
    }

    if (!raw.repo) { errors.push({ name: raw.name, error: 'Missing repo URL' }); continue; }

    const config: ScriptConfig = {
      name:         raw.name,
      language:     raw.language     || 'node',
      repo:         raw.repo,
      branch:       raw.branch       || 'main',
      entryPoint:   raw.entryPoint   || 'index.js',
      buildCommand: raw.buildCommand || undefined,
      repoToken:    raw.repoToken    || undefined,
      port:         raw.port,
      env:          raw.env          || {},
      runMode:      raw.runMode      || 'persistent',
      schedule:     raw.schedule     || undefined,
      timezone:     raw.timezone     || undefined,
      createdAt:    new Date().toISOString(),
    };

    try {
      configService.save(config);
      auditService.record(user, 'script.imported', config.name, auditService.configAsChanges(config));

      setImmediate(async () => {
        try {
          await gitService.cloneOrPull(config);
          configService.save({ ...config, lastSync: new Date().toISOString() });
          if (config.runMode === 'persistent') {
            const runId = logService.createRun(config.name, config.language, config.runMode);
            await dockerService.start(config, runId);
          } else if (config.runMode === 'scheduled' && config.schedule) {
            cronService.register(config);
          }
        } catch (err) { console.error(`[import] ${config.name}:`, err); }
      });

      imported.push(config.name);
    } catch (err: any) {
      errors.push({ name: config.name, error: err.message });
    }
  }

  res.json({ imported, skipped, errors });
});

export default router;
