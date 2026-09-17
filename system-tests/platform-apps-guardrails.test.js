// System tests for Platform Apps' Docker-backed implementation (dockerPlatformAppService.ts),
// which replaced the k8s-backed one on 2026-09-16: this VM (and, it turned out, every real
// deployment) runs the plain Docker Compose stack with no Kubernetes cluster at all, so
// Kubernetes was dropped entirely rather than kept as a second, effectively-untested backend.
//
// These tests are written against utility-tools-hub's own install requirements — the "Utility
// Tools Hub" quick-add card in app.js pre-fills the Add Platform App modal with exactly the
// config below — so a change that silently drops one of these capabilities while moving code
// around gets caught here, not by someone clicking "+ Add Platform App" in production again.
//
//   containerPort: 3000, no hostPort (network-internal only)
//   needsDockerSock: true    (hub's onboarding runner drives sibling containers)
//   needsDataVolume: true    (persistent /app/data)
//   healthCheckPath: /api/health
//   resources: cpu 100m request / 500m limit, memory 128Mi request / 512Mi limit
//
// Like the old k8sService.ts tests, these are static source-inspection checks — jest here has no
// ts-jest transform, so .ts sources are read as text and asserted against with regexes rather
// than actually imported and executed. This can't catch a runtime Docker Engine error, but it
// does catch someone deleting or silently reordering the logic that makes the above requirements
// actually take effect.

const fs = require('fs');
const path = require('path');

const dockerPlatformAppServiceSrc = fs.readFileSync(
  path.join(__dirname, '..', 'manager', 'src', 'services', 'dockerPlatformAppService.ts'), 'utf8',
);
const dockerServiceSrc = fs.readFileSync(
  path.join(__dirname, '..', 'manager', 'src', 'services', 'dockerService.ts'), 'utf8',
);
const platformAppServiceSrc = fs.readFileSync(
  path.join(__dirname, '..', 'manager', 'src', 'services', 'platformAppService.ts'), 'utf8',
);
const platformAppsRouteSrc = fs.readFileSync(
  path.join(__dirname, '..', 'manager', 'src', 'routes', 'platform-apps.ts'), 'utf8',
);
const appJsSrc = fs.readFileSync(
  path.join(__dirname, '..', 'manager', 'src', 'public', 'app.js'), 'utf8',
);
const indexSrc = fs.readFileSync(
  path.join(__dirname, '..', 'manager', 'src', 'index.ts'), 'utf8',
);
const packageJson = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'manager', 'package.json'), 'utf8',
));

describe('Platform Apps has no remaining Kubernetes dependency', () => {
  test('k8sService.ts no longer exists', () => {
    expect(fs.existsSync(path.join(__dirname, '..', 'manager', 'src', 'services', 'k8sService.ts'))).toBe(false);
  });

  test('the k8s/ Kustomize manifest directory no longer exists', () => {
    expect(fs.existsSync(path.join(__dirname, '..', 'k8s'))).toBe(false);
  });

  test('@kubernetes/client-node is not a manager dependency', () => {
    expect(packageJson.dependencies).not.toHaveProperty('@kubernetes/client-node');
  });

  test('no manager source file still imports k8sService or @kubernetes/client-node (mentioning it in a historical-context comment is fine)', () => {
    const srcDir = path.join(__dirname, '..', 'manager', 'src');
    const offenders = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|js)$/.test(entry.name)) continue;
        const text = fs.readFileSync(full, 'utf8');
        if (/(?:from|require\()\s*['"][^'"]*(?:k8sService|@kubernetes\/client-node)['"]/.test(text)) offenders.push(full);
      }
    })(srcDir);
    expect(offenders).toEqual([]);
  });
});

