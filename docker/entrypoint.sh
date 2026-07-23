#!/bin/sh
set -eu

log() {
    printf '%s\n' "ai-tg-bot: $*" >&2
}

is_test_mode() {
    [ "${BOXLITE_ENTRYPOINT_TEST:-0}" = "1" ]
}

preflight_error=
fail_preflight() {
    preflight_error=$*
    log "BoxLite preflight failed: $*"
    return 1
}

cgroup_root=/sys/fs/cgroup
proc_cgroup_file=/proc/self/cgroup
proc_root=/proc
proc_sys=/proc/sys
kvm_device=/dev/kvm
app_data_root=/app/data
if is_test_mode; then
    cgroup_root=${BOXLITE_TEST_CGROUP_ROOT:?}
    proc_cgroup_file=${BOXLITE_TEST_PROC_CGROUP_FILE:?}
    proc_root=${BOXLITE_TEST_PROC_ROOT:?}
    proc_sys=${BOXLITE_TEST_PROC_SYS:?}
    kvm_device=${BOXLITE_TEST_KVM_DEVICE:?}
    app_data_root=${BOXLITE_TEST_APP_DATA_ROOT:?}
fi
boxlite_cgroup="${cgroup_root}/boxlite"
application_cgroup="${boxlite_cgroup}/app"
application_cgroup_ready=0

mount_option_present() {
    case ",$1," in
        *,"$2",*) return 0 ;;
        *) return 1 ;;
    esac
}

mount_options() {
    target=$1
    field=$2
    if is_test_mode; then
        case "${target}:${field}" in
            "${cgroup_root}:VFS-OPTIONS") printf '%s\n' "${BOXLITE_TEST_CGROUP_VFS_OPTIONS:-rw}" ;;
            "${cgroup_root}:FS-OPTIONS") printf '%s\n' "${BOXLITE_TEST_CGROUP_FS_OPTIONS:-rw,nsdelegate}" ;;
            "${proc_sys}:VFS-OPTIONS") printf '%s\n' "${BOXLITE_TEST_PROC_SYS_VFS_OPTIONS:-rw}" ;;
            *) return 1 ;;
        esac
        return
    fi
    findmnt --noheadings --raw --output "${field}" --target "${target}" 2>/dev/null
}

