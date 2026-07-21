import { Router } from 'express';
import multer     from 'multer';
import * as backupService from '../services/backupService';
import * as auditService  from '../services/auditService';
import { requireRole }    from '../middleware/auth';
import { getUser }        from '../utils/getUser';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

router.use(requireRole('admin'));

// GET /api/admin/backup — download a full, encrypted environment backup
router.get('/', (req, res) => {
  try {
    const bundle    = backupService.buildBundle();
    const encrypted = backupService.encryptBundle(bundle);
    const user      = getUser(req);
    auditService.record(user, 'backup.downloaded', '-', [
      { field: 'scripts', newValue: bundle.scripts.length },
      { field: 'users',   newValue: bundle.users.length },
    ]);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="dock-tools-backup-${new Date().toISOString().slice(0, 10)}.dtbackup"`);
    res.send(encrypted);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/admin/backup/inspect — decrypt and summarize a backup file, no mutation
router.post('/inspect', upload.single('backup'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const bundle = backupService.decryptBundle(req.file.buffer.toString('utf8'));
    res.json({
      createdAt:     bundle.createdAt,
      scriptNames:   bundle.scripts.map(s => s.name),
      usernames:     bundle.users.map(u => u.username),
      hasAdminVpn:   Boolean(bundle.adminVpnConfig),
      hasSqlTestVpn: Boolean(bundle.sqlTestVpnConfig),
      auditEntries:  bundle.audit.length,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/admin/backup/restore — full overwrite restore, requires confirm: 'RESTORE'
router.post('/restore', upload.single('backup'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (req.body?.confirm !== 'RESTORE')
    return res.status(400).json({ error: 'Type RESTORE to confirm this action' });

  try {
    const bundle  = backupService.decryptBundle(req.file.buffer.toString('utf8'));
    const user    = getUser(req);
    const summary = await backupService.restoreBundle(bundle, user);
    res.json({ message: 'Environment restored', ...summary });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
