#!/bin/sh
set -eu

if [ "$#" -ne 0 ]; then
    printf '%s\n' "Usage: ./docker/import-migration.sh" >&2
    exit 2
fi

if [ "${UPGRADE_MODE:-}" != "import" ]; then
    printf '%s\n' "ai-tg-bot: ERROR: import-migration.sh requires UPGRADE_MODE=import." >&2
    exit 1
fi

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
app_root=$(CDPATH='' cd -- "${script_dir}/.." && pwd)
cd "${app_root}"

exec "${script_dir}/entrypoint.sh" npm run upgrade:migrate -- --from /app/data/import
