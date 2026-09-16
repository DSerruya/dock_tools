// System test documenting a known gap: nginx (nginx/nginx.conf) is the shared entrypoint for
// manager, but it does NOT proxy to utility-tools-hub or to any Platform App — that upstream
// simply isn't there. A Platform App gets external reach only via its own `hostPort` (published
// directly on the host, see dockerPlatformAppService.ts) or a hand-edited nginx.conf; without
// hostPort it's reachable only from other containers on the same Docker network (script-network).
//
// This test is a deliberate trip-wire, not a bug report: if someone adds hub (or platform-app)
// routing to nginx.conf, this test SHOULD start failing — that's the signal to update it, not a
// regression to "fix" by reverting the nginx change.

const fs = require('fs');
const path = require('path');

const nginxConf = fs.readFileSync(
  path.join(__dirname, '..', 'nginx', 'nginx.conf'), 'utf8',
);

describe('nginx entrypoint (nginx/nginx.conf)', () => {
  test('proxies to manager', () => {
    expect(nginxConf).toMatch(/upstream\s+manager\s*\{/);
    expect(nginxConf).toMatch(/proxy_pass\s+http:\/\/manager;/);
  });

  test('has exactly one upstream block today (manager only)', () => {
    const upstreamBlocks = nginxConf.match(/upstream\s+\w+\s*\{/g) || [];
    expect(upstreamBlocks).toEqual(['upstream manager {']);
  });

  test('does not yet proxy to utility-tools-hub or any other named app — external reach for those is not automatic', () => {
    expect(nginxConf).not.toMatch(/utility-tools-hub/);
    expect(nginxConf).not.toMatch(/upstream\s+hub\s*\{/);
  });
});
