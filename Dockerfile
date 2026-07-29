# syntax=docker/dockerfile:1

# ---- build ------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Baked into the client bundle at build time, so it has to be set here, not at run.
ARG NUXT_PUBLIC_URL_BASE=https://u34ss-explorer.gimme.pet
ENV NUXT_PUBLIC_URL_BASE=$NUXT_PUBLIC_URL_BASE

RUN npm run build

# ---- serve ------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/.output/public /usr/share/nginx/html
EXPOSE 80
