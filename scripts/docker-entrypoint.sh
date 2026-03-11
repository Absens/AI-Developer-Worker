#!/bin/sh
set -eu

CODEX_HOME_PATH="${CODEX_HOME:-/codex-home}"
HOST_CODEX_HOME_PATH="${HOST_CODEX_HOME_MOUNT:-/host-codex}"

if [ ! -f "${CODEX_HOME_PATH}/auth.json" ] && [ -f "${HOST_CODEX_HOME_PATH}/auth.json" ]; then
  echo "Bootstrapping CODEX_HOME from ${HOST_CODEX_HOME_PATH} into ${CODEX_HOME_PATH}"
  mkdir -p "${CODEX_HOME_PATH}"
  cp -a "${HOST_CODEX_HOME_PATH}/." "${CODEX_HOME_PATH}/"
fi

exec "$@"
