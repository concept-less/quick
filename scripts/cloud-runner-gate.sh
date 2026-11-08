#!/usr/bin/env bash
# Install OUTSIDE any checkout as ops/trust-gate.sh. Runs before any job step/checkout.
# Do not source repository code here. Fail closed, including unknown events/workflows.
set -euo pipefail
BASE=/home/simon/.local/share/quick-release-runner
[ "$(sha256sum /etc/machine-id | cut -d' ' -f1)" = "$(<"$BASE/ops/machine-id.sha256")" ] || exit 1
[ "${GITHUB_REPOSITORY:-}" = concept-less/quick ] &&
[ "${GITHUB_REF:-}" = refs/heads/main ] &&
[ "${GITHUB_WORKFLOW_REF:-}" = concept-less/quick/.github/workflows/release.yml@refs/heads/main ] &&
{ [ "${GITHUB_EVENT_NAME:-}" = push ] || [ "${GITHUB_EVENT_NAME:-}" = workflow_dispatch ]; } || {
  echo 'Rejected: cloud runner accepts only the main release workflow on push/manual dispatch' >&2
  exit 1
}
echo 'Trusted main release on pinned cloud host'
