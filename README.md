# SunuMarket (Prototype)

Prototype d'une **marketplace intelligente africaine** avec frontend + backend API.

## 🚀 Lancer le site

1. Ouvrez un terminal dans le dossier du projet.
2. (Optionnel) Lancez le backend API si vous souhaitez utiliser les fonctions avancees (auth, commandes, paiement, IA). Vous aurez besoin de Node.js 18+ recommande.

```powershell
cd server
npm install
npm start
```

Le backend expose l'API sur `http://localhost:4001`.

3. Lancez un serveur local pour le frontend (exemple avec Python 3) :

```powershell
python -m http.server 8000
```

3. Ouvrez votre navigateur à : [http://localhost:8000](http://localhost:8000)

## ✨ Fonctionnalités incluses

- Inscription / connexion via API securisee (JWT + mot de passe hash)
- Protection API (Helmet + limitation de debit / anti-bruteforce)
- Création de boutique (slug partagé)
- Ajout de produits (photo, prix, stock, livraison)
- Suivi des ventes (inventaire, chiffres, objectif mensuel)
- Système de badge (active / pro / top)
- Chatbot basique (réponses préprogrammées)
- Pages de boutique partageables (`#store/<slug>`)
- Persistance SQLite (`server/sunumarket.db`)

> Le frontend peut tourner en local, et le backend stocke les donnees dans SQLite.

## 📌 Améliorations possibles

- Paiements (Wave, Orange Money, carte bancaire)
- Système de commandes + livraison
- IA avancée pour recommandations et génération automatique

## Mise en ligne (checklist rapide)

1. Copier `server/.env.example` vers `server/.env` puis remplir les vraies valeurs.
2. Definir un `JWT_SECRET` fort (minimum 32 caracteres aleatoires).
3. Definir `FRONTEND_ORIGINS` avec ton vrai domaine frontend.
4. Verifier que `DATABASE_PATH` pointe vers un stockage persistant.
5. Ajuster `AUTH_RATE_LIMIT_MAX` et `API_RATE_LIMIT_MAX` selon ton trafic.
6. Activer `TRUST_PROXY=true` si l'API est derriere Nginx/Caddy/Cloudflare.
7. Remplacer les cles de test paiement/SMTP/WhatsApp par des cles de production.
8. Lancer l'API derriere HTTPS (reverse proxy type Nginx/Caddy).

Guide detaille: voir `DEPLOYMENT.md`.

Fichiers proxy prets a copier:

- Nginx: `deploy/nginx/sunumarket-api.conf`
- Caddy: `deploy/caddy/Caddyfile`

---

*Ce projet est un MVP. Il peut etre publie en version initiale, puis evoluer vers une base PostgreSQL/MySQL selon la charge.*
