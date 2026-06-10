from fpdf import FPDF
from fpdf.enums import XPos, YPos

class PDF(FPDF):
    def header(self):
        self.set_font("Helvetica", "B", 10)
        self.set_fill_color(30, 30, 30)
        self.set_text_color(255, 255, 255)
        self.cell(0, 10, "Dock Tools - Hyper-V Deployment Plan", align="C", fill=True,
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

    def section_heading(self, text):
        self.ln(3)
        self.set_font("Helvetica", "B", 10)
        self.set_text_color(20, 90, 160)
        self.cell(0, 6, text, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        self.set_text_color(0, 0, 0)

    def body(self, text):
        self.set_font("Helvetica", "", 9)
        self.multi_cell(0, 5, text, new_x=XPos.LMARGIN, new_y=YPos.NEXT)

    def note(self, text):
        self.set_fill_color(255, 248, 220)
        self.set_font("Helvetica", "I", 9)
        self.set_text_color(100, 70, 0)
        self.multi_cell(0, 5, f"  Note: {text}", fill=True, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        self.set_text_color(0, 0, 0)

    def code_block(self, lines):
        self.set_fill_color(30, 30, 30)
        self.set_text_color(200, 230, 180)
        self.set_font("Courier", "", 8)
        for line in lines:
            self.cell(0, 4.5, f"  {line}", fill=True, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        self.ln(1)
        self.set_text_color(0, 0, 0)

    def table(self, headers, rows, col_widths):
        self.set_font("Helvetica", "B", 9)
        self.set_fill_color(50, 100, 160)
        self.set_text_color(255, 255, 255)
        for h, w in zip(headers, col_widths):
            self.cell(w, 7, f"  {h}", fill=True, border=0)
        self.ln()
        self.set_text_color(0, 0, 0)
        for i, row in enumerate(rows):
            self.set_fill_color(240, 245, 255) if i % 2 == 0 else self.set_fill_color(255, 255, 255)
            self.set_font("Helvetica", "", 9)
            for cell, w in zip(row, col_widths):
                self.cell(w, 6, f"  {cell}", fill=True, border=0)
            self.ln()
        self.ln(2)


pdf = PDF()
pdf.set_auto_page_break(auto=True, margin=15)
pdf.add_page()
pdf.set_margins(15, 15, 15)

# ── Title Block ──────────────────────────────────────────────────────────────
pdf.set_font("Helvetica", "B", 18)
pdf.set_text_color(20, 90, 160)
pdf.cell(0, 10, "Dock Tools", align="C", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
pdf.set_font("Helvetica", "", 12)
pdf.set_text_color(60, 60, 60)
pdf.cell(0, 7, "Ubuntu VM on Hyper-V  |  Deployment Plan", align="C",
         new_x=XPos.LMARGIN, new_y=YPos.NEXT)
pdf.ln(4)
pdf.set_draw_color(20, 90, 160)
pdf.set_line_width(0.8)
pdf.line(15, pdf.get_y(), 195, pdf.get_y())
pdf.ln(6)

# ── Overview ─────────────────────────────────────────────────────────────────
pdf.set_font("Helvetica", "", 9)
pdf.set_text_color(0, 0, 0)
pdf.multi_cell(0, 5,
    "This document describes how to deploy Dock Tools on a Windows machine running Hyper-V. "
    "The recommended approach is to create a dedicated Ubuntu Server VM inside Hyper-V. "
    "This avoids Windows-to-Linux path translation issues, gives the Docker daemon a native "
    "Linux socket, and provides a clean, production-grade environment.",
    new_x=XPos.LMARGIN, new_y=YPos.NEXT)
pdf.ln(2)

pdf.body("Prerequisites on the Windows host:")
pdf.set_font("Helvetica", "", 9)
prereqs = [
    "- Hyper-V enabled (Windows 10/11 Pro, Enterprise, or Education; or Windows Server)",
    "- An External Virtual Switch configured in Hyper-V Manager",
    "- Ubuntu Server 24.04 LTS ISO downloaded (ubuntu.com/download/server)",
    "- Internet access from the VM network",
]
for p in prereqs:
    pdf.cell(5)
    pdf.multi_cell(0, 5, p, new_x=XPos.LMARGIN, new_y=YPos.NEXT)

# ─────────────────────────────────────────────────────────────────────────────
pdf.phase_title("Phase 1 - Create the Hyper-V VM")

pdf.body("Open Hyper-V Manager and create a new virtual machine with the following settings:")

pdf.table(
    ["Setting", "Recommended Value"],
    [
        ["Generation", "Generation 2 (UEFI) - disable Secure Boot after creation"],
        ["RAM", "2 GB minimum, 4 GB recommended (enable Dynamic Memory)"],
        ["Storage", "40 GB virtual hard disk (VHDX)"],
        ["Network Adapter", "External Virtual Switch (maps to physical NIC)"],
        ["Boot ISO", "Ubuntu Server 24.04 LTS"],
    ],
    [60, 120],
)

pdf.note("After creating the VM, go to Settings > Security and uncheck 'Enable Secure Boot' "
         "or select the Microsoft UEFI Certificate Authority template, otherwise Ubuntu will fail to boot.")

pdf.body("During the Ubuntu installation wizard:")
steps = [
    "- Choose 'Ubuntu Server (minimized)' or full server install",
    "- Configure a static IP or note the DHCP address for SSH access",
    "- Enable the OpenSSH server option",
    "- Create a non-root user (e.g. docktools) and set a strong password",
]
for s in steps:
    pdf.cell(5)
    pdf.multi_cell(0, 5, s, new_x=XPos.LMARGIN, new_y=YPos.NEXT)

# ─────────────────────────────────────────────────────────────────────────────
pdf.phase_title("Phase 2 - Prepare the VM")

pdf.body("SSH into the VM from PowerShell on the Windows host:")
pdf.code_block(["ssh docktools@<vm-ip>"])

pdf.body("Update the system and install Docker:")
pdf.code_block([
    "sudo apt-get update && sudo apt-get upgrade -y",
    "curl -fsSL https://get.docker.com | sudo sh",
    "sudo usermod -aG docker $USER",
    "newgrp docker",
    "sudo apt-get install -y git curl",
    "docker version   # verify Docker is running",
])

# ─────────────────────────────────────────────────────────────────────────────
pdf.phase_title("Phase 3 - Clone and Configure the Project")

pdf.body("Create the deployment directory and clone the repository:")
pdf.code_block([
    "sudo mkdir -p /opt/dock-tools",
    "sudo chown $USER:$USER /opt/dock-tools",
    "cd /opt/dock-tools",
    "git clone https://github.com/DSerruya/dock_tools.git .",
])

pdf.body("Create the environment file from the template and edit it:")
pdf.code_block([
    "cp .env.example .env",
    "nano .env",
])

pdf.body("Required .env values:")
pdf.code_block([
    "# Generate the secret with: openssl rand -hex 32",
    "WEBHOOK_SECRET=<your-generated-secret>",
    "",
    "# Absolute path on the VM - NOT a Windows path",
    "HOST_SCRIPTS_DATA_PATH=/opt/dock-tools/scripts-data",
    "",
    "DEFAULT_TIMEZONE=UTC",
    "MANAGER_PORT=80",
    "UI_USERNAME=admin",
    "UI_PASSWORD=<strong-password>",
])

pdf.note("HOST_SCRIPTS_DATA_PATH must be the real Linux filesystem path on the VM. "
         "Docker bind-mounts this directory into each script container. "
         "An incorrect path will cause script containers to start with no code inside.")

# ─────────────────────────────────────────────────────────────────────────────
pdf.phase_title("Phase 4 - Build and Start the Stack")

pdf.code_block([
    "cd /opt/dock-tools",
    "docker compose up -d --build",
    "",
    "# Verify both services are running",
    "docker compose ps",
    "",
    "# Tail logs to confirm healthy startup",
    "docker compose logs -f",
])

pdf.body("Expected output from 'docker compose ps':")
pdf.table(
    ["NAME", "IMAGE", "STATUS", "PORTS"],
    [
        ["manager", "dock-tools-manager", "Up", "3000/tcp (internal)"],
        ["nginx",   "nginx:alpine",       "Up", "0.0.0.0:80->80/tcp"],
    ],
    [35, 50, 25, 72],
)

# ─────────────────────────────────────────────────────────────────────────────
pdf.phase_title("Phase 5 - Configure Windows Firewall")

pdf.body("Run the following in PowerShell as Administrator on the Windows host to allow "
         "traffic to reach the VM:")
pdf.code_block([
    "# Allow inbound HTTP",
    'New-NetFirewallRule -DisplayName "Dock Tools HTTP" -Direction Inbound \\',
    "    -Protocol TCP -LocalPort 80 -Action Allow",
    "",
    "# Allow inbound HTTPS (if using TLS)",
    'New-NetFirewallRule -DisplayName "Dock Tools HTTPS" -Direction Inbound \\',
    "    -Protocol TCP -LocalPort 443 -Action Allow",
])

pdf.note("Also verify that the VM's ufw (Ubuntu firewall) is not blocking port 80/443. "
         "Run: sudo ufw allow 80/tcp && sudo ufw allow 443/tcp on the VM if ufw is active.")

# ─────────────────────────────────────────────────────────────────────────────
pdf.phase_title("Phase 6 - Optional: Enable HTTPS / TLS")

pdf.body("Generate a self-signed certificate (or use Let's Encrypt if you have a domain):")
pdf.code_block([
    "cd /opt/dock-tools/nginx/certs",
    "openssl req -x509 -nodes -days 365 -newkey rsa:2048 \\",
    '    -keyout key.pem -out cert.pem -subj "/CN=dock-tools.local"',
])

pdf.body("Update docker-compose.yml to use the TLS nginx config:")
pdf.code_block([
    "nginx:",
    "  volumes:",
    "    - ./nginx/nginx-tls.conf:/etc/nginx/nginx.conf:ro   # use TLS config",
    "    - ./nginx/certs:/etc/nginx/certs:ro",
])

pdf.body("Add MANAGER_TLS_PORT=443 to .env, then restart the stack:")
pdf.code_block(["docker compose up -d"])

# ─────────────────────────────────────────────────────────────────────────────
pdf.phase_title("Phase 7 - GitHub Webhook Setup")

pdf.body("GitHub must be able to reach the VM to trigger auto-restarts on git push. "
         "Choose the option that fits your network:")
pdf.table(
    ["Option", "Use Case", "Notes"],
    [
        ["Port Forward (router)", "Static public IP", "Forward port 80/443 to VM IP in router settings"],
        ["Cloudflare Tunnel",     "No open ports needed", "Free tier available, no public IP required"],
        ["ngrok",                 "Local testing only",  "Not suitable for production use"],
    ],
    [45, 50, 87],
)

pdf.body("Webhook URL format once the host is accessible:")
pdf.code_block(["http://<vm-ip-or-domain>/webhook/<script-name>"])

# ─────────────────────────────────────────────────────────────────────────────
pdf.phase_title("Phase 8 - Persist Across VM Reboots")

pdf.body("Enable Docker and the Dock Tools stack to start automatically on boot:")
pdf.code_block([
    "sudo systemctl enable docker",
    "",
    "# Create a systemd service for the compose stack",
    "sudo nano /etc/systemd/system/dock-tools.service",
])

pdf.body("Paste the following into the service file:")
pdf.code_block([
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
    "User=docktools",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
])

pdf.code_block([
    "sudo systemctl daemon-reload",
    "sudo systemctl enable dock-tools",
])

# ─────────────────────────────────────────────────────────────────────────────
pdf.phase_title("Phase 9 - Verify the Deployment")

pdf.table(
    ["Check", "How to Verify"],
    [
        ["Web UI accessible",      "Open http://<vm-ip> in a browser on the Windows host"],
        ["Manager API healthy",    "curl http://<vm-ip>/api/scripts  (expect JSON response)"],
        ["Log streaming works",    "Add a test script, start it, open the Logs tab in the UI"],
        ["Webhook triggers",       "Push to a connected GitHub repo, confirm auto-restart in UI"],
        ["Survives reboot",        "Reboot the VM; verify stack restarts automatically"],
    ],
    [70, 112],
)

# ─────────────────────────────────────────────────────────────────────────────
pdf.phase_title("Script Management - Checking for Updates")

pdf.body(
    "Each script has a built-in update check that fetches the latest commits from its "
    "GitHub repository and lets you install the update with a single click - without "
    "touching the script's environment variables."
)

pdf.section_heading("How to use")
steps = [
    "1. Open the Edit modal for any script (click the pencil icon on the script card).",
    "2. Click 'Check for Updates' in the bottom-left of the modal.",
    "3. Dock Tools fetches from the remote and reports how many commits are behind.",
    "4. If updates exist, the latest commit message is shown and an 'Install Update' button appears.",
    "5. Click 'Install Update' to pull the latest code.",
    "6. Persistent scripts restart automatically; scheduled scripts pick up the new code on next run.",
]
for s in steps:
    pdf.cell(5)
    pdf.multi_cell(0, 5, s, new_x=XPos.LMARGIN, new_y=YPos.NEXT)

pdf.note(
    "Environment variables are stored in Dock Tools' own config (scripts.json), not inside "
    "the cloned repository. They are always preserved when an update is applied - you never "
    "need to re-enter them."
)

pdf.table(
    ["State", "What you see"],
    [
        ["Up to date",       "Green text: 'Already up to date'"],
        ["Updates available", "Yellow text: '<N> new commits: <latest message>' + Install Update button"],
        ["After install",    "Green text: 'Update applied and script restarted' (persistent) or 'Update applied' (scheduled)"],
        ["Not yet cloned",   "Error: 'Repository not cloned yet. Start the script first.'"],
    ],
    [55, 127],
)

# ─────────────────────────────────────────────────────────────────────────────
pdf.phase_title("Common Hyper-V / Windows Gotchas")

pdf.table(
    ["Issue", "Solution"],
    [
        ["Docker socket path",    "Linux VM uses /var/run/docker.sock natively - no Windows path needed"],
        ["Volume paths",          "HOST_SCRIPTS_DATA_PATH is the Linux VM path, never a Windows C:\\ path"],
        ["VM networking",         "Use External Virtual Switch so the VM gets a real LAN IP"],
        ["Windows firewall",      "Open ports 80/443 on both Windows host firewall AND VM ufw"],
        ["Self-update feature",   "Requires outbound internet from the VM to reach GitHub"],
        ["Secure Boot",           "Must be disabled (or set to UEFI CA) for Ubuntu to boot on Gen 2 VM"],
    ],
    [65, 117],
)

# ─────────────────────────────────────────────────────────────────────────────
out_path = "/Users/user/Documents/Projects/docker_support_env/DockTools_HyperV_Deployment_Plan.pdf"
pdf.output(out_path)
print(f"PDF written to: {out_path}")
