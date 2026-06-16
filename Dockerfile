FROM node:20-slim AS builder

WORKDIR /app

# Install build dependencies for better-sqlite3
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .

# Final stage
FROM node:20-slim

WORKDIR /app

COPY --from=builder /app /app

ENV PORT=3007
ENV DB_PATH=/app/data/database.sqlite

EXPOSE 3007

VOLUME ["/app/data"]

CMD ["npm", "start"]
