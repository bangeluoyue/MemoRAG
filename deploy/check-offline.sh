#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export MEMORAG_ENV_FILE=/dev/null
export NODE_ENV=test
export OPENAI_API_KEY=offline-placeholder
export OPENAI_BASE_URL=http://127.0.0.1:9
export MODEL_NAME=offline-chat
export EMBEDDINGS_MODEL_NAME=offline-embedding
export EMBEDDING_DIMENSION=1024
export MILVUS_ADDRESS=127.0.0.1:9
export MILVUS_TOKEN=offline-placeholder
export DATABASE_URL=postgresql://offline:offline@127.0.0.1:9/offline
export ELASTICSEARCH_NODE=http://127.0.0.1:9
export SESSION_SECRET=offline-placeholder-at-least-32-characters
export ENABLE_WEB_SEARCH=false ENABLE_RERANK=false ENABLE_NOTE_RERANK=false
export LANGSMITH_TRACING=false LANGSMITH_TRACING_V2=false
export LANGCHAIN_TRACING=false LANGCHAIN_TRACING_V2=false
export ENABLE_NOTE_LANGSMITH_TRACING=false
export NODE_OPTIONS="--import=$PWD/backend/test-support/offline-network.js"
npm --prefix backend test
npm --prefix frontend test
NODE_ENV=production npm --prefix frontend run build
docker compose -f deploy/elasticsearch/compose.yaml config --quiet
node backend/src/cli/init-deployment.js postgres
node backend/src/cli/init-deployment.js milvus
node backend/src/cli/init-deployment.js elasticsearch
node backend/src/cli/init-deployment.js accounts
