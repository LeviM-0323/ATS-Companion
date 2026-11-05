#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: linux-install.sh [--game-dir PATH] [--prefix PATH]

Prepare the ATS Companion bridge on Linux. Node.js 20+ and npm are required.
ATS is detected in common Steam library locations when possible. Use --game-dir
to select an installation explicitly or when automatic detection is unavailable.
For native Linux telemetry, g++, curl, sha256sum, and unzip are also required.

Native Linux telemetry is installed only for an ATS bin/linux_x64 game build.
Proton/Windows game installs keep using the Windows telemetry plugin.
EOF
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

game_directory=''
install_prefix=''
native_game_directory=''
while (($#)); do
  case "$1" in
    --game-dir)
      (($# >= 2)) || fail '--game-dir requires a path.'
      game_directory=$2
      shift 2
      ;;
    --prefix)
      (($# >= 2)) || fail '--prefix requires a path.'
      install_prefix=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1. Run linux-install.sh --help for usage."
      ;;
  esac
done

if [[ -z "$install_prefix" ]]; then
  if [[ -n "${XDG_DATA_HOME:-}" ]]; then
    install_prefix="$XDG_DATA_HOME/ats-companion/bridge"
  elif [[ -n "${HOME:-}" ]]; then
    install_prefix="$HOME/.local/share/ats-companion/bridge"
  else
    fail 'Set HOME or XDG_DATA_HOME, or provide --prefix <path>.'
  fi
fi

[[ "$(uname -s)" == Linux ]] || fail 'This installer supports Linux only.'
command -v node >/dev/null 2>&1 || fail 'Node.js 20 or newer is required. Install Node.js and retry.'
command -v npm >/dev/null 2>&1 || fail 'npm is required. Install npm with Node.js and retry.'
node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
[[ "$node_major" =~ ^[0-9]+$ ]] && ((node_major >= 20)) ||
  fail "Node.js 20 or newer is required; found $(node --version)."

script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
bridge_source=$script_directory
[[ -f "$bridge_source/package-lock.json" && -d "$bridge_source/src" ]] ||
  fail "Bridge source files were not found next to the installer: $bridge_source"

is_ats_directory() {
  [[ -d "$1/bin/linux_x64" || -d "$1/bin/win_x64" ]]
}

if [[ -n "$game_directory" ]]; then
  [[ -d "$game_directory" ]] || fail "Selected ATS directory does not exist: $game_directory"
  is_ats_directory "$game_directory" ||
    fail "ATS game binaries were not found under '$game_directory' (expected bin/linux_x64 or bin/win_x64)."
  printf 'ATS installation selected: %s\n' "$game_directory"
  if [[ -x "$game_directory/bin/linux_x64/amtrucks" ]]; then
    [[ "$(uname -m)" == x86_64 ]] ||
      fail 'The native Linux ATS telemetry plugin currently supports x86_64 only.'
    native_game_directory=$game_directory
  fi
else
  steam_roots=()
  if [[ -n "${HOME:-}" ]]; then
    for root in \
      "$HOME/.steam/steam" \
      "$HOME/.local/share/Steam" \
      "$HOME/.var/app/com.valvesoftware.Steam/.local/share/Steam"; do
      [[ -d "$root" ]] && steam_roots+=("$root")
    done
  fi

  game_directories=()
  declare -A seen_directories=()
  for root in "${steam_roots[@]}"; do
    library_roots=("$root")
    library_file="$root/steamapps/libraryfolders.vdf"
    if [[ -f "$library_file" ]]; then
      while IFS= read -r library_root; do
        [[ -n "$library_root" ]] && library_roots+=("$library_root")
      done < <(sed -nE 's/.*"path"[[:space:]]+"([^"]+)".*/\1/p' "$library_file")
    fi

    for library_root in "${library_roots[@]}"; do
      candidate="$library_root/steamapps/common/American Truck Simulator"
      if is_ats_directory "$candidate" && [[ -z "${seen_directories["$candidate"]+present}" ]]; then
        game_directories+=("$candidate")
        seen_directories["$candidate"]=1
      fi
    done
  done

  if ((${#game_directories[@]} == 1)); then
    game_directory=${game_directories[0]}
    printf 'Detected ATS installation: %s\n' "$game_directory"
  elif ((${#game_directories[@]} > 1)); then
    printf 'Multiple ATS installations were detected. Select one with --game-dir:\n'
    printf '  %s\n' "${game_directories[@]}"
  else
    printf 'No ATS installation was detected in common Steam libraries.\n'
    printf 'If needed, select it explicitly with --game-dir <path>.\n'
  fi
fi

if [[ -z "$native_game_directory" && -n "$game_directory" && -x "$game_directory/bin/linux_x64/amtrucks" ]]; then
  [[ "$(uname -m)" == x86_64 ]] ||
    fail 'The native Linux ATS telemetry plugin currently supports x86_64 only.'
  native_game_directory=$game_directory
fi

if [[ -n "$native_game_directory" ]]; then
  plugin_directory="$native_game_directory/bin/linux_x64/plugins"
  plugin_path="$plugin_directory/ATSCompanionTelemetry.so"
  plugin_marker="$plugin_directory/.ats-companion-telemetry"
  if [[ -e "$plugin_directory" || -L "$plugin_directory" ]]; then
    [[ -d "$plugin_directory" && ! -L "$plugin_directory" ]] ||
      fail "The ATS plugin path must be a regular directory: $plugin_directory"
  fi
  if [[ -e "$plugin_path" || -L "$plugin_path" ]]; then
    [[ -f "$plugin_path" && ! -L "$plugin_path" ]] ||
      fail "The ATS telemetry plugin path is not a regular file: $plugin_path"
    [[ -f "$plugin_marker" && ! -L "$plugin_marker" &&
      "$(cat -- "$plugin_marker")" == 'ats-companion-linux-telemetry-v1' ]] ||
      fail "An unmanaged ATS telemetry plugin already exists: $plugin_path. Remove it or back it up before installing."
  fi
  if [[ -e "$plugin_marker" || -L "$plugin_marker" ]]; then
    [[ -f "$plugin_marker" && ! -L "$plugin_marker" &&
      "$(cat -- "$plugin_marker")" == 'ats-companion-linux-telemetry-v1' ]] ||
      fail "An unmanaged ATS telemetry marker already exists: $plugin_marker"
  fi
fi

[[ "$install_prefix" != / ]] || fail '--prefix cannot be the filesystem root.'
resolved_prefix=$(realpath -m -- "$install_prefix")
resolved_source=$(realpath -- "$bridge_source")
if [[ "$resolved_prefix" == "$resolved_source" ]] ||
  [[ "$resolved_prefix" == "$resolved_source/"* ]] ||
  [[ "$resolved_source" == "$resolved_prefix/"* ]]; then
  fail 'The install prefix cannot overlap the bridge source checkout.'
fi
if [[ -n "$game_directory" ]]; then
  resolved_game=$(realpath -- "$game_directory")
  if [[ "$resolved_prefix" == "$resolved_game" ]] ||
    [[ "$resolved_prefix" == "$resolved_game/"* ]] ||
    [[ "$resolved_game" == "$resolved_prefix/"* ]]; then
    fail 'The install prefix cannot overlap the ATS directory.'
  fi
fi
if [[ -e "$install_prefix" ]]; then
  [[ -d "$install_prefix" && ! -L "$install_prefix" ]] ||
    fail "The install prefix must be a regular directory: $install_prefix"
  marker="$install_prefix/.ats-companion-install"
  if [[ -f "$marker" ]] && [[ "$(cat -- "$marker")" == 'ats-companion-linux-bridge-v1' ]]; then
    :
  elif [[ -z "$(find "$install_prefix" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    :
  else
    fail "The install prefix already contains files and is not a managed ATS Companion installation: $install_prefix. Choose an empty directory."
  fi
fi
install_parent=$(dirname -- "$install_prefix")
mkdir -p -- "$install_parent" || fail "Could not create install directory: $install_parent"
staging_directory=$(mktemp -d "$install_parent/.ats-companion-bridge.XXXXXX") ||
  fail "Could not create a staging directory under: $install_parent"
backup_directory=''
plugin_temporary_file=''
marker_temporary_file=''
cleanup() {
  [[ -z "$staging_directory" || ! -d "$staging_directory" ]] || rm -rf -- "$staging_directory"
  [[ -z "$plugin_temporary_file" || ! -e "$plugin_temporary_file" ]] || rm -f -- "$plugin_temporary_file"
  [[ -z "$marker_temporary_file" || ! -e "$marker_temporary_file" ]] || rm -f -- "$marker_temporary_file"
}
trap cleanup EXIT

cp -R -- "$bridge_source/src" "$staging_directory/"
cp -- "$bridge_source/package.json" "$bridge_source/package-lock.json" "$staging_directory/"
printf '%s\n' 'ats-companion-linux-bridge-v1' >"$staging_directory/.ats-companion-install"
mkdir -- "$staging_directory/bin"
cat >"$staging_directory/bin/ats-companion-bridge" <<'EOF'
#!/usr/bin/env sh
bridge_directory=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec node "$bridge_directory/src/server.mjs" "$@"
EOF
chmod 755 "$staging_directory/bin/ats-companion-bridge"

npm ci --omit=dev --prefix "$staging_directory" ||
  fail 'Could not install bridge dependencies. Check npm access and retry.'
if [[ -n "$native_game_directory" ]]; then
  bash "$bridge_source/build-plugin-linux.sh" \
    --output "$staging_directory/ATSCompanionTelemetry.so"
fi

if [[ -e "$install_prefix" ]]; then
  backup_directory=$(mktemp -d "$install_parent/.ats-companion-backup.XXXXXX") ||
    fail "Could not stage an update under: $install_parent"
  rmdir -- "$backup_directory"
  mv -- "$install_prefix" "$backup_directory" ||
    fail "Could not move the previous installation aside: $install_prefix"
fi
if ! mv -- "$staging_directory" "$install_prefix"; then
  if [[ -n "$backup_directory" && -d "$backup_directory" ]]; then
    if mv -- "$backup_directory" "$install_prefix"; then
      backup_directory=''
    else
      fail "Could not install the Linux bridge. The previous installation remains at: $backup_directory"
    fi
  fi
  fail "Could not install the Linux bridge to: $install_prefix"
fi
staging_directory=''

if [[ -n "$backup_directory" && -d "$backup_directory" ]]; then
  rm -rf -- "$backup_directory"
  backup_directory=''
fi

printf 'ATS Companion bridge installed to: %s\n' "$install_prefix"
printf 'Start it with: %s/bin/ats-companion-bridge\n' "$install_prefix"
if [[ -n "$native_game_directory" ]]; then
  mkdir -p -- "$plugin_directory"
  plugin_temporary_file="$plugin_directory/.ATSCompanionTelemetry.so.$$"
  cp -- "$install_prefix/ATSCompanionTelemetry.so" "$plugin_temporary_file" ||
    fail "Could not stage the ATS telemetry plugin in: $plugin_directory"
  chmod 644 "$plugin_temporary_file"
  marker_temporary_file="$plugin_directory/.ats-companion-telemetry.$$"
  printf '%s\n' 'ats-companion-linux-telemetry-v1' >"$marker_temporary_file"
  mv -f -- "$marker_temporary_file" "$plugin_marker"
  marker_temporary_file=''
  mv -f -- "$plugin_temporary_file" "$plugin_path"
  plugin_temporary_file=''
  rm -f -- "$install_prefix/ATSCompanionTelemetry.so"
  printf 'Native ATS telemetry plugin installed to: %s\n' "$plugin_path"
  printf 'Restart ATS to load the native telemetry plugin.\n'
else
  rm -f -- "$install_prefix/ATSCompanionTelemetry.so"
  printf 'Live telemetry is unavailable for this install because no native Linux ATS game binary was selected.\n'
fi
