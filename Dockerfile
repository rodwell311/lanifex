# PlanForge — single-file Node app, zero dependency, Node 22+ (node:sqlite)
FROM node:22-alpine

WORKDIR /app
COPY server.js cli.js ./
COPY public ./public
RUN mkdir -p /app/data

ENV PORT=8788 \
    DATA_DIR=/app/data \
    LLM_BASE_URL=http://host.docker.internal:20128/v1

EXPOSE 8788
VOLUME ["/app/data"]
CMD ["node", "server.js"]
