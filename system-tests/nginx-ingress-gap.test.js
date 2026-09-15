// System test documenting a known gap: nginx (k8s/configmap-nginx.yaml) is the shared entrypoint
// for manager, but it does NOT proxy to utility-tools-hub or to any Platform App — that upstream
// simply isn't there. Today hub is ClusterIP-only and reached some other way (unconfirmed —
// possibly a Cloudflare Tunnel elsewhere, per the utility-tools-hub-migration memory), and a
// Platform App gets external reach only via its own `hostPort` or a hand-edited nginx ConfigMap.
//
// This test is a deliberate trip-wire, not a bug report: if someone adds hub (or platform-app)
// routing to nginx.conf, this test SHOULD start failing — that's the signal to update it, not a
// regression to "fix" by reverting the nginx change.

const fs = require('fs');
const path = require('path');

const nginxYaml = fs.readFileSync(
  path.join(__dirname, '..', 'k8s', 'configmap-nginx.yaml'), 'utf8',
);

describe('nginx entrypoint (k8s/configmap-nginx.yaml)', () => {
  test('proxies to manager', () => {
    expect(nginxYaml).toMatch(/upstream\s+manager\s*\{/);
    expect(nginxYaml).toMatch(/proxy_pass\s+http:\/\/manager;/);
  });

  test('has exactly one upstream block today (manager only)', () => {
    const upstreamBlocks = nginxYaml.match(/upstream\s+\w+\s*\{/g) || [];
    expect(upstreamBlocks).toEqual(['upstream manager {']);
  });

  test('does not yet proxy to utility-tools-hub or any other named app — external reach for those is not automatic', () => {
    expect(nginxYaml).not.toMatch(/utility-tools-hub/);
    expect(nginxYaml).not.toMatch(/upstream\s+hub\s*\{/);
  });
});
