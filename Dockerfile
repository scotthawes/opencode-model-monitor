FROM node:18-slim

# Passively monitors OpenCode hosted models. Continuous mode by default.
WORKDIR /app

# Install deps first for better layer caching (node-notifier is optional; the
# monitor runs with zero runtime deps, but install it for desktop notifications).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source. subscribers.json / config.json / state are NOT copied (gitignored,
# user-supplied) — mount them as volumes, e.g.:
#   -v "$PWD/subscribers.json:/app/subscribers.json:ro"
#   -v "$PWD/state:/app/state"
COPY . .

# State + subscriber secret live on the host volume, not in the image.
VOLUME ["/app/state"]

CMD ["node", "src/monitor.js"]
