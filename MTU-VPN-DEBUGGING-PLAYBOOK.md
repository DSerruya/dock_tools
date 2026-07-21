# SQL-over-VPN "hangs after login" — Diagnosis & Fix Playbook

Written up from a live debugging session on the `support-tools` VM (Ubuntu-on-Hyper-V-on-Hetzner), so the same steps/tools can be reapplied to any other project with a similar OpenVPN + on-prem-DB setup.

## The symptom

A query over an OpenVPN tunnel to an on-prem MSSQL server would:
- Connect over TCP fine
- Complete the *entire* TDS login handshake (multiple successful round trips: server hello, `LOGINACK`, "Changed database context to 'onebeat'", env-change negotiation)
- Then die the instant the actual query's result set tried to come back — `PENDING → READING → DEAD`, "Read attempt when state is TDS_DEAD"

**The key clue:** small packets (login/handshake) always worked; it only broke once a real, multi-packet response had to travel back through the tunnel. That rules out "port blocked" — a blocked port fails at the TCP handshake, not four round-trips into a successful login.

## Root cause: a Path-MTU-Discovery (PMTUD) blackhole

Standard TCP relies on ICMP "fragmentation needed" replies to discover the real usable packet size on a path (PMTUD). Many cloud/VPN paths **silently drop ICMP** instead of replying — so instead of TCP cleanly stepping down to a smaller packet size, oversized packets just vanish with no signal back to either side. Small packets (a TCP handshake, TDS login) never hit this ceiling; a real query response (bigger, multi-segment) does, and the connection just stalls and eventually gets torn down.

This is *not* the same as "MTU is set wrong and everything breaks" — it's specifically insidious because everything *looks* fine right up until a payload crosses the invisible threshold.

### How we confirmed it (in order — cheapest/most diagnostic first)

1. **Interface MTUs at every layer** — `ip link show` on the host and inside the VPN-connected container. In our case `tun0` reported `mtu 1500` — the same as `eth0`. That's a red flag by itself: OpenVPN's own encapsulation overhead (UDP/TCP header + OpenVPN opcode/session bytes + HMAC, typically 40-100 bytes) has to fit *under* whatever the physical link's real MTU is. If `tun0` claims the same 1500 as the physical link, there's no room left for that overhead — the "lie" in the interface's own reported MTU.

2. **PMTUD probe: `ping -M do` at decreasing payload sizes.** `-M do` sets the IP don't-fragment bit, so a failure means "this exact size cannot get through," not "it got fragmented and reassembled fine."
   ```bash
   ping -M do -c 3 -w 5 -s 1472 <db-host>   # then 1400, 1372, 1300, 1200...
   ```
   Add 28 bytes (IP + ICMP headers) to the payload size that works to get the real usable MTU. In our case: 1472 and 1400 got **zero ICMP response at all** (confirming ICMP truly is blackholed, not just slow); 1372 (→ MTU 1400) was the first size that got through cleanly. So the tunnel's *real* usable MTU was ~1400, while `tun0` was claiming 1500 — exactly the mismatch from step 1.

3. **Correlate with a trivial vs. real query.** `SELECT 1` (tiny response) succeeds; the actual multi-column, multi-row query dies the same way every time. This nails down "response size triggers it," ruling out auth, permissions, or the DB/port itself.

## The two candidate fixes — and why only one worked

Both clamp TCP's negotiated segment size (MSS) so it can never produce a packet the path can't carry, sidestepping the need for PMTUD to work at all. They are **not equivalent**:

| Fix | Mechanism | Result here |
|---|---|---|
| `iptables -t mangle -A OUTPUT -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu` | Clamps MSS to whatever path MTU is **already cached in the kernel's routing table** — a cache populated by real ICMP feedback | **Did nothing.** Since ICMP is fully blackholed on this path, the kernel never learns a smaller PMTU, so the cache stays at the interface's nominal (wrong) MTU and the clamp is a no-op. |
| OpenVPN `--mssfix <n>` (e.g. `1360`) | A **static, unconditional** clamp applied by OpenVPN itself to traffic through the tunnel — doesn't depend on any PMTU cache or ICMP at all | **Fixed it.** The query completed once mssfix was set below the real usable MTU found in step 2 (with a little safety margin — TCP/application framing overhead isn't identical to a bare ICMP echo, so don't cut it exactly to the probed boundary). |

