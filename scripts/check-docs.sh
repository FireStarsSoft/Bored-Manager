#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
readonly REPOSITORY_ROOT

work_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT INT TERM

mapfile -d '' markdown_files < <(find "$REPOSITORY_ROOT" \
  -path '*/.git' -prune -o -path '*/node_modules' -prune -o \
  -type f \( -name '*.md' -o -name '*.MD' \) -print0)

((${#markdown_files[@]} > 0)) || {
  printf 'check-docs: no Markdown files found\n' >&2
  exit 1
}

snippet_count=0
for markdown_file in "${markdown_files[@]}"; do
  in_bash=0
  snippet_file=''
  while IFS= read -r line || [[ -n "$line" ]]; do
    if ((in_bash == 0)) && [[ "$line" =~ ^\`\`\`(bash|sh)[[:space:]]*$ ]]; then
      snippet_count=$((snippet_count + 1))
      snippet_file="${work_dir}/snippet-${snippet_count}.bash"
      printf '#!/usr/bin/env bash\nset -u\n' >"$snippet_file"
      in_bash=1
      continue
    fi
    if ((in_bash == 1)) && [[ "$line" == '```' ]]; then
      bash -n "$snippet_file" || {
        printf 'check-docs: invalid Bash block in %s (snippet %d)\n' \
          "$markdown_file" "$snippet_count" >&2
        exit 1
      }
      if command -v shellcheck >/dev/null 2>&1; then
        shellcheck --severity=error --shell=bash "$snippet_file"
      fi
      in_bash=0
      snippet_file=''
      continue
    fi
    if ((in_bash == 1)); then
      printf '%s\n' "$line" >>"$snippet_file"
    fi
  done <"$markdown_file"

  if ((in_bash == 1)); then
    printf 'check-docs: unclosed Bash fence in %s\n' "$markdown_file" >&2
    exit 1
  fi
done

printf 'check-docs: validated %d Bash blocks in %d Markdown files\n' \
  "$snippet_count" "${#markdown_files[@]}"
