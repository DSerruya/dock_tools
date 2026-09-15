import * as k8s from '@kubernetes/client-node';
import { PlatformAppConfig, PlatformAppRuntimeStatus } from '../types';

const NAMESPACE = process.env.K8S_NAMESPACE || 'dock-tools';
// Node-real path backing each app's persistent volume — same convention as deployment-hub.yaml's
// hub-data hostPath (/opt/dock-tools/<app>-data), just namespaced under one directory so future
// apps installed from the admin UI don't need a hand-authored hostPath entry each.
const HOST_DATA_ROOT = process.env.PLATFORM_APPS_DATA_ROOT || '/opt/dock-tools/platform-apps';

const kc = new k8s.KubeConfig();
try {
  kc.loadFromCluster();
} catch {
  // Not running in-cluster (e.g. `npm run dev` on a workstation) — fall back to whatever
  // kubeconfig is on disk. If neither is available, every call below fails loudly, which is
  // preferable to silently no-op'ing platform-app management.
  try { kc.loadFromDefault(); } catch { /* no kubeconfig available either */ }
}

const apps = kc.makeApiClient(k8s.AppsV1Api);
const core = kc.makeApiClient(k8s.CoreV1Api);

// @kubernetes/client-node's response shape has changed across major versions (some return
// `{response, body}`, others return the resource object directly) — this unwraps either so the
// functions below don't have to track which one is installed.
function unwrap<T>(res: unknown): T {
  return (res && typeof res === 'object' && 'body' in (res as any) ? (res as any).body : res) as T;
}

function isNotFound(err: any): boolean {
  return err?.statusCode === 404 || err?.response?.statusCode === 404 || err?.code === 404;
}

function appLabels(name: string): Record<string, string> {
  return { app: name, 'managed-by': 'script-manager-platform-apps' };
}

function buildDeploymentSpec(config: PlatformAppConfig): k8s.V1Deployment {
  const volumeMounts: k8s.V1VolumeMount[] = [];
  const volumes: k8s.V1Volume[] = [];

  if (config.needsDockerSock) {
    volumeMounts.push({ name: 'docker-sock', mountPath: '/var/run/docker.sock' });
    volumes.push({ name: 'docker-sock', hostPath: { path: '/var/run/docker.sock', type: 'Socket' } });
  }
  if (config.needsDataVolume) {
    volumeMounts.push({ name: 'app-data', mountPath: '/app/data' });
    volumes.push({
      name: 'app-data',
      hostPath: { path: `${HOST_DATA_ROOT}/${config.name}-data`, type: 'DirectoryOrCreate' },
    });
  }

  const containerPort: k8s.V1ContainerPort = { containerPort: config.containerPort };
  if (config.hostPort) containerPort.hostPort = config.hostPort;

  // Same shape/defaults as deployment-hub.yaml's own probes: a slower liveness than readiness so
  // a container that's merely slow to become ready doesn't get killed before it has a chance.
  const probe: k8s.V1Probe | undefined = config.healthCheckPath
    ? { httpGet: { path: config.healthCheckPath, port: config.containerPort } }
    : undefined;
  const readinessProbe = probe ? { ...probe, initialDelaySeconds: 5, periodSeconds: 5 } : undefined;
  const livenessProbe  = probe ? { ...probe, initialDelaySeconds: 15, periodSeconds: 20 } : undefined;

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: config.name, namespace: NAMESPACE, labels: appLabels(config.name) },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: config.name } },
      // Recreate, not RollingUpdate: a hostPort/docker.sock-bound app can only ever have one
      // instance holding that port/socket at a time — same reasoning as manager's own Deployment.
      strategy: { type: 'Recreate' },
      template: {
        metadata: { labels: appLabels(config.name) },
        spec: {
          containers: [{
            name: config.name,
            image: `${config.name}:latest`,
            imagePullPolicy: 'Never', // built locally on the node, same convention as manager/hub
            ports: [containerPort],
            env: Object.entries(config.env || {}).map(([name, value]) => ({ name, value })),
            volumeMounts,
            readinessProbe,
            livenessProbe,
            resources: config.resources,
          }],
          volumes,
        },
      },
    },
  };
}

function buildServiceSpec(config: PlatformAppConfig): k8s.V1Service {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: config.name, namespace: NAMESPACE, labels: appLabels(config.name) },
    spec: {
      selector: { app: config.name },
      type: 'ClusterIP',
      ports: [{ name: 'http', port: config.containerPort, targetPort: config.containerPort }],
    },
  };
}

async function deploymentExists(name: string): Promise<boolean> {
  try { await apps.readNamespacedDeployment(name, NAMESPACE); return true; }
  catch (err: any) { if (isNotFound(err)) return false; throw err; }
}

async function serviceExists(name: string): Promise<boolean> {
  try { await core.readNamespacedService(name, NAMESPACE); return true; }
  catch (err: any) { if (isNotFound(err)) return false; throw err; }
}

