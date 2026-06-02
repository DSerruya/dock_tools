import { Router } from 'express';
import * as configService from '../services/configService';
import * as gitService    from '../services/gitService';

const router = Router();

// GET /api/export
// Downloads all script configs as JSON, including the local clone path for each.
router.get('/', (_req, res) => {
  const configs = configService.loadAll();

  const data = configs.map(config => ({
    name:         config.name,
    language:     config.language,
    repo:         config.repo,
    branch:       config.branch,
    entryPoint:   config.entryPoint,
    buildCommand: config.buildCommand,
    runMode:      config.runMode,
    schedule:     config.schedule,
    timezone:     config.timezone,
    port:         config.port,
    env:          config.env,
    createdAt:    config.createdAt,
    lastSync:     config.lastSync,
    lastRun:      config.lastRun,
    // repoToken intentionally excluded
    localGitPath: gitService.getLocalPath(config.name),
    isCloned:     gitService.isCloned(config.name),
  }));

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="scripts-export-${new Date().toISOString().slice(0,10)}.json"`);
  res.json(data);
});

export default router;
