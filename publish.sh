#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$SCRIPT_DIR"

if ! command -v npm >/dev/null 2>&1; then
  printf 'Error: npm was not found.\n' >&2
  exit 1
fi

if ! npm whoami >/dev/null 2>&1; then
  printf 'Error: npm is not authenticated or the token has expired. Run npm login first.\n' >&2
  exit 1
fi

PACKAGE_NAME="$(node -p "require('./package.json').name")"
PACKAGE_VERSION="$(node -p "require('./package.json').version")"
PACKAGE_SPEC="${PACKAGE_NAME}@${PACKAGE_VERSION}"

VERSION_CHECK=""
if VERSION_CHECK="$(npm view "$PACKAGE_SPEC" version --json 2>&1)"; then
  printf 'Error: %s has already been published. Update the version in package.json first.\n' "$PACKAGE_SPEC" >&2
  exit 1
elif [[ "$VERSION_CHECK" != *E404* ]]; then
  printf 'Error: unable to determine whether %s has already been published:\n%s\n' "$PACKAGE_SPEC" "$VERSION_CHECK" >&2
  exit 1
fi
unset VERSION_CHECK

npm test
npm run typecheck
npm publish --dry-run --access public

OTP=""
trap 'unset OTP' EXIT

IFS= read -r -s -p 'npm OTP (6 digits): ' OTP
printf '\n'

# Some SSH terminals wrap pasted input in bracketed-paste control sequences.
OTP="${OTP//$'\e[200~'/}"
OTP="${OTP//$'\e[201~'/}"
OTP="${OTP//$'\r'/}"

if [[ ! "$OTP" =~ ^[0-9]{6}$ ]]; then
  printf 'Error: OTP must be exactly 6 digits.\n' >&2
  exit 1
fi

NPM_CONFIG_OTP="$OTP" npm publish --access public
printf 'Published: %s\n' "$PACKAGE_SPEC"
