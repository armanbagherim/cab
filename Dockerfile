FROM node:22-alpine AS web-build

WORKDIR /app
COPY apps/mobile/package*.json ./
RUN npm ci
COPY apps/mobile/ ./

ARG EXPO_PUBLIC_API_URL=/api
ARG EXPO_PUBLIC_SOCKET_URL=/
ARG EXPO_PUBLIC_NESHAN_TILE_KEY
ENV EXPO_PUBLIC_API_URL=$EXPO_PUBLIC_API_URL
ENV EXPO_PUBLIC_SOCKET_URL=$EXPO_PUBLIC_SOCKET_URL
ENV EXPO_PUBLIC_NESHAN_TILE_KEY=$EXPO_PUBLIC_NESHAN_TILE_KEY

RUN npx expo export --platform web

FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/dist /usr/share/nginx/html
