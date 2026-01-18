# Configuration des Appels Entrants via Push

Ce document explique comment configurer le flux complet d'appels entrants avec push notifications pour réveiller l'application mobile même quand elle est fermée.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  APPEL ENTRANT SUR TRUNK GSM                                            │
│  (SIP INVITE depuis chan_quectel ou autre trunk)                        │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  ASTERISK / FreePBX                                                     │
│  - Route l'appel vers les extensions configurées                        │
│  - Génère événements AMI (DialBegin, etc.)                             │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  homenichat-serv / FreePBXAmiService.js                                 │
│  - Connecté via AMI TCP (port 5038)                                     │
│  - Détecte les appels entrants (handleIncomingRing)                     │
│  - Extrait: callerNumber, callerName, extension destination             │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  PushService.js                                                         │
│  - broadcast(INCOMING_CALL, callData) → WebSocket clients               │
│  - sendIncomingCallFCM(callData) → FCM Push                            │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  FCMPushService.js                                                      │
│  - sendIncomingCallNotification(callId, callerName, callerNumber)       │
│  - Envoie message DATA-ONLY (pas de notification visible)               │
│  - Payload: { type: 'incoming_call', callId, callerName, ... }          │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  FCM CLOUD (Google)                                                     │
│  - Route le message vers le device Android enregistré                   │
│  - Fonctionne même app fermée (high priority)                           │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Android App (index.js background handler)                              │
│  - setBackgroundMessageHandler() reçoit le push                         │
│  - RNCallKeep.displayIncomingCall() affiche UI native                   │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  UI Native Android (CallKeep / TelecomManager)                          │
│  - Affiche écran plein (même écran verrouillé)                         │
│  - Boutons Répondre / Refuser                                          │
│  - Audio: sonnerie système                                              │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                        ┌─────────┴─────────┐
                        ▼                   ▼
┌───────────────────────────┐   ┌───────────────────────────┐
│  RÉPONDRE                  │   │  REFUSER                   │
│  - ConnectionService       │   │  - ConnectionService       │
│    .onCallAnswered()       │   │    .onCallRejected()       │
│  - POST /api/voip/answer   │   │  - POST /api/voip/reject   │
│  - AMI Redirect vers ext   │   │  - AMI Hangup              │
│  - WebRTC SIP connect      │   │                            │
└───────────────────────────┘   └───────────────────────────┘
```

## Prérequis

### Côté Serveur (homenichat-serv)

1. **FreePBX/Asterisk** avec AMI activé
2. **homenichat-serv** en cours d'exécution
3. **Firebase Service Account** configuré (via interface Admin ou fichier)

### Côté Android (homenichat-app-android)

1. **google-services.json** dans le projet (votre propre projet Firebase)
2. **expo-dev-client** pour build custom (les plugins natifs nécessitent un build personnalisé)

> **Important**: Les fichiers Firebase (google-services.json et firebase-service-account.json) doivent provenir du **même projet Firebase** que vous créez. Voir la section Configuration Firebase ci-dessous.

---

## Configuration Serveur

### 1. Configuration AMI (FreePBX)

Dans FreePBX, créer un utilisateur AMI:

1. Aller dans **Admin** → **Asterisk Manager Users**
2. Cliquer **Add Manager**
3. Configurer:
   - **Manager Name**: `homenichat`
   - **Manager Secret**: `<votre_mot_de_passe>`
   - **Deny**: `0.0.0.0/0.0.0.0`
   - **Permit**: `127.0.0.1/255.255.255.0` (ou l'IP de homenichat-serv)
   - **Read**: `system,call,log,verbose,command,agent,user,config,dtmf,reporting,cdr,dialplan,originate`
   - **Write**: `system,call,log,verbose,command,agent,user,config,dtmf,reporting,cdr,dialplan,originate`
4. Cliquer **Submit** puis **Apply Config**

### 2. Variables d'environnement (.env)

```env
# AMI Connection
AMI_HOST=192.168.1.160        # IP du serveur FreePBX
AMI_PORT=5038                  # Port AMI (défaut 5038)
AMI_USERNAME=homenichat
AMI_PASSWORD=<votre_mot_de_passe>