describe('dockerPlatformAppService uses the same dockerode client dockerService.ts already uses', () => {
  test('both instantiate Dockerode against the same local socket', () => {
    const socketLine = "new Dockerode({ socketPath: '/var/run/docker.sock' })";
    expect(dockerServiceSrc).toContain(socketLine);
    expect(dockerPlatformAppServiceSrc).toContain(socketLine);
  });

  test('both demux raw container logs with the same shared helper, not a re-implementation', () => {
    expect(dockerServiceSrc).toMatch(/from ['"]\.\.\/utils\/dockerLogs['"]/);
    expect(dockerPlatformAppServiceSrc).toMatch(/from ['"]\.\.\/utils\/dockerLogs['"]/);
  });
});

describe("utility-tools-hub's quick-add requirements are all wired into dockerPlatformAppService", () => {
  test('the quick-add card still requests every capability this suite checks for', () => {
    // If this ever drifts from the list below, the capabilities below are testing a config hub
    // no longer actually asks for — update both together.
    expect(appJsSrc).toMatch(/pa-container-port'\)\.value\s*=\s*3000/);
    expect(appJsSrc).toMatch(/pa-needs-docker-sock'\)\.checked\s*=\s*true/);
    expect(appJsSrc).toMatch(/pa-needs-data-volume'\)\.checked\s*=\s*true/);
    expect(appJsSrc).toMatch(/pa-health-check-path'\)\.value\s*=\s*'\/api\/health'/);
    expect(appJsSrc).toMatch(/pa-cpu-limit'\)\.value\s*=\s*'500m'/);
    expect(appJsSrc).toMatch(/pa-memory-limit'\)\.value\s*=\s*'512Mi'/);
  });

  test('needsDockerSock binds the host docker.sock into the container', () => {
    expect(dockerPlatformAppServiceSrc).toMatch(
      /if\s*\(config\.needsDockerSock\)\s*binds\.push\('\/var\/run\/docker\.sock:\/var\/run\/docker\.sock'\)/,
    );
  });

  test('needsDataVolume binds a persistent, per-app host-backed directory at /app/data', () => {
    expect(dockerPlatformAppServiceSrc).toMatch(
      /if\s*\(config\.needsDataVolume\)\s*binds\.push\(`\$\{HOST_DATA_ROOT\}\/\$\{config\.name\}-data:\/app\/data`\)/,
    );
  });

  test('no hostPort still leaves the app reachable by name on the Docker network (unconditional alias)', () => {
    // The Aliases line must sit outside the `if (config.hostPort)` block — hub's quick-add sets
    // no hostPort at all, so if this were conditional on hostPort, hub would be unreachable by
    // anyone (including this process's own health checks) after install.
    const hostPortBlockStart = dockerPlatformAppServiceSrc.indexOf('if (config.hostPort)');
    const aliasIdx = dockerPlatformAppServiceSrc.indexOf('Aliases: [config.name, containerName(config.name)]');
    expect(aliasIdx).toBeGreaterThan(-1);
    expect(hostPortBlockStart).toBeGreaterThan(-1);
    expect(aliasIdx).toBeLessThan(hostPortBlockStart);
  });

  test('healthCheckPath is stashed as a container label so getStatus()/liveness stay name-only lookups', () => {
    expect(dockerPlatformAppServiceSrc).toMatch(/\[HEALTH_CHECK_PATH_LABEL\]:\s*config\.healthCheckPath/);
    expect(dockerPlatformAppServiceSrc).toMatch(/\[CONTAINER_PORT_LABEL\]:\s*String\(config\.containerPort\)/);
  });

  test('getStatus gates "running" vs "error" on a live health check when healthCheckPath is set', () => {
    const fnBody = dockerPlatformAppServiceSrc.slice(
      dockerPlatformAppServiceSrc.indexOf('export async function getStatus'),
      dockerPlatformAppServiceSrc.indexOf('export async function getLogs'),
    );
    expect(fnBody).toMatch(/checkHealth\(name, Number\(containerPort\), healthCheckPath\)/);
    expect(fnBody).toMatch(/return healthy \? 'running' : 'error'/);
  });

  test('an app with no healthCheckPath is always "running" once started (no probe = always-ready)', () => {
    const fnBody = dockerPlatformAppServiceSrc.slice(
      dockerPlatformAppServiceSrc.indexOf('export async function getStatus'),
      dockerPlatformAppServiceSrc.indexOf('export async function getLogs'),
    );
    expect(fnBody).toMatch(/if\s*\(!healthCheckPath \|\| !containerPort\)\s*return 'running'/);
  });

  test('a sustained health-check failure eventually forces a restart (liveness, not just readiness)', () => {
    expect(dockerPlatformAppServiceSrc).toMatch(/LIVENESS_FAILURE_THRESHOLD/);
    expect(dockerPlatformAppServiceSrc).toMatch(/failures < LIVENESS_FAILURE_THRESHOLD\) return/);
    expect(dockerPlatformAppServiceSrc).toMatch(/await apply\(config\)/);
  });

  test('the liveness auto-restart has a cooldown so a genuinely broken app cannot restart-loop tightly', () => {
    expect(dockerPlatformAppServiceSrc).toMatch(/LIVENESS_RESTART_COOLDOWN_MS/);
    expect(dockerPlatformAppServiceSrc).toMatch(/Date\.now\(\) - lastRestart < LIVENESS_RESTART_COOLDOWN_MS\) return/);
  });

  test('resources.limits (cpu/memory) parse k8s-style quantity strings ("500m", "512Mi") into Docker HostConfig fields', () => {
    expect(dockerPlatformAppServiceSrc).toMatch(/NanoCpus\s*=\s*Math\.round\(parseCpuQuantity\(resources\.limits\.cpu\) \* 1e9\)/);
    expect(dockerPlatformAppServiceSrc).toMatch(/Memory\s*=\s*parseMemoryQuantity\(resources\.limits\.memory\)/);
    // "m" suffix (millicores) and the "Mi"/"Gi"/"Ki" binary suffixes hub's quick-add actually uses
    expect(dockerPlatformAppServiceSrc).toMatch(/cpu\.endsWith\('m'\)/);
    expect(dockerPlatformAppServiceSrc).toMatch(/Mi:\s*1024\s*\*\*\s*2/);
  });

  test('resources.requests are applied too (soft/advisory, since Docker has no scheduler to enforce them)', () => {
    expect(dockerPlatformAppServiceSrc).toMatch(/MemoryReservation\s*=\s*parseMemoryQuantity\(resources\.requests\.memory\)/);
    expect(dockerPlatformAppServiceSrc).toMatch(/CpuShares\s*=\s*Math\.round\(parseCpuQuantity\(resources\.requests\.cpu\) \* 1024\)/);
  });

  test('install always stops+removes any existing container before creating — single-instance is structural, not configured', () => {
    const fnBody = dockerPlatformAppServiceSrc.slice(
      dockerPlatformAppServiceSrc.indexOf('export async function apply'),
      dockerPlatformAppServiceSrc.indexOf('export async function start'),
    );
    const removeIdx = fnBody.indexOf('removeIfExists(config.name)');
    const createIdx = fnBody.indexOf('createContainer(');
    expect(removeIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(-1);
    expect(removeIdx).toBeLessThan(createIdx);
  });
});

describe('platform-app name-collision guard', () => {
  test('dockerPlatformAppService exports isNameTaken', () => {
    expect(dockerPlatformAppServiceSrc).toMatch(/export\s+async\s+function\s+isNameTaken/);
  });

  test('isNameTaken checks both the Scripts registry and real Docker container state', () => {
    const fnBody = dockerPlatformAppServiceSrc.slice(
      dockerPlatformAppServiceSrc.indexOf('export async function isNameTaken'),
      dockerPlatformAppServiceSrc.indexOf('// ── k8s-style resource'),
    );
    expect(fnBody).toMatch(/configService\.get\(name\)/); // a Script already using this bare alias
    expect(fnBody).toMatch(/Labels\?\.\[MANAGED_LABEL_KEY\]\s*!==\s*MANAGED_LABEL_VALUE/); // a foreign container
  });

  test('the POST / create route calls isNameTaken before persisting or installing the app', () => {
    const guardCallIdx = platformAppsRouteSrc.indexOf('dockerPlatformAppService.isNameTaken(');
    const saveIdx = platformAppsRouteSrc.indexOf('configService.save(config)');
    const installIdx = platformAppsRouteSrc.indexOf('platformAppService.install(config)');

    expect(guardCallIdx).toBeGreaterThan(-1);
    expect(saveIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeGreaterThan(-1);
    expect(guardCallIdx).toBeLessThan(saveIdx);
    expect(guardCallIdx).toBeLessThan(installIdx);
  });

  test('a taken name is rejected with 409, not silently allowed through', () => {
    const guardBlock = platformAppsRouteSrc.slice(
      platformAppsRouteSrc.indexOf('dockerPlatformAppService.isNameTaken('),
      platformAppsRouteSrc.indexOf('const config: PlatformAppConfig'),
    );
    expect(guardBlock).toMatch(/res\.status\(409\)/);
  });

  test('the "managed-by" label used to mark ownership is the same string everywhere it is checked', () => {
    expect(dockerPlatformAppServiceSrc).toMatch(/MANAGED_LABEL_VALUE\s*=\s*'script-manager-platform-apps'/);
    const writeCount = (dockerPlatformAppServiceSrc.match(/\[MANAGED_LABEL_KEY\]:\s*MANAGED_LABEL_VALUE/g) || []).length;
    const readCount  = (dockerPlatformAppServiceSrc.match(/Labels\?\.\[MANAGED_LABEL_KEY\]\s*!==\s*MANAGED_LABEL_VALUE/g) || []).length;
    expect(writeCount).toBeGreaterThan(0);
    expect(readCount).toBeGreaterThan(0);
  });
});

// Regression tests for the 2026-09-15 "HTTP 502 on Add Platform App" incident: a create-time
// guard call that rejects must be caught explicitly — the POST / route awaited it with no
// try/catch, and with no process-wide unhandledRejection handler either, that rejection crashed
// the whole manager process; nginx then returned a bare 502 to the request that triggered it,
// before any clone/build step ever ran. Still applies verbatim under the Docker-backed guard.
describe('POST / does not crash the process when the name-collision check errors', () => {
  test('the isNameTaken call is wrapped in its own try/catch, not left to reject unguarded', () => {
    const guardCallIdx = platformAppsRouteSrc.indexOf('dockerPlatformAppService.isNameTaken(');
    const tryIdx = platformAppsRouteSrc.lastIndexOf('try {', guardCallIdx);
    const catchIdx = platformAppsRouteSrc.indexOf('} catch', guardCallIdx);

    expect(tryIdx).toBeGreaterThan(-1);
    expect(catchIdx).toBeGreaterThan(guardCallIdx);

    const tryBlock = platformAppsRouteSrc.slice(tryIdx, catchIdx);
    expect(tryBlock).toContain('dockerPlatformAppService.isNameTaken(');
  });

  test('a failed name-collision check responds with 500, not a silently dropped rejection', () => {
    const guardCallIdx = platformAppsRouteSrc.indexOf('dockerPlatformAppService.isNameTaken(');
    const catchIdx = platformAppsRouteSrc.indexOf('} catch', guardCallIdx);
    const catchBlockEnd = platformAppsRouteSrc.indexOf('\n  }', catchIdx);
    const catchBlock = platformAppsRouteSrc.slice(catchIdx, catchBlockEnd);

    expect(catchBlock).toMatch(/res\.status\(500\)/);
  });
});

describe('manager process survives an unhandled promise rejection', () => {
  test('index.ts registers a process-level unhandledRejection handler', () => {
    expect(indexSrc).toMatch(/process\.on\(\s*['"]unhandledRejection['"]/);
  });

  test('the unhandledRejection handler is registered before app.listen boots the server', () => {
    const handlerIdx = indexSrc.indexOf("process.on('unhandledRejection'");
    const listenIdx = indexSrc.indexOf('app.listen(');
    expect(handlerIdx).toBeGreaterThan(-1);
    expect(listenIdx).toBeGreaterThan(-1);
    expect(handlerIdx).toBeLessThan(listenIdx);
  });

  test('an Express error-handling middleware is registered (4-arg signature)', () => {
    expect(indexSrc).toMatch(/app\.use\(\s*\(\s*err[^)]*,\s*_?req[^)]*,\s*res[^)]*,\s*_?next[^)]*\)\s*=>/);
  });
});

describe('platformAppService wires install/update/restart/uninstall through dockerPlatformAppService', () => {
  test('install clones, builds, then applies — in that order', () => {
    const fnBody = platformAppServiceSrc.slice(
      platformAppServiceSrc.indexOf('export async function install'),
      platformAppServiceSrc.indexOf('export async function update'),
    );
    const cloneIdx = fnBody.indexOf('gitService.clone(');
    const buildIdx = fnBody.indexOf('buildImage(config)');
    const applyIdx = fnBody.indexOf('dockerPlatformAppService.apply(config)');
    expect(cloneIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeGreaterThan(cloneIdx);
    expect(applyIdx).toBeGreaterThan(buildIdx);
  });

  test('update pulls, rebuilds, then re-applies to pick up the freshly built image', () => {
    const fnBody = platformAppServiceSrc.slice(
      platformAppServiceSrc.indexOf('export async function update'),
      platformAppServiceSrc.indexOf('export async function start'),
    );
    expect(fnBody).toMatch(/gitService\.pull\(/);
    expect(fnBody).toMatch(/buildImage\(config\)/);
    expect(fnBody).toMatch(/dockerPlatformAppService\.apply\(config\)/);
  });

  test('restart takes the full config, not just a name — Docker containers must be fully recreated, unlike a k8s Deployment patch', () => {
    expect(platformAppServiceSrc).toMatch(/export async function restart\(config: PlatformAppConfig\)/);
    expect(platformAppsRouteSrc).toMatch(/platformAppService\.restart\(existing\)/);
  });

  test('uninstall deletes the container before deleting the cloned repo', () => {
    const fnBody = platformAppServiceSrc.slice(platformAppServiceSrc.indexOf('export async function uninstall'));
    const deleteAppIdx = fnBody.indexOf('dockerPlatformAppService.deleteApp(name)');
    const deleteCloneIdx = fnBody.indexOf('gitService.deleteClone(');
    expect(deleteAppIdx).toBeGreaterThan(-1);
    expect(deleteAppIdx).toBeLessThan(deleteCloneIdx);
  });
});

// Regression tests for "how do I know a Platform App is still pulling/building vs. ready to
// restart" — the container's own runtime status stays whatever it was BEFORE an update for the
// entire clone/pull+build+apply duration (apply() only swaps in the new image at the very end),
// so status alone can never show build progress. platformAppService.buildState fills that gap.
describe('Platform Apps surface real install/update progress, not just container status', () => {
  test('install and update both run through the shared build-state tracker, not bare calls', () => {
    const installBody = platformAppServiceSrc.slice(
      platformAppServiceSrc.indexOf('export async function install'),
      platformAppServiceSrc.indexOf('export async function update'),
    );
    const updateBody = platformAppServiceSrc.slice(
      platformAppServiceSrc.indexOf('export async function update'),
      platformAppServiceSrc.indexOf('export async function start'),
    );
    expect(installBody).toMatch(/runBuild\(config\.name, 'installing'/);
    expect(updateBody).toMatch(/runBuild\(config\.name, 'updating'/);
  });

  test('a failed build keeps its error on buildState instead of silently clearing (so the UI keeps showing it)', () => {
    const fnBody = platformAppServiceSrc.slice(
      platformAppServiceSrc.indexOf('async function runBuild'),
      platformAppServiceSrc.indexOf('export async function install'),
    );
    expect(fnBody).toMatch(/buildState\.delete\(name\)/);       // success clears it
    expect(fnBody).toMatch(/error:\s*err\?\.message/);           // failure keeps it, with the error
  });

  test('isDeploying is false once a build has failed — a failed attempt has nothing left running to race with', () => {
    const fnBody = platformAppServiceSrc.slice(
      platformAppServiceSrc.indexOf('export function isDeploying'),
      platformAppServiceSrc.indexOf('async function runBuild'),
    );
    expect(fnBody).toMatch(/!state\.error/);
  });

  test('GET /api/platform-apps includes each app\'s build state alongside its container status', () => {
    expect(platformAppsRouteSrc).toMatch(/build:\s*platformAppService\.getBuildState\(config\.name\)/);
  });

  test('start/stop/restart/update/edit are all gated on isDeploying, so they cannot race an in-flight install/update', () => {
    const gatedRoutes = [
      "router.put('/:name'",
      "router.post('/:name/start'",
      "router.post('/:name/stop'",
      "router.post('/:name/restart'",
      "router.post('/:name/update'",
    ];
    gatedRoutes.forEach(routeStart => {
      const idx = platformAppsRouteSrc.indexOf(routeStart);
      expect(idx).toBeGreaterThan(-1);
      const nextRouteIdx = platformAppsRouteSrc.indexOf('router.', idx + routeStart.length);
      const routeBody = platformAppsRouteSrc.slice(idx, nextRouteIdx > -1 ? nextRouteIdx : undefined);
      expect(routeBody).toMatch(/platformAppService\.isDeploying\(existing\.name\)/);
      expect(routeBody).toMatch(/res\.status\(409\)/);
    });
  });
});
