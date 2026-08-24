#!/bin/sh
set -eu

APPLICATION_UID=1000
APPLICATION_GID=1000

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
        chown -R "${APPLICATION_UID}:${APPLICATION_GID}" "${APP_DATA_ROOT}" "${PI_CODING_AGENT_DIR}"
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
        --reuid "${APPLICATION_UID}" \
        --regid "${APPLICATION_GID}" \
        --clear-groups \
        --inh-caps=-all \
        --ambient-caps=-all \
        --bounding-set=-all \
        --no-new-privs \
        -- "$@"
}

: "${APP_DATA_ROOT:=/app/data}"
: "${PI_CODING_AGENT_DIR:=${APP_DATA_ROOT}/pi}"
export APP_DATA_ROOT PI_CODING_AGENT_DIR

if [ "$#" -eq 0 ]; then
    set -- node dist/src/main.js
fi

configure_postgres_url
prepare_directories
run_as_application_user "$@"
