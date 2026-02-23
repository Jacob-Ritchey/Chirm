# ── Build Stage ──────────────────────────────────────────────────────────────
FROM golang:1.21-alpine AS builder

WORKDIR /build

# Dependencies first (cache layer)
COPY go.mod go.sum ./
RUN go mod download

# Source
COPY . .

# Build static binary (no CGO needed - pure Go SQLite driver)
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o chirm .

# ── Final Stage ───────────────────────────────────────────────────────────────
FROM alpine:3.19

RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -S chirm && adduser -S chirm -G chirm

WORKDIR /app

COPY --from=builder /build/chirm .

# Create data + certs directories
RUN mkdir -p /data/uploads /app/certs && chown -R chirm:chirm /data /app/certs

USER chirm

VOLUME ["/data"]

EXPOSE 8080 8443

ENV DATA_DIR=/data \
    PORT=8080 \
    HTTPS_PORT=8443

ENTRYPOINT ["./chirm"]
