FROM golang:1.24-alpine@sha256:8bee1901f1e530bfb4a7850aa7a479d17ae3a18beb6e09064ed54cfd245b7191 AS agent
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY internal/protocol ./internal/protocol
COPY guest ./guest
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" \
        -o /smolagentd ./guest/smolagentd

FROM alpine:3.21@sha256:48b0309ca019d89d40f670aa1bc06e426dc0931948452e8491e3d65087abc07d
# ripgrep and tree are here for the Antares agent, not for general polish: its
# system prompt advertises `rg` and `tree` by name, and its trained policy spends
# ~52% of its tool calls on search (PLAN §11.1.16). A model reaching for a
# binary that is not installed spends its budget on error messages.
# python3 is the one interpreter here: a model that can write a script gets
# arithmetic, JSON and text munging in one tool call instead of a pipeline of
# five. There is deliberately no pip — the guest has no network, so it could
# only ever install from files already inside the VM — and the trim drops the
# parts of the stdlib that exist to build or document Python rather than to run
# it. __pycache__ stays: recompiling the stdlib on every invocation costs far
# more inside an emulated x86 than the 5.3 MiB it would save (PLAN §10.24).
RUN apk add --no-cache coreutils findutils grep ripgrep tree python3 \
 && cd /usr/lib/python3.12 \
 && rm -rf ensurepip lib2to3 pydoc_data idlelib turtledemo test */test */tests
COPY --from=agent /smolagentd /sbin/smolagentd
RUN mkdir -p /mnt/host
ENTRYPOINT ["/sbin/smolagentd"]
