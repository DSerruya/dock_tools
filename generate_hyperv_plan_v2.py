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
        ["script-manager", "dock-tools-manager", "Up", "3000/tcp (internal)"],
        ["script-nginx",   "nginx:alpine",       "Up", "0.0.0.0:8484->80/tcp"],
    ],
    [35, 48, 20, 79],
)

pdf.body("Step 5 - Access the web UI:")
pdf.table(
    ["Mode", "URL", "Notes"],
    [
        ["Internal (cloud)", "http://192.168.100.2:8484", "Default port 8484 - check MANAGER_PORT in .env"],
        ["External (LAN)",   "http://<vm-ip>:8484",       "Use the port shown in docker compose ps"],
    ],
    [35, 60, 87],
)
pdf.warning_box(
    "Seeing 'Welcome to nginx' instead of Dock Tools? You are hitting the wrong port. "
    "Check your .env for MANAGER_PORT and add it to the URL. "
    "Run: grep MANAGER_PORT ~/dock-tools/.env"
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
    ["Variable", "Description", "Default"],
    [
        ["Webhook secret",    "HMAC-SHA256 key for GitHub webhooks",    "Auto-generated (openssl rand -hex 32)"],
        ["Timezone",          "Default timezone for cron schedules",    "Auto-detected from system"],
        ["HTTP port",         "Host port mapped to nginx container",    "8484  (avoids conflicts with system port 80)"],
        ["HTTPS port",        "TLS port (only if TLS enabled)",         "8443  (avoids conflicts with system port 443)"],
        ["UI username",       "Web UI login username",                  "admin"],
        ["UI password",       "Web UI login password (required)",       "You choose - cannot be empty"],
        ["TLS enabled?",      "Generate self-signed cert, use HTTPS",   "No (optional)"],
        ["scripts-data path", "HOST_SCRIPTS_DATA_PATH on host",         "~/dock-tools/scripts-data (auto-set)"],
    ],
    [35, 72, 75],
)
pdf.note("Ports 80 and 443 require root privileges on Linux and are often occupied by other "
         "services on cloud servers. The installer defaults to 8484/8443 which work without sudo.")

pdf.body("Demo script (Step 7) - validates the local pipeline end-to-end:")
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
pdf.note("demo-heartbeat (Python) stays running after install as a permanent pipeline health indicator.")

pdf.body("GitHub PAT and webhook test (Step 8) - validates GitHub connectivity:")
pdf.table(
    ["Test", "What is checked", "Cleaned up?"],
    [
        ["PAT validation",  "Calls api.github.com/user with the token, confirms authenticated username", "N/A"],
        ["Git clone",       "Direct clone of dock_tools_test repo (with PAT or public)",                "Yes"],
        ["Webhook delivery","Signed HMAC-SHA256 POST to /webhook/git-test, signature validated",        "Yes"],
        ["Log output",      "Fetches logs to confirm stdbuf -o0 stdout fix is working",                 "Yes"],
    ],
    [30, 100, 52],
)

pdf.body("Test repo used by the installer:")
pdf.table(
    ["Field", "Value"],
    [
        ["URL",        "https://github.com/DSerruya/dock_tools_test"],
        ["Visibility", "Public - no PAT required for clone"],
        ["Script",     "main.rb - Ruby heartbeat with $stdout.sync = true"],
        ["Entry point","stdbuf -o0 ruby main.rb"],
        ["Purpose",    "Validates git clone, webhook, and log streaming in one test"],
    ],
    [30, 152],
)
pdf.code_block([
    "# main.rb content (dock_tools_test repo):",
    "$stdout.sync = true",
    "$stderr.sync = true",
    "",
    'puts "=" * 55',
    'puts "  Dock Tools - Git & Log Test"',
    'puts "  Started: #{Time.now}"',
    'puts "=" * 55',
    "count = 0",
    "loop do",
    "  count += 1",
    '  puts "[#{Time.now.strftime("%H:%M:%S")}] heartbeat ##{count} - pipeline OK"',
    "  sleep 5",
    "end",
])

