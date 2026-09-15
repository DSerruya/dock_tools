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
