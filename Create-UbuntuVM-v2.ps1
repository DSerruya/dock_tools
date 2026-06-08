# =============================================================================
# Create-UbuntuVM.ps1
# Creates an Ubuntu Server VM on Hyper-V.
# Run as Administrator in PowerShell.
#
# Network modes:
#   "External" - VM gets a real LAN IP via your physical NIC (local server)
#   "Internal" - VM is isolated behind Windows NAT (cloud/no router access)
#                Internet access works via NAT through the Windows host.
#                Mac connects to the VM by RDP port-forwarded through the host.
#
# Flow:
#   1. Set $networkMode below ("External" or "Internal")
#   2. Run this script as Administrator
#   3. Complete Ubuntu install in the console that opens
#      -> In Internal mode the static IP is printed before the console opens
#      -> In External mode use DHCP or the printed host info for a static IP
#   4. Inside Ubuntu, run the xRDP commands at the bottom
#   5. Mac connects via Microsoft Remote Desktop:
#      -> External: VM IP directly on port 3389
#      -> Internal: cloud server public IP on port 3390 (forwarded to VM)
#
# After the OS install completes, uncomment the ISO eject lines at the bottom.
# =============================================================================

# -- Must run as Administrator ------------------------------------------------
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
          ).IsInRole([Security.Principal.WindowsBuiltInRole]"Administrator")) {
    Write-Error "This script must be run as Administrator. Right-click PowerShell and choose 'Run as Administrator'."
    exit 1
}

# =============================================================================
# CONFIG - edit these values before running
# =============================================================================
$networkMode = "Internal"        # "External" or "Internal"

# -- VM settings --------------------------------------------------------------
$vmName    = "UbuntuServer"
$vmPath    = "C:\VMs"
$vhdPath   = "$vmPath\$vmName\$vmName.vhdx"
$isoPath   = "C:\ISOs\ubuntu-24.04-live-server-amd64.iso"
$vhdSizeGB = 40GB
$ramGB     = 2GB
$cpuCount  = 2

# -- External mode settings (only used when $networkMode = "External") --------
$externalSwitch = "ExternalSwitch"
$nicName        = "Ethernet"     # Run Get-NetAdapter to find your adapter name

# -- Internal / NAT mode settings (only used when $networkMode = "Internal") --
$internalSwitch  = "InternalSwitch"
$natName         = "VMNat"
$natSubnet       = "192.168.100.0/24"
$hostGatewayIP   = "192.168.100.1"   # IP assigned to the Windows host on the internal network
$vmStaticIP      = "192.168.100.2"   # Static IP to assign to Ubuntu during install
$vmPrefixLength  = 24
# Port on the Windows host that forwards to the VM's xRDP (port 3389)
# Mac will connect to: <cloud-server-public-ip>:$hostForwardPort
$hostForwardPort = 3390
# =============================================================================

# -- Install Hyper-V Management Tools if missing (includes VMConnect.exe) -----
$vmconnectPath = @(
    "$env:SystemRoot\System32\vmconnect.exe",
    "C:\Program Files\Hyper-V\VMConnect.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $vmconnectPath) {
    Write-Host "VMConnect.exe not found. Installing Hyper-V Management Tools..." -ForegroundColor Yellow
    $os = (Get-CimInstance Win32_OperatingSystem).Caption
    if ($os -match "Server") {
        Install-WindowsFeature -Name Hyper-V-Tools, Hyper-V-PowerShell, RSAT-Hyper-V-Tools -IncludeAllSubFeature
    } else {
        Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -NoRestart
    }
    $vmconnectPath = @(
        "$env:SystemRoot\System32\vmconnect.exe",
        "C:\Program Files\Hyper-V\VMConnect.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $vmconnectPath) {
        Write-Warning "VMConnect.exe still not found after install. A reboot may be required."
        exit 1
    }
    Write-Host "Hyper-V Management Tools installed successfully." -ForegroundColor Green
}

# -- Install & import Hyper-V PowerShell module if missing --------------------
if (-not (Get-Module -ListAvailable -Name Hyper-V)) {
    Write-Host "Hyper-V PowerShell module not found. Installing..." -ForegroundColor Yellow
    $os = (Get-CimInstance Win32_OperatingSystem).Caption
    if ($os -match "Server") {
        Install-WindowsFeature -Name Hyper-V, Hyper-V-PowerShell -IncludeManagementTools
    } else {
        Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-Management-PowerShell -NoRestart
    }
    Write-Host "Hyper-V module installed. If errors follow, reboot and run the script again." -ForegroundColor Yellow
}

