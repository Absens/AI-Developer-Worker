FROM node:22-bookworm-slim

WORKDIR /workspace

ARG CODEX_CLI_VERSION=0.149.1
ENV CODEX_HOME=/codex-home
ENV TASK_TRACKER_UI_STATIC_DIR=/workspace/web/dist/task-tracker-console/browser

RUN set -eu; \
  for attempt in 1 2 3 4 5; do \
    if apt-get update -o Acquire::Retries=5 \
      && apt-get install -y -o Acquire::Retries=5 --no-install-recommends \
        git curl jq ripgrep ca-certificates openssh-client; then \
      break; \
    fi; \
    if [ "$attempt" = "5" ]; then \
      exit 1; \
    fi; \
    rm -rf /var/lib/apt/lists/*; \
    sleep 5; \
  done \
  && npm install -g @openai/codex@${CODEX_CLI_VERSION} \
  && mkdir -p /codex-home \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* tsconfig.json tsconfig.build.json ./
COPY web/package.json web/package-lock.json ./web/
RUN npm install
RUN npm --prefix web install

COPY src ./src
COPY config ./config
COPY scripts ./scripts
COPY web ./web

RUN npm run web:build
RUN npm run build

RUN sed -i 's/\r$//' ./scripts/docker-entrypoint.sh \
  && chmod +x ./scripts/docker-entrypoint.sh

ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
CMD ["npm", "run", "start"]
