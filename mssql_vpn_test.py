#!/usr/bin/env python3
"""
Standalone MSSQL-over-OpenVPN connectivity test — runs directly on the server
host (no Docker) so its behavior can be compared against the containerized
"SQL over VPN Test" in the Script Manager UI (manager/src/routes/admin.ts).

Prompts for an .ovpn config and MSSQL connection parameters, connects the
tunnel, checks TCP reachability, then runs the query — via bsqldb (FreeTDS,
the same client the containerized test uses) on Linux/macOS, or via sqlcmd
on Windows since FreeTDS isn't native there.

Requires admin/root (openvpn needs to create a network adapter) plus:
    Debian/Ubuntu: sudo apt-get install -y openvpn freetds-bin
    macOS (Homebrew): brew install openvpn freetds
    Windows: openvpn.exe and sqlcmd are auto-installed via `winget` if
        missing (packages OpenVPNTechnologies.OpenVPN and Microsoft.Sqlcmd).
        Run this script from an elevated ("Run as Administrator") shell —
        Windows has no `sudo`, so don't prefix the command with one. If
        winget itself isn't available, install manually:
        https://openvpn.net/community-downloads/
        https://learn.microsoft.com/en-us/sql/tools/sqlcmd/sqlcmd-download-install
"""

import getpass
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

IS_WINDOWS = platform.system() == 'Windows'

VPN_HANDSHAKE_TIMEOUT = 30  # seconds to wait for "Initialization Sequence Completed"
TCP_CHECK_TIMEOUT = 5
MSSQL_SEP = '\t'

WINGET_PACKAGES = {
    'openvpn': 'OpenVPNTechnologies.OpenVPN',
    'sqlcmd':  'Microsoft.Sqlcmd',
}


def fail(msg):
    print(f"\n✗ {msg}", file=sys.stderr)
    sys.exit(1)


def is_admin():
    if IS_WINDOWS:
        import ctypes
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    return os.geteuid() == 0


# A process's PATH is a snapshot taken at startup — winget updates the
# registry, not this process's environment, so a tool it just installed
# stays invisible to shutil.which() until PATH is re-read from there.
def refresh_windows_path():
    import winreg

    def read_reg_path(root, subkey):
        try:
            with winreg.OpenKey(root, subkey) as key:
                value, _ = winreg.QueryValueEx(key, 'Path')
                return value
        except OSError:
            return ''

    machine_path = read_reg_path(winreg.HKEY_LOCAL_MACHINE, r'SYSTEM\CurrentControlSet\Control\Session Manager\Environment')
    user_path    = read_reg_path(winreg.HKEY_CURRENT_USER, r'Environment')
    # The official OpenVPN MSI (which the winget package just wraps) has used
    # this fixed install path across releases but has not reliably added
    # itself to PATH — included as a last-resort fallback alongside whatever
    # the registry now reports.
    known_dirs = [r'C:\Program Files\OpenVPN\bin']

    parts = os.environ.get('PATH', '').split(';') + machine_path.split(';') + user_path.split(';') + known_dirs
    seen = set()
    deduped = []
    for p in parts:
        if p and p not in seen:
            seen.add(p)
            deduped.append(p)
    os.environ['PATH'] = ';'.join(deduped)


def winget_install(package_id):
    print(f"Installing {package_id} via winget...")
    try:
        proc = subprocess.run(
            ['winget', 'install', '--id', package_id, '-e', '--silent',
             '--accept-package-agreements', '--accept-source-agreements'],
            capture_output=True, text=True, timeout=300,
        )
    except FileNotFoundError:
        print("winget itself is not available on this machine.")
        return False
    except subprocess.TimeoutExpired:
        print("winget install timed out after 5 minutes.")
        return False
    output = (proc.stdout or '') + (proc.stderr or '')
    if output.strip():
        print(output.strip())
    if proc.returncode != 0:
        print(f"winget exited with code {proc.returncode}.")
        return False
    return True


# Python's ssl module validates certs through its own bundled OpenSSL, which
# is stricter than Windows' native trust store about some legacy/corporate-
# proxy CA certs (e.g. a Basic Constraints extension not marked critical) —
# real-world case: urllib raised CERTIFICATE_VERIFY_FAILED on a Windows box
# behind TLS-inspecting middleware whose root CA Windows itself trusts fine.
# curl.exe (built into Windows 10 1803+/Server 2019+) uses WinHTTP/Schannel,
# the same OS-native validation a browser would use, so it succeeds where
# urllib doesn't — without weakening certificate verification to get there.
def win_curl(args, **kwargs):
    proc = subprocess.run(['curl.exe', '-sSL', *args], capture_output=True, timeout=kwargs.get('timeout', 120))
    if proc.returncode != 0:
        raise RuntimeError(f"curl.exe failed (exit {proc.returncode}): {proc.stderr.decode(errors='ignore').strip()}")
    return proc


