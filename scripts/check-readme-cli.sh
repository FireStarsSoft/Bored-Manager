#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
readonly REPOSITORY_ROOT
readonly README="${REPOSITORY_ROOT}/README.MD"
bmctl_binary="${BMCTL_BINARY:-${REPOSITORY_ROOT}/bin/bmctl}"

[[ -x "$bmctl_binary" ]] || {
  printf 'check-readme-cli: bmctl binary is not executable: %s\n' "$bmctl_binary" >&2
  exit 1
}

mapfile -t commands < <(
  awk '
    /^```bash[[:space:]]*$/ { in_bash = 1; next }
    /^```[[:space:]]*$/ { in_bash = 0; next }
    in_bash { print }
  ' "$README" |
    grep -oE '(^|[[:space:]])bmctl[[:space:]]+[a-z][a-z-]*' |
    awk '{print $NF}' |
    sort -u
)

((${#commands[@]} > 0)) || {
  printf 'check-readme-cli: no bmctl commands found in README.MD\n' >&2
  exit 1
}

for command_name in "${commands[@]}"; do
  cli_help="$("$bmctl_binary" help)"
  if ! grep -Eq "(^|[[:space:]|{])${command_name}([[:space:]|}]|$)" <<<"$cli_help"; then
    printf 'check-readme-cli: README references unavailable command: bmctl %s\n' \
      "$command_name" >&2
    exit 1
  fi
done

printf 'check-readme-cli: validated %d first-level commands\n' "${#commands[@]}"
