# Homenichat-Serv

> Self-Hosted Unified Communication Server

[![License](https://img.shields.io/badge/license-GPL%20v3-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/Docker-Ready-blue.svg)](https://docker.com)
[![Raspberry Pi](https://img.shields.io/badge/Raspberry%20Pi-4%2F5-red.svg)](#raspberry-pi)

---

## Overview

Homenichat-Serv is the backend server for the Homenichat unified communication platform. It provides:

- **WhatsApp Integration** via Baileys (QR Code) or Meta Cloud API
- **SMS Integration** via USB GSM modems or cloud providers (Twilio, OVH, Plivo)
- **VoIP Integration** via FreePBX/Asterisk
- **Web Admin Interface** for configuration and monitoring
- **REST API** for mobile/web clients

## Quick Start

### Docker (Recommended)

```bash
git clone https://github.com/elkir0/homenichat-serv.git
cd homenichat-serv
docker compose up -d

# Access:
# - Web Admin: http://localhost:8080/admin
# - API: http://localhost:8080/api
```

### Raspberry Pi

```bash
curl -fsSL https://raw.githubusercontent.com/elkir0/homenichat-serv/main/scripts/install.sh | sudo bash
```

## Default Credentials

- **Username:** `admin`
- **Password:** `Homenichat`

**Change immediately after first login!**

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3001` |
| `NODE_ENV` | Environment | `production` |
| `DATA_DIR` | Data directory | `/app/data` |
| `JWT_SECRET` | JWT signing key | (generated) |

### providers.yaml

```yaml
version: "2.0"
instance:
  name: "My Homenichat"
  timezone: "Europe/Paris"

providers:
  whatsapp:
    - id: main
      type: baileys
      enabled: true

  sms:
    - id: twilio
      type: twilio
      enabled: true
      config:
        account_sid: "${TWILIO_SID}"
        auth_token: "${TWILIO_TOKEN}"

  voip:
    - id: pbx
      type: freepbx
      enabled: true
      config:
        host: "192.168.1.160"
        ami_port: 5038
```

## Architecture

```
homenichat-serv/
├── admin/              # React admin interface
├── config/             # YAML configuration
├── middleware/         # Express middlewares
├── providers/          # Communication providers
│   ├── whatsapp/       # Baileys, Meta Cloud
│   ├── sms/            # Twilio, OVH, Gammu
│   └── voip/           # FreePBX, SIP
├── routes/             # API routes
├── services/           # Business logic
├── scripts/            # Installation scripts
├── Dockerfile
├── docker-compose.yml
└── server.js           # Entry point
```

## API Documentation

### Authentication

```bash
# Login
POST /api/auth/login
{
  "username": "admin",
  "password": "Homenichat"
}

# Response
{
  "token": "eyJhbGc...",
  "user": { "id": 1, "username": "admin", "role": "admin" }
}
```

### Chats

```bash
# Get all chats
GET /api/chats
Authorization: Bearer <token>

# Send message
POST /api/chats/:id/messages
{
  "content": "Hello!",
  "type": "text"
}
```

See [API.md](docs/API.md) for full documentation.

## Related Projects

| Project | Description |
|---------|-------------|
| [homenichat-pwa](https://github.com/elkir0/homenichat-pwa) | Progressive Web App |
| [homenichat-app-android](https://github.com/elkir0/homenichat-app-android) | Android App |
| [homenichat-app-ios](https://github.com/elkir0/homenichat-app-ios) | iOS App |

## Legal Disclaimers

### WhatsApp / Baileys

This software optionally uses [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web API.

- **NOT** affiliated with WhatsApp Inc. or Meta Platforms, Inc.
- Using Baileys **may violate** WhatsApp's Terms of Service
- Your WhatsApp account **may be banned**
- **DO NOT** use for spam, bulk messaging, or stalkerware
- Use at your own risk for personal purposes only

### FreePBX / Asterisk

- FreePBX and Asterisk are trademarks of Sangoma Technologies
- This project is **NOT** affiliated with Sangoma
- Components are downloaded from official sources during installation

## License

GNU General Public License v3.0 - see [LICENSE](LICENSE)

## Contributing

Contributions welcome! Please read our contributing guidelines before submitting PRs.

---

**Homenichat** - Home + Omni + Chat
*Self-hosted unified communication, your way.*
