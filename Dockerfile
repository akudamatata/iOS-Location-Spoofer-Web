FROM node:20-alpine

# Install openssl (for potential future cert needs)
RUN apk add --no-cache openssl

WORKDIR /app

# Copy app files
COPY server.js .
COPY public/ ./public/

# Data volume (loc.json + favorites.json persisted here)
VOLUME ["/data"]

ENV PORT=8080
ENV DATA_DIR=/data

EXPOSE 8080

CMD ["node", "server.js"]
