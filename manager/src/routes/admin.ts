import { Router } from 'express';
import * as userService  from '../services/userService';
import * as auditService from '../services/auditService';
import { requireRole }   from '../middleware/auth';
import { getUser }       from '../utils/getUser';

const router = Router();

// Every admin route requires admin role
router.use(requireRole('admin'));

// GET /api/admin/users
router.get('/users', (_req, res) => {
  const users = userService.listUsers().map(u => ({
    username:  u.username,
    role:      u.role,
    createdAt: u.createdAt,
  }));
  res.json(users);
});

// POST /api/admin/users
router.post('/users', async (req, res) => {
  const { username, password, role } = req.body;
  const actor = getUser(req);

  if (!username || !password || !role)
    return res.status(400).json({ error: 'username, password, and role are required' });
  if (!['admin', 'agent', 'viewer'].includes(role))
    return res.status(400).json({ error: 'role must be admin, agent, or viewer' });
  if (!/^[a-zA-Z0-9_-]+$/.test(username))
    return res.status(400).json({ error: 'username may only contain letters, numbers, _ and -' });
  if (password.length < 6)
    return res.status(400).json({ error: 'password must be at least 6 characters' });

  try {
    const user = await userService.createUser(username, password, role as userService.Role);
    auditService.record(actor, 'user.created', username, [
      { field: 'role', oldValue: undefined, newValue: role },
    ]);
    res.status(201).json({ username: user.username, role: user.role, createdAt: user.createdAt });
  } catch (err: any) { res.status(409).json({ error: err.message }); }
});

// PUT /api/admin/users/:username
router.put('/users/:username', async (req, res) => {
  const { role, password } = req.body;
  const actor = getUser(req);

  if (!role && !password)
    return res.status(400).json({ error: 'Provide role and/or password to update' });
  if (role && !['admin', 'agent', 'viewer'].includes(role))
    return res.status(400).json({ error: 'Invalid role' });
  if (password && password.length < 6)
    return res.status(400).json({ error: 'password must be at least 6 characters' });

  try {
    const before = userService.listUsers().find(u => u.username === req.params.username);
    const user   = await userService.updateUser(req.params.username, { role, password });

    const changes: auditService.ChangeDetail[] = [];
    if (role && before?.role !== role)
      changes.push({ field: 'role', oldValue: before?.role, newValue: role });
    if (password)
      changes.push({ field: 'password', oldValue: '(changed)', newValue: '(changed)' });

    auditService.record(actor, 'user.updated', req.params.username, changes);
    res.json({ username: user.username, role: user.role });
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

// DELETE /api/admin/users/:username
router.delete('/users/:username', (req, res) => {
  const actor = getUser(req);
  try {
    userService.deleteUser(req.params.username, actor);
    auditService.record(actor, 'user.deleted', req.params.username, []);
    res.json({ message: `User "${req.params.username}" deleted` });
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

export default router;
