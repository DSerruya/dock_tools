import { Router, Request, Response } from 'express';
import { PassThrough } from 'stream';
import Dockerode from 'dockerode';
import * as logService from '../services/logService';

const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });
const router = Router();

// GET /api/logs?script=<name>&since=<iso>&until=<iso>
router.get('/', (req, res) => {
  const { script, since, until } = req.query;
  let runs = logService.listRuns(script as string | undefined);

  if (since) {
    const from = new Date(since as string).getTime();
    if (!isNaN(from)) runs = runs.filter(r => new Date(r.startTime).getTime() >= from);
  }
  if (until) {
    const to = new Date(until as string).getTime();
    if (!isNaN(to))   runs = runs.filter(r => new Date(r.startTime).getTime() <= to);
  }

  res.json(runs);
});

// GET /api/logs/:runId/content  — full saved log for completed runs
router.get('/:runId/content', (req, res) => {
  const run = logService.getRun(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json({ run, content: logService.getLogContent(req.params.runId) });
});

// GET /api/logs/:runId/stream  — SSE
// • running  → streams live from Docker
// • finished → sends saved log and closes
router.get('/:runId/stream', async (req: Request, res: Response) => {
  const run = logService.getRun(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');  // disable nginx buffering for SSE
  res.flushHeaders();

  const send = (payload: object) =>
    res.write(`data: ${JSON.stringify(payload)}\n\n`);

  if (run.status !== 'running') {
    send({ type: 'content', text: logService.getLogContent(run.runId) });
    send({ type: 'end', status: run.status });
    return res.end();
  }

  // ── Live stream from Docker ───────────────────────────────────────────────
  try {
    const containerName = `script-${run.scriptName}`;
    const container = docker.getContainer(containerName);

    // Send buffered content first (includes VPN header + output so far)
    const buffered = logService.getLogContent(run.runId);
    if (buffered && buffered !== '(no output captured)') {
      send({ type: 'data', text: buffered });
    }

    // Follow from current position only — no tail replay to avoid duplicates
    const raw = await container.logs({
      stdout: true, stderr: true,
      follow: true, timestamps: true,
      tail: 0,
    }) as unknown as NodeJS.ReadableStream;

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    (docker as any).modem.demuxStream(raw, stdout, stderr);

    const onData = (chunk: Buffer) =>
      send({ type: 'data', text: chunk.toString('utf8') });

    stdout.on('data', onData);
    stderr.on('data', onData);

    raw.on('end', () => {
      const fresh = logService.getRun(run.runId);
      send({ type: 'end', status: fresh?.status ?? 'stopped' });
      res.end();
    });

    req.on('close', () => (raw as any).destroy?.());

  } catch (err: any) {
    send({ type: 'error', text: err.message });
    res.end();
  }
});

export default router;