# VoIP WebRTC (optionnel)
VOIP_WSS_URL=wss://rtc.example.com/ws
VOIP_DOMAIN=rtc.example.com
```

### 3. Configuration Firebase

> **⚠️ Sécurité**: Chaque installation doit utiliser son propre projet Firebase. Les fichiers de configuration contiennent des clés d'accès et ne doivent JAMAIS être partagés publiquement.

**a) Créer un projet Firebase:**
1. Aller sur https://console.firebase.google.com/
2. Créer un nouveau projet (ex: "homenichat-votre-nom")
3. Cloud Messaging est automatiquement activé

**b) Ajouter une application Android:**
1. Dans votre projet Firebase → **Add app** → **Android**
2. Package name: `fr.shathony.homenichat`
3. Télécharger `google-services.json` → pour l'app Android

**c) Générer la clé de service (pour le serveur):**
1. **Project Settings** → **Service Accounts**
2. Cliquer **Generate new private key**
3. Télécharger le fichier JSON

**d) Installer la clé sur le serveur:**

**Option 1 - Via l'interface Admin (recommandé):**
1. Aller dans l'interface Admin → **Paramètres** → **Firebase Push Notifications**
2. Cliquer **Sélectionner un fichier**
3. Choisir le fichier JSON téléchargé depuis Firebase
4. Le serveur valide et charge automatiquement la configuration

**Option 2 - Via ligne de commande:**
```bash
# Copier le fichier dans le répertoire config de homenichat-serv
cp ~/Downloads/votre-projet-firebase-adminsdk-xxxxx.json \
   /opt/homenichat/config/firebase-service-account.json

# Redémarrer le service
sudo supervisorctl restart homenichat
```

Le service cherche le fichier dans cet ordre:
1. `./config/firebase-service-account.json`
2. `./firebase-service-account.json`
3. `$DATA_DIR/firebase-service-account.json`

**e) Vérifier l'initialisation:**

Via l'interface Admin → Paramètres → Firebase, ou dans les logs:
```
[FCM] Service initialized for project: votre-projet-firebase
```

---

## Configuration Android

> **Documentation complète**: Voir `FIREBASE-SETUP.md` dans le dossier `homenichat-app-android` pour un guide pas-à-pas avec captures d'écran.

### 1. google-services.json

Le repository contient un fichier template `google-services.json.example`. Vous devez le remplacer par votre propre fichier provenant de votre projet Firebase.

1. Dans Firebase Console → **Project Settings** → **General**
2. Ajouter une app Android avec le package `fr.shathony.homenichat`
3. Télécharger `google-services.json`
4. Placer dans la racine du projet Android:

```bash
# Remplacer le template par votre fichier
cp ~/Downloads/google-services.json /path/to/homenichat-app-android/
```

> **Important**: Le fichier `google-services.json` est dans `.gitignore` pour éviter de committer vos clés. Chaque développeur/utilisateur doit fournir le sien.

### 2. Build de l'application

L'app utilise des modules natifs (CallKeep, Firebase) qui nécessitent un build custom:

```bash
cd homenichat-app-android

# Installer les dépendances
npm install

# Générer le code natif Android
npx expo prebuild --platform android --clean

# Build APK de développement
cd android && ./gradlew assembleDebug

# OU utiliser EAS Build
eas build --platform android --profile preview
```

### 3. Enregistrement du token FCM

L'application enregistre automatiquement son token FCM avec le serveur lors de la connexion:

1. L'utilisateur se connecte (login)
2. FCMService.ts récupère le token Firebase
3. POST `/api/notifications/fcm-token` avec le token
4. Le serveur stocke le token pour cet utilisateur

---

## Test du flux

### 1. Vérifier la connexion AMI

```bash
# Sur homenichat-serv
curl http://localhost:3001/api/providers/status

