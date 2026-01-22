# Push Notification Security Model

This document describes the security architecture of push notifications in Homenichat, ensuring that notifications are delivered to the correct user and preventing cross-user delivery.

## Overview

Homenichat uses a relay server (`relay.homenichat.com`) to handle push notifications for multiple users. The security model ensures complete isolation between users.

## Authentication

All push-related API calls require a Bearer token (API token `hc_xxx`) in the Authorization header:

```
Authorization: Bearer hc_xxx...
```

The API token is obtained when a user logs into Homenichat Cloud and uniquely identifies that user.

## Security Guarantees

### 1. Device Registration

When registering a device token (APNs/FCM/VoIP):

```
POST /push/register
Authorization: Bearer hc_alice_token
Body: { deviceId: "...", platform: "ios", token: "..." }
```

**Security**: The relay server extracts the `userId` from the Bearer token, NOT from the request body.
- Even if an attacker includes a different `userId` in the body, it is ignored
- Devices can only be registered for the authenticated user's account
- This prevents spoofing

### 2. Push Sending

When sending a push notification:

```
POST /push/send
Authorization: Bearer hc_alice_token
Body: { userId: "alice_id", type: "incoming_call", data: {...} }
```

**Security**: The relay validates that `body.userId === token.userId`:
- If they match: Push is sent to all devices registered under that user
- If they don't match: Returns `403 "Cannot send push to other users"`
- Servers can only send pushes to their own user's devices

### 3. Device Token Isolation

Device tokens are stored per-user in the database:

```sql
device_tokens (
    user_id,      -- From the API token
    device_id,    -- Unique device identifier
    token,        -- APNs/FCM/VoIP token
    platform,     -- 'ios' or 'android'
    token_type    -- 'apns', 'fcm', 'voip', 'expo'
)
```

When fetching tokens for push delivery, the relay queries:
```sql
SELECT * FROM device_tokens WHERE user_id = ?
```

Only tokens belonging to the authenticated user are returned.

## Multi-User Scenario

### Example: Two Active Homenichat Cloud Accounts

| User | Email | API Token | User ID |
|------|-------|-----------|---------|
| Alice | alice@mail.com | `hc_alice_xxx` | `user_001` |
| Bob | bob@mail.com | `hc_bob_yyy` | `user_002` |

### Registration Flow

```
Alice's iPhone                  Relay DB
─────────────                   ────────
POST /push/register             device_tokens:
Auth: hc_alice_xxx              ├─ user_id: user_001
Body: {deviceId, token}         │  device: iphone-alice
                                │  token: apns_alice

Bob's Android
────────────
POST /push/register             └─ user_id: user_002
Auth: hc_bob_yyy                   device: android-bob
Body: {deviceId, token}            token: fcm_bob
```

### Send Flow

```
Alice's Server (incoming call)
│
├─ API Token: hc_alice_xxx → user_id = user_001
├─ Requests: userId: "user_001"
│
└──▶ Relay validates: "user_001" == "user_001" ✅
     └──▶ SELECT tokens WHERE user_id = "user_001"
          → Only apns_alice is returned
          → Bob's fcm_bob token is NOT accessible
```

### Attack Scenario (Prevented)

```
Malicious Actor with hc_alice_xxx tries to send to Bob:

POST /push/send
Auth: Bearer hc_alice_xxx
Body: { userId: "user_002", ... }  // Trying to target Bob

Relay validation:
├─ Token user_id: "user_001" (from hc_alice_xxx)
├─ Body userId: "user_002" (attack attempt)
└─ "user_001" !== "user_002"
   → 403 "Cannot send push to other users"
```

## Code Implementation

### Server-Side (homenichat-serv)

**PushRelayService.js** and **HomenichatCloudService.js**:
- `registerDevice()` does NOT send userId to relay (extracted from token)
- `unregisterDevice()` does NOT send userId to relay (extracted from token)
- `sendPush()` sends userId for explicit validation by relay

### Relay-Side (homenichat-provisioning)

**routes/push.js**:
```javascript
// Registration: userId from token
const user = db.findUserByApiToken(apiToken);
db.upsertDeviceToken({ userId: user.id, ... });

// Sending: Validate userId matches token
const targetUserId = req.body.userId || user.id;
if (targetUserId !== user.id) {
    return res.status(403).json({ error: 'Cannot send push to other users' });
}
```

### Mobile App (iOS/Android)

**CloudAuthService.ts** and **VoipPushService.ts**:
- Token registration does NOT include userId in request body
- Authentication via Bearer token (hc_xxx) only
- Relay handles user identification securely

## Token Types

| Type | Platform | Usage |
|------|----------|-------|
| `apns` | iOS | Standard notifications (messages) |
| `voip` | iOS | PushKit VoIP for incoming calls |
| `fcm` | Android | All notifications via Firebase |
| `expo` | Both | Deprecated, for legacy support |

For incoming calls on iOS, VoIP tokens (`voip` type) are used to ensure the app can display CallKit even when terminated.

## Summary

1. **Registration**: userId from Bearer token, not request body
2. **Sending**: userId validated against Bearer token
3. **Storage**: Tokens isolated per-user in database
4. **Result**: No cross-user push delivery is possible
