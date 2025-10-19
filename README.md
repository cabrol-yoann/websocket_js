# Peer-to-Peer Secure Messaging

Un système de messagerie P2P chiffrée avec WebSocket et chiffrement asymétrique, incluant un tracker central pour découvrir les pairs et un client web léger.

## 📦 Architecture

Le projet se compose de trois parties principales :

**Peer (Node.js)**
- Établit des connexions WebSocket avec d'autres pairs
- Utilise un handshake sécurisé avec signatures `Ed25519` et dérivation de clés de session via `X25519`
- Messages chiffrés avec AES-256-GCM et ratchet de type Double Ratchet
- Supporte la rotation régulière des clés de session
- Maintient un buffer pour les messages destinés à des pairs hors-ligne

**Client Web**
- Interface simple pour envoyer et recevoir des messages
- Permet les messages publics (broadcast) ou privés à un destinataire spécifique
- Ping/Pong pour vérifier la connexion

**Tracker (Node.js)**
- Maintient la liste des pairs connectés
- Distribue les informations sur les autres pairs pour faciliter la découverte P2P
- Supporte l'enregistrement, la désinscription et la notification des pairs

## ⚙️ Installation

1. **Cloner le dépôt**
   ```bash
   git clone <repo-url>
   cd <repo-folder>
   ```

2. **Installer les dépendances**
   ```bash
   npm install
   ```

3. **Lancer le tracker**
   ```bash
   node tracker.js
   ```

4. **Lancer un peer**
   ```bash
   node peer.js [PORT]
   ```
   Par défaut, `PORT = 9001`. Chaque peer se connecte automatiquement au tracker (`ws://localhost:8080`).

5. **Accéder au client web**
   Ouvrir un navigateur sur `http://localhost:<PORT>` du peer.

## 🔐 Fonctionnalités de sécurité

**Handshake sécurisé**
- Authentification via signature `Ed25519`
- Échange de clés publiques éphémères pour dériver la sessionKey

**Chiffrement des messages**
- AES-256-GCM pour l'intégrité et la confidentialité
- Nonces pour prévenir les attaques de replay
- Double Ratchet pour la rotation continue des clés

**Rotation des clés**
- Automatique toutes les 5 minutes
- Synchronisation avec les pairs

**Buffering**
- Les messages destinés à des pairs hors-ligne sont conservés et livrés dès que le pair se reconnecte

## 💬 Utilisation

**Envoi de messages via le client web**
- **Broadcast** : laisser le champ "Nom destinataire" vide
- **Privé** : renseigner le nom du destinataire

**Logs et monitoring**
- Le peer affiche régulièrement l'état du réseau et des pairs connectés
- Les messages et événements sont loggés avec des emojis pour faciliter la lecture :
  - ℹ️ Info
  - ⚠️ Avertissement
  - 🚨 Erreur
  - 💬 Message
  - 🔐 Sécurité
  - ✅ Succès

## 🌐 Architecture réseau

```
+-------------+          +-------------+          +-------------+
| Peer Node 1 | <------> | Peer Node 2 | <------> | Peer Node 3 |
+-------------+          +-------------+          +-------------+
       ^                        ^
       |                        |
       v                        v
     Tracker -------------------+
```

- Le tracker agit uniquement comme service de découverte
- La communication entre pairs est directe et chiffrée

## 📝 Notes

- Chaque peer génère un `peerId` unique et un `username` par défaut aléatoire
- Limitation : le nombre maximal de pairs connectés simultanément est configurable via `MAX_PEERS`
- Les adresses IPv6 sont correctement supportées grâce à l'encapsulation `[]`

## 🔧 Personnalisation

- Modifier la fréquence de rotation des clés : `setInterval` dans `peer.js`
- Ajuster le `PING_INTERVAL` et `PONG_TIMEOUT` dans le client web pour une meilleure tolérance aux délais réseau

## ⚡ Technologies utilisées

- Node.js
- WebSocket (`ws`)
- Crypto (`Ed25519`, `X25519`, AES-256-GCM)
- Express pour le serveur HTTP
- UUID pour l'identifiant unique des peers
- Vanilla JS + HTML/CSS pour le client web

---

# 📡 Documentation du protocole P2P Secure Messaging

## 1. Vue d'ensemble

Le protocole repose sur trois types de participants :

- **Peer Node** : communication P2P directe avec chiffrement
- **Tracker** : service central pour découvrir les peers
- **Client Web** : interface utilisateur, envoie et reçoit des messages via WebSocket

Le protocole utilise WebSocket comme transport et JSON comme format de message.

## 2. Messages du protocole

### 2.1 Messages Peer ↔ Peer

#### 2.1.1 Handshake initial

Envoyé par le peer initiateur pour établir la session :

```json
{
  "type": "handshake",
  "peerId": "uuid-v4",
  "username": "user123",
  "publicKey": "<clé publique X25519 base64>",
  "identityKey": "<clé publique Ed25519 base64>",
  "signature": "<signature Ed25519 base64 sur publicKey>"
}
```

Réponse (handshake_ack) :

```json
{
  "type": "handshake_ack",
  "peerId": "uuid-v4",
  "username": "user456",
  "publicKey": "<clé publique X25519 base64>",
  "identityKey": "<clé publique Ed25519 base64>",
  "signature": "<signature Ed25519 base64 sur publicKey>"
}
```

**Objectif** : authentifier le peer, établir un secret partagé pour la session chiffrée. Les clés de session sont dérivées via Diffie-Hellman X25519 + HKDF.

#### 2.1.2 Messages chiffrés

Format envoyé après handshake :

```json
{
  "type": "encrypted",
  "payload": {
    "iv": "<base64>",
    "encrypted": "<base64>",
    "tag": "<base64>"
  },
  "nonce": 0
}
```