Import-Module Hyper-V -ErrorAction Stop
Write-Host "Hyper-V module loaded." -ForegroundColor Green

# -- Validate ISO exists ------------------------------------------------------
if (-not (Test-Path $isoPath)) {
    Write-Error "ISO not found at '$isoPath'. Download Ubuntu Server 24.04 and update the `$isoPath variable."
    exit 1
}

# =============================================================================
# NETWORK SETUP
# =============================================================================

if ($networkMode -eq "Internal") {

    Write-Host ""
    Write-Host "Network mode: INTERNAL (NAT through Windows host)" -ForegroundColor Cyan
    Write-Host "The VM will have internet access via Windows NAT but is not directly" -ForegroundColor Cyan
    Write-Host "reachable from outside. Mac connects via port $hostForwardPort on this host." -ForegroundColor Cyan
    Write-Host ""

    # -- Create internal switch -----------------------------------------------
    if (-not (Get-VMSwitch -Name $internalSwitch -ErrorAction SilentlyContinue)) {
        Write-Host "Creating Internal virtual switch '$internalSwitch'..."
        New-VMSwitch -Name $internalSwitch -SwitchType Internal
    } else {
        Write-Host "Internal switch '$internalSwitch' already exists, skipping." -ForegroundColor Green
    }

    # -- Assign host IP to the vEthernet adapter created by the switch --------
    $vEthernet = Get-NetAdapter | Where-Object { $_.Name -like "*$internalSwitch*" }
    if (-not $vEthernet) {
        Write-Error "Could not find vEthernet adapter for switch '$internalSwitch'. Try rebooting and re-running."
        exit 1
    }
    $existingIP = Get-NetIPAddress -InterfaceIndex $vEthernet.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue
    if (-not $existingIP) {
        Write-Host "Assigning host gateway IP $hostGatewayIP to vEthernet adapter..."
        New-NetIPAddress -IPAddress $hostGatewayIP -PrefixLength $vmPrefixLength -InterfaceIndex $vEthernet.ifIndex
    } else {
        Write-Host "Host adapter already has IP $($existingIP.IPAddress), skipping." -ForegroundColor Green
    }

    # -- Create NAT -----------------------------------------------------------
    if (-not (Get-NetNat -Name $natName -ErrorAction SilentlyContinue)) {
        Write-Host "Creating NAT '$natName' for subnet $natSubnet..."
        New-NetNat -Name $natName -InternalIPInterfaceAddressPrefix $natSubnet
    } else {
        Write-Host "NAT '$natName' already exists, skipping." -ForegroundColor Green
    }

    # -- Port forward: host:$hostForwardPort -> VM:3389 (xRDP) ----------------
    $existingProxy = netsh interface portproxy show v4tov4 | Select-String "$hostForwardPort"
    if (-not $existingProxy) {
        Write-Host "Adding port forward: host:$hostForwardPort -> VM $vmStaticIP`:3389..."
        netsh interface portproxy add v4tov4 `
            listenport=$hostForwardPort `
            listenaddress=0.0.0.0 `
            connectport=3389 `
            connectaddress=$vmStaticIP
        # Allow the forwarded port through Windows Firewall
        $ruleName = "Hyper-V VM xRDP forward ($hostForwardPort)"
        if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
            New-NetFirewallRule -DisplayName $ruleName -Direction Inbound `
                -Protocol TCP -LocalPort $hostForwardPort -Action Allow | Out-Null
        }
        Write-Host "Port forward added and firewall rule created." -ForegroundColor Green
    } else {
        Write-Host "Port forward on $hostForwardPort already exists, skipping." -ForegroundColor Green
    }

    $activeSwitch = $internalSwitch

    # Print static IP instructions for the Ubuntu installer
    Write-Host ""
    Write-Host "=========================================================" -ForegroundColor Yellow
    Write-Host " INTERNAL MODE - enter these values in the Ubuntu installer" -ForegroundColor Yellow
    Write-Host "=========================================================" -ForegroundColor Yellow
    Write-Host " Subnet:   $natSubnet" -ForegroundColor White
    Write-Host " Address:  $vmStaticIP" -ForegroundColor White
    Write-Host " Gateway:  $hostGatewayIP" -ForegroundColor White
    Write-Host " DNS:      8.8.8.8, 8.8.4.4" -ForegroundColor White
    Write-Host "=========================================================" -ForegroundColor Yellow
    Write-Host " After install, Mac connects via RDP to:" -ForegroundColor Yellow
    Write-Host " <this-server-public-ip>:$hostForwardPort" -ForegroundColor White
    Write-Host "=========================================================" -ForegroundColor Yellow
    Write-Host ""

} elseif ($networkMode -eq "External") {

    Write-Host ""
    Write-Host "Network mode: EXTERNAL (VM gets LAN IP via physical NIC)" -ForegroundColor Cyan
    Write-Host ""

    $existingSwitch = Get-VMSwitch -Name $externalSwitch -ErrorAction SilentlyContinue
    if ($existingSwitch) {
        if ($existingSwitch.SwitchType -ne "External") {
            Write-Warning "Switch '$externalSwitch' is type '$($existingSwitch.SwitchType)', must be External. Recreating..."
            Remove-VMSwitch -Name $externalSwitch -Force
            $existingSwitch = $null
        } else {
            Write-Host "External switch '$externalSwitch' already exists, skipping." -ForegroundColor Green
        }
    }
    if (-not $existingSwitch) {
        $adapter = Get-NetAdapter -Name $nicName -ErrorAction SilentlyContinue
        if (-not $adapter) {
            Write-Error "Adapter '$nicName' not found. Run Get-NetAdapter and update `$nicName."
            exit 1
        }
        if ($adapter.Status -ne "Up") {
            Write-Warning "Adapter '$nicName' status is '$($adapter.Status)'. VM may not get a network address."
        }
        Write-Host "Creating External virtual switch '$externalSwitch' on adapter '$nicName'..."
        New-VMSwitch -Name $externalSwitch -NetAdapterName $nicName -AllowManagementOS $true
    }

    # Print host network info for static IP reference
    Write-Host ""
    Write-Host "Host network info (use if setting a static IP in Ubuntu installer):" -ForegroundColor Cyan
    Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.InterfaceAlias -notmatch "Loopback" -and $_.IPAddress -notmatch "^169" } |
        Select-Object InterfaceAlias, IPAddress, PrefixLength | Format-Table -AutoSize
    $gw = (Get-NetRoute -DestinationPrefix "0.0.0.0/0" | Sort-Object RouteMetric | Select-Object -First 1).NextHop
    Write-Host "Default Gateway: $gw" -ForegroundColor Cyan
    Write-Host ""

    $activeSwitch = $externalSwitch

} else {
    Write-Error "Invalid `$networkMode '$networkMode'. Set it to 'External' or 'Internal'."
    exit 1
}

