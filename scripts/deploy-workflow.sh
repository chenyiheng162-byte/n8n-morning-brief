#!/usr/bin/env bash
# Builds the workflow, imports + publishes it in n8n, and only then switches the runtime files over.
# If ANY step fails after the backup (an explicit error, a failed command, a signal), ONE exit handler restores the n8n
# database from that backup AND puts the previous workflow files and scripts back, so a failed deploy never leaves "new files, old
# workflow" (or the reverse) behind. If the restore itself fails, the backup is kept and its path is printed.
# n8n must not be running (it shares a SQLite database), and no brief run may be in progress.
set -euo pipefail
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$SRC_DIR/scripts/env.sh"; . "$SRC_DIR/scripts/lib-config.sh"
die() { echo "ERROR: $*" >&2; exit 1; }
curl -s -o /dev/null -m 2 "http://127.0.0.1:$N8N_PORT/healthz" && die "n8n (or something else) is answering on port $N8N_PORT; stop it first."
runtime_check || exit 1
mkdir -p "${BRIEF_STATE_DIR:-$BRIEF_HOME/data/state}" "$BRIEF_HOME/data/backups"

# Share the run lock with run-brief.sh so a deploy never overlaps a scheduled run.
LOCK="${BRIEF_STATE_DIR:-$BRIEF_HOME/data/state}/run.lockf"
. "$SRC_DIR/scripts/lock.sh"
lrc=0; lock_take "$LOCK" deploy-workflow || lrc=$?   # (set -e must not end the script on a refusal)
[ "$lrc" = 2 ] && die "could not take the run lock (is the state folder writable? is /usr/bin/lockf there?)"
[ "$lrc" = 1 ] && die "A brief run is in progress (lock held by ${LOCK_HOLDER:-another process}); try again in a minute."
STAGING="$BRIEF_HOME/workflows.next"; SSTAGING="$BRIEF_HOME/scripts.next"; DB="$N8N_USER_FOLDER/.n8n/database.sqlite"; BACKUP=""; WF=morningBriefTest01
TOUCHED=0; SWITCHING=0; COMMITTED=0
restore_files() {
  [ "$SWITCHING" = 1 ] || return 0
  # The switch moves workflows -> workflows.prev, staging -> workflows, then scripts -> scripts.prev, staging -> scripts.
  # Old .prev copies are removed BEFORE the switch starts, so any .prev that exists now was made by this deploy: undo it.
  if [ -d "$BRIEF_HOME/scripts.prev" ]; then rm -rf "${BRIEF_HOME:?}/scripts"; mv "$BRIEF_HOME/scripts.prev" "$BRIEF_HOME/scripts" && echo "previous scripts restored" >&2; fi
  if [ -d "$BRIEF_HOME/workflows.prev" ]; then rm -rf "${BRIEF_HOME:?}/workflows"; mv "$BRIEF_HOME/workflows.prev" "$BRIEF_HOME/workflows" && echo "previous workflow files restored (build $(cat "$BRIEF_HOME/workflows/BUILD" 2>/dev/null || echo none))" >&2; fi
}
restore_db() {
  [ "$TOUCHED" = 1 ] || return 0
  if [ -n "$BACKUP" ] && [ -f "$BACKUP" ]; then
    rm -f "$DB-wal" "$DB-shm"
    if cp "$BACKUP" "$DB"; then echo "n8n database restored from $BACKUP" >&2; else echo "CRITICAL: could not restore the n8n database; the backup is kept at $BACKUP" >&2; fi
  fi
}
cleanup() {
  local rc=$?
  trap - EXIT
  if [ "$rc" -ne 0 ] && [ "$COMMITTED" = 0 ] && [ "$TOUCHED" = 1 ]; then echo "ERROR: deploy did not finish (exit $rc): rolling back" >&2; restore_db; restore_files; fi
  rm -rf "${STAGING:?}" "${SSTAGING:?}"
  lock_release
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 143' TERM INT HUP

# This script patches n8n's INTERNAL tables (see below). That is only known to work with the n8n version it was tested with.
EXPECTED_N8N="$(node -e "console.log(require(process.argv[1]).dependencies.n8n)" "$SRC_DIR/package.json")"
ACTUAL_N8N="$(n8n --version 2>/dev/null | tail -1)"
if [ "$ACTUAL_N8N" != "$EXPECTED_N8N" ] && [ -z "${BRIEF_ALLOW_N8N_MISMATCH:-}" ]; then
  die "n8n is $ACTUAL_N8N but this deploy step was only tested with $EXPECTED_N8N (it edits n8n's internal tables). Re-verify, then run again with BRIEF_ALLOW_N8N_MISMATCH=1."
fi

# A random webhook token, created once and kept in the settings file (never in the workflow, never in git).
config_has BRIEF_TOKEN || config_set BRIEF_TOKEN "$(generate_token)"

node "$SRC_DIR/scripts/build-workflow.mjs"
BUILD="$(tr -d '[:space:]' < "$SRC_DIR/workflows/BUILD")"
rm -rf "${STAGING:?}"; mkdir -p "$STAGING"
rsync -a "$SRC_DIR/workflows/" "$STAGING/"
# The scripts are staged too, so the runtime folder switches to the new version as a whole or not at all.
rm -rf "${SSTAGING:?}"; mkdir -p "$SSTAGING"
rsync -a "$SRC_DIR/scripts/" "$SSTAGING/"
echo "build $BUILD (staged)"

# Back up the database; any failure below restores it.
if [ -f "$DB" ]; then
  BACKUP="$BRIEF_HOME/data/backups/database-pre-deploy-$(date +%Y%m%d-%H%M%S).sqlite"
  sqlite3 "$DB" ".backup '$BACKUP'" || die "could not back up the n8n database"
  chmod 600 "$BACKUP"
  ls -1t "$BRIEF_HOME/data/backups"/database-pre-deploy-*.sqlite 2>/dev/null | tail -n +4 | while read -r old; do rm -f "$old"; done   # keep the last 3
fi
rollback() { echo "ERROR: $1" >&2; exit 1; }   # the exit handler above does the restoring

# Unpublish first: importing over a published workflow can fail with "You do not have permission to
# deactivate this workflow" on an instance whose owner account was never set up. Harmless if it does not exist yet.
TOUCHED=1
n8n unpublish:workflow --id="$WF" >/dev/null 2>&1 || true
out="$(n8n import:workflow --input="$STAGING/morning-brief.json" 2>&1)" || rollback "import failed: $(echo "$out" | tail -1)"
echo "$out" | tail -1
out="$(n8n publish:workflow --id="$WF" 2>&1)" || rollback "publish failed: $(echo "$out" | tail -1)"
echo "$out" | tail -3

# Root cause of "n8n keeps running the previous version": `n8n import:workflow` queues a pending row in
# workflow_publication_outbox that targets the version that was active BEFORE the import, and n8n applies
# that queue on its next start. `publish:workflow` does not fix it. n8n is stopped here (checked above), so retarget the
# pending rows and the published/active pointers to the freshly imported version, in ONE transaction. The webhook path
# carries the build hash, so even a missed pointer can only make the run fail (404), never send from a stale workflow.
CUR="$(sqlite3 "$DB" "select versionId from workflow_entity where id='$WF';")"
[ -n "$CUR" ] || rollback "the workflow is not in n8n after the import"
sqlite3 "$DB" <<SQL || rollback "could not update n8n's version pointers"
BEGIN;
insert or ignore into workflow_published_version(workflowId, publishedVersionId, createdAt, updatedAt) values('$WF','$CUR',strftime('%Y-%m-%d %H:%M:%f','now'),strftime('%Y-%m-%d %H:%M:%f','now'));
update workflow_publication_outbox set publishedVersionId='$CUR' where workflowId='$WF' and status!='completed';
update workflow_published_version set publishedVersionId='$CUR', updatedAt=strftime('%Y-%m-%d %H:%M:%f','now') where workflowId='$WF';
update workflow_entity set activeVersionId='$CUR', active=1 where id='$WF';
delete from webhook_entity where workflowId='$WF' and webhookPath!='morning-brief-$BUILD';
COMMIT;
SQL
PUB="$(sqlite3 "$DB" "select publishedVersionId from workflow_published_version where workflowId='$WF';")"
STALE="$(sqlite3 "$DB" "select count(*) from workflow_publication_outbox where workflowId='$WF' and status!='completed' and publishedVersionId!='$CUR';")"
[ "$CUR" = "$PUB" ] && [ "$STALE" = 0 ] || rollback "version pointers still inconsistent (published=$PUB stale_outbox=$STALE current=$CUR)"

# Everything worked: switch both folders over by renaming (no partial copies), keep the previous sets as *.prev.
echo "build=$BUILD n8n=$ACTUAL_N8N deployed=$(date -u +%FT%TZ)" > "$STAGING/DEPLOYED"
rm -rf "${BRIEF_HOME:?}/workflows.prev" "${BRIEF_HOME:?}/scripts.prev"
SWITCHING=1
if [ -d "$BRIEF_HOME/workflows" ]; then mv "$BRIEF_HOME/workflows" "$BRIEF_HOME/workflows.prev"; fi
mv "$STAGING" "$BRIEF_HOME/workflows"
if [ -d "$BRIEF_HOME/scripts" ]; then mv "$BRIEF_HOME/scripts" "$BRIEF_HOME/scripts.prev"; fi
mv "$SSTAGING" "$BRIEF_HOME/scripts"
COMMITTED=1
echo "deployed version $CUR (build $BUILD)"
