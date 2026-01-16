# Homenichat - Raspberry Pi Installation Guide

This guide walks you through installing Homenichat on a Raspberry Pi 4 or 5.

## Prerequisites

### Hardware

| Item | Minimum | Recommended |
|------|---------|-------------|
| Raspberry Pi | Pi 4 (2GB) | Pi 5 (4GB) |
| MicroSD Card | 16GB | 32GB+ Class 10 |
| Power Supply | Official 15W | Official 27W (Pi 5) |
| Network | Ethernet or WiFi | Ethernet |
| Optional | USB GSM Modem | SIM7600G-H |

### Software

- **Raspberry Pi OS 64-bit** (Bookworm or newer)
- Fresh installation recommended

## Step 1: Prepare Your Raspberry Pi

### 1.1 Download Raspberry Pi Imager

Download from: https://www.raspberrypi.com/software/

### 1.2 Flash Raspberry Pi OS

1. Insert your MicroSD card
2. Open Raspberry Pi Imager
3. Click "Choose OS" → "Raspberry Pi OS (64-bit)"
4. Click "Choose Storage" → Select your SD card
5. Click the gear icon for advanced settings:
   - Set hostname: `homenichat`
   - Enable SSH
   - Set username/password
   - Configure WiFi (if needed)
6. Click "Write"

### 1.3 Boot and Connect

1. Insert SD card into Raspberry Pi
2. Connect power
3. Wait 2-3 minutes for first boot
4. Connect via SSH:
   ```bash
   ssh your-username@homenichat.local
   # or use IP address
   ssh your-username@192.168.1.xxx
   ```

## Step 2: Update System

```bash
sudo apt update
sudo apt upgrade -y
sudo reboot
```

Wait for reboot, then reconnect via SSH.

## Step 3: Install Homenichat

### Option A: Automatic Installation (Recommended)

```bash
# Download and run installer
curl -fsSL https://raw.githubusercontent.com/your-repo/homenichat/main/scripts/install.sh -o install.sh
chmod +x install.sh
sudo ./install.sh
```

The installer will:
1. Show legal disclaimers (you must accept)
2. Ask which components to install
3. Install all dependencies
4. Configure services
5. Start Homenichat

### Option B: Manual Installation

See [MANUAL_INSTALL.md](MANUAL_INSTALL.md)

## Step 4: Access Homenichat

After installation completes:

1. **Web Interface**: http://homenichat.local/
2. **Admin Panel**: http://homenichat.local/admin

Default credentials:
- Username: `admin`
- Password: `Homenichat`

**Change the password immediately!**

## Step 5: Initial Configuration

### 5.1 Login to Admin Panel

1. Open http://homenichat.local/admin
2. Login with admin / Homenichat
3. Go to Settings → Change Password

### 5.2 Configure WhatsApp (Baileys)

1. Go to WhatsApp section
2. Click "New Session"
3. Scan the QR code with your phone
4. Wait for connection

### 5.3 Configure SMS (if using GSM modem)

1. Plug in your USB modem
2. Go to SMS section
3. Click "Scan for Modems"
4. Configure detected modem

### 5.4 Configure VoIP (if installed)

1. Go to VoIP section
2. Configure trunk settings
3. Test connection

## Troubleshooting

### Service Not Starting

```bash
# Check service status
sudo supervisorctl status homenichat

# View logs
sudo tail -f /var/log/homenichat/output.log
sudo tail -f /var/log/homenichat/error.log

# Restart service
sudo supervisorctl restart homenichat
```

### Cannot Access Web Interface

```bash
# Check nginx
sudo systemctl status nginx
sudo nginx -t

# Check firewall
sudo ufw status
```

### WhatsApp QR Code Not Loading

```bash
# Check if Baileys is installed
cd /opt/homenichat/backend
npm list @whiskeysockets/baileys

# Reinstall if needed
npm install @whiskeysockets/baileys
```

### GSM Modem Not Detected

```bash
# List USB devices
lsusb

# Check serial ports
ls -la /dev/ttyUSB*

# Add user to dialout group
sudo usermod -a -G dialout $USER
```

## Updating Homenichat

```bash
# Stop service
sudo supervisorctl stop homenichat

# Update code
cd /opt/homenichat
sudo git pull

# Update dependencies
cd backend
sudo npm install --omit=dev

# Rebuild admin interface
cd admin
sudo npm install
sudo npm run build

# Start service
sudo supervisorctl start homenichat
```

## Backup & Restore

### Backup

```bash
# Backup data
sudo tar -czvf homenichat-backup-$(date +%Y%m%d).tar.gz \
  /var/lib/homenichat \
  /etc/homenichat
```

### Restore

```bash
# Stop service
sudo supervisorctl stop homenichat

# Restore data
sudo tar -xzvf homenichat-backup-YYYYMMDD.tar.gz -C /

# Start service
sudo supervisorctl start homenichat
```

## Uninstall

```bash
# Stop and disable services
sudo supervisorctl stop homenichat
sudo systemctl stop nginx

# Remove files
sudo rm -rf /opt/homenichat
sudo rm -rf /var/lib/homenichat
sudo rm -rf /etc/homenichat
sudo rm /etc/supervisor/conf.d/homenichat.conf
sudo rm /etc/nginx/sites-enabled/homenichat

# Reload services
sudo supervisorctl reread
sudo supervisorctl update
sudo systemctl reload nginx
```

## Performance Tips

### Optimize for Pi 4 (2GB)

```bash
# Reduce GPU memory
sudo raspi-config
# → Performance → GPU Memory → Set to 16MB

# Add swap
sudo dphys-swapfile swapoff
sudo nano /etc/dphys-swapfile
# Set CONF_SWAPSIZE=1024
sudo dphys-swapfile setup
sudo dphys-swapfile swapon
```

### Use SSD instead of SD Card

1. Get a USB 3.0 SSD enclosure
2. Flash Raspberry Pi OS to SSD
3. Boot from SSD (faster and more reliable)

## Security Recommendations

1. **Change default password immediately**
2. **Use HTTPS** (configure Let's Encrypt)
3. **Keep system updated**
4. **Use strong WiFi password**
5. **Consider VPN for remote access**

## Getting Help

- GitHub Issues: https://github.com/elkir0/homenichat-serv/issues
- Documentation: https://github.com/elkir0/homenichat-serv/docs

---

Happy messaging with Homenichat!
