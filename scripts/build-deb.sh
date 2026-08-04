#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
readonly REPOSITORY_ROOT

app_version="0.1.0-dev"
revision="1"
architecture="amd64"
binary_dir="${REPOSITORY_ROOT}/bin"
output_dir="${REPOSITORY_ROOT}/dist"
release_public_key=""
web_dir="${REPOSITORY_ROOT}/web/dist"

usage() {
  cat <<'USAGE'
Usage: scripts/build-deb.sh [options]

Options:
  --version VERSION        Application SemVer (default: 0.1.0-dev)
  --revision REVISION      Debian revision (default: 1)
  --architecture ARCH      Package architecture; v1 supports amd64 only
  --binary-dir DIRECTORY   Directory containing built binaries
  --output-dir DIRECTORY   Output directory (default: dist)
  --release-public-key FILE
                           Reviewed Ed25519 public key for a release package
  --web-dir DIRECTORY      Built Web UI directory (default: web/dist)
  -h, --help               Show this help
USAGE
}

die() {
  printf 'build-deb: error: %s\n' "$*" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --version)
      (($# >= 2)) || die "--version requires a value"
      app_version="$2"
      shift 2
      ;;
    --revision)
      (($# >= 2)) || die "--revision requires a value"
      revision="$2"
      shift 2
      ;;
    --architecture)
      (($# >= 2)) || die "--architecture requires a value"
      architecture="$2"
      shift 2
      ;;
    --binary-dir)
      (($# >= 2)) || die "--binary-dir requires a value"
      binary_dir="$2"
      shift 2
      ;;
    --output-dir)
      (($# >= 2)) || die "--output-dir requires a value"
      output_dir="$2"
      shift 2
      ;;
    --release-public-key)
      (($# >= 2)) || die "--release-public-key requires a value"
      release_public_key="$2"
      shift 2
      ;;
    --web-dir)
      (($# >= 2)) || die "--web-dir requires a value"
      web_dir="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
done

command -v dpkg-deb >/dev/null 2>&1 || die "dpkg-deb is required"
command -v dpkg >/dev/null 2>&1 || die "dpkg is required"

if [[ -n "$release_public_key" ]]; then
  [[ -f "$release_public_key" ]] || die "release public key is not a file"
  command -v openssl >/dev/null 2>&1 || die "openssl is required for release-key validation"
  openssl pkey -pubin -in "$release_public_key" -noout >/dev/null 2>&1 || \
    die "release public key is not valid PEM"
fi

[[ "$architecture" == "amd64" ]] || die "v1 packages support amd64 only"
[[ "$app_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]] || \
  die "version must be SemVer without a leading v"
[[ "$revision" =~ ^[0-9]+([.+~][0-9A-Za-z]+)*$ ]] || die "invalid Debian revision"

upstream_version="${app_version/-/\~}"
upstream_version="${upstream_version/+/.}"
deb_version="${upstream_version}-${revision}"
dpkg --validate-version "$deb_version" >/dev/null 2>&1 || die "invalid Debian version: $deb_version"

for binary in bored-managerd bored-agentd bmctl bored-update-helper; do
  [[ -f "${binary_dir}/${binary}" ]] || die "missing binary: ${binary_dir}/${binary}"
done
[[ -f "${web_dir}/index.html" ]] || die "built Web UI is missing: ${web_dir}/index.html"

work_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT INT TERM

manager_root="${work_dir}/manager"
agent_root="${work_dir}/agent"

install -d -m 0755 \
  "${manager_root}/DEBIAN" \
  "${manager_root}/usr/bin" \
  "${manager_root}/usr/lib/bored-manager" \
  "${manager_root}/usr/lib/systemd/system" \
  "${manager_root}/usr/lib/tmpfiles.d" \
  "${manager_root}/usr/share/bored-manager" \
  "${manager_root}/usr/share/bored-manager/web" \
  "${manager_root}/usr/share/doc/bored-manager" \
  "${manager_root}/usr/share/applications" \
  "${manager_root}/etc/default"

install -m 0755 "${binary_dir}/bored-managerd" "${manager_root}/usr/bin/bored-managerd"
install -m 0755 "${binary_dir}/bmctl" "${manager_root}/usr/bin/bmctl"
install -m 0755 "${binary_dir}/bored-update-helper" \
  "${manager_root}/usr/lib/bored-manager/bored-update-helper"
install -m 0644 "${REPOSITORY_ROOT}/packaging/debian/manager/bored-managerd.service" \
  "${manager_root}/usr/lib/systemd/system/bored-managerd.service"
install -m 0644 "${REPOSITORY_ROOT}/packaging/debian/manager/bored-update-helper.service" \
  "${manager_root}/usr/lib/systemd/system/bored-update-helper.service"
install -m 0644 "${REPOSITORY_ROOT}/packaging/debian/manager/bored-manager.tmpfiles.conf" \
  "${manager_root}/usr/lib/tmpfiles.d/bored-manager.conf"
install -m 0644 "${REPOSITORY_ROOT}/packaging/debian/manager/bored-manager.default" \
  "${manager_root}/etc/default/bored-manager"
install -m 0644 "${REPOSITORY_ROOT}/packaging/debian/manager/bored-manager.desktop" \
  "${manager_root}/usr/share/applications/bored-manager.desktop"
if [[ -n "$release_public_key" ]]; then
  install -m 0644 "$release_public_key" \
    "${manager_root}/usr/share/bored-manager/release-signing.pub"
else
  install -m 0644 "${REPOSITORY_ROOT}/packaging/debian/manager/release-signing.pub" \
    "${manager_root}/usr/share/bored-manager/release-signing.pub"
fi
cp -a -- "${web_dir}/." "${manager_root}/usr/share/bored-manager/web/"
find "${manager_root}/usr/share/bored-manager/web" -type d -exec chmod 0755 {} +
find "${manager_root}/usr/share/bored-manager/web" -type f -exec chmod 0644 {} +
install -m 0644 "${REPOSITORY_ROOT}/README.MD" \
  "${manager_root}/usr/share/doc/bored-manager/README.MD"
install -m 0644 "${REPOSITORY_ROOT}/packaging/debian/copyright" \
  "${manager_root}/usr/share/doc/bored-manager/copyright"
for maintainer_script in postinst prerm postrm; do
  install -m 0755 "${REPOSITORY_ROOT}/packaging/debian/manager/${maintainer_script}" \
    "${manager_root}/DEBIAN/${maintainer_script}"
done

install -d -m 0755 \
  "${agent_root}/DEBIAN" \
  "${agent_root}/usr/bin" \
  "${agent_root}/usr/lib/systemd/system" \
  "${agent_root}/usr/lib/tmpfiles.d" \
  "${agent_root}/usr/share/doc/bored-manager-agent" \
  "${agent_root}/etc/default"

install -m 0755 "${binary_dir}/bored-agentd" "${agent_root}/usr/bin/bored-agentd"
install -m 0644 "${REPOSITORY_ROOT}/packaging/debian/agent/bored-agentd.service" \
  "${agent_root}/usr/lib/systemd/system/bored-agentd.service"
install -m 0644 "${REPOSITORY_ROOT}/packaging/debian/agent/bored-manager-agent.tmpfiles.conf" \
  "${agent_root}/usr/lib/tmpfiles.d/bored-manager-agent.conf"
install -m 0644 "${REPOSITORY_ROOT}/packaging/debian/agent/bored-manager-agent.default" \
  "${agent_root}/etc/default/bored-manager-agent"
install -m 0644 "${REPOSITORY_ROOT}/README.MD" \
  "${agent_root}/usr/share/doc/bored-manager-agent/README.MD"
install -m 0644 "${REPOSITORY_ROOT}/packaging/debian/copyright" \
  "${agent_root}/usr/share/doc/bored-manager-agent/copyright"
for maintainer_script in postinst prerm postrm; do
  install -m 0755 "${REPOSITORY_ROOT}/packaging/debian/agent/${maintainer_script}" \
    "${agent_root}/DEBIAN/${maintainer_script}"
done

render_control() {
  local template="$1"
  local package_root="$2"
  local installed_size
  installed_size="$(du -sk --exclude=DEBIAN "$package_root" | awk '{print $1}')"
  sed \
    -e "s/@@VERSION@@/${deb_version}/g" \
    -e "s/@@ARCHITECTURE@@/${architecture}/g" \
    -e "s/@@INSTALLED_SIZE@@/${installed_size}/g" \
    "$template" >"${package_root}/DEBIAN/control"
  chmod 0644 "${package_root}/DEBIAN/control"
}

render_control "${REPOSITORY_ROOT}/packaging/debian/manager/control.in" "$manager_root"
render_control "${REPOSITORY_ROOT}/packaging/debian/agent/control.in" "$agent_root"

mkdir -p -- "$output_dir"
filename_version="${app_version}-${revision}"
manager_deb="${output_dir}/bored-manager_${filename_version}_${architecture}.deb"
agent_deb="${output_dir}/bored-manager-agent_${filename_version}_${architecture}.deb"

dpkg-deb --root-owner-group --build "$manager_root" "$manager_deb" >/dev/null
dpkg-deb --root-owner-group --build "$agent_root" "$agent_deb" >/dev/null
dpkg-deb --info "$manager_deb" >/dev/null
dpkg-deb --info "$agent_deb" >/dev/null

printf '%s\n' "$manager_deb" "$agent_deb"
