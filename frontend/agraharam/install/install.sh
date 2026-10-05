#!/usr/bin/env bash
# Agraharam install helper for the /local channel (architecture §13.2, §17.6).
#
# Copies one verified build (dist/agraharam/<version>/, or a release downloaded into a directory named after its
# version) into <HA config>/www/agraharam/<version>/ through an authorized file channel, for example the NAS file
# share mounted on this machine. Dry run by default. The directory is flat (§17.2): the module with both fonts
# embedded, three license texts, the manifest and the checksums.
#
# It never restarts Home Assistant, never touches configuration.yaml or .storage, never overwrites or edits an
# existing version directory, never creates www itself and never follows a symbolic link at the destination.
# Resource registration and dashboard creation are separate admin steps (install/README.md).
#
# Exit codes: 0 ok, 2 usage, 3 verification failed, 4 destination conflict.
# Written for bash 3.2 (macOS /bin/bash): no associative arrays, no mapfile, guarded empty-array expansion.

set -euo pipefail
umask 022

readonly EXIT_USAGE=2
readonly EXIT_VERIFY=3
readonly EXIT_CONFLICT=4
readonly FILE_MODE=0644
readonly DIR_MODE=0755
readonly VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
readonly SUM_LINE_RE='^[0-9a-f]{64}  (.+)$'

usage() {
  cat <<'USAGE'
usage: install/install.sh --dest <HA config>/www/agraharam [--version X.Y.Z] [--src DIR] [--apply] [--allow-dirty]
                          [--allow-missing-private]
  default: dry run (no writes). --src defaults to ../dist/agraharam/<version from package.json>.
  --dest                   the agraharam directory inside HA's www directory, as an absolute path with no
                           symbolic links
  --version                release to install; must match the source directory name and its manifest
  --src                    a built release directory (defaults to the package's dist/agraharam/<version>), or a
                           release downloaded into a directory named after its version
  --apply                  copy the files (without it nothing is written)
  --allow-dirty            accept a build made from uncommitted changes (a warning is printed)
  --allow-missing-private  let the privacy re-scan skip on a machine without the private files (the plan says so)
USAGE
}

die() {
  local code=$1
  shift
  printf 'install.sh: %s\n' "$*" >&2
  exit "$code"
}

warn() {
  printf 'warning      %s\n' "$*" >&2
}

script_dir=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
package_dir=$(cd -P "$script_dir/.." && pwd -P)

dest=''
version=''
src=''
apply=false
allow_dirty=false
allow_missing_private=false

while [ $# -gt 0 ]; do
  case $1 in
    --dest | --version | --src)
      [ $# -ge 2 ] && [ -n "$2" ] || { usage >&2; die "$EXIT_USAGE" "$1 needs a value."; }
      case $1 in
        --dest) dest=$2 ;;
        --version) version=$2 ;;
        --src) src=$2 ;;
      esac
      shift 2
      ;;
    --apply) apply=true; shift ;;
    --allow-dirty) allow_dirty=true; shift ;;
    --allow-missing-private) allow_missing_private=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "$EXIT_USAGE" "unknown argument: $1" ;;
  esac
done

# ---------------------------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------------------------

if command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
  sums_check() { shasum -a 256 -c SHA256SUMS >/dev/null 2>&1; }
elif command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | cut -d ' ' -f 1; }
  # Only -c: the BSD sha256sum shipped with macOS has no long options. verify_sums checks the line format itself.
  sums_check() { sha256sum -c SHA256SUMS >/dev/null 2>&1; }
else
  die "$EXIT_VERIFY" "neither shasum nor sha256sum is installed; cannot verify checksums."
fi

# Renames directory $1 to the absent path $2 without following a symbolic link at $2: if $2 has become a link
# since it was checked, the rename fails instead of moving $1 through it, which plain `mv` would do. GNU mv spells
# this -T, BSD and macOS mv spell it -h. A real directory that appears at $2 is still a conflict: GNU mv -T fails
# on a non-empty one, and BSD mv moves $1 inside it, which the caller detects and undoes.
if mv --version 2>/dev/null | grep -q 'GNU coreutils'; then
  rename_no_follow() { mv -T -- "$1" "$2"; }
else
  rename_no_follow() { mv -h -- "$1" "$2"; }
fi

