import { Router } from 'express';
import * as cronService from '../services/cronService';

const router = Router();

router.get('/schedules', (_req, res) => {
  res.json(cronService.listActive());
});

router.post('/schedules/validate', (req, res) => {
  const { expression } = req.body;
  if (!expression) return res.status(400).json({ error: 'expression is required' });
  const valid = cronService.isValidExpression(expression);
  res.json({ valid });
});

export default router;
