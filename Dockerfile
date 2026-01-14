# Dockerfile pour Homenichat-serv

# Stage 1: Build du frontend
FROM node:20-alpine AS frontend-builder

WORKDIR /app/frontend

# Copier les fichiers de dépendances
COPY frontend/package*.json ./

# Installer les dépendances
RUN npm install --omit=dev

# Copier le code source
COPY frontend/ ./

# Build de l'application React
RUN npm run build

# Stage 2: Build de l'admin interface
FROM node:20-alpine AS admin-builder

WORKDIR /app/admin

# Copier les fichiers de dépendances
COPY backend/admin/package*.json ./

# Installer les dépendances
RUN npm install

# Copier le code source
COPY backend/admin/ ./

# Build de l'interface admin
RUN npm run build

# Stage 3: Serveur de production
FROM node:20-alpine

# Installer nginx, supervisor et les dépendances pour sqlite3
RUN apk add --no-cache nginx supervisor python3 make g++ sqlite-dev git

# Créer le répertoire de travail et le répertoire data
WORKDIR /app
RUN mkdir -p /app/data && chmod 777 /app/data

# Copier le backend
COPY backend/package*.json ./backend/
WORKDIR /app/backend
# Forcer la reconstruction de sqlite3
RUN npm install --omit=dev && npm rebuild better-sqlite3
COPY backend/ ./
# Copier le fichier .env si présent
COPY backend/.env* ./

# Copier le build de l'admin interface dans le backend
COPY --from=admin-builder /app/admin/dist ./admin/dist

# Copier le build du frontend
COPY --from=frontend-builder /app/frontend/build /usr/share/nginx/html

# Copier la configuration nginx optimisée
COPY nginx.conf /etc/nginx/http.d/default.conf

# Copier la configuration supervisor
COPY supervisord.conf /etc/supervisord.conf

# Exposer les ports
EXPOSE 80 3001

# Variables d'environnement par défaut
ENV NODE_ENV=production
ENV PORT=3001
ENV INSTANCE_NAME=homenichat
ENV DATA_DIR=/app/data

# Démarrer l'application avec supervisor
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisord.conf"]