**Takeaway for any similar setup:** if you've confirmed ICMP is blackholed on the path (step 2 above showed *zero* replies, not just packet loss), don't reach for a PMTU-cache-dependent fix (`clamp-mss-to-pmtu`, relying on OS-level Path MTU Discovery) — it structurally cannot work. Use a static clamp instead (OpenVPN's `--mssfix`/`--fragment`, or `iptables ... --set-mss <fixed-number>`).

## Tooling built (in `docker_support_env`)

- **`manager/src/routes/admin.ts`** — the Admin → SQL Test feature now, on every run:
  - Logs `ip link show` (interface MTUs, esp. `tun0`) right after VPN connect
  - Runs the `ping -M do` step-down probe automatically and logs a verdict
  - Offers two opt-in flags to test a fix live, without editing the uploaded `.ovpn`: `mssFix` (passes `--mssfix <n>` to the OpenVPN invocation) and `clampMssToPmtu` (applies the iptables clamp) — both wired into the UI (checkbox + input) and persisted via the existing Save/Load Parameters JSON feature
  - Container packages extended with `iputils` (Alpine's busybox `ping` doesn't support `-M do`) and `iptables`
- **`check-health.sh`** — post-VM-restart stack health check (Docker daemon, core containers, manager reachability, script containers, Ollama, the health-check cron addon)
- **`check-sql-vpn-mtu.sh`** — the same MTU/PMTUD/response-size diagnostic (steps 1–3 above), runnable standalone via SSH against an already-running `admin-sqltest` container, printing a plain-language verdict

## An architectural gap this surfaced — worth checking in any project with the same shape

The diagnostic tool's container builds its own throwaway `openvpn --config ...` invocation, which is where the `--mssfix` flag got added. But **real, permanently-running scripts** in this project connect through a *different* mechanism: a per-script VPN "sidecar" container (`manager/src/services/dockerService.ts`, `startVpnSidecar`) that the actual script container shares a network namespace with. That sidecar runs a bare `openvpn --config /vpn/config.ovpn` with **no `--mssfix` support at all** — the identical gap the SQL-test tool had before this fix.

**In other words: fixing the diagnostic tool does not automatically fix a real deployed script hitting the same blackholed path.** If a production script's own VPN sidecar reaches a similarly-misconfigured tunnel, it will silently hang the same way — and until an equivalent `mssfix` option is added to *that* container-creation code path (plus a way to set a per-script value, mirroring what the SQL-test flags already do), the only fixes available today are diagnostic, not production-applied.

## Playbook: applying this to another project

1. **Reproduce the "small-packets-fine, real-response-dies" signature first.** If a query hangs but a trivial one (`SELECT 1`) works, and the connection/login itself completed, you're very likely looking at the same class of bug — don't waste time on port/firewall/credential checks first.
2. **Check every interface's reported MTU along the path** (physical host NIC, any vSwitch/hypervisor layer, container bridge, VPN's `tun`/`tap` interface). Look for the VPN interface claiming the *same* MTU as the physical layer underneath it — that's the giveaway.
3. **Run the `ping -M do` step-down probe** against the actual DB/service host, from inside whatever container/namespace the real traffic goes through. Note whether you get *any* ICMP reply at the failing sizes — no reply at all means PMTUD is genuinely blackholed, not just that the path is slow/lossy.
4. **Apply a static MSS clamp**, not a PMTU-cache-dependent one: OpenVPN `--mssfix`/`--fragment` if you control the VPN client invocation, or `iptables ... TCPMSS --set-mss <n>` (a fixed value, not `--clamp-mss-to-pmtu`) if you don't.
5. **Find wherever the VPN tunnel is actually established for the real running workload** (not just a diagnostic/admin tool) — it may be a completely separate code path from anything you used to test the fix, as it was here. Confirm the fix needs to be applied there too before considering it "solved" for production.
