# Homenichat-Serv

> 🏠 **Self-Hosted Unified Communication Server** - Stop paying monthly fees, own your data

[![License](https://img.shields.io/badge/license-AGPL%20v3-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org)
[![Raspberry Pi](https://img.shields.io/badge/Raspberry%20Pi-4%2F5-red.svg)](#raspberry-pi-installation)

---

## 💰 Why Homenichat?

### Stop Paying Multiple Subscriptions

| Cloud Service | Monthly Cost | What You Pay with Homenichat |
|---------------|--------------|------------------------------|
| Zoko (WhatsApp Business) | ~50-200€/month | **0€** (Baileys is free) |
| Ringover / Aircall (VoIP) | ~25-50€/user/month | **0€** (Self-hosted Asterisk) |
| OVH SMS / Twilio | ~0.05-0.10€/SMS | **~0.02€/SMS** (Your own SIM card) |

### One-Time Hardware Investment

| Hardware | Cost | Lifetime |
|----------|------|----------|
| Raspberry Pi 4 (4GB) | ~60€ | 5+ years |
| SIM7600 GSM Modem | ~40€ | 5+ years |
| Powered USB Hub | ~20€ | 5+ years |
| **Total** | **~120€** | **One-time** |

> 💡 **ROI**: If you're paying 100€/month for cloud services, Homenichat pays for itself in **5 weeks**.

### 🔒 Your Data, Your Control

**Everything stays local:**
- ✅ WhatsApp messages processed on YOUR server
- ✅ Call recordings stored on YOUR storage
- ✅ SMS logs never leave YOUR network
- ✅ No third-party API tracking your conversations
- ✅ GDPR compliance made simple

---

## ✨ Features

### Unified Inbox
- **WhatsApp** - Via Baileys (free, QR code auth) or Meta Cloud API
- **SMS** - Via USB GSM modems or cloud fallback (Twilio, OVH)
- **Phone Calls** - Via Asterisk/FreePBX with SIP trunks

### Professional Features
- 📱 Web admin interface for configuration
- 🔔 Real-time notifications via WebSocket
- 📊 Message analytics and reports
- 👥 Multi-user support with role-based access
- 🔌 REST API for custom integrations

---

## 🚀 Quick Start

### Raspberry Pi Installation (Recommended)

**Supported OS:** Debian 12 Bookworm (recommended for FreePBX compatibility)

```bash
# Full installation (all components)
curl -fsSL https://raw.githubusercontent.com/elkir0/homenichat-serv/main/scripts/install.sh | sudo bash -s -- --full

# Interactive installation (choose components)
curl -fsSL https://raw.githubusercontent.com/elkir0/homenichat-serv/main/scripts/install.sh | sudo bash
```

**Installation includes:**
- ✅ Node.js 20 LTS
- ✅ Baileys (WhatsApp)
- ✅ Asterisk (VoIP PBX) - compiled from source
- ✅ Gammu + chan_quectel (GSM modem support)
- ✅ FreePBX web interface (via ARM installer)

### Docker (For VPS/Server)

```bash
git clone https://github.com/elkir0/homenichat-serv.git
cd homenichat-serv
docker compose up -d
```

---

## 📋 Platform Compatibility

| Platform | Asterisk | FreePBX | GSM Modems | Notes |
|----------|----------|---------|------------|-------|
| **Debian 12 Bookworm (ARM64)** | ✅ | ✅ | ✅ | **Recommended for Pi** |
| Debian 12 Bookworm (AMD64) | ✅ | ✅ | ✅ | Full support |
| Debian 13 Trixie | ✅ | ⚠️ External | ✅ | FreePBX not compatible |
| Docker (any) | ✅ | ❌ | ⚠️ | Requires USB passthrough |

> ⚠️ **Why Bookworm?** FreePBX official installer only supports Debian 12. For the best experience with VoIP, stick with Bookworm.

---

## 📱 GSM Modem Setup (SIM7600/Quectel EC25)

### Supported Modems

| Model | Vendor | USB ID | Status |
|-------|--------|--------|--------|
| SIM7600G-H | SIMCom | 1e0e:9001 | ✅ Tested |
| SIM7600E-H | SIMCom | 1e0e:9001 | ✅ Tested |
| EC25 | Quectel | 2c7c:0125 | ✅ Tested |

### ⚡ IMPORTANT: Powered USB Hub Required

> **⚠️ Critical Warning:** Raspberry Pi USB ports cannot provide enough power for GSM modems. **You MUST use a powered USB hub**, otherwise:
> - The modem will disconnect randomly
> - Calls will drop silently
> - SMS sending will fail intermittently
> - The Pi may freeze or reboot

**Recommended Setup:**
```
[Raspberry Pi] → [Powered USB Hub (5V 3A+)] → [SIM7600 Modem]
```

### Modem Configuration

After installation, configure your modem in `/etc/asterisk/quectel.conf`:

```ini
[quectel-sim7600]
audio = /dev/sim7600-audio
data = /dev/sim7600-at
context = from-gsm
group = 0
rxgain = -5
txgain = -15
slin16 = yes
```

---

## 🔑 Default Credentials

| Service | Username | Password |
|---------|----------|----------|
| Admin Panel | `admin` | `Homenichat` |
| FreePBX | (set during install) | (set during install) |

**⚠️ Change passwords immediately after first login!**

---

## 📁 Directory Structure

```
/opt/homenichat/        # Application
├── server.js           # Main entry point
├── admin/              # Web admin interface
├── config/             # Configuration files
└── scripts/            # Installation scripts

/var/lib/homenichat/    # Data
├── sessions/           # WhatsApp sessions
├── media/              # Media files
└── homenichat.db       # SQLite database

/etc/homenichat/        # Configuration
├── .env                # Environment variables
└── providers.yaml      # Provider configuration
```

---

## 🔧 Configuration

### providers.yaml

```yaml
version: "2.0"
instance:
  name: "My Home Communication Hub"
  timezone: "Europe/Paris"

providers:
  whatsapp:
    - id: main
      type: baileys
      enabled: true

  sms:
    # Option 1: Local GSM modem (recommended)
    - id: sim7600
      type: gammu
      enabled: true
      config:
        device: "/dev/sim7600-at"

    # Option 2: Cloud fallback
    - id: ovh_backup
      type: ovh
      enabled: false
      priority: 2
      config:
        app_key: "${OVH_APP_KEY}"
        app_secret: "${OVH_APP_SECRET}"

  voip:
    - id: local_pbx
      type: freepbx
      enabled: true
      config:
        host: "127.0.0.1"
        ami_port: 5038
        ami_user: "homenichat"
        ami_secret: "${AMI_SECRET}"
```

---

## 📚 API Overview

### Authentication
```bash
POST /api/auth/login
GET  /api/auth/verify
```

### Chats
```bash
GET  /api/chats
GET  /api/chats/:id/messages
POST /api/chats/:id/messages
```

### Providers
```bash
GET  /api/providers/status
GET  /api/providers/qr/baileys  # WhatsApp QR code
```

---

## 🆘 Troubleshooting

### Modem Not Detected
```bash
# Check USB devices
lsusb | grep -E "1e0e|2c7c"

# Check serial ports
ls -la /dev/ttyUSB*
```

### Asterisk Issues
```bash
# Check Asterisk status
sudo asterisk -rx "core show version"
sudo asterisk -rx "quectel show devices"

# View logs
sudo tail -f /var/log/asterisk/messages
```

### Service Management
```bash
sudo supervisorctl status homenichat
sudo supervisorctl restart homenichat
sudo systemctl restart asterisk
```

---

## 🌐 Network Ports & Firewall Configuration

### Minimal Ports for Internet Exposure

For a **plug-and-play** deployment accessible from internet, open only these ports:

| Port | Protocol | Service | Required For | Priority |
|------|----------|---------|--------------|----------|
| **443** | TCP | HTTPS | Web interface + API + WebRTC (via reverse proxy) | **Essential** |
| **5061** | TCP | SIP TLS | Native SIP clients (Groundwire, Zoiper) | Optional |
| **10000-10100** | UDP | RTP | Voice media packets | **Essential** |

> 💡 **Recommended Setup:** Use a reverse proxy (Caddy/nginx) on port 443 to handle everything. This minimizes attack surface.

### Complete Port Reference

#### Homenichat Core Services

| Port | Protocol | Service | Description | Expose to Internet? |
|------|----------|---------|-------------|---------------------|
| 3001 | TCP | Homenichat API | REST API + WebSocket | Via reverse proxy only |
| 8080 | TCP | Admin UI | Web administration panel | Via reverse proxy only |

#### VoIP / WebRTC Ports

| Port | Protocol | Service | Description | Expose to Internet? |
|------|----------|---------|-------------|---------------------|
| 5060 | UDP | SIP | Standard SIP signaling | ⚠️ Not recommended (unencrypted) |
| 5061 | TCP | SIP TLS | Secure SIP signaling | ✅ Yes for native SIP clients |
| 8088 | TCP | WebSocket (WS) | Non-SSL WebRTC | ❌ Local testing only |
| 8089 | TCP | WebSocket (WSS) | SSL WebRTC signaling | Via reverse proxy (or direct) |
| 10000-10100 | UDP | RTP | Voice/video media | ✅ Yes (required for audio) |

#### FreePBX Management (Internal Only)

| Port | Protocol | Service | Description | Expose to Internet? |
|------|----------|---------|-------------|---------------------|
| 80 | TCP | HTTP | FreePBX web (redirects to 443) | ❌ Internal only |
| 443 | TCP | HTTPS | FreePBX web interface | ❌ Internal only |
| 5038 | TCP | AMI | Asterisk Manager Interface | ❌ Never expose |

### Firewall Configuration Examples

#### UFW (Ubuntu/Debian)

```bash
# Essential ports only (recommended)
sudo ufw allow 443/tcp        # HTTPS (reverse proxy)
sudo ufw allow 5061/tcp       # SIP TLS
sudo ufw allow 10000:10100/udp  # RTP media

# Enable firewall
sudo ufw enable
```

#### iptables

```bash
# Essential ports
iptables -A INPUT -p tcp --dport 443 -j ACCEPT
iptables -A INPUT -p tcp --dport 5061 -j ACCEPT
iptables -A INPUT -p udp --dport 10000:10100 -j ACCEPT
```

### Reverse Proxy Configuration (Recommended)

Using a single HTTPS port (443) with a reverse proxy provides the best security:

#### Caddy (Automatic HTTPS)

```caddyfile
homenichat.example.com {
    # WebRTC WebSocket
    handle /ws {
        reverse_proxy localhost:8089
    }

    # Homenichat API
    handle /api/* {
        reverse_proxy localhost:3001
    }

    # Admin interface
    handle {
        reverse_proxy localhost:3001
    }
}
```

#### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name homenichat.example.com;

    ssl_certificate /etc/letsencrypt/live/homenichat.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/homenichat.example.com/privkey.pem;

    # WebRTC WebSocket
    location /ws {
        proxy_pass http://127.0.0.1:8089;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }

    # Homenichat API & UI
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Client Connection Matrix

| Client Type | Connection Method | Ports Used |
|-------------|-------------------|------------|
| **Homenichat App (WebRTC)** | WSS via HTTPS | 443 + RTP (10000-10100) |
| **Browser (WebRTC)** | WSS via HTTPS | 443 + RTP (10000-10100) |
| **Groundwire / Zoiper** | SIP TLS | 5061 + RTP (10000-10100) |
| **Generic SIP Phone** | SIP UDP | 5060 + RTP (avoid if possible) |

### NAT/Router Configuration

If behind a NAT router, configure port forwarding:

```
External Port    →    Internal IP:Port
443/TCP          →    192.168.x.x:443     (Reverse proxy)
5061/TCP         →    192.168.x.x:5061    (SIP TLS)
10000-10100/UDP  →    192.168.x.x:10000-10100  (RTP)
```

### Security Recommendations

1. **Always use TLS** - Never expose plain SIP (5060) or WS (8088) to internet
2. **Use fail2ban** - Protect against SIP brute force attacks
3. **Limit RTP range** - 101 ports (10000-10100) is sufficient for 10 concurrent calls
4. **Use strong passwords** - Change default FreePBX/AMI credentials
5. **Regular updates** - Keep Asterisk and FreePBX patched

---

## 🔐 SSL/HTTPS Configuration

### HTTP Mode (Default)

By default, Homenichat runs in **HTTP mode** for easy local network installation. This is suitable for:
- Local network deployments (192.168.x.x)
- Testing and development
- Private home servers

**Limitations without HTTPS:**
- PWA "Add to Home Screen" may not work on some browsers
- Push notifications require HTTPS
- Some browser security features are limited
- Not recommended for internet-facing deployments

### Enabling HTTPS

To enable HTTPS mode, set the environment variable:

```bash
# In /etc/homenichat/.env
HTTPS=true
```

Then configure a reverse proxy (nginx/Caddy) with SSL certificates:

**Using Let's Encrypt with Certbot:**
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

**Using Caddy (automatic HTTPS):**
```bash
# /etc/caddy/Caddyfile
your-domain.com {
    reverse_proxy localhost:3001
}
```

### Security Headers

| Mode | HSTS | upgrade-insecure-requests | Cross-Origin Policies |
|------|------|---------------------------|----------------------|
| HTTP (HTTPS=false) | ❌ Disabled | ❌ Disabled | ❌ Disabled |
| HTTPS (HTTPS=true) | ✅ Enabled | ✅ Enabled | ✅ Enabled |

> ⚠️ **Warning**: Without HTTPS, data between client and server is not encrypted. Only use HTTP mode on trusted local networks.

---

## 📦 Related Projects

| Project | Description |
|---------|-------------|
| [homenichat-pwa](https://github.com/elkir0/homenichat-pwa) | Progressive Web App frontend |
| [homenichat-app-android](https://github.com/elkir0/homenichat-app-android) | Android mobile app |

---

## ⚖️ Legal Disclaimers

### WhatsApp / Baileys
- Uses [Baileys](https://github.com/WhiskeySockets/Baileys), an **unofficial** WhatsApp API
- **NOT** affiliated with WhatsApp Inc. or Meta
- May violate WhatsApp Terms of Service
- Use at your own risk, for personal purposes only

### FreePBX / Asterisk
- FreePBX and Asterisk are trademarks of Sangoma Technologies
- This project is **NOT** affiliated with Sangoma
- Components downloaded from official sources during installation

---

## 📄 License

GNU Affero General Public License v3.0 - see [LICENSE](LICENSE)

---

## 🙏 Contributing

Contributions welcome! Please open an issue or PR.

---

**Homenichat** - *Your data. Your servers. Your freedom.*

🏠 Home + 📱 Omni + 💬 Chat = **Homenichat**
