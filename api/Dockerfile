# Multi-stage build for the Go API.
FROM golang:1.23-alpine AS build
WORKDIR /src
RUN apk add --no-cache git ca-certificates
# Copy sources and resolve deps at build time (go.sum is generated here).
COPY . .
RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -o /out/api ./cmd/api

FROM alpine:3.20
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 app
# Pre-create the local-storage root owned by app so a fresh named volume mounted
# here inherits app ownership (Docker seeds new volumes from the image content).
RUN mkdir -p /data/blobs && chown -R app:app /data
COPY --from=build /out/api /usr/local/bin/api
USER app
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/api"]