# =============================================================================
# VM CREATION
# =============================================================================

# -- Directory + VHD ----------------------------------------------------------
Write-Host "Creating VM directory and virtual hard disk..."
New-Item -ItemType Directory -Path "$vmPath\$vmName" -Force | Out-Null
New-VHD  -Path $vhdPath -SizeBytes $vhdSizeGB -Dynamic

# -- Create VM ----------------------------------------------------------------
Write-Host "Creating VM '$vmName'..."
New-VM -Name $vmName -Generation 2 -MemoryStartupBytes $ramGB `
       -VHDPath $vhdPath -SwitchName $activeSwitch -Path $vmPath

# -- Configure ----------------------------------------------------------------
Write-Host "Configuring VM settings..."
Set-VMProcessor -VMName $vmName -Count $cpuCount

Set-VMMemory -VMName $vmName `
             -DynamicMemoryEnabled $true `
             -MinimumBytes 512MB `
             -MaximumBytes 4GB `
             -StartupBytes $ramGB

Set-VMFirmware -VMName $vmName -EnableSecureBoot Off

Enable-VMIntegrationService -VMName $vmName -Name "Guest Service Interface"

Set-VM -VMName $vmName -AutomaticStartAction Start -AutomaticStartDelay 30
Set-VM -VMName $vmName -AutomaticStopAction ShutDown

# -- Attach ISO + boot order --------------------------------------------------
Write-Host "Attaching ISO..."
Add-VMDvdDrive -VMName $vmName -Path $isoPath
$dvd = Get-VMDvdDrive      -VMName $vmName
$hdd = Get-VMHardDiskDrive -VMName $vmName
Set-VMFirmware -VMName $vmName -BootOrder $dvd, $hdd

# -- Enhanced Session Mode (Mac keyboard fix) ---------------------------------
Write-Host "Enabling Enhanced Session Mode..."
Set-VMHost -EnableEnhancedSessionMode $true
Set-VM -VMName $vmName -EnhancedSessionTransportType HvSocket
Write-Host "Enhanced Session Mode enabled." -ForegroundColor Green

# -- Summary ------------------------------------------------------------------
Write-Host ""
Write-Host "VM '$vmName' created successfully." -ForegroundColor Green
Get-VM -Name $vmName | Format-Table Name, State, MemoryAssigned, ProcessorCount

# -- Start and open console ---------------------------------------------------
Write-Host "Starting VM and opening console..."
Start-VM -Name $vmName
& $vmconnectPath $env:COMPUTERNAME $vmName

# -- After OS install: uncomment to eject ISO ---------------------------------
# Set-VMDvdDrive -VMName $vmName -Path $null

# =============================================================================
# INTERNAL MODE - Ubuntu installer network settings
# =============================================================================
# When the installer reaches the Network configuration screen:
#   1. Select eth0 -> Edit IPv4 -> Manual
#   2. Enter:
#        Subnet:  192.168.100.0/24
#        Address: 192.168.100.2
#        Gateway: 192.168.100.1
#        DNS:     8.8.8.8,8.8.4.4
#   3. Save -> Done -> continue install
#
# To persist with Netplan after install (run inside Ubuntu):
#
#   sudo nano /etc/netplan/00-installer-config.yaml
#
#   network:
#     version: 2
#     ethernets:
#       ens3:                          <- use your actual interface name
#         dhcp4: false
#         addresses: [192.168.100.2/24]
#         routes:
#           - to: default
#             via: 192.168.100.1
#         nameservers:
#           addresses: [8.8.8.8, 8.8.4.4]
#
#   sudo netplan apply
#   ping 8.8.8.8    <- verify internet access through NAT
# =============================================================================

# =============================================================================
# EXTERNAL MODE - if eth0 autoconfiguration fails
# =============================================================================
# On the Ubuntu Network Configuration screen:
#   1. Select eth0 -> Edit IPv4 -> Manual
#   2. Fill in using the host network info printed above:
#        Subnet:  <host-subnet>
#        Address: <pick a free IP in the same range>
#        Gateway: <default gateway shown above>
#        DNS:     8.8.8.8,8.8.4.4
# =============================================================================

# =============================================================================
# AFTER INSTALL - xRDP for Mac keyboard support
# =============================================================================
# SSH into the VM and run:
#
#   sudo apt-get update
#   sudo apt-get install -y xrdp
#   sudo systemctl enable xrdp
#   sudo systemctl start xrdp
#   sudo ufw allow 3389/tcp
#   echo "setxkbmap -layout us" >> ~/.bashrc
#
# Connect from Mac using Microsoft Remote Desktop (free on App Store):
#
#   EXTERNAL mode -> connect to <vm-ip>:3389
#   INTERNAL mode -> connect to <cloud-server-public-ip>:3390
#                    (port 3390 is forwarded to the VM's port 3389)
# =============================================================================

# =============================================================================
# INSTALL DOCK TOOLS - run install-guided.sh inside the VM
# =============================================================================
# Once Ubuntu/Debian is running and has network access, copy install-guided.sh
# to the VM and run it. It handles everything interactively - no extra commands.
#
# Transfer the script to the VM:
#   scp install-guided.sh <user>@<vm-ip>:~/
#   # INTERNAL mode: scp install-guided.sh <user>@192.168.100.2:~/
#
# Then on the VM:
#   chmod +x install-guided.sh
#   ./install-guided.sh
#
# The installer will ask:
#   Step 1  - Deployment target      : Docker Compose (Ubuntu/Debian) or Rancher/K8s
#   Step 2  - Dependencies           : Installs Docker, git, curl if missing
#   Step 3  - Install directory      : Where to clone Dock Tools (default: ~/dock-tools)
#   Step 4  - Configuration          : Webhook secret, timezone, port, username, password, TLS
#   Step 5  - Build & deploy         : docker compose up --build
#   Step 6  - Validate services      : Checks containers are up, web UI responds, volume mount works
#   Step 7  - Demo script            : Creates a Python heartbeat script, runs it, checks logs
#   Step 8  - GitHub test (optional) : Clones a public repo to verify git connectivity
#   Step 9  - Auto-start (optional)  : Creates systemd service so Dock Tools starts on boot
#
# KEY: HOST_SCRIPTS_DATA_PATH is set automatically to the correct host path.
#      This fixes the "package.json not found" error caused by a wrong mount path.
#
# After install, Dock Tools is available at:
#   INTERNAL mode: http://192.168.100.2       (from Windows host browser)
#   EXTERNAL mode: http://<vm-ip>             (from any LAN machine)
#
# Credentials are printed at the end of the installer.
# =============================================================================