def http_get(url, headers=None):
    if IS_WINDOWS and shutil.which('curl.exe'):
        args = []
        for k, v in (headers or {}).items():
            args += ['-H', f'{k}: {v}']
        args.append(url)
        return win_curl(args, timeout=30).stdout

    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', **(headers or {})})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def download_to(url, dest_path):
    if IS_WINDOWS and shutil.which('curl.exe'):
        win_curl(['-o', str(dest_path), url], timeout=120)
        return

    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=120) as resp, open(dest_path, 'wb') as f:
        shutil.copyfileobj(resp, f)


# winget isn't present on plain Windows Server (it ships via the Microsoft
# Store app, which Server editions lack) — these resolve the *current*
# installer URL at run time instead of a version hardcoded here, since a
# pinned version number would go stale the next time either project ships.
def find_openvpn_msi_url():
    html = http_get('https://openvpn.net/community-downloads/').decode('utf-8', errors='ignore')
    matches = re.findall(r'https://swupdate\.openvpn\.org/community/releases/OpenVPN-[\d.]+-I\d+-amd64\.msi', html)
    return matches[0] if matches else None


def find_sqlcmd_msi_url():
    data = json.loads(http_get(
        'https://api.github.com/repos/microsoft/go-sqlcmd/releases/latest',
        headers={'Accept': 'application/vnd.github+json'},
    ))
    for asset in data.get('assets', []):
        if asset.get('name') == 'sqlcmd-amd64.msi':
            return asset.get('browser_download_url')
    return None


MSI_FINDERS = {
    'openvpn': find_openvpn_msi_url,
    'sqlcmd':  find_sqlcmd_msi_url,
}


def msi_install(msi_path):
    print(f"Running silent install: msiexec /i {msi_path} /qn /norestart ...")
    proc = subprocess.run(['msiexec', '/i', str(msi_path), '/qn', '/norestart'],
                           capture_output=True, text=True, timeout=300)
    if proc.stdout.strip():
        print(proc.stdout.strip())
    if proc.stderr.strip():
        print(proc.stderr.strip())
    if proc.returncode != 0:
        print(f"msiexec exited with code {proc.returncode}.")
        return False
    return True


def direct_install(command):
    print(f"Falling back to a direct download for {command} (winget unavailable)...")
    try:
        url = MSI_FINDERS[command]()
        if not url:
            print(f"Could not find a current download URL for {command}.")
            return False
        print(f"Downloading {url} ...")
        with tempfile.TemporaryDirectory(prefix='vpn-test-dl-') as tmp:
            msi_path = Path(tmp) / f"{command}.msi"
            download_to(url, msi_path)
            return msi_install(msi_path)
    except Exception as e:
        print(f"Direct download install failed: {e}")
        return False


def ensure_windows_tool(command, winget_id, manual_url):
    if shutil.which(command):
        return
    print(f"\n{command} not found on PATH.")
    installed = winget_install(winget_id)
    if not installed:
        installed = direct_install(command)
    if installed:
        refresh_windows_path()
    if not shutil.which(command):
        fail(f"{command} still not found after attempting automatic install. "
             f"Close and reopen this (elevated) shell and try again, or install manually: {manual_url}")
    print(f"✓ {command} is now available.")


def check_prereqs():
    if IS_WINDOWS:
        if not is_admin():
            fail("Must run from an elevated shell (right-click PowerShell/cmd → 'Run as Administrator') — "
                 "openvpn needs to install a TAP/Wintun adapter. Windows has no `sudo`.")
        ensure_windows_tool('openvpn', WINGET_PACKAGES['openvpn'], 'https://openvpn.net/community-downloads/')
        ensure_windows_tool('sqlcmd', WINGET_PACKAGES['sqlcmd'],
                             'https://learn.microsoft.com/en-us/sql/tools/sqlcmd/sqlcmd-download-install')
    else:
        if not is_admin():
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


# sqlcmd -C trusts the server's TLS certificate — the ODBC 18 driver it ships
# with defaults to enforcing full certificate validation, which would
# otherwise fail against a client's self-signed/internal-CA SQL Server; that
# tradeoff is fine for a manual diagnostic run.
def run_sqlcmd_query(params):
    host, port, database, username, password, query = (
        params['host'], params['port'], params['database'],
        params['username'], params['password'], params['query'],
    )
    server = f"{host},{port}"
    print(f"\nConnecting to MSSQL at {server}/{database} as '{username}' via sqlcmd...")
    return subprocess.run(
        ['sqlcmd', '-S', server, '-d', database, '-U', username, '-P', password,
         '-Q', query, '-s', MSSQL_SEP, '-W', '-C'],
        capture_output=True, text=True,
    )


def run_query(params, workdir):
    return run_sqlcmd_query(params) if IS_WINDOWS else run_bsqldb_query(params, workdir)


def print_result(proc, workdir):
    client = 'sqlcmd' if IS_WINDOWS else 'bsqldb'
    print(f"\n--- {client} exit code: {proc.returncode} ---")
    if proc.stdout.strip():
        print("--- stdout (data) ---")
        print(proc.stdout)
    if proc.stderr.strip():
        print("--- stderr (metadata / errors) ---")
        print(proc.stderr)

    if not IS_WINDOWS and proc.returncode != 0:
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
            result = run_query(params, workdir)
            print_result(result, workdir)
        finally:
            stop_vpn(vpn_proc)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted.")
        sys.exit(130)
