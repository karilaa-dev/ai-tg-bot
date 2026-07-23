#!/bin/sh
set -eu

log() {
    printf '%s\n' "ai-tg-bot: $*" >&2
}

valid_id() {
    printf '%s' "$1" | grep -Eq '^(0|[1-9][0-9]*)$'
}

prepare_directories() {
    mkdir -p "${APP_DATA_ROOT}" "${AGENT_SHARED_ROOT}"
    ownership_marker="${AGENT_SHARED_ROOT}/.ai-tg-bot-owner"
    expected_owner="${APP_UID}:${APP_GID}"
    current_owner=$(command cat "${ownership_marker}" 2>/dev/null || true)

    if [ "$(id -u)" = "0" ]; then
        chown -R "${APP_UID}:${APP_GID}" "${APP_DATA_ROOT}"
        if [ "${current_owner}" != "${expected_owner}" ]; then
            log "Updating ${AGENT_SHARED_ROOT} ownership for application identity ${expected_owner}."
            chown -R "${APP_UID}:${APP_GID}" "${AGENT_SHARED_ROOT}"
            printf '%s\n' "${expected_owner}" >"${ownership_marker}"
            chown "${APP_UID}:${APP_GID}" "${ownership_marker}"
        fi
    else
        probe="${AGENT_SHARED_ROOT}/.write-test.$$"
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
: "${AGENT_SHARED_ROOT:=/data}"
: "${APP_DATA_ROOT:=/app/data}"
export APP_UID APP_GID AGENT_SHARED_ROOT APP_DATA_ROOT

valid_id "${APP_UID}" || { log "ERROR: APP_UID must be a non-negative numeric UID."; exit 1; }
valid_id "${APP_GID}" || { log "ERROR: APP_GID must be a non-negative numeric GID."; exit 1; }
[ "${APP_UID}" != "0" ] || { log "ERROR: APP_UID must not be 0."; exit 1; }

if [ "$#" -eq 0 ]; then
    set -- node dist/src/main.js
fi

prepare_directories
run_as_application_user "$@"
