#!/bin/sh

set -eu

project_id='horner-next-ten-isaiah'
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_dir=$(dirname -- "$script_dir")

if ! command -v firebase >/dev/null 2>&1; then
  echo 'Firebase CLI is required. Install firebase-tools, then try again.' >&2
  exit 1
fi

cd "$repository_dir"

firebase deploy --only firestore:rules --dry-run --non-interactive --project "$project_id"
firebase deploy --only firestore:rules --non-interactive --project "$project_id"