# Devrait montrer:
# { "providers": [{ "name": "asterisk", "type": "voip", "connected": true, "amiConnected": true }] }
```

### 2. Vérifier FCM

**Via l'interface Admin:**
- Aller dans **Paramètres** → **Firebase Push Notifications**
- Le statut affiche: "Configuré" avec le Project ID et le nombre d'appareils enregistrés

**Via API:**
```bash
curl http://localhost:3001/api/admin/firebase/status -H "Authorization: Bearer <token>"

# Devrait montrer:
# { "configured": true, "projectId": "votre-projet", "registeredDevices": 1 }
```

### 3. Test de push manuel

**Via l'interface Admin:**
- Aller dans **Paramètres** → **Firebase Push Notifications**
- Cliquer le bouton **Tester**
- Une notification devrait arriver sur tous les appareils enregistrés

**Via API:**
```bash
curl -X POST http://localhost:3001/api/admin/firebase/test \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json"
```

### 4. Simuler un appel entrant

Sur le serveur, vous pouvez déclencher un événement d'appel entrant manuellement pour tester:

```javascript
// Dans la console Node.js ou via API
const pushService = require('./services/PushService');

pushService.broadcast('incoming_call', {
  callId: 'test-' + Date.now(),
  callerNumber: '0690123456',
  callerName: 'Test Appel',
  lineName: 'Chiro',
  extension: '2001'
});
```

---

## Dépannage

### Le push n'arrive pas sur l'app

1. **Vérifier google-services.json** - doit correspondre au package de l'app (`fr.shathony.homenichat`)
2. **Vérifier firebase-service-account.json** - doit être du **même projet Firebase**
3. **Vérifier les logs serveur** - chercher `[FCM]`
4. **Vérifier le statut Firebase** - Interface Admin → Paramètres → Firebase
5. **Vérifier les appareils enregistrés** - L'app doit être connectée et avoir enregistré son token

> **Erreur courante**: Les deux fichiers (google-services.json côté Android et firebase-service-account.json côté serveur) doivent provenir du MÊME projet Firebase.

### L'écran d'appel natif ne s'affiche pas

1. **Vérifier les permissions Android** - Aller dans Paramètres → Apps → Homenichat → Permissions
2. **Activer le Phone Account** - L'app demande cette permission au premier lancement
3. **Vérifier les logs Android** - `adb logcat | grep -E "CallKeep|FCM"`

### L'appel ne se connecte pas après "Répondre"

1. **Vérifier la connexion AMI** - `/api/providers/status`
2. **Vérifier l'extension WebRTC** - L'utilisateur doit avoir une extension configurée
3. **Vérifier les logs AMI** - chercher `[AMI] Redirecting call`

---

## Fichiers clés

### Serveur (homenichat-serv)

| Fichier | Rôle |
|---------|------|
| `services/FreePBXAmiService.js` | Détection appels entrants via AMI |
| `services/PushService.js` | Broadcast WebSocket + FCM |
| `services/FCMPushService.js` | Envoi push Firebase |
| `routes/mobile-compat.js` | API /voip/answer, /voip/reject |
| `routes/admin.js` | API Firebase config (upload/status/test) |
| `admin/src/pages/SettingsPage.tsx` | Interface Admin Firebase |
| `config/firebase-service-account.json` | Clé Firebase (uploadée via Admin) |

### Android (homenichat-app-android)

| Fichier | Rôle |
|---------|------|
| `index.js` | Background handler FCM + CallKeep headless |
| `src/services/ConnectionService.ts` | Gestion appels avec CallKeep |
| `src/services/FCMService.ts` | Réception push Firebase |
| `plugins/withCallKeep.js` | Config native CallKeep |
| `google-services.json` | Config Firebase (à créer depuis votre projet) |
| `google-services.json.example` | Template de référence |
| `FIREBASE-SETUP.md` | Guide complet de configuration Firebase |

---

## Liens utiles

- [Firebase Console](https://console.firebase.google.com/)
- [Documentation FCM](https://firebase.google.com/docs/cloud-messaging)
- [react-native-callkeep](https://github.com/react-native-webrtc/react-native-callkeep)
- [Documentation Homenichat - Admin API](./api-reference.md)
