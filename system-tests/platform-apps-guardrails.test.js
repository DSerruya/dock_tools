// System tests for the name-collision guard added in d8fa4cb ("Re-add Platform Apps with a guard
// against overwriting existing cluster resources"). The manager's RBAC Role has no `resourceNames`
// restriction (see rbac-scope.test.js) — it CAN create/replace/delete any Deployment/Service in
// dock-tools by name. isNameTaken()/collidesWithForeignResource() in k8sService.ts is the only
// thing standing between "register a Platform App named manager/nginx/utility-tools-hub" and it
// silently overwriting that resource's real, hand-authored Deployment/Service. These tests check
// the guard is still wired into the create route, and that the "is this resource ours" check
// agrees with itself, rather than exercising it against a live cluster.

const fs = require('fs');
const path = require('path');

const k8sServiceSrc = fs.readFileSync(
  path.join(__dirname, '..', 'manager', 'src', 'services', 'k8sService.ts'), 'utf8',
);
const platformAppsRouteSrc = fs.readFileSync(
  path.join(__dirname, '..', 'manager', 'src', 'routes', 'platform-apps.ts'), 'utf8',
);
const indexSrc = fs.readFileSync(
  path.join(__dirname, '..', 'manager', 'src', 'index.ts'), 'utf8',
);

describe('platform-app name-collision guard', () => {
  test('k8sService exports isNameTaken', () => {
    expect(k8sServiceSrc).toMatch(/export\s+async\s+function\s+isNameTaken/);
  });

  test('the POST / create route calls isNameTaken before persisting or installing the app', () => {
    const guardCallIdx = platformAppsRouteSrc.indexOf('k8sService.isNameTaken(');
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
      platformAppsRouteSrc.indexOf('k8sService.isNameTaken('),
      platformAppsRouteSrc.indexOf('const config: PlatformAppConfig'),
    );
    expect(guardBlock).toMatch(/res\.status\(409\)/);
  });

  test('the "managed-by" label used to mark ownership is the same string everywhere it is checked', () => {
    const labelWrites = k8sServiceSrc.match(/'managed-by':\s*'([^']+)'/g) || [];
    const labelReads = k8sServiceSrc.match(/labels\?\.\['managed-by'\]\s*!==\s*'([^']+)'/) || [];

    expect(labelWrites.length).toBeGreaterThan(0);
    expect(labelReads.length).toBeGreaterThan(0);

    const writtenValue = labelWrites[0].match(/'managed-by':\s*'([^']+)'/)[1];
    const readValue = labelReads[1];
    expect(readValue).toBe(writtenValue);
  });

  test('collidesWithForeignResource treats a "not found" resource as available, not foreign', () => {
    const fnBody = k8sServiceSrc.slice(
      k8sServiceSrc.indexOf('async function collidesWithForeignResource'),
      k8sServiceSrc.indexOf('export async function isNameTaken'),
    );
    expect(fnBody).toMatch(/if\s*\(isNotFound\(err\)\)\s*return\s*false/);
  });
});

// Regression tests for the 2026-09-15 "HTTP 502 on Add Platform App" incident: isNameTaken()
// rethrows any non-404 k8s API error (RBAC drift, an API-server network blip — more likely on a
// real remote cluster than in local dev). The POST / route awaited it with no try/catch, and with
// no process-wide unhandledRejection handler either, that rejection crashed the whole manager
// process; nginx then returned a bare 502 to the request that triggered it, before any
// clone/build step ever ran. See platform-apps.ts and index.ts for the fix.
describe('POST / does not crash the process when the k8s API errors', () => {
  test('the isNameTaken call is wrapped in its own try/catch, not left to reject unguarded', () => {
    const guardCallIdx = platformAppsRouteSrc.indexOf('k8sService.isNameTaken(');
    const tryIdx = platformAppsRouteSrc.lastIndexOf('try {', guardCallIdx);
    const catchIdx = platformAppsRouteSrc.indexOf('} catch', guardCallIdx);

    expect(tryIdx).toBeGreaterThan(-1);
    expect(catchIdx).toBeGreaterThan(guardCallIdx);

    // the try block must actually wrap the guard call (no unrelated try/catch in between)
    const tryBlock = platformAppsRouteSrc.slice(tryIdx, catchIdx);
    expect(tryBlock).toContain('k8sService.isNameTaken(');
  });

  test('a failed name-collision check responds with 500, not a silently dropped rejection', () => {
    const guardCallIdx = platformAppsRouteSrc.indexOf('k8sService.isNameTaken(');
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