// The manager's own RBAC Role has no per-resource `resourceNames` restriction — it can create,
// update, and delete ANY Deployment/Service in the namespace, including manager's/nginx's/
// utility-tools-hub's own (statically defined outside platform-apps.json). Without this check, a
// platform app whose name happens to collide with one of those would silently replace it via
// applyDeployment/applyService's exists-then-replace logic, or delete it on app removal. A
// resource is only "ours" — and therefore safe to reuse the name for — if it carries the
// managed-by label this module itself sets in appLabels(); anything else (found or not found) is
// left alone.
async function collidesWithForeignResource(name: string): Promise<boolean> {
  async function isForeign(read: () => Promise<unknown>): Promise<boolean> {
    try {
      const resource = unwrap<k8s.V1Deployment | k8s.V1Service>(await read());
      return resource.metadata?.labels?.['managed-by'] !== 'script-manager-platform-apps';
    } catch (err: any) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }
  const [depForeign, svcForeign] = await Promise.all([
    isForeign(() => apps.readNamespacedDeployment(name, NAMESPACE)),
    isForeign(() => core.readNamespacedService(name, NAMESPACE)),
  ]);
  return depForeign || svcForeign;
}

// Exported for the create-time name check in routes/platform-apps.ts — must be called (and
// rejected on true) before any applyDeployment/applyService/deleteApp call for a name that isn't
// already a known PlatformAppConfig.
export async function isNameTaken(name: string): Promise<boolean> {
  return collidesWithForeignResource(name);
}

export async function applyDeployment(config: PlatformAppConfig): Promise<void> {
  const spec = buildDeploymentSpec(config);
  if (await deploymentExists(config.name)) {
    await apps.replaceNamespacedDeployment(config.name, NAMESPACE, spec);
  } else {
    await apps.createNamespacedDeployment(NAMESPACE, spec);
  }
}

export async function applyService(config: PlatformAppConfig): Promise<void> {
  const spec = buildServiceSpec(config);
  if (await serviceExists(config.name)) {
    await core.replaceNamespacedService(config.name, NAMESPACE, spec);
  } else {
    await core.createNamespacedService(NAMESPACE, spec);
  }
}

const MERGE_PATCH_OPTS = { headers: { 'Content-Type': 'application/merge-patch+json' } };

export async function scaleDeployment(name: string, replicas: number): Promise<void> {
  await apps.patchNamespacedDeployment(
    name, NAMESPACE, { spec: { replicas } },
    undefined, undefined, undefined, undefined, undefined, MERGE_PATCH_OPTS,
  );
}

// Forces a rollout even though the image tag is unchanged — imagePullPolicy: Never means a plain
// restart won't otherwise pick up a freshly rebuilt same-tag image. Same trick `kubectl rollout
// restart` uses under the hood (touch a pod-template annotation).
export async function forceRollout(name: string): Promise<void> {
  await apps.patchNamespacedDeployment(
    name, NAMESPACE,
    { spec: { template: { metadata: { annotations: { 'script-manager/restartedAt': new Date().toISOString() } } } } },
    undefined, undefined, undefined, undefined, undefined, MERGE_PATCH_OPTS,
  );
}

export async function deleteApp(name: string): Promise<void> {
  await apps.deleteNamespacedDeployment(name, NAMESPACE).catch((err: any) => { if (!isNotFound(err)) throw err; });
  await core.deleteNamespacedService(name, NAMESPACE).catch((err: any) => { if (!isNotFound(err)) throw err; });
}

export async function getStatus(name: string): Promise<PlatformAppRuntimeStatus> {
  let dep: k8s.V1Deployment;
  try {
    dep = unwrap<k8s.V1Deployment>(await apps.readNamespacedDeployment(name, NAMESPACE));
  } catch (err: any) {
    if (isNotFound(err)) return 'not_deployed';
    return 'error';
  }
  const desired = dep.spec?.replicas ?? 0;
  const ready   = dep.status?.readyReplicas ?? 0;
  if (desired === 0) return 'stopped';
  return ready >= desired ? 'running' : 'error';
}

async function getPodName(name: string): Promise<string | null> {
  const list = unwrap<k8s.V1PodList>(
    await core.listNamespacedPod(NAMESPACE, undefined, undefined, undefined, undefined, `app=${name}`),
  );
  return list.items?.[0]?.metadata?.name ?? null;
}

export async function getLogs(name: string, tailLines = 200): Promise<string> {
  const podName = await getPodName(name);
  if (!podName) return '';
  try {
    return unwrap<string>(
      await core.readNamespacedPodLog(podName, NAMESPACE, undefined, undefined, undefined, undefined, undefined, undefined, undefined, tailLines),
    );
  } catch (err: any) {
    return `(failed to read logs: ${err?.message || err})`;
  }
}