- **nonce** : compteur pour la ratchet (prévenir le replay)
- **payload** : AES-256-GCM encrypté du message JSON suivant :

```json
{
  "type": "sendMessage",
  "peerId": "uuid-v4",
  "data": {
    "username": "user123",
    "text": "Bonjour",
    "to": "user456"
  },
  "date": "2025-10-19T12:00:00Z",
  "id": "uuid-v4"
}
```

Note : `to` est facultatif, `null` = broadcast

#### 2.1.3 Rotation de clés

```json
{
  "type": "keyRotation",
  "publicKey": "<nouvelle clé X25519 base64>"
}
```

Permet de recalculer sessionKey via Diffie-Hellman. Assure un forward secrecy continu.

#### 2.1.4 Ping / Pong

```json
{ "type": "ping" }
{ "type": "pong" }
```

Vérifie la disponibilité du peer.

### 2.2 Messages Client Web ↔ Peer

#### 2.2.1 Enregistrement

```json
{ "type": "register" }
```

Indique au peer que ce WebSocket est un client local.

#### 2.2.2 Envoi de message

```json
{
  "type": "sendMessage",
  "data": {
    "text": "Bonjour",
    "to": "user456"
  }
}
```

Le peer va chiffrer le message et l'envoyer aux peers concernés. Note : `to` peut être `null` pour un broadcast

#### 2.2.3 Réception de message

```json
{
  "type": "sendMessage",
  "data": {
    "username": "user123",
    "text": "Bonjour",
    "to": "user456"
  },
  "date": "2025-10-19T12:00:00Z",
  "id": "uuid-v4"
}
```

### 2.3 Messages Tracker ↔ Peer

#### 2.3.1 Registration

```json
{
  "type": "register",
  "payload": {
    "id": "uuid-v4",
    "username": "user123",
    "port": 9001
  }
}
```

#### 2.3.2 Désinscription

```json
{ "type": "unregister" }
```

#### 2.3.3 Liste des peers

```json
{
  "type": "peersUpdate",
  "payload": [
    { "id": "uuid-v4", "username": "user456", "address": "127.0.0.1", "port": 9002, "online": true }
  ]
}
```

#### 2.3.4 Ping / Pong

```json
{ "type": "ping" }
{ "type": "pong" }
```

## 3. Workflows

### 3.1 Découverte d'un peer

1. Peer envoie `register` au tracker
2. Tracker répond avec `peersUpdate`
3. Peer se connecte aux peers listés et initie le handshake

### 3.2 Handshake P2P sécurisé

1. Peer A envoie `handshake` à Peer B
2. Peer B vérifie la signature, calcule `sessionKey`
3. Peer B répond avec `handshake_ack`
4. Peer A vérifie la signature et dérive sa `sessionKey`
5. Communication chiffrée peut commencer

### 3.3 Envoi de messages

1. Client Web envoie `sendMessage` au peer
2. Peer chiffre le message avec AES-256-GCM et envoie aux peers concernés
3. Si peer destinataire hors-ligne, message est bufferisé
4. Peer destinataire reçoit `encrypted`, décrypte et transmet au client local si applicable

### 3.4 Rotation de clés

1. Peer génère une nouvelle clé éphémère
2. Envoie `keyRotation` aux peers connectés
3. Chaque peer recalcule la `sessionKey` via Diffie-Hellman
4. Les messages suivants utilisent la nouvelle clé

### 3.5 Ping / Pong et keepalive

1. Chaque 5s, le client et les peers envoient un `ping`
2. Si le `pong` n'est pas reçu sous `PONG_TIMEOUT`, la connexion est considérée fermée

---

# 🚀 Lancer le projet

Voici les étapes complètes pour récupérer, configurer et lancer ton projet de messagerie P2P sécurisé.

## 1️⃣ Récupérer le projet depuis GitHub

```bash
git clone <URL_DE_TON_REPO>
cd <NOM_DU_DOSSIER>
```

Remplace `<URL_DE_TON_REPO>` par l'URL de ton dépôt GitHub et `<NOM_DU_DOSSIER>` par le nom du dossier créé lors du clone.

## 2️⃣ Initialiser le projet Node.js

```bash
npm init -y
```

Cette commande crée un fichier `package.json` avec les paramètres par défaut.

## 3️⃣ Vérifier le type de module

Ouvre `package.json` et assure-toi que la ligne suivante existe :

```json
"type": "module"
```

Cela permet d'utiliser les imports ES6 (`import … from …`) dans tes fichiers `.js`.

## 4️⃣ Installer les dépendances

```bash
npm install ws express uuid
```

- `ws` → WebSockets pour Node.js
- `express` → serveur HTTP pour le client web
- `uuid` → génération d'identifiants uniques pour les peers

## 5️⃣ Lancer le tracker

```bash
node tracker.js
```

Par défaut, le tracker écoute sur le port `8080`. Il permet aux peers de se découvrir mutuellement.

## 6️⃣ Lancer un peer

```bash
node peer.js [PORT]
```

- `[PORT]` : port sur lequel le peer écoutera (ex : `9001`)
- Si aucun port n'est fourni, le peer utilise `9001` par défaut

**Exemple pour lancer deux peers sur la même machine :**

```bash
node peer.js 9001
node peer.js 9002
```

Chaque peer se connecte automatiquement au tracker pour s'enregistrer et découvre les autres peers.

## 7️⃣ Accéder au client web

```
http://localhost:<PORT>
```

Remplace `<PORT>` par le port du peer (ex : `9001` ou `9002`). Tu peux envoyer des messages publics (broadcast) ou privés à un peer spécifique.
