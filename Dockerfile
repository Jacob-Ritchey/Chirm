# ─── Stage 1: Build ──────────────────────────────────────────────────────────
FROM golang:1.22-alpine AS builder

WORKDIR /build

# Copy everything and build
COPY . .
RUN go mod tidy && \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o chirm .

# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM alpine:3.19

RUN apk add --no-cache ca-certificates tzdata

# Non-root user for security
RUN addgroup -S chirm && adduser -S chirm -G chirm

WORKDIR /app

# Copy the binary and entrypoint from builder
COPY --from=builder /build/chirm /app/chirm
COPY docker-entrypoint.sh /app/docker-entrypoint.sh

# Strip Windows line-endings (CRLF → LF) that break the shebang, then set permissions
RUN sed -i 's/\r$//' /app/docker-entrypoint.sh && \
    chmod +x /app/docker-entrypoint.sh && \
    mkdir -p /app/data/uploads /app/certs && \
    chown -R chirm:chirm /app

USER chirm

# Defaults — override via docker-compose.yml or `docker run -e`
ENV DATA_DIR=/app/data \
    PORT=8080 \
    HTTPS_PORT=8443

EXPOSE 8080 8443

VOLUME ["/app/data", "/app/certs"]

ENTRYPOINT ["/app/docker-entrypoint.sh"]