pdf.body("What remains in Dock Tools UI after a full install:")
pdf.table(
    ["Script", "Language", "Remains?", "Purpose"],
    [
        ["demo-heartbeat", "Python", "Yes - permanent", "Local pipeline health check"],
        ["git-test",       "Ruby",   "No - cleaned up", "GitHub/webhook test only"],
    ],
    [35, 25, 35, 87],
)

pdf.warning_box(
    "If the demo script fails with 'package.json not found', HOST_SCRIPTS_DATA_PATH is wrong. "
    "The installer sets this automatically - if you cloned to ~/dock-tools the value is "
    "~/dock-tools/scripts-data. Verify with: grep HOST_SCRIPTS_DATA_PATH ~/dock-tools/.env"
)

pdf.warning_box(
    "Docker group permission denied? The installer detects this automatically and uses "
    "'sudo docker' for the session. After install completes, reconnect your SSH session "
    "so future docker commands work without sudo. "
    "Do NOT run 'newgrp docker' on a headless server - it causes 'Cannot open display' errors."
)

pdf.body("docker-compose.yml key fixes applied (auto-applied via git pull):")
pdf.table(
    ["Fix", "What was wrong", "What was fixed"],
    [
        ["UI_PASSWORD not passed",  "Manager started without auth - UI was publicly open",  "Added UI_USERNAME and UI_PASSWORD to manager environment"],
        ["Wrong default ports",     "Port 80/443 default caused conflicts on cloud servers","Changed fallback defaults to 8484/8443 in docker-compose.yml"],
        ["Obsolete version field",  "version: '3.8' caused a warning on every compose run", "Removed the version attribute"],
    ],
    [38, 72, 72],
)
pdf.body("After pulling these fixes, restart the stack:")
pdf.code_block([
    "cd ~/dock-tools",
    "git pull",
    "sudo docker compose down",
    "sudo docker compose up -d",
    "",
    "# Confirm UI_PASSWORD reached the manager",
    "sudo docker exec script-manager env | grep UI_PASSWORD",
])

pdf.body("Rancher/K8s path (Step 6) additional steps:")
pdf.code_block([
    "# Installer runs these automatically:",
    "kubectl apply -f k8s/namespace.yaml",
    "kubectl create secret generic dock-tools-secret --namespace dock-tools ...",
    "kubectl apply -k k8s/",
    "kubectl rollout status deployment/dock-tools-manager -n dock-tools --timeout=120s",
    "kubectl rollout status deployment/dock-tools-nginx   -n dock-tools --timeout=120s",
])

# ── UI features ───────────────────────────────────────────────────────────────
pdf.highlight_title("UI Features - HowTo? and Admin Quick-Add", color=(20, 90, 160))

pdf.body("Two UI additions make adding and configuring scripts faster:")

pdf.table(
    ["Feature", "Where", "What it does"],
    [
        ["? button",                "Top-right header, next to user badge",     "Opens HowTo modal with per-language field examples and copy buttons"],
        ["Heartbeat quick-add card","Admin tab, top of page",                   "Pre-fills Add Script modal with dock_tools_test Ruby heartbeat values"],
    ],
    [38, 65, 79],
)

pdf.body("HowTo? modal - field examples per language:")
pdf.table(
    ["Language", "Entry Point", "Build Command", "Key note"],
    [
        ["Ruby",       "stdbuf -o0 ruby main.rb",  "bundle install",                   "stdout buffering fix included"],
        ["Python",     "python -u main.py",         "pip install -r requirements.txt",  "-u flag = unbuffered output"],
        ["Node.js",    "node index.js",             "npm install",                      "No buffering issues"],
        ["TypeScript", "npx ts-node index.ts",      "npm install",                      "Or: npm run build + node dist/index.js"],
    ],
    [28, 55, 55, 44],
)
pdf.note("Every field in the HowTo modal has a copy button. Click it to copy the value directly into the clipboard.")

