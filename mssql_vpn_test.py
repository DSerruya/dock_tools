#!/usr/bin/env python3
"""
Standalone MSSQL-over-OpenVPN connectivity test — runs directly on the server
host (no Docker) so its behavior can be compared against the containerized
"SQL over VPN Test" in the Script Manager UI (manager/src/routes/admin.ts).

Prompts for an .ovpn config and MSSQL connection parameters, connects the
tunnel, checks TCP reachability, then runs the query via bsqldb (FreeTDS) —
the same client the containerized test uses, for an apples-to-apples result.

Requires root (openvpn needs to create a tun device) plus:
    Debian/Ubuntu: sudo apt-get install -y openvpn freetds-bin
    macOS (Homebrew): brew install openvpn freetds
"""

import getpass
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

VPN_HANDSHAKE_TIMEOUT = 30  # seconds to wait for "Initialization Sequence Completed"
TCP_CHECK_TIMEOUT = 5
MSSQL_SEP = '\t'


def fail(msg):
    print(f"\n✗ {msg}", file=sys.stderr)
    sys.exit(1)


def check_prereqs():
    if os.geteuid() != 0:
        fail("Must run as root (openvpn needs to create a tun device). Re-run with sudo.")
    if not shutil.which('openvpn'):
        fail("openvpn not found on PATH. Install it (apt-get install -y openvpn / brew install openvpn).")
    if not shutil.which('bsqldb'):
        fail("bsqldb not found on PATH (part of FreeTDS). Install it (apt-get install -y freetds-bin / brew install freetds).")


def prompt_ovpn_config():
    print("\n--- OpenVPN configuration ---")
    path = input("Path to .ovpn file (leave blank to paste its contents instead): ").strip()
    if path:
        p = Path(path).expanduser()
        if not p.is_file():
            fail(f"No such file: {p}")
        return p.read_text()

    print("Paste the full .ovpn contents (including any inline <ca>/<cert>/<key> blocks).")
    print("Finish with a line containing only 'EOF':")
    lines = []
    while True:
        try:
            line = input()
        except EOFError:
            break
        if line.strip() == 'EOF':
            break
        lines.append(line)
    content = '\n'.join(lines)
    if not content.strip():
        fail("No .ovpn content provided.")
    return content


def prompt_mssql_params():
    print("\n--- MSSQL connection ---")
    host = input("Host: ").strip()
    port = input("Port [1433]: ").strip() or '1433'
    database = input("Database: ").strip()
    username = input("Username: ").strip()
    password = getpass.getpass("Password: ")
    query = input("Query: ").strip()
    if not all([host, port, database, username, query]):
        fail("Host, port, database, username and query are all required.")
    return dict(host=host, port=port, database=database, username=username, password=password, query=query)


def start_vpn(ovpn_text, workdir):
    config_path = workdir / 'config.ovpn'
    config_path.write_text(ovpn_text)
    os.chmod(config_path, 0o600)
    log_path = workdir / 'openvpn.log'

    print(f"\nStarting openvpn (log: {log_path})...")
    proc = subprocess.Popen(['openvpn', '--config', str(config_path), '--log', str(log_path)])

    deadline = time.time() + VPN_HANDSHAKE_TIMEOUT
    connected = False
    while time.time() < deadline:
        if proc.poll() is not None:
            break  # openvpn exited early — bad config, auth failure, etc.
        if log_path.exists() and 'Initialization Sequence Completed' in log_path.read_text(errors='ignore'):
            connected = True
            break
        time.sleep(1)

    if not connected:
        tail = log_path.read_text(errors='ignore')[-4000:] if log_path.exists() else '(no log yet)'
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        fail(f"VPN did not connect within {VPN_HANDSHAKE_TIMEOUT}s.\n--- tail of {log_path} ---\n{tail}")

    print("✓ VPN connected (Initialization Sequence Completed).")
    return proc


def check_tcp_reachable(host, port):
    print(f"\nChecking TCP reachability to {host}:{port} (timeout {TCP_CHECK_TIMEOUT}s)...")
    try:
        with socket.create_connection((host, int(port)), timeout=TCP_CHECK_TIMEOUT):
            print(f"✓ {host}:{port} is reachable.")
    except OSError as e:
        print(f"✗ Could not reach {host}:{port}: {e}. Continuing to attempt the DB connection anyway.")


def run_bsqldb_query(params, workdir):
    host, port, database, username, password, query = (
        params['host'], params['port'], params['database'],
        params['username'], params['password'], params['query'],
    )

    freetds_conf = workdir / 'freetds.conf'
    tdsdump_path = workdir / 'tdsdump.log'
    freetds_conf.write_text(f"[sqltarget]\n    host = {host}\n    port = {port}\n    tds version = auto\n")

    env = os.environ.copy()
    env['FREETDSCONF'] = str(freetds_conf)
    env['TDSDUMP'] = str(tdsdump_path)

    print(f"\nConnecting to MSSQL at {host}:{port}/{database} as '{username}' via bsqldb...")
    return subprocess.run(
        ['bsqldb', '-S', 'sqltarget', '-D', database, '-U', username, '-P', password, '-t', MSSQL_SEP, '-v'],
        input=f"{query}\ngo\n",
        capture_output=True, text=True, env=env,
    )


def print_result(proc, workdir):
    print(f"\n--- bsqldb exit code: {proc.returncode} ---")
    if proc.stdout.strip():
        print("--- stdout (data) ---")
        print(proc.stdout)
    if proc.stderr.strip():
        print("--- stderr (metadata / errors) ---")
        print(proc.stderr)

    if proc.returncode != 0:
        tdsdump_path = workdir / 'tdsdump.log'
        if tdsdump_path.exists() and tdsdump_path.stat().st_size > 0:
            print("\n--- FreeTDS wire-level trace (tail) ---")
            print(tdsdump_path.read_text(errors='ignore')[-4000:])


def stop_vpn(proc):
    print("\nStopping VPN...")
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


def main():
    check_prereqs()
    ovpn_text = prompt_ovpn_config()
    params = prompt_mssql_params()

    with tempfile.TemporaryDirectory(prefix='mssql-vpn-test-') as tmp:
        workdir = Path(tmp)
        os.chmod(workdir, 0o700)
        vpn_proc = start_vpn(ovpn_text, workdir)
        try:
            check_tcp_reachable(params['host'], params['port'])
            result = run_bsqldb_query(params, workdir)
            print_result(result, workdir)
        finally:
            stop_vpn(vpn_proc)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted.")
        sys.exit(130)
