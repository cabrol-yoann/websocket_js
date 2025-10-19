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
