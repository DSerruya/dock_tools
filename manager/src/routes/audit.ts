import { Router } from 'express';
import * as auditService from '../services/auditService';
import { requireRole } from '../middleware/auth';

const router = Router();

// GET /api/audit?script=<name> — admin and agent only; viewers cannot read audit records
router.get('/', requireRole('admin', 'agent'), (req, res) => {
  const { script } = req.query;
  res.json(auditService.list(script as string | undefined));
});

export default router;
