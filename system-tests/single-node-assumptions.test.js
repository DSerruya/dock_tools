// System tests encoding the "single node + local dockerd, no registry" assumption that manager,
// utility-tools-hub, and every future Platform App are built on (see the fresh-environment
// checklist worked out with the utility-tools-hub session, 2026-09-15). None of this is enforced
// by Kubernetes itself — it's a convention baked into the manifests and into k8sService.ts's
// generated Deployment spec. These tests exist so an edit that quietly breaks the assumption
// (e.g. switching imagePullPolicy to IfNotPresent, or adding a PVC/registry push) gets caught
// here instead of surfacing as a confusing pod-scheduling failure on a future multi-node cluster.

const fs = require('fs');
const path = require('path');

const K8S_DIR = path.join(__dirname, '..', 'k8s');
const readK8s = name => fs.readFileSync(path.join(K8S_DIR, name), 'utf8');

const managerYaml = readK8s('deployment-manager.yaml');
const hubYaml = readK8s('deployment-hub.yaml');
const k8sServiceSrc = fs.readFileSync(
  path.join(__dirname, '..', 'manager', 'src', 'services', 'k8sService.ts'), 'utf8',
);

describe.each([
  ['manager', managerYaml],
  ['utility-tools-hub', hubYaml],
])('%s Deployment: single-node/local-image assumptions', (name, yaml) => {
  test('imagePullPolicy is Never — expects the image already built on this node', () => {
    expect(yaml).toMatch(/imagePullPolicy:\s*Never/);
  });

  test('docker.sock is a node-local hostPath Socket, not a shared/DinD endpoint', () => {
    expect(yaml).toMatch(/path:\s*\/var\/run\/docker\.sock/);
    expect(yaml).toMatch(/type:\s*Socket/);
  });

  test('its data volume is a node-local hostPath, not a PVC', () => {
    expect(yaml).toMatch(/type:\s*DirectoryOrCreate/);
    expect(yaml).not.toMatch(/PersistentVolumeClaim/);
  });

  test('uses Recreate rollout strategy (only one pod may hold docker.sock at a time)', () => {
    expect(yaml).toMatch(/strategy:\s*\n\s*type:\s*Recreate/);
  });
});

describe('no k8s manifest references a registry, PVC, or StorageClass', () => {
  const files = fs.readdirSync(K8S_DIR).filter(f => f.endsWith('.yaml'));

  test.each(files)('%s has no imagePullSecrets / PersistentVolumeClaim / StorageClass', file => {
    const contents = readK8s(file);
    expect(contents).not.toMatch(/imagePullSecrets/);
    expect(contents).not.toMatch(/PersistentVolumeClaim/);
    expect(contents).not.toMatch(/StorageClass/);
  });
});

describe('k8sService.ts generates Platform App pods with the same assumption', () => {
  test('sets imagePullPolicy: Never on every generated Deployment', () => {
    expect(k8sServiceSrc).toMatch(/imagePullPolicy:\s*'Never'/);
  });

  test('needsDockerSock mounts the node-local socket, not a remote/DinD daemon', () => {
    expect(k8sServiceSrc).toMatch(/path:\s*'\/var\/run\/docker\.sock',\s*type:\s*'Socket'/);
  });

  test('needsDataVolume uses a hostPath, not a PVC/StorageClass request', () => {
    expect(k8sServiceSrc).toMatch(/hostPath:\s*\{\s*path:\s*`\$\{HOST_DATA_ROOT\}/);
    expect(k8sServiceSrc).not.toMatch(/PersistentVolumeClaim/);
  });

  test('never references a registry push/pull or imagePullSecrets — builds are local-only', () => {
    expect(k8sServiceSrc).not.toMatch(/imagePullSecrets/);
    expect(k8sServiceSrc).not.toMatch(/registry/i);
  });
});
