from fpdf import FPDF
from fpdf.enums import XPos, YPos

class PDF(FPDF):
    def header(self):
        self.set_font("Helvetica", "B", 10)
        self.set_fill_color(30, 30, 30)
        self.set_text_color(255, 255, 255)
        self.cell(0, 10, "Hyper-V VM Creation  |  External & Internal Network  |  Mac Keyboard", align="C", fill=True,
                  new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        self.ln(2)

    def footer(self):
        self.set_y(-12)
        self.set_font("Helvetica", "I", 8)
        self.set_text_color(120, 120, 120)
        self.cell(0, 10, f"Page {self.page_no()}", align="C")

    def phase_title(self, text):
        self.ln(4)
        self.set_fill_color(20, 90, 160)
        self.set_text_color(255, 255, 255)
        self.set_font("Helvetica", "B", 11)
        self.cell(0, 8, f"  {text}", fill=True, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        self.ln(2)
        self.set_text_color(0, 0, 0)

    def highlight_title(self, text, color=(0, 130, 80)):
        self.ln(4)
        self.set_fill_color(*color)
        self.set_text_color(255, 255, 255)
        self.set_font("Helvetica", "B", 11)
        self.cell(0, 8, f"  {text}", fill=True, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        self.ln(2)
        self.set_text_color(0, 0, 0)

    def body(self, text):
        self.set_font("Helvetica", "", 9)
        self.set_text_color(40, 40, 40)
        self.multi_cell(0, 5, text, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        self.set_text_color(0, 0, 0)

    def bullet(self, items):
        self.set_font("Helvetica", "", 9)
        self.set_text_color(40, 40, 40)
        for item in items:
            self.cell(5)
            self.multi_cell(0, 5, item, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        self.set_text_color(0, 0, 0)

    def note(self, text):
        self.set_fill_color(255, 248, 220)
        self.set_font("Helvetica", "I", 9)
        self.set_text_color(100, 70, 0)
        self.multi_cell(0, 5, f"  Note: {text}", fill=True, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        self.set_text_color(0, 0, 0)
        self.ln(1)

    def warning_box(self, text):
        self.set_fill_color(255, 235, 235)
        self.set_font("Helvetica", "B", 9)
        self.set_text_color(160, 0, 0)
        self.multi_cell(0, 5, f"  ! {text}", fill=True, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        self.set_text_color(0, 0, 0)
        self.ln(1)

    def info_box(self, text):
        self.set_fill_color(230, 244, 255)
        self.set_font("Helvetica", "", 9)
        self.set_text_color(0, 60, 120)
        self.multi_cell(0, 5, f"  {text}", fill=True, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        self.set_text_color(0, 0, 0)
        self.ln(1)

    def code_block(self, lines):
        self.set_fill_color(22, 27, 34)
        self.set_text_color(180, 230, 140)
        self.set_font("Courier", "", 7.5)
        for line in lines:
            if line == "":
                self.cell(0, 3, "", fill=True, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
            elif line.startswith("#"):
                self.set_text_color(130, 160, 130)
                self.cell(0, 4.5, f"  {line}", fill=True, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
                self.set_text_color(180, 230, 140)
            else:
                self.cell(0, 4.5, f"  {line}", fill=True, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        self.ln(2)
        self.set_text_color(0, 0, 0)
        self.set_fill_color(255, 255, 255)

    def table(self, headers, rows, col_widths):
        self.set_font("Helvetica", "B", 9)
        self.set_fill_color(20, 90, 160)
        self.set_text_color(255, 255, 255)
        for h, w in zip(headers, col_widths):
            self.cell(w, 7, f"  {h}", fill=True, border=0)
        self.ln()
        self.set_text_color(0, 0, 0)
        for i, row in enumerate(rows):
            self.set_fill_color(235, 243, 255) if i % 2 == 0 else self.set_fill_color(255, 255, 255)
            self.set_font("Helvetica", "", 9)
            for cell, w in zip(row, col_widths):
                self.cell(w, 6, f"  {cell}", fill=True, border=0)
            self.ln()
        self.ln(3)


pdf = PDF()
pdf.set_auto_page_break(auto=True, margin=15)
pdf.add_page()
pdf.set_margins(15, 15, 15)

# ── Title ─────────────────────────────────────────────────────────────────────
pdf.set_font("Helvetica", "B", 18)
pdf.set_text_color(20, 90, 160)
pdf.cell(0, 10, "Hyper-V VM Creation", align="C", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
pdf.set_font("Helvetica", "", 12)
pdf.set_text_color(60, 60, 60)
pdf.cell(0, 7, "PowerShell guide  |  External & Internal network modes  |  Mac keyboard support",
         align="C", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
pdf.ln(3)
pdf.set_draw_color(20, 90, 160)
pdf.set_line_width(0.8)
pdf.line(15, pdf.get_y(), 195, pdf.get_y())
pdf.ln(5)

pdf.body(
    "This guide covers creating an Ubuntu Server VM on Hyper-V using PowerShell, "
    "with two network modes: External (local server with router access) and Internal "
    "(cloud-hosted server with no router access, using Windows NAT). "
    "Also covers Mac keyboard support via Enhanced Session Mode and xRDP, "
    "and fixing eth0 autoconfiguration failures during Ubuntu install."
)
pdf.ln(1)

# ── Network mode overview ─────────────────────────────────────────────────────
pdf.phase_title("Network Mode Overview")
pdf.body("Set $networkMode in the script config section before running:")
pdf.table(
    ["Mode", "When to use", "VM internet access", "Mac connects via"],
    [
        ["External", "Local server with router/DHCP", "Direct via LAN",          "VM IP:3389"],
        ["Internal", "Cloud server, no router access", "NAT through Windows host", "Server public IP:3390"],
    ],
    [25, 65, 50, 42],
)
pdf.info_box(
    "In Internal mode the script automatically: creates the Internal switch, assigns the host "
    "gateway IP (192.168.100.1) to the vEthernet adapter, creates a Windows NAT, and adds a "
    "port-forward rule so that port 3390 on the Windows host routes to port 3389 on the VM."
)

# ── Prerequisites ─────────────────────────────────────────────────────────────
pdf.phase_title("Prerequisites")
pdf.body("Verify Hyper-V is enabled. If not, enable it and reboot:")
pdf.code_block([
    "Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V",
    "# Enable if needed:",
    "Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All",
])

# ── Phase 1 ───────────────────────────────────────────────────────────────────
pdf.phase_title("Phase 1 - Config Block (edit before running)")
pdf.body("Open Create-UbuntuVM-v2.ps1 and set these variables at the top of the CONFIG section:")
pdf.code_block([
    '$networkMode = "Internal"     # "External" or "Internal"',
    "",
    "# VM settings",
    '$vmName    = "UbuntuServer"',
    '$isoPath   = "C:\\ISOs\\ubuntu-24.04-live-server-amd64.iso"',
    '$vhdSizeGB = 40GB',
    '$ramGB     = 2GB',
    '$cpuCount  = 2',
    "",
    "# External mode only",
    '$nicName   = "Ethernet"       # run Get-NetAdapter to find your adapter name',
    "",
    "# Internal / NAT mode only",
    '$hostGatewayIP  = "192.168.100.1"   # host IP on the internal network',
    '$vmStaticIP     = "192.168.100.2"   # static IP to assign to Ubuntu',
    '$hostForwardPort = 3390             # port on host that forwards to VM RDP',
])

# ── Phase 2 - Internal network ────────────────────────────────────────────────
pdf.highlight_title("Phase 2 (Internal mode) - Switch, NAT, and Port Forward", color=(100, 50, 160))
pdf.body("When $networkMode is 'Internal' the script runs these steps automatically:")
pdf.code_block([
    "# 1. Create Internal virtual switch",
    'New-VMSwitch -Name "InternalSwitch" -SwitchType Internal',
    "",
    "# 2. Assign host gateway IP to the vEthernet adapter",
    '$vEthernet = Get-NetAdapter | Where-Object { $_.Name -like "*InternalSwitch*" }',
    "New-NetIPAddress -IPAddress 192.168.100.1 -PrefixLength 24 -InterfaceIndex $vEthernet.ifIndex",
    "",
    "# 3. Create NAT so the VM can reach the internet through the host",
    'New-NetNat -Name "VMNat" -InternalIPInterfaceAddressPrefix 192.168.100.0/24',
    "",
    "# 4. Port forward: host port 3390 -> VM port 3389 (xRDP)",
    "netsh interface portproxy add v4tov4 `",
    "    listenport=3390 listenaddress=0.0.0.0 `",
    "    connectport=3389 connectaddress=192.168.100.2",
    "",
    "# 5. Open the forwarded port in Windows Firewall",
    'New-NetFirewallRule -DisplayName "Hyper-V VM xRDP forward (3390)" `',
    "    -Direction Inbound -Protocol TCP -LocalPort 3390 -Action Allow",
])
pdf.note(
    "The NAT gives the VM outbound internet access (apt-get, git, etc.) through the "
    "Windows host's network connection. The port forward lets your Mac reach the VM's "
    "xRDP without the VM having a public IP."
)

# ── Phase 2b - External network ───────────────────────────────────────────────
pdf.highlight_title("Phase 2 (External mode) - Virtual Switch Validation", color=(0, 110, 60))
pdf.body("When $networkMode is 'External' the script validates the switch and adapter:")
pdf.code_block([
    "# Checks switch exists and is type External (recreates if Internal/Private)",
    "# Checks physical adapter exists and is Up",
    "# Prints host IP and gateway for reference if you need a static IP",
    "",
    "# Manual creation if running steps individually:",
    'New-VMSwitch -Name "ExternalSwitch" -NetAdapterName "Ethernet" -AllowManagementOS $true',
])
pdf.table(
    ["Switch Type", "Result in Ubuntu installer"],
    [
        ["External (correct)", "eth0 gets DHCP address automatically"],
        ["Internal or Private", "eth0 autoconfiguration fails - no DHCP"],
    ],
    [50, 132],
)

# ── Phase 3 ───────────────────────────────────────────────────────────────────
pdf.phase_title("Phase 3 - Create VHD and VM")
pdf.code_block([
    'New-Item -ItemType Directory -Path "C:\\VMs\\UbuntuServer" -Force',
    'New-VHD  -Path "C:\\VMs\\UbuntuServer\\UbuntuServer.vhdx" -SizeBytes 40GB -Dynamic',
    "",
    'New-VM -Name "UbuntuServer" -Generation 2 -MemoryStartupBytes 2GB `',
    '       -VHDPath "C:\\VMs\\UbuntuServer\\UbuntuServer.vhdx" `',
    '       -SwitchName $activeSwitch -Path "C:\\VMs"',
    "",
    'Set-VMProcessor -VMName "UbuntuServer" -Count 2',
    'Set-VMMemory    -VMName "UbuntuServer" -DynamicMemoryEnabled $true `',
    '                -MinimumBytes 512MB -MaximumBytes 4GB -StartupBytes 2GB',
    'Set-VMFirmware  -VMName "UbuntuServer" -EnableSecureBoot Off',
    'Enable-VMIntegrationService -VMName "UbuntuServer" -Name "Guest Service Interface"',
    'Set-VM -VMName "UbuntuServer" -AutomaticStartAction Start -AutomaticStartDelay 30',
    'Set-VM -VMName "UbuntuServer" -AutomaticStopAction ShutDown',
])

# ── Phase 4 - Ubuntu install network ─────────────────────────────────────────
pdf.highlight_title("Phase 4 - Ubuntu Installer Network Configuration", color=(160, 60, 0))
pdf.body("When the Ubuntu installer reaches the Network screen, configure eth0 manually "
         "based on the mode you are using:")

pdf.body("Internal mode - always use a static IP (no DHCP on internal switch):")
pdf.table(
    ["Field", "Value", "Notes"],
    [
        ["Subnet",         "192.168.100.0/24", "Fixed - matches the NAT subnet in the PS1 script"],
        ["Address",        "192.168.100.2",    "Static IP assigned to this VM"],
        ["Gateway",        "192.168.100.1",    "Windows host vEthernet adapter IP (created by script)"],
        ["Name servers",   "8.8.8.8, 8.8.4.4","Google DNS - traffic routes out via Windows NAT"],
        ["Search domains", "(leave blank)",    "Not needed unless you have a private DNS domain"],
    ],
    [32, 40, 110],
)
pdf.note("If you add a second VM later, assign it 192.168.100.3 and keep the same Gateway, "
         "Name servers, and Search domains values.")

pdf.body("External mode - if eth0 autoconfiguration fails, set a static IP using the "
         "values printed by the script (host subnet and gateway):")
pdf.table(
    ["Field", "Value", "Notes"],
    [
        ["Subnet",         "<host-subnet>",         "Shown by script at startup (e.g. 192.168.1.0/24)"],
        ["Address",        "<free IP in LAN range>","Pick any unused IP in the same subnet"],
        ["Gateway",        "<default gateway>",     "Shown by script at startup (your router IP)"],
        ["Name servers",   "8.8.8.8, 8.8.4.4",     "Or use your router IP as DNS"],
        ["Search domains", "(leave blank)",          "Not needed"],
    ],
    [32, 45, 105],
)

pdf.body("Persist static IP after install using Netplan (run inside Ubuntu):")
pdf.code_block([
    "ip link show   # find your interface name (eth0, ens3, ens18, etc.)",
    "",
    "sudo nano /etc/netplan/00-installer-config.yaml",
    "",
    "# Internal mode content:",
    "network:",
    "  version: 2",
    "  ethernets:",
    "    ens3:                           # replace with your interface name",
    "      dhcp4: false",
    "      addresses: [192.168.100.2/24]",
    "      routes:",
    "        - to: default",
    "          via: 192.168.100.1",
    "      nameservers:",
    "        addresses: [8.8.8.8, 8.8.4.4]",
    "",
    "sudo netplan apply",
    "ping 8.8.8.8   # verify internet access through NAT",
])
pdf.warning_box("Netplan YAML requires spaces for indentation, never tabs. Wrong indentation causes netplan apply to fail.")

# ── Phase 5 - Enhanced Session ────────────────────────────────────────────────
pdf.highlight_title("Phase 5 - Enhanced Session Mode (Mac Keyboard Fix)")
pdf.body("The script enables Enhanced Session Mode automatically. This switches the "
         "Hyper-V console to use RDP internally, which translates Mac keyboard layouts correctly:")
pdf.code_block([
    "Set-VMHost -EnableEnhancedSessionMode $true",
    'Set-VM -VMName "UbuntuServer" -EnhancedSessionTransportType HvSocket',
])
pdf.table(
    ["Without Enhanced Session", "With Enhanced Session"],
    [
        ["Basic video feed", "RDP protocol inside Hyper-V"],
        ["Mac keys not translated", "Mac keyboard fully mapped"],
        ["No clipboard sharing", "Clipboard works between Mac and VM"],
    ],
    [93, 93],
)

# ── Phase 6 - xRDP ────────────────────────────────────────────────────────────
pdf.highlight_title("Phase 6 - Install xRDP on Ubuntu")
pdf.body("SSH into the VM and install xRDP to enable Mac Remote Desktop access:")
pdf.code_block([
    "sudo apt-get update",
    "sudo apt-get install -y xrdp",
    "sudo systemctl enable xrdp",
    "sudo systemctl start xrdp",
    "sudo ufw allow 3389/tcp",
    "echo 'setxkbmap -layout us' >> ~/.bashrc",
    "",
    "# Print IP (for External mode)",
    "ip addr show | grep 'inet ' | grep -v 127.0.0.1",
])

# ── Phase 7 - Mac connection ──────────────────────────────────────────────────
pdf.highlight_title("Phase 7 - Connect from Mac (Microsoft Remote Desktop)")
pdf.body("Install 'Microsoft Remote Desktop' from the Mac App Store (free), then add a connection:")
pdf.table(
    ["Setting", "External mode", "Internal mode (cloud)"],
    [
        ["PC Name / IP", "VM IP (e.g. 192.168.1.50)", "Cloud server public IP"],
        ["Port",         "3389",                       "3390 (forwarded to VM)"],
        ["Username",     "Ubuntu username",            "Ubuntu username"],
        ["Password",     "Ubuntu password",            "Ubuntu password"],
    ],
    [35, 70, 77],
)
pdf.table(
    ["Mac Key", "Sent to Ubuntu"],
    [
        ["Option + key", "AltGr / special chars (|, @, #, etc.)"],
        ["Command",      "Super / Meta key"],
        ["Control",      "Ctrl"],
        ["Fn + Delete",  "Forward delete"],
    ],
    [50, 132],
)

# ── Phase 8 - Cleanup ─────────────────────────────────────────────────────────
pdf.phase_title("Phase 8 - Post-Install Cleanup")
pdf.code_block([
    "# Eject ISO",
    'Set-VMDvdDrive -VMName "UbuntuServer" -Path $null',
    "",
    "# Check port forward is active (Internal mode)",
    "netsh interface portproxy show v4tov4",
    "",
    "# Check NAT is active (Internal mode)",
    'Get-NetNat -Name "VMNat"',
    "",
    "# Verify Enhanced Session",
    'Get-VM -VMName "UbuntuServer" | Select-Object Name, EnhancedSessionTransportType',
])

# ── Manage port forwards ──────────────────────────────────────────────────────
pdf.phase_title("Managing Port Forwards (Internal mode)")
pdf.body("Useful commands for managing the port forward and NAT:")
pdf.code_block([
    "# View all port forwards",
    "netsh interface portproxy show v4tov4",
    "",
    "# Remove a port forward",
    "netsh interface portproxy delete v4tov4 listenport=3390 listenaddress=0.0.0.0",
    "",
    "# Add a second VM forward on a different port (e.g. second VM on 192.168.100.3)",
    "netsh interface portproxy add v4tov4 `",
    "    listenport=3391 listenaddress=0.0.0.0 `",
    "    connectport=3389 connectaddress=192.168.100.3",
    "",
    "# Remove NAT entirely",
    'Remove-NetNat -Name "VMNat" -Confirm:$false',
])

# ── Day-to-day ────────────────────────────────────────────────────────────────
pdf.phase_title("Useful Day-to-Day Commands")
pdf.code_block([
    "Get-VM",
    'Start-VM   -Name "UbuntuServer"',
    'Stop-VM    -Name "UbuntuServer" -Force',
    'Restart-VM -Name "UbuntuServer" -Force',
    "",
    'Checkpoint-VM -Name "UbuntuServer" -SnapshotName "Before Docker Install"',
    'Restore-VMCheckpoint -Name "UbuntuServer" -VMCheckpointName "Before Docker Install" -Confirm:$false',
    "",
    'Get-VMNetworkAdapter -VMName "UbuntuServer" | Select-Object -ExpandProperty IPAddresses',
    "",
    'Remove-VM   -Name "UbuntuServer" -Force',
    'Remove-Item -Recurse -Force "C:\\VMs\\UbuntuServer"',
])

# ── Dock Tools install ────────────────────────────────────────────────────────
pdf.highlight_title("Dock Tools - Installation Inside the VM", color=(20, 90, 160))
pdf.body("Run these commands inside the VM after Ubuntu/Debian is installed and has network access.")

pdf.body("Step 1 - Install Docker:")
pdf.code_block([
    "sudo apt-get update && sudo apt-get upgrade -y",
    "curl -fsSL https://get.docker.com | sudo sh",
    "sudo usermod -aG docker $USER",
    "newgrp docker",
])

pdf.body("Step 2 - Clone the project:")
pdf.code_block([
    "# Create /opt/dock-tools and take ownership in one step",
    "sudo mkdir -p /opt/dock-tools && sudo chown $USER:$USER /opt/dock-tools",
    "git clone https://github.com/DSerruya/dock_tools.git /opt/dock-tools",
    "cd /opt/dock-tools",
])
pdf.warning_box(
    "Permission denied on /opt? Your user may not have sudo rights. Fix as root:"
)
pdf.code_block([
    "su -                                           # switch to root",
    "mkdir -p /opt/dock-tools",
    "chown <your-username>:<your-username> /opt/dock-tools",
    "exit                                           # back to normal user",
    "git clone https://github.com/DSerruya/dock_tools.git /opt/dock-tools",
])
pdf.body("Alternative - clone into home directory (no root needed):")
pdf.code_block([
    "git clone https://github.com/DSerruya/dock_tools.git ~/dock-tools",
    "cd ~/dock-tools",
])
pdf.note("If you clone into ~/dock-tools, update HOST_SCRIPTS_DATA_PATH in .env to: "
         "/home/<your-username>/dock-tools/scripts-data")

pdf.body("Step 3 - Configure the environment file:")
pdf.code_block([
    "cp .env.example .env",
    "nano .env",
])
pdf.table(
    ["Variable", "Value", "Notes"],
    [
        ["WEBHOOK_SECRET",        "openssl rand -hex 32",        "Run that command and paste the output"],
        ["HOST_SCRIPTS_DATA_PATH","/opt/dock-tools/scripts-data","Change to ~/dock-tools/scripts-data if cloned in home"],
        ["DEFAULT_TIMEZONE",      "UTC",                         "Or your local timezone"],
        ["MANAGER_PORT",          "80",                          "HTTP port exposed by nginx"],
        ["UI_USERNAME",           "admin",                       "Web UI login username"],
        ["UI_PASSWORD",           "<strong-password>",           "Web UI login password"],
    ],
    [50, 55, 77],
)

pdf.body("Step 4 - Build and start:")
pdf.code_block([
    "cd /opt/dock-tools   # or ~/dock-tools if cloned in home",
    "docker compose up -d --build",
    "",
    "# Verify both services are running",
    "docker compose ps",
    "",
    "# Tail logs to confirm healthy startup",
    "docker compose logs -f",
])
pdf.body("Expected output from docker compose ps:")
pdf.table(
    ["Name", "Image", "Status", "Ports"],
    [
        ["manager", "dock-tools-manager", "Up", "3000/tcp (internal)"],
        ["nginx",   "nginx:alpine",       "Up", "0.0.0.0:80->80/tcp"],
    ],
    [30, 48, 20, 84],
)

pdf.body("Step 5 - Access the web UI:")
pdf.table(
    ["Mode", "URL"],
    [
        ["Internal (cloud)", "http://192.168.100.2  (from Windows host browser)"],
        ["External (LAN)",   "http://<vm-ip>        (from any machine on the LAN)"],
    ],
    [40, 142],
)

pdf.body("Credentials:")
pdf.table(
    ["Field", "Value"],
    [
        ["UI Username",    "admin"],
        ["UI Password",    "admin123"],
        ["Webhook Secret", "ac15923a20c120a97dea6c7024fc79db0e86e3cef01b49a872efac429089343d"],
    ],
    [35, 147],
)
pdf.note("These credentials were retrieved from the Rancher/Kubernetes dock-tools-secret. "
         "Keep this document secure and consider changing the UI password on a new deployment.")

pdf.body("Step 6 - Auto-start on VM reboot:")
pdf.code_block([
    "sudo systemctl enable docker",
    "",
    "sudo tee /etc/systemd/system/dock-tools.service > /dev/null <<EOF",
    "[Unit]",
    "Description=Dock Tools",
    "After=docker.service",
    "Requires=docker.service",
    "",
    "[Service]",
    "WorkingDirectory=/opt/dock-tools",
    "ExecStart=/usr/bin/docker compose up",
    "ExecStop=/usr/bin/docker compose down",
    "Restart=always",
    "User=$USER",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "EOF",
    "",
    "sudo systemctl daemon-reload",
    "sudo systemctl enable dock-tools",
])

# ── Guided installer ─────────────────────────────────────────────────────────
pdf.highlight_title("Guided Installer  (install-guided.sh)", color=(60, 20, 120))

pdf.body(
    "The guided installer handles the full setup interactively with no extra commands. "
    "Copy install-guided.sh to the VM, make it executable, and run it. "
    "It asks all required values, validates every path, deploys the stack, "
    "and runs a demo script to confirm the full pipeline is working."
)

pdf.code_block([
    "chmod +x install-guided.sh",
    "./install-guided.sh",
])

pdf.body("The installer walks through the following steps:")
pdf.table(
    ["Step", "What happens", "Mode"],
    [
        ["1 - Deployment target",    "Choose Docker Compose (Ubuntu/Debian) or Rancher/K8s",   "Both"],
        ["2 - Dependencies",         "Installs Docker, git, curl; handles docker group session fix","Compose"],
        ["2 - Prerequisites",        "Checks kubectl, docker, cluster context",                "Rancher"],
        ["3 - Install directory",    "Clones repo or pulls latest; creates scripts-data dir",  "Both"],
        ["4 - Configuration",        "Asks all .env values interactively (see table below)",   "Both"],
        ["5 - Build & deploy",       "docker compose up --build  OR  kubectl apply -k k8s/",  "Both"],
        ["6 - Validate services",    "Checks containers are up, web UI responds, mount works", "Both"],
        ["7 - Demo script",          "Creates local Python heartbeat, adds via API, checks logs","Compose"],
        ["8 - GitHub test",          "Optional: clones a public repo to test git connectivity","Compose"],
        ["9 - Auto-start",           "Optional: creates systemd service for boot auto-start",  "Compose"],
    ],
    [38, 100, 44],
)

pdf.body("All .env values collected during Step 4:")
pdf.table(
    ["Variable", "Description", "Default / Example"],
    [
        ["Webhook secret",        "HMAC-SHA256 key for GitHub webhooks",     "Auto-generated (openssl rand -hex 32)"],
        ["Timezone",              "Default timezone for cron schedules",      "Auto-detected from system"],
        ["HTTP port",             "Port nginx listens on",                    "80"],
        ["HTTPS port",            "TLS port (only if TLS enabled)",           "443"],
        ["UI username",           "Web UI login username",                    "admin"],
        ["UI password",           "Web UI login password (required)",         "You choose"],
        ["TLS enabled?",          "Generate self-signed cert and use HTTPS",  "No (optional)"],
        ["scripts-data path",     "HOST_SCRIPTS_DATA_PATH on host",           "~/dock-tools/scripts-data"],
    ],
    [40, 75, 67],
)

pdf.body("Demo script (Step 7) - validates the full pipeline end-to-end:")
pdf.table(
    ["Check", "How it works"],
    [
        ["Volume mount correct",   "Creates repo in scripts-data, manager clones it via file:// URL"],
        ["Container creation",     "Dock Tools API starts a Python container"],
        ["Script execution",       "Python heartbeat prints timestamped output every 5 seconds"],
        ["Log streaming",          "Installer fetches logs via API and confirms output is present"],
        ["scripts-data populated", "Checks that <scripts-data>/demo-heartbeat/repo exists on host"],
    ],
    [45, 137],
)

pdf.warning_box(
    "If the demo script fails with 'package.json not found', HOST_SCRIPTS_DATA_PATH is wrong. "
    "The installer sets this automatically - if you cloned to ~/dock-tools the value is "
    "~/dock-tools/scripts-data. Verify with: grep HOST_SCRIPTS_DATA_PATH ~/dock-tools/.env"
)

pdf.warning_box(
    "Docker group permission denied? This happens right after Docker is first installed "
    "because the current shell session does not have the docker group yet. "
    "The installer handles this automatically using 'sg docker -c' for all Docker commands. "
    "After install, log out and back in (or run 'newgrp docker') so future manual "
    "docker commands work without sudo."
)

pdf.body("Rancher/K8s path (Step 6) additional steps:")
pdf.code_block([
    "# Installer runs these automatically:",
    "kubectl apply -f k8s/namespace.yaml",
    "kubectl create secret generic dock-tools-secret --namespace dock-tools ...",
    "kubectl apply -k k8s/",
    "kubectl rollout status deployment/dock-tools-manager -n dock-tools --timeout=120s",
    "kubectl rollout status deployment/dock-tools-nginx   -n dock-tools --timeout=120s",
])

# ── Network diagnosis ─────────────────────────────────────────────────────────
pdf.phase_title("Network Diagnosis Checklist")
pdf.table(
    ["Check", "Command", "Where"],
    [
        ["Interface name",          "ip link show",                          "Ubuntu"],
        ["Current IP",              "ip addr show",                          "Ubuntu"],
        ["Internet via NAT",        "ping 8.8.8.8",                          "Ubuntu"],
        ["NAT active",              "Get-NetNat",                            "Windows (PS)"],
        ["Port forward active",     "netsh interface portproxy show v4tov4", "Windows (PS)"],
        ["Switch type",             "Get-VMSwitch | Select Name,SwitchType", "Windows (PS)"],
        ["Adapter status",          "Get-NetAdapter | Select Name,Status",   "Windows (PS)"],
    ],
    [55, 90, 37],
)

out_path = "/Users/user/Documents/Projects/docker_support_env/HyperV_VM_PowerShell_Guide_v2.pdf"
pdf.output(out_path)
print(f"PDF written to: {out_path}")
