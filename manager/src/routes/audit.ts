import { Router } from 'express';
import * as auditService from '../services/auditService';

const router = Router();

// GET /api/audit?script=<name>
router.get('/', (req, res) => {
  const { script } = req.query;
  res.json(auditService.list(script as string | undefined));
});

export default router;