pdf.body("Heartbeat quick-add (Admin tab) pre-fills the Add Script modal with:")
pdf.table(
    ["Field", "Pre-filled value"],
    [
        ["Name",          "heartbeat-test"],
        ["Language",      "Ruby"],
        ["Repo URL",      "https://github.com/DSerruya/dock_tools_test.git"],
        ["Branch",        "main"],
        ["Entry Point",   "stdbuf -o0 ruby main.rb"],
        ["Build Command", "(empty - no dependencies)"],
    ],
    [35, 147],
)
pdf.note("All fields are editable before submitting. Add a GitHub Token if you fork the repo as private.")

pdf.body("To pick up UI changes after a git pull, restart the stack:")
pdf.code_block([
    "cd ~/dock-tools",
    "git pull",
    "sudo docker compose restart",
])

# ── Dock Tools troubleshooting ────────────────────────────────────────────────
pdf.phase_title("Dock Tools Troubleshooting")
pdf.table(
    ["Symptom", "Cause", "Fix"],
    [
        ["Welcome to nginx page",
         "Accessing wrong port - MANAGER_PORT is not 80",
         "Add port to URL: http://<ip>:8484  (check .env for MANAGER_PORT)"],
        ["No UI_PASSWORD set (in logs)",
         "UI_PASSWORD missing from docker-compose.yml environment",
         "git pull to get the fix, then docker compose down && up -d"],
        ["package.json not found (script error)",
         "HOST_SCRIPTS_DATA_PATH in .env does not match actual scripts-data location",
         "grep HOST_SCRIPTS_DATA_PATH .env  and compare to actual path"],
        ["docker: permission denied",
         "User not in docker group or session not refreshed after install",
         "Use sudo docker, then reconnect SSH (do NOT run newgrp on headless server)"],
        ["eth0 autoconfiguration failed",
         "No DHCP on internal switch, or switch is not External type",
         "Set static IP manually in installer (see network config section)"],
        ["Containers exited immediately",
         "Port conflict, low disk, or bad .env values",
         "Run: sudo docker compose logs --tail=40  to see the exact error"],
        ["commit unknown / NaNd ago in Admin",
         "GIT_COMMIT build arg not passed at docker compose build time",
         "git pull + docker compose down && up -d --build (installer now exports GIT_COMMIT)"],
        ["Update available loop after clicking Update",
         "process.exit(0) restarted container with OLD image ID, not new image",
         "git pull - update now recreates the container from the new image"],
        ["ruby: No such file or directory -- <entry point>",
         "Entry point passed as single arg to ruby, not as shell command",
         "git pull - all languages now run via sh -c so flags and prefixes work"],
    ],
    [42, 60, 80],
)

pdf.body("After pulling fixes, always restart the stack to apply changes:")
pdf.code_block([
    "cd ~/dock-tools",
    "git pull",
    "sudo docker compose down",
    "sudo docker compose up -d",
    "",
    "# Verify containers are running",
    "sudo docker compose ps",
    "",
    "# Check manager received correct env vars",
    "sudo docker exec script-manager env | grep -E 'UI_|HOST_|WEBHOOK'",
])

# ── Entry point reference ─────────────────────────────────────────────────────
pdf.phase_title("Entry Point Reference - All Languages")

pdf.body(
    "The Entry Point field is always run via 'sh -c' inside the container, so it supports "
    "any valid shell command including flags, prefixes, and chained commands. "
    "Do NOT include the interpreter if using a build command - the build command runs first, "
    "then the entry point is executed as a shell command."
)

pdf.table(
    ["Language", "Recommended Entry Point", "With Bundler/deps", "Stdout fix"],
    [
        ["Ruby",       "ruby main.rb",          "bundle exec ruby main.rb",      "$stdout.sync = true in script"],
        ["Python",     "python -u main.py",      "python -u main.py",            "-u flag (unbuffered)"],
        ["Node.js",    "node index.js",          "node index.js",                "No fix needed"],
        ["TypeScript", "npx ts-node index.ts",   "node dist/index.js",           "No fix needed"],
    ],
    [28, 48, 50, 56],
)

