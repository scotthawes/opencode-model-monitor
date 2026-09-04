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

# Lightweight liveness probe: the monitor is a long-running Node process. This
# only confirms the container/runtime is healthy (Node can execute); it does not
# assert monitor state. Keep it trivial so it never breaks the build.
HEALTHCHECK --interval=5m --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "process.exit(0)"

CMD ["node", "src/monitor.js"]
