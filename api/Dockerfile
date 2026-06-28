# Multi-stage build for the Go API.
FROM golang:1.25-alpine AS build
WORKDIR /src
RUN apk add --no-cache git ca-certificates
# Copy sources and resolve deps at build time (go.sum is generated here).
COPY . .
RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -o /out/api ./cmd/api

FROM alpine:3.22
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 app
# Pre-create the local-storage root owned by app so a fresh named volume mounted
# here inherits app ownership (Docker seeds new volumes from the image content).
RUN mkdir -p /data/blobs && chown -R app:app /data
COPY --from=build /out/api /usr/local/bin/api
USER app
EXPOSE 8080
# Liveness/readiness: the API serves /healthz (200 {"status":"ok"}).
# busybox wget ships in the alpine base.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1
ENTRYPOINT ["/usr/local/bin/api"]
