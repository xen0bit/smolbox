FROM golang:1.24-alpine@sha256:8bee1901f1e530bfb4a7850aa7a479d17ae3a18beb6e09064ed54cfd245b7191 AS agent
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY internal/protocol ./internal/protocol
COPY guest ./guest
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" \
        -o /smolagentd ./guest/smolagentd

FROM alpine:3.21@sha256:48b0309ca019d89d40f670aa1bc06e426dc0931948452e8491e3d65087abc07d
RUN apk add --no-cache coreutils findutils grep
COPY --from=agent /smolagentd /sbin/smolagentd
RUN mkdir -p /mnt/host
ENTRYPOINT ["/bin/sh"]
