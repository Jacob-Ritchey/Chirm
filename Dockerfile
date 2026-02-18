# ── Build Stage ──────────────────────────────────────────────────────────────
FROM golang:1.21-alpine AS builder

WORKDIR /build

# Dependencies first (cache layer)
COPY go.mod go.sum ./
RUN go mod download

# Source
COPY . .

# Build static binary (no CGO needed - pure Go SQLite driver)
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o nexus .

# ── Final Stage ───────────────────────────────────────────────────────────────
FROM alpine:3.19

RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -S nexus && adduser -S nexus -G nexus

WORKDIR /app

COPY --from=builder /build/nexus .

# Create data directory
RUN mkdir -p /data/uploads && chown -R nexus:nexus /data

USER nexus

VOLUME ["/data"]

EXPOSE 8080

ENV DATA_DIR=/data \
    PORT=8080

ENTRYPOINT ["./nexus"]