setup_cgroups() {
    supervisor_cgroup="${cgroup_root}/supervisor"

    [ -f "${cgroup_root}/cgroup.controllers" ] \
        || { fail_preflight "Cgroup v2 is required. Run Docker with a cgroup v2 host."; return 1; }

    grep -qx '0::/' "${proc_cgroup_file}" \
        || { fail_preflight "A private cgroup namespace is required. Add --cgroupns=private."; return 1; }

    cgroup_vfs_options=$(mount_options "${cgroup_root}" VFS-OPTIONS) \
        || { fail_preflight "Cannot inspect cgroup mount options."; return 1; }
    mount_option_present "${cgroup_vfs_options}" rw \
        || { fail_preflight "The private cgroup filesystem is read-only. Docker Engine 28 or newer is required; add --security-opt writable-cgroups=true."; return 1; }

    cgroup_fs_options=$(mount_options "${cgroup_root}" FS-OPTIONS) \
        || { fail_preflight "Cannot inspect cgroup filesystem options."; return 1; }
    mount_option_present "${cgroup_fs_options}" nsdelegate \
        || { fail_preflight "The host cgroup v2 filesystem must be mounted with nsdelegate before writable cgroups can be enabled safely."; return 1; }

    for controller in cpu memory pids; do
        grep -qw "${controller}" "${cgroup_root}/cgroup.controllers" \
            || { fail_preflight "The ${controller} controller is not delegated to the container."; return 1; }
    done

    mkdir -p "${supervisor_cgroup}" \
        || { fail_preflight "Cannot create the supervisor cgroup. Confirm writable-cgroups=true is active."; return 1; }

    migration_attempts=0
    while [ "${migration_attempts}" -lt 5 ]; do
        root_pids=$(read_cgroup_procs "${cgroup_root}/cgroup.procs") \
            || { fail_preflight "Cannot inspect processes in the cgroup namespace root."; return 1; }
        [ -n "${root_pids}" ] || break

        while IFS= read -r pid; do
            [ -n "${pid}" ] || continue
            [ -d "${proc_root}/${pid}" ] || continue
            printf '%s\n' "${pid}" >"${supervisor_cgroup}/cgroup.procs" \
                || { fail_preflight "Cannot move process ${pid} into the supervisor cgroup."; return 1; }
        done <<EOF_PIDS
${root_pids}
EOF_PIDS

        migration_attempts=$((migration_attempts + 1))
    done

    root_pids=$(read_cgroup_procs "${cgroup_root}/cgroup.procs") \
        || { fail_preflight "Cannot inspect processes in the cgroup namespace root."; return 1; }
    [ -z "${root_pids}" ] \
        || { fail_preflight "Processes keep appearing in the cgroup namespace root; cannot delegate controllers safely."; return 1; }

    printf '%s\n' '+cpu +memory +pids' >"${cgroup_root}/cgroup.subtree_control" \
        || { fail_preflight "Cannot delegate the cpu, memory, and pids controllers to BoxLite."; return 1; }

    mkdir -p "${application_cgroup}" \
        || { fail_preflight "Cannot create the delegated BoxLite application cgroup."; return 1; }
    if is_test_mode; then
        : >"${boxlite_cgroup}/cgroup.procs"
        : >"${boxlite_cgroup}/cgroup.subtree_control"
        : >"${application_cgroup}/cgroup.procs"
    fi
    printf '%s\n' '+cpu +memory +pids' >"${boxlite_cgroup}/cgroup.subtree_control" \
        || { fail_preflight "Cannot enable controllers in the delegated BoxLite cgroup."; return 1; }
    chown "${APP_UID}:${APP_GID}" \
        "${boxlite_cgroup}" \
        "${boxlite_cgroup}/cgroup.procs" \
        "${boxlite_cgroup}/cgroup.subtree_control" \
        "${application_cgroup}" \
        "${application_cgroup}/cgroup.procs" \
        || { fail_preflight "Cannot delegate the BoxLite cgroup to ${APP_UID}:${APP_GID}."; return 1; }
    application_cgroup_ready=1
}

read_cgroup_procs() {
    if is_test_mode; then
        return 0
    fi
    command cat "$1"
}

run_probe_as_application_user() {
    if is_test_mode; then
        "$@"
        return
    fi

    kvm_gid=$(stat -c '%g' "${kvm_device}")
    setpriv \
        --reuid "${APP_UID}" \
        --regid "${APP_GID}" \
        --groups "${kvm_gid}" \
        --inh-caps=-all \
        --ambient-caps=-all \
        --bounding-set=-all \
        --no-new-privs \
        -- "$@"
}

preflight() {
    proc_vfs_options=$(mount_options "${proc_sys}" VFS-OPTIONS) \
        || { fail_preflight "Cannot inspect mount options for ${proc_sys}."; return 1; }
    if mount_option_present "${proc_vfs_options}" ro; then
        fail_preflight "Docker system-path confinement makes /proc/sys read-only. Add systempaths=unconfined alongside seccomp=unconfined."
        return 1
    fi

    setup_cgroups || return 1

    [ -e "${kvm_device}" ] \
        || { fail_preflight "/dev/kvm is missing. Start the container with --device=/dev/kvm:/dev/kvm."; return 1; }
    run_probe_as_application_user sh -c '[ -r "$1" ] && [ -w "$1" ]' sh "${kvm_device}" \
        || { fail_preflight "/dev/kvm is not readable and writable by application UID ${APP_UID}. Check the device mapping and host permissions."; return 1; }

    run_probe_as_application_user sh -c 'probe="$1/.write-test.$$"; : >"$probe" && rm -f "$probe"' sh "${BOXLITE_HOME}" \
        || { fail_preflight "BOXLITE_HOME (${BOXLITE_HOME}) is not writable by application UID ${APP_UID}."; return 1; }

    if ! is_test_mode \
        && ! run_probe_as_application_user unshare --user --map-root-user --mount true >/dev/null 2>&1; then
        fail_preflight "BoxLite cannot create user and mount namespaces as application UID ${APP_UID}. Add seccomp=unconfined and systempaths=unconfined; an AppArmor profile may also need adjustment."
        return 1
    fi
}