# Reads one top-level string or boolean field from the manifest postbuild writes (two-space indented JSON).
manifest_field() {
  sed -n "s/^  \"$2\": \"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\}\$/\1/p" "$1/manifest.json" | head -n 1
}

# 183204 → 183,204
group_digits() {
  local digits=$1 grouped=''
  while [ ${#digits} -gt 3 ]; do
    grouped=",${digits: -3}$grouped"
    digits=${digits:0:${#digits}-3}
  done
  printf '%s%s' "$digits" "$grouped"
}

# The exact flat file set of a release (§17.2), in copy order: the module, the license texts, the manifest and the
# checksums. Nothing else is ever copied: /local serves files unauthenticated on the HA origin, so an unexpected
# .html or .svg file would be active content there.
readonly RELEASE_FILES=(agraharam.js THIRD_PARTY_LICENSES.md OFL-1.1-Hanken-Grotesk.txt OFL-1.1-Newsreader.txt
  manifest.json SHA256SUMS)

is_allowlisted() {
  local name
  for name in "${RELEASE_FILES[@]}"; do
    [ "$1" = "$name" ] && return 0
  done
  return 1
}

# Lists every entry under $1 as "<type> <relative path>" (f file, d directory, o anything else), NUL-safe.
list_entries() {
  local root=$1 entry rel
  while IFS= read -r -d '' entry; do
    rel=${entry#"$root"/}
    if [ -L "$entry" ]; then
      printf 'o %s\n' "$rel"
    elif [ -d "$entry" ]; then
      printf 'd %s\n' "$rel"
    elif [ -f "$entry" ]; then
      printf 'f %s\n' "$rel"
    else
      printf 'o %s\n' "$rel"
    fi
  done < <(find "$root" -mindepth 1 -print0)
}

# Verifies $1/SHA256SUMS: safe relative paths only, then every listed file matches. Prints the listed paths.
verify_sums() {
  local dir=$1 line path
  [ -f "$dir/SHA256SUMS" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    [[ $line =~ $SUM_LINE_RE ]] || return 1
    path=${BASH_REMATCH[1]}
    case $path in
      /* | ../* | */../* | */.. | ..) return 1 ;;
    esac
    printf '%s\n' "$path"
  done <"$dir/SHA256SUMS"
  (cd "$dir" && sums_check) || return 1
}

# The physical path of an existing directory (symbolic links resolved).
physical_dir() {
  (cd -P "$1" 2>/dev/null && pwd -P)
}

# ---------------------------------------------------------------------------------------------------------------
# Checks (run in both modes, in the documented order)
# ---------------------------------------------------------------------------------------------------------------

# 1. --dest names <...>/www/agraharam.
[ -n "$dest" ] || { usage >&2; die "$EXIT_USAGE" "--dest is required (expected .../www/agraharam)."; }
while [ "${dest%/}" != "$dest" ] && [ "$dest" != / ]; do dest=${dest%/}; done
www_dir=$(dirname "$dest")
if [ "$(basename "$dest")" != agraharam ] || [ "$(basename "$www_dir")" != www ]; then
  die "$EXIT_USAGE" "--dest must be the agraharam directory inside HA's www directory (expected .../www/agraharam)."
fi
case $dest in
  /*) ;;
  *) die "$EXIT_USAGE" "--dest must be an absolute path (expected /.../www/agraharam)." ;;
esac

# 2. www exists. HA serves /local only when /config/www existed at startup, so this script never creates it.
if [ ! -d "$www_dir" ]; then
  die "$EXIT_VERIFY" "$www_dir does not exist. HA serves /local only if /config/www existed at startup. Create it" \
    "through the file share, then schedule an HA restart separately. This script never restarts HA."
fi

# 2a. No symbolic link at www or the destination, and the physical path equals the given path, so a planted link
#     cannot redirect the copy outside the HA config share.
if [ -L "$www_dir" ] || [ -L "$dest" ] || [ "$(physical_dir "$www_dir")" != "$www_dir" ]; then
  die "$EXIT_VERIFY" "refusing a symlinked destination: $dest must be a real path with no symbolic links."
fi
dest_exists=false
if [ -e "$dest" ]; then
  [ -d "$dest" ] && [ "$(physical_dir "$dest")" = "$dest" ] ||
    die "$EXIT_VERIFY" "refusing a symlinked destination: $dest must be a real directory."
  dest_exists=true
fi

# 3. The source exists and its manifest names the same version as its directory and --version.
if [ -z "$version" ]; then
  version=$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' "$package_dir/package.json" | head -n 1)
fi
[[ $version =~ $VERSION_RE ]] || die "$EXIT_USAGE" "version must look like X.Y.Z (got an unexpected value)."
[ -n "$src" ] || src="$package_dir/dist/agraharam/$version"
[ -d "$src" ] || die "$EXIT_VERIFY" "source $src not found. Run \"npm run build\" first, or pass --src."
src=$(physical_dir "$src")
[ -f "$src/manifest.json" ] || die "$EXIT_VERIFY" "source $src has no manifest.json. Rebuild with \"npm run build\"."
manifest_version=$(manifest_field "$src" version)
if [ "$manifest_version" != "$version" ] || [ "$(basename "$src")" != "$version" ]; then
  die "$EXIT_VERIFY" "version mismatch: --version $version, directory $(basename "$src"), manifest" \
    "${manifest_version:-missing}. Install the directory whose name and manifest match."
fi

# 4. SHA256SUMS verifies.
listed=$(verify_sums "$src") || die "$EXIT_VERIFY" "SHA256SUMS in $src does not verify. Rebuild; never edit a build."
sum_count=$(printf '%s\n' "$listed" | grep -c . || true)

# 5. The file set equals the allowlist exactly (flat, no directories), and every file except SHA256SUMS is listed in
#    it.
while IFS= read -r entry; do
  type=${entry%% *}
  rel=${entry#* }
  case $type in
    d) die "$EXIT_VERIFY" "unexpected directory in the source: $rel (a release directory is flat)" ;;
    f)
      is_allowlisted "$rel" || die "$EXIT_VERIFY" "file not on the install allowlist: $rel"
      if [ "$rel" != SHA256SUMS ] && ! printf '%s\n' "$listed" | grep -Fxq -- "$rel"; then
        die "$EXIT_VERIFY" "file not covered by SHA256SUMS: $rel"
      fi
      ;;
    *) die "$EXIT_VERIFY" "not a regular file (symbolic link or special file) in the source: $rel" ;;
  esac
done < <(list_entries "$src" | LC_ALL=C sort)
for required in "${RELEASE_FILES[@]}"; do
  [ -f "$src/$required" ] || die "$EXIT_VERIFY" "missing $required in $src"
done
files=("${RELEASE_FILES[@]}")
[ "$sum_count" -eq $((${#files[@]} - 1)) ] || die "$EXIT_VERIFY" "SHA256SUMS lists files that are not in $src."

# 6. A build from uncommitted changes is refused unless explicitly allowed.
git_sha=$(manifest_field "$src" git_sha)
git_dirty=$(manifest_field "$src" git_dirty)
build_state=clean
if [ "$git_dirty" != false ]; then
  build_state=dirty
  if [ "$allow_dirty" = true ]; then
    warn "the build was made from uncommitted changes (--allow-dirty given)."
  else
    die "$EXIT_VERIFY" "the build was made from uncommitted changes. Commit and rebuild, or pass --allow-dirty."
  fi
fi

# 7. Existing versions are never overwritten.
target="$dest/$version"
if [ -e "$target" ] || [ -L "$target" ]; then
  die "$EXIT_CONFLICT" "$target already exists. Versions are never overwritten; bump the version and rebuild."
fi

# 8. Re-run the privacy scan on exactly these files when node is available. check-public exits 2 when it finds no
#    private directory, so a machine without the private files fails here unless --allow-missing-private is given;
#    its output (counts and path:line:column only, never values) goes to stderr.
scan_args=(--dist "$src")
[ "$allow_missing_private" = false ] || scan_args+=(--allow-missing-private)
if command -v node >/dev/null 2>&1; then
  if ! scan_output=$(cd "$package_dir" && node scripts/check-public.mjs "${scan_args[@]}" 2>&1); then
    printf '%s\n' "$scan_output" >&2
    die "$EXIT_VERIFY" "the privacy re-scan failed (see above). Set AGR_PRIVATE_DIR if the private files live" \
      "elsewhere, or pass --allow-missing-private on a machine that has none."
  fi
  printf '%s\n' "$scan_output" >&2
  case $scan_output in
    *'check-public: skipped:'*)
      privacy_scan='privacy re-scan skipped: no private files'
      [ "$allow_missing_private" = false ] || privacy_scan="$privacy_scan (--allow-missing-private given)"
      ;;
    *) privacy_scan='re-scanned with check-public --dist' ;;
  esac
else
  privacy_scan='privacy re-scan skipped: node not found (the checksums bind these files to the build-time scan)'
fi

# ---------------------------------------------------------------------------------------------------------------
# Plan
# ---------------------------------------------------------------------------------------------------------------

display_src=${src#"$package_dir"/}
if [ "$apply" = true ]; then
  echo 'agraharam install (apply)'
else
  echo 'agraharam install plan (dry run: nothing written)'
fi
printf 'source       %s   manifest %s  git %s  %s\n' "$display_src" "$manifest_version" "${git_sha:-unknown}" "$build_state"
printf 'destination  %s   (absent: ok)\n' "$target"
if [ "$dest_exists" = false ]; then
  printf 'destination parent absent: will create %s   (first install only)\n' "$dest"
fi
printf 'checksums    %s files verified\n' "$sum_count"
printf 'privacy      %s\n' "$privacy_scan"
for rel in "${files[@]}"; do
  bytes=$(wc -c <"$src/$rel" | tr -d ' ')
  sum=$(sha256_of "$src/$rel")
  printf 'copy         %-28s %10s B  sha256 %s…%s\n' "$rel" "$(group_digits "$bytes")" "${sum:0:4}" "${sum: -4}"
done
printf 'resource     /local/agraharam/%s/agraharam.js   (type: module; create or update, see install/README.md)\n' \
  "$version"
echo 'dashboard    url_path agraharam-next, view path home   (create once; see install/README.md)'
echo 'restart      not performed; required only if www did not exist when HA last started'

if [ "$apply" != true ]; then
  echo 'next         re-run with --apply to copy'
  exit 0
fi

# ---------------------------------------------------------------------------------------------------------------
# Apply: copy into a private partial directory, verify, then rename into place
# ---------------------------------------------------------------------------------------------------------------

if [ "$dest_exists" = false ]; then
  # One non-recursive mkdir, only after checks 1, 2 and 2a: www exists, is real and is not a link.
  mkdir -m "$DIR_MODE" "$dest" || die "$EXIT_CONFLICT" "could not create $dest."
fi
if [ -L "$dest" ] || [ ! -d "$dest" ] || [ "$(physical_dir "$dest")" != "$dest" ]; then
  die "$EXIT_VERIFY" "refusing a symlinked destination: $dest changed while installing."
fi

partial="$dest/.$version.partial-$$"
partial_created=false
cleanup() {
  # Removes only the partial directory this run created; a stale one left by an earlier run is never touched.
  if [ "$partial_created" = true ] && [ -d "$partial" ] && [ ! -L "$partial" ]; then rm -rf -- "$partial"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

mode_warning=false
# mkdir fails on any existing path, links included, so this run owns the partial directory once it succeeds.
mkdir -m "$DIR_MODE" "$partial" ||
  die "$EXIT_CONFLICT" "could not create $partial (a stale partial directory from an earlier run?). Remove it" \
    "through the file share, then re-run."
partial_created=true
for rel in "${files[@]}"; do
  cp -- "$src/$rel" "$partial/$rel"
  # Some network shares map permissions themselves and refuse chmod; the copy is still valid.
  chmod "$FILE_MODE" "$partial/$rel" 2>/dev/null || mode_warning=true
done
[ "$mode_warning" = false ] || warn "the share did not accept file modes; it applies its own permissions."
verify_sums "$partial" >/dev/null || die "$EXIT_VERIFY" "the copied files do not verify; nothing was installed."

if [ -e "$target" ] || [ -L "$target" ]; then
  die "$EXIT_CONFLICT" "$target appeared while copying; nothing was installed."
fi
rename_no_follow "$partial" "$target" ||
  die "$EXIT_CONFLICT" "$target appeared while installing; nothing was installed and that path was left alone."
if [ ! -L "$target" ] && [ -e "$target/$(basename "$partial")" ]; then
  # A real directory appeared at the version path in the gap and BSD mv moved ours inside it: undo only our copy.
  rm -rf -- "${target:?}/$(basename "$partial")"
  die "$EXIT_CONFLICT" "$target appeared while installing; removed this run's copy and left that directory alone."
fi
partial_created=false
printf 'installed    %s\n' "$target"
echo 'next         register or update the resource, then follow install/README.md (read-only verification first)'
