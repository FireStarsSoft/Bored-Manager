GO ?= go
NPM ?= npm
VERSION ?= 0.1.0-dev
COMMIT ?= unknown
BUILD_TIME ?= unknown
LDFLAGS := -X github.com/FireStarsSoft/Bored-Manager/internal/version.Version=$(VERSION) -X github.com/FireStarsSoft/Bored-Manager/internal/version.Commit=$(COMMIT) -X github.com/FireStarsSoft/Bored-Manager/internal/version.BuildTime=$(BUILD_TIME)

.PHONY: all generate fmt lint test web build clean

all: test build

generate:
	bash scripts/generate-contracts.sh

fmt:
	$(GO) fmt ./...

lint:
	$(GO) vet ./...
	cd web && $(NPM) run typecheck

test:
	$(GO) test ./...
	cd web && $(NPM) test -- --run

web:
	cd web && $(NPM) ci && $(NPM) run build

build: web
	$(GO) build -buildvcs=false -trimpath -ldflags "$(LDFLAGS)" -o bin/bored-managerd ./cmd/bored-managerd
	$(GO) build -buildvcs=false -trimpath -ldflags "$(LDFLAGS)" -o bin/bored-agentd ./cmd/bored-agentd
	$(GO) build -buildvcs=false -trimpath -ldflags "$(LDFLAGS)" -o bin/bmctl ./cmd/bmctl
	$(GO) build -buildvcs=false -trimpath -ldflags "$(LDFLAGS)" -o bin/bored-update-helper ./cmd/bored-update-helper

clean:
	rm -rf bin web/dist coverage