valid_id() {
    printf '%s' "$1" | grep -Eq '^(0|[1-9][0-9]*)$'
}

prepare_directories() {
    mkdir -p "${app_data_root}" "${AGENT_SHARED_ROOT}" "${BOXLITE_HOME}"
    chown -R "${APP_UID}:${APP_GID}" "${app_data_root}" "${BOXLITE_HOME}"

    ownership_marker="${AGENT_SHARED_ROOT}/.ai-tg-bot-owner"
    expected_owner="${APP_UID}:${APP_GID}"
    current_owner=$(command cat "${ownership_marker}" 2>/dev/null || true)
    if [ "${current_owner}" != "${expected_owner}" ]; then
        log "Updating ${AGENT_SHARED_ROOT} ownership for application identity ${expected_owner}."
        chown -R "${APP_UID}:${APP_GID}" "${AGENT_SHARED_ROOT}"
        printf '%s\n' "${expected_owner}" >"${ownership_marker}"
        chown "${APP_UID}:${APP_GID}" "${ownership_marker}"
    fi
}

enter_application_cgroup() {
    [ "${application_cgroup_ready}" = "1" ] || return 0
    printf '%s\n' "$$" >"${application_cgroup}/cgroup.procs"
}

run_as_application_user() {
    if is_test_mode && [ "${BOXLITE_TEST_SKIP_PRIVILEGE_DROP:-0}" = "1" ]; then
        exec "$@"
    fi

    if [ -e "${kvm_device}" ]; then
        kvm_gid=$(stat -c '%g' "${kvm_device}")
        exec setpriv \
            --reuid "${APP_UID}" \
            --regid "${APP_GID}" \
            --groups "${kvm_gid}" \
            --inh-caps=-all \
            --ambient-caps=-all \
            --bounding-set=-all \
            --no-new-privs \
            -- "$@"
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
: "${BOXLITE_HOME:=/var/lib/boxlite}"
export APP_UID APP_GID AGENT_SHARED_ROOT BOXLITE_HOME

valid_id "${APP_UID}" || { log "ERROR: APP_UID must be a non-negative numeric UID."; exit 1; }
valid_id "${APP_GID}" || { log "ERROR: APP_GID must be a non-negative numeric GID."; exit 1; }
[ "${APP_UID}" != "0" ] || { log "ERROR: APP_UID must not be 0."; exit 1; }

if [ "$#" -eq 0 ]; then
    set -- node dist/src/main.js
fi

current_uid=$(id -u)
if is_test_mode && [ -n "${BOXLITE_TEST_CURRENT_UID:-}" ]; then
    current_uid=${BOXLITE_TEST_CURRENT_UID}
fi
if [ "${current_uid}" != "0" ]; then
    BOXLITE_UNAVAILABLE_REASON="BoxLite preflight requires the container entrypoint to start as root."
    export BOXLITE_UNAVAILABLE_REASON
    log "WARNING: ${BOXLITE_UNAVAILABLE_REASON} Online-only bot features will remain available."
    exec "$@"
fi

prepare_directories
if [ "${BOXLITE_SKIP_PREFLIGHT:-0}" != "1" ]; then
    if preflight; then
        unset BOXLITE_UNAVAILABLE_REASON
    else
        BOXLITE_UNAVAILABLE_REASON=${preflight_error:-"BoxLite preflight failed."}
        export BOXLITE_UNAVAILABLE_REASON
        log "WARNING: BoxLite VM tools are disabled until the deployment is corrected. Online-only bot features will remain available."
    fi
fi

if ! enter_application_cgroup; then
    BOXLITE_UNAVAILABLE_REASON="Cannot enter the delegated BoxLite application cgroup."
    export BOXLITE_UNAVAILABLE_REASON
    log "WARNING: ${BOXLITE_UNAVAILABLE_REASON} Online-only bot features will remain available."
fi

run_as_application_user "$@"
