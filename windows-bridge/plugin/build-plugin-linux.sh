#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf 'Usage: build-plugin-linux.sh [--output PATH]\n'
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

output_path=''
while (($#)); do
  case "$1" in
    --output)
      (($# >= 2)) || fail '--output requires a path.'
      output_path=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1. Run build-plugin-linux.sh --help for usage."
      ;;
  esac
done

[[ "$(uname -s)" == Linux ]] || fail 'The native Linux telemetry plugin can only be built on Linux.'
[[ "$(uname -m)" == x86_64 ]] || fail 'The native Linux ATS plugin currently supports x86_64 only.'
command -v g++ >/dev/null 2>&1 || fail 'g++ is required to build the native Linux ATS plugin.'
command -v curl >/dev/null 2>&1 || fail 'curl is required to download the SCS Telemetry SDK.'
command -v sha256sum >/dev/null 2>&1 || fail 'sha256sum is required to verify the SCS Telemetry SDK.'
command -v unzip >/dev/null 2>&1 || fail 'unzip is required to extract the SCS Telemetry SDK.'

plugin_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ -z "$output_path" ]]; then
  output_path="$plugin_directory/build/ATSCompanionTelemetry.so"
fi
mkdir -p -- "$(dirname -- "$output_path")"

if [[ -n "${XDG_CACHE_HOME:-}" ]]; then
  cache_directory="$XDG_CACHE_HOME/ats-companion"
elif [[ -n "${HOME:-}" ]]; then
  cache_directory="$HOME/.cache/ats-companion"
elif [[ -n "${SCS_SDK_ARCHIVE:-}" ]]; then
  cache_directory=$(dirname -- "$SCS_SDK_ARCHIVE")
else
  fail 'Set HOME, XDG_CACHE_HOME, or SCS_SDK_ARCHIVE to cache the SDK.'
fi
mkdir -p -- "$cache_directory"
sdk_archive=${SCS_SDK_ARCHIVE:-"$cache_directory/scs_sdk_1_16.zip"}
expected_sdk_hash=49821e25568f4d7e462135f577f8fef2ab197326404f2c1daef139b8f3dc5e69
if [[ ! -f "$sdk_archive" ]]; then
  temporary_archive=$(mktemp "$cache_directory/scs_sdk_1_16.XXXXXX")
  trap 'rm -f -- "$temporary_archive"' EXIT
  curl --fail --location --silent --show-error \
    https://download.eurotrucksimulator2.com/scs_sdk_1_16.zip \
    --output "$temporary_archive" ||
    fail 'Could not download the official SCS Telemetry SDK 1.16.'
  actual_sdk_hash=$(sha256sum "$temporary_archive" | cut -d ' ' -f 1)
  [[ "$actual_sdk_hash" == "$expected_sdk_hash" ]] ||
    fail "The SCS Telemetry SDK archive failed its SHA-256 check (received $actual_sdk_hash)."
  mv -- "$temporary_archive" "$sdk_archive"
  trap - EXIT
fi

actual_sdk_hash=$(sha256sum "$sdk_archive" | cut -d ' ' -f 1)
[[ "$actual_sdk_hash" == "$expected_sdk_hash" ]] ||
  fail "The SCS Telemetry SDK archive failed its SHA-256 check (received $actual_sdk_hash)."

sdk_directory=$(mktemp -d)
trap 'rm -rf -- "$sdk_directory"' EXIT
unzip -oq "$sdk_archive" -d "$sdk_directory"
include_directory="$sdk_directory/include"
[[ -f "$include_directory/scssdk_telemetry.h" ]] ||
  fail "The verified SCS SDK archive does not contain its telemetry headers: $sdk_archive"

g++ -std=c++17 -O2 -fPIC -shared -pthread -Wall -Wextra \
  -I "$include_directory" \
  "$plugin_directory/ATSCompanionTelemetry.cpp" \
  -o "$output_path" ||
  fail 'The native Linux ATS telemetry plugin build failed.'

nm -D --defined-only "$output_path" | grep -q ' scs_telemetry_init$' ||
  fail 'The built plugin does not export scs_telemetry_init.'
nm -D --defined-only "$output_path" | grep -q ' scs_telemetry_shutdown$' ||
  fail 'The built plugin does not export scs_telemetry_shutdown.'
printf 'Built native ATS telemetry plugin: %s\n' "$output_path"
