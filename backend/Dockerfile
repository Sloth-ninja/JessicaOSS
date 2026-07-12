# JessicaOS backend — production container image.
#
# Not built or run in the authoring sandbox (no Docker daemon available there).
# Verify locally before relying on it:
#   docker build -t jessicaos-backend backend/
#   docker run --rm -p 3001:3001 --env-file backend/.env jessicaos-backend
#
# Two stages: build (compiles TypeScript with tsc, per package.json's
# "build" script) and runtime (installs only production deps + LibreOffice,
# needed by backend/src/lib/convert.ts for DOCX -> PDF conversion via the
# `soffice` binary).

# ---- Build stage -----------------------------------------------------------
FROM node:22-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage ----------------------------------------------------------
FROM node:22-slim AS runtime

# libreoffice-writer is the minimal apt package that provides a headless
# `soffice` binary capable of DOCX -> PDF conversion (backend/src/lib/convert.ts
# calls docxToPdf(), which shells out to soffice via the libreoffice-convert
# package). Installing the full `libreoffice` metapackage would also pull in
# Impress/Calc/Draw, which this backend never uses.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libreoffice-writer \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

# node:22-slim ships a non-root "node" user (uid 1000) already; use it instead
# of running the server as root. Ownership is set per-COPY (and by running
# npm ci as that user) rather than via a trailing `chown -R`, which would
# duplicate every file into an extra image layer. WORKDIR creates /app owned
# by root, so hand the (still empty) directory to node first — non-recursive,
# so the layer stays tiny.
RUN chown node:node /app
COPY --chown=node:node package.json package-lock.json ./
USER node
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY --from=build --chown=node:node /app/dist ./dist

EXPOSE 3001

CMD ["node", "dist/index.js"]
