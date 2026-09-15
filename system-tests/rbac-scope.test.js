// System tests for the manager's in-cluster RBAC (k8s/rbac-manager.yaml).
//
// These read the manifest as text rather than parsing YAML, matching manager/tests's existing
// convention (parseEnvText.test.js) of plain Node assertions with no extra tooling. The goal is
// to catch a silent scope-widening edit before it reaches a cluster: manager-sa is the identity
// the whole Platform Apps feature runs under, and its Role is deliberately namespace-scoped with
// no secrets access — see k8sService.ts's isNameTaken()/collidesWithForeignResource() comments
// for why that scoping matters (an over-broad Role would let Platform Apps touch resources it has
// no business touching, e.g. other namespaces or Secrets).

const fs = require('fs');
const path = require('path');

const rbacYaml = fs.readFileSync(path.join(__dirname, '..', 'k8s', 'rbac-manager.yaml'), 'utf8');
const managerDeploymentYaml = fs.readFileSync(
  path.join(__dirname, '..', 'k8s', 'deployment-manager.yaml'), 'utf8',
);

describe('manager RBAC scope (k8s/rbac-manager.yaml)', () => {
  test('defines a ServiceAccount named manager-sa in dock-tools', () => {
    expect(rbacYaml).toMatch(/kind:\s*ServiceAccount/);
    expect(rbacYaml).toMatch(/name:\s*manager-sa/);
  });

  test('grants access via a namespaced Role, never a ClusterRole', () => {
    expect(rbacYaml).toMatch(/kind:\s*Role\b/);
    expect(rbacYaml).not.toMatch(/kind:\s*ClusterRole\b/);
    expect(rbacYaml).toMatch(/kind:\s*RoleBinding\b/);
    expect(rbacYaml).not.toMatch(/kind:\s*ClusterRoleBinding\b/);
  });

  test('every Role/RoleBinding/ServiceAccount is scoped to the dock-tools namespace', () => {
    const namespaceLines = rbacYaml.match(/namespace:\s*\S+/g) || [];
    expect(namespaceLines.length).toBeGreaterThan(0);
    namespaceLines.forEach(line => expect(line).toMatch(/namespace:\s*dock-tools/));
  });

  test('grants full CRUD on deployments', () => {
    const rule = rbacYaml.match(/apiGroups:\s*\["apps"\][\s\S]*?verbs:\s*\[([^\]]*)\]/);
    expect(rule).not.toBeNull();
    ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'].forEach(verb => {
      expect(rule[1]).toMatch(new RegExp(`"${verb}"`));
    });
  });

  test('grants pods/pods-log read-only — never write access to running pods', () => {
    const rule = rbacYaml.match(/resources:\s*\["pods",\s*"pods\/log"\][\s\S]*?verbs:\s*\[([^\]]*)\]/);
    expect(rule).not.toBeNull();
    ['get', 'list', 'watch'].forEach(verb => expect(rule[1]).toMatch(new RegExp(`"${verb}"`)));
    ['create', 'update', 'patch', 'delete', 'exec'].forEach(verb => {
      expect(rule[1]).not.toMatch(new RegExp(`"${verb}"`));
    });
  });

  test('never grants access to secrets', () => {
    expect(rbacYaml).not.toMatch(/"secrets"/);
  });

  test('binds manager-sa to the manager-platform-apps Role', () => {
    expect(rbacYaml).toMatch(/name:\s*manager-sa/);
    expect(rbacYaml).toMatch(/name:\s*manager-platform-apps/);
    expect(rbacYaml).toMatch(/roleRef:/);
  });

  test('the manager Deployment actually runs as manager-sa (RBAC is not just declared, it\'s wired up)', () => {
    expect(managerDeploymentYaml).toMatch(/serviceAccountName:\s*manager-sa/);
  });
});
