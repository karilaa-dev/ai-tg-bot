#!/bin/sh
set -eu

log() {
    printf '%s\n' "ai-tg-bot: $*" >&2
}

valid_id() {
    printf '%s' "$1" | grep -Eq '^(0|[1-9][0-9]*)$'
}

configure_postgres_url() {
    if [ -n "${DB_URL:-}" ] \
        && [ "${DB_URL}" != "sqlite:/app/data/bot.db" ] \
        && [ "${DB_URL}" != "sqlite:./data/bot.db" ]; then
        return
    fi
    if [ -z "${POSTGRES_PASSWORD:-}" ]; then
        return
    fi
    encoded_password=$(node -e 'process.stdout.write(encodeURIComponent(process.env.POSTGRES_PASSWORD))')
    DB_URL="postgres://aibot:${encoded_password}@postgres:5432/aibot"
    export DB_URL
}

prepare_directories() {
    mkdir -p "${APP_DATA_ROOT}" "${PI_CODING_AGENT_DIR}"
    if [ "$(id -u)" = "0" ]; then
        chown -R "${APP_UID}:${APP_GID}" "${APP_DATA_ROOT}" "${PI_CODING_AGENT_DIR}"
    else
        probe="${APP_DATA_ROOT}/.write-test.$$"
        : >"${probe}"
        rm -f "${probe}"
    fi
}

run_as_application_user() {
    if [ "${AI_TG_BOT_ENTRYPOINT_TEST:-0}" = "1" ] && [ "${AI_TG_BOT_TEST_SKIP_PRIVILEGE_DROP:-0}" = "1" ]; then
        exec "$@"
    fi
    if [ "$(id -u)" != "0" ]; then
        exec "$@"
    fi
    exec setpriv \
        --reuid "${APP_UID}" \
        --regid "${APP_GID}" \
        --clear-groups \
        --inh-caps=-all \
        --ambient-caps=-all \
        --bounding-set=-all \
        --no-new-privs \
        -- "$@"
}

: "${APP_UID:=1000}"
: "${APP_GID:=1000}"
: "${APP_DATA_ROOT:=/app/data}"
: "${PI_CODING_AGENT_DIR:=${APP_DATA_ROOT}/pi}"
export APP_UID APP_GID APP_DATA_ROOT PI_CODING_AGENT_DIR

valid_id "${APP_UID}" || { log "ERROR: APP_UID must be a non-negative numeric UID."; exit 1; }
valid_id "${APP_GID}" || { log "ERROR: APP_GID must be a non-negative numeric GID."; exit 1; }
[ "${APP_UID}" != "0" ] || { log "ERROR: APP_UID must not be 0."; exit 1; }
[ "${APP_GID}" != "0" ] || { log "ERROR: APP_GID must not be 0."; exit 1; }

if [ "$#" -eq 0 ]; then
    set -- node dist/src/main.js
fi

configure_postgres_url
prepare_directories
run_as_application_user "$@"
