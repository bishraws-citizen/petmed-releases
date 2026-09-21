# Runtime for the whole app: the API serves the built SPA, so one container and
# one port is all a host needs.
FROM node:22-bookworm-slim

# Chromium is only needed for the flight-search automation. It roughly triples
# the image, so it can be skipped for a deployment that will not use search.
ARG INSTALL_BROWSER=true

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORT=4000

WORKDIR /app

# Dependencies first, so a code change does not re-download the world.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

RUN if [ "$INSTALL_BROWSER" = "true" ]; then \
      npx playwright install --with-deps chromium && \
      rm -rf /var/lib/apt/lists/*; \
    fi

COPY . .
RUN npm run build

# Anything written at runtime lives here. On hosts with an ephemeral filesystem
# this resets when the container restarts — see the deployment notes.
RUN mkdir -p server/data && chown -R node:node server/data
USER node

EXPOSE 4000
CMD ["npm", "start"]
