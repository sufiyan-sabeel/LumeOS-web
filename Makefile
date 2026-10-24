# =====================================================================
# LumeOS-web - unified build system
#   make            -> build backend + frontend
#   make run        -> build then start the server on :8080
#   make test       -> build and run the C unit tests
#   make package-source -> produce build/lumeos-source.tar.gz
# =====================================================================

CC       ?= cc
CFLAGS   ?= -std=c11 -Wall -Wextra -O2 -pthread
LDFLAGS  ?= -pthread
PORT     ?= 8080
WEBROOT  ?= build/web

# TypeScript compiler: prefer a local install, fall back to npx.
TSC      ?= $(shell command -v tsc 2>/dev/null || echo "npx --yes tsc")

ENGINE_SRC  := $(wildcard engine/*.c)
BACKEND_SRC := $(wildcard backend/*.c)
BACKEND_LIB := $(filter-out backend/main.c,$(BACKEND_SRC))
CORE_SRC    := $(ENGINE_SRC) $(BACKEND_SRC)

SERVER_BIN  := build/lume-server
TEST_BIN    := build/lume-tests

CFLAGS += -Iengine -Ibackend/include

.PHONY: all backend frontend run test clean package-source deps help

all: backend frontend

# ---------------------------------------------------------------------
# Backend (C)
# ---------------------------------------------------------------------
backend: $(SERVER_BIN)

$(SERVER_BIN): $(CORE_SRC) $(wildcard engine/*.h) $(wildcard backend/include/*.h)
	@mkdir -p build
	$(CC) $(CFLAGS) $(CORE_SRC) -o $(SERVER_BIN) $(LDFLAGS)
	@echo "  -> built $(SERVER_BIN)"

# ---------------------------------------------------------------------
# Frontend (TypeScript -> build/web)
# ---------------------------------------------------------------------
frontend: $(WEBROOT)/index.html

$(WEBROOT)/index.html: $(wildcard frontend/**/*.ts) frontend/index.html frontend/tsconfig.json
	@mkdir -p $(WEBROOT)
	@echo "  -> compiling TypeScript"
	$(TSC) -p frontend/tsconfig.json
	@cp -f frontend/index.html $(WEBROOT)/index.html
	@cp -f frontend/manifest.json $(WEBROOT)/manifest.json
	@cp -f frontend/service-worker.js $(WEBROOT)/service-worker.js
	@mkdir -p $(WEBROOT)/styles $(WEBROOT)/assets
	@cp -rf frontend/styles/. $(WEBROOT)/styles/ 2>/dev/null || true
	@echo "  -> frontend ready in $(WEBROOT)"

# ---------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------
run: all
	./$(SERVER_BIN) --port $(PORT) --webroot $(WEBROOT) --root .

# ---------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------
test: $(TEST_BIN)
	./$(TEST_BIN)

$(TEST_BIN): $(CORE_SRC) $(wildcard tests/*.c) $(wildcard tests/*.h)
	@mkdir -p build
	$(CC) $(CFLAGS) -Itests $(ENGINE_SRC) $(BACKEND_LIB) tests/test_main.c -o $(TEST_BIN) $(LDFLAGS)
	@echo "  -> built $(TEST_BIN)"

# ---------------------------------------------------------------------
# Source packaging
# ---------------------------------------------------------------------
package-source:
	@mkdir -p build
	tar czf build/lumeos-source.tar.gz \
	    --exclude='./build' --exclude='*/build' \
	    --exclude='./node_modules' --exclude='*/node_modules' \
	    -C . .
	@echo "  -> build/lumeos-source.tar.gz"

# ---------------------------------------------------------------------
# Housekeeping
# ---------------------------------------------------------------------
clean:
	rm -rf build
	@find frontend -name '*.js' -not -path '*/node_modules/*' -delete 2>/dev/null || true

help:
	@echo "LumeOS-web build targets:"
	@echo "  make / all        build backend and frontend"
	@echo "  make backend      build the C server only"
	@echo "  make frontend     compile TypeScript into $(WEBROOT)"
	@echo "  make run          build and start the server (PORT=$(PORT))"
	@echo "  make test         run C unit tests"
	@echo "  make package-source  create build/lumeos-source.tar.gz"
	@echo "  make clean        remove build artifacts"
