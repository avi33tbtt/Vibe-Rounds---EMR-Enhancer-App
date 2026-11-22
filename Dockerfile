# EMR Enhancer server image. Synthetic data only, not for clinical use.
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first (cached layer). Production dependencies only: no jsdom, no playwright.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Application files (.dockerignore keeps out tests, docs, plans, .env and .git).
COPY . .

# Run as the unprivileged "node" user that ships with the image. The app writes no files.
USER node
EXPOSE 3000
CMD ["node", "server.js"]