pdf.warning_box(
    "DO NOT use 'stdbuf -o0 ruby main.rb' as the entry point unless stdbuf is "
    "installed in the container image (ruby:slim images may not include it). "
    "Use 'ruby main.rb' with '$stdout.sync = true' inside the script instead."
)

pdf.body("Before this fix, entry points containing spaces or flags caused errors like:")
pdf.code_block([
    "# Entry point: stdbuf -o0 ruby main.rb",
    "# Old behaviour (broken):",
    "ruby 'stdbuf -o0 ruby main.rb'   <- entire string treated as filename",
    "# Error: ruby: No such file or directory -- stdbuf -o0 ruby main.rb",
    "",
    "# New behaviour (fixed):",
    "sh -c 'stdbuf -o0 ruby main.rb'  <- parsed as shell command",
    "# Works correctly",
])

pdf.body("The heartbeat quick-add button (Admin tab) now pre-fills 'ruby main.rb' "
         "because dock_tools_test/main.rb already has $stdout.sync = true built in.")

# ── Script logging ────────────────────────────────────────────────────────────
pdf.highlight_title("Script Logging - Limits and Real-time Output", color=(20, 90, 160))

pdf.body("Dock Tools captures stdout and stderr from script containers via Docker logs. "
         "Understanding the limits and buffering behaviour prevents missing output in the UI.")

pdf.table(
    ["Scenario", "Line limit", "Real-time?"],
    [
        ["Logs tab - snapshot on open",    "Last 500 lines",             "Yes - then streams live"],
        ["/api/scripts/:name/logs",        "Last 200 lines (default)",   "No - snapshot only"],
        ["/api/scripts/:name/logs?tail=N", "N lines (your choice)",      "No - snapshot only"],
        ["Live stream while running",      "No limit",                   "Yes - SSE real-time"],
        ["Log file on disk (scripts-data)","No limit - kept forever",    "N/A - persistent file"],
    ],
    [65, 42, 75],
)

pdf.body("Ruby stdout buffering - the most common reason logs appear empty or delayed:")
pdf.body("Ruby buffers stdout by default when running non-interactively inside a container. "
         "Output is held in an 8 KB internal buffer and only flushed when it fills up or "
         "the script exits - so 'puts' lines may not appear for minutes in the live log view.")

pdf.table(
    ["Fix", "How to apply", "Changes script?"],
    [
        ["$stdout.sync = true",   "Add at top of Ruby script",              "Yes"],
        ["stdbuf -o0 ruby main.rb","Set as the entry point in Dock Tools UI","No"],
    ],
    [45, 80, 57],
)

pdf.body("Option 1 - add to the Ruby script (fix travels with the code):")
pdf.code_block([
    "$stdout.sync = true",
    "$stderr.sync = true",
    "",
    "puts 'Script started'",
    "loop do",
    "  puts \"#{Time.now} - doing work...\"",
    "  sleep 5",
    "end",
])

pdf.body("Option 2 - set in the Dock Tools entry point field (no code change needed):")
pdf.code_block([
    "stdbuf -o0 ruby main.rb",
])
pdf.note("Use stdbuf when the script is from a GitHub repo you do not control or "
         "when you cannot edit the source. It forces unbuffered output at the OS level "
         "and works for all output including stdout and stderr.")

pdf.table(
    ["Language", "Buffering fix"],
    [
        ["Ruby",       "$stdout.sync = true  OR  stdbuf -o0 ruby main.rb"],
        ["Python",     "sys.stdout.flush() after each print  OR  python -u main.py"],
        ["Node.js",    "No buffering issue - console.log() is unbuffered by default"],
    ],
    [25, 157],
)

pdf.body("Override the default 200-line API limit to get more log history:")
pdf.code_block([
    "# Get last 5000 lines via API",
    "curl -u admin:password http://192.168.100.2:8484/api/scripts/my-script/logs?tail=5000",
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
