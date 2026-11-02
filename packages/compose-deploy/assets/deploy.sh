# Remote deploy script. Piped to `sh -s` over SSH after an `export CD_*=...` preamble.
# Everything runs inside main() and main gets </dev/null: sh reads this script from
# stdin, so a command that read stdin (docker compose exec -T, docker login) would
# otherwise swallow the rest of the script.
set -eu

R_STATUS=failed
R_PREV=
R_IMAGE=
R_BACKUP=
TMP_DOCKER_CONFIG=

log() { printf '[deploy] %s\n' "$*"; }

compose() {
  if [ -n "$CD_PROJECT" ]; then
    docker compose -f "$CD_COMPOSE_FILE" -p "$CD_PROJECT" "$@"
  else
    docker compose -f "$CD_COMPOSE_FILE" "$@"
  fi
}

first_line() { head -n 1 || true; }

# Print a full sha256:<id> for an image id (empty in, empty out).
full_id() {
  [ -n "$1" ] || return 0
  fid="$(docker image inspect -f '{{.Id}}' "$1" 2>/dev/null | first_line)"
  fid="${fid:-$1}"
  case "$fid" in
    sha256:*) printf '%s\n' "$fid" ;;
    *) printf 'sha256:%s\n' "$fid" ;;
  esac
}

finish() {
  code=$?
  trap - EXIT
  # The temp DOCKER_CONFIG holds the login; removing it leaves the VPS's own credentials alone.
  # Limit: the docker CLI may still pick an installed pass/secretservice helper by itself, so
  # the login is only guaranteed temporary on hosts without one.
  if [ -n "$TMP_DOCKER_CONFIG" ]; then rm -rf "$TMP_DOCKER_CONFIG"; fi
  printf '@@ci-sdk@@ status=%s\n' "$R_STATUS"
  printf '@@ci-sdk@@ previous-image-id=%s\n' "$R_PREV"
  printf '@@ci-sdk@@ image-id=%s\n' "$R_IMAGE"
  printf '@@ci-sdk@@ backup-file=%s\n' "$R_BACKUP"
  exit "$code"
}

# The service's OWN configured image. `compose config --images <svc>` also lists the images of
# its depends_on services (in random order), so parse the normalised YAML instead.
service_image() {
  img="$(compose config "$CD_SERVICE" 2>/dev/null | awk -v svc="$CD_SERVICE" '
    /^services:/ { in_s = 1; next }
    /^[^ ]/ { in_s = 0 }
    in_s && /^  [^ ]/ {
      cur = $0; sub(/^  /, "", cur); sub(/:.*$/, "", cur); gsub(/["\047]/, "", cur)
      in_svc = (cur == svc); next
    }
    in_s && in_svc && /^    image:/ {
      v = $0; sub(/^    image:[ ]*/, "", v); gsub(/^["\047]|["\047]$/, "", v)
      print v; exit
    }
  ' || true)"
  if [ -z "$img" ]; then
    # Only trust the plain list when it holds exactly one image.
    list="$(compose config --images "$CD_SERVICE" 2>/dev/null | sort -u || true)"
    if [ -n "$list" ] && [ "$(printf '%s\n' "$list" | wc -l | tr -d ' ')" = 1 ]; then img="$list"; fi
  fi
  printf '%s' "$img"
}

service_container() { compose ps -q "$1" 2>/dev/null | first_line; }

backup_postgres() {
  db_cid="$(service_container "$CD_DB_SERVICE")"
  if [ -z "$db_cid" ]; then
    log "DB service '$CD_DB_SERVICE' is not running; skipping backup"
    return 0
  fi
  umask 077
  mkdir -p "$CD_BACKUP_DIR"
  path="$CD_BACKUP_DIR/deploy-$(date -u +%Y%m%d-%H%M%S).dump"
  log "Backing up PostgreSQL to $path"
  if ! compose exec -T "$CD_DB_SERVICE" sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >"$path"; then
    rm -f "$path"
    log "Backup failed (pg_dump error)"
    return 1
  fi
  if [ ! -s "$path" ]; then
    rm -f "$path"
    log "Backup failed (empty dump)"
    return 1
  fi
  R_BACKUP="$path"
  log "Backup bytes: $(wc -c <"$path" | tr -d ' ')"
  # Keep the newest CD_BACKUP_KEEP dumps.
  ls -1t "$CD_BACKUP_DIR"/deploy-*.dump 2>/dev/null | tail -n +"$((CD_BACKUP_KEEP + 1))" |
    while IFS= read -r old; do
      log "Removing old backup $old"
      rm -f "$old"
    done || true
}

health_ok() {
  if [ -n "$CD_HEALTH_COMMAND" ]; then
    compose exec -T "$CD_SERVICE" sh -c "$CD_HEALTH_COMMAND" >/dev/null 2>&1
  elif [ -n "$CD_HEALTH_URL" ]; then
    if command -v curl >/dev/null 2>&1; then
      curl -fsS -m 5 -o /dev/null "$CD_HEALTH_URL" >/dev/null 2>&1
    else
      wget -q -T 5 -O /dev/null "$CD_HEALTH_URL" >/dev/null 2>&1
    fi
  else
    cid="$(service_container "$CD_SERVICE")"
    [ -n "$cid" ] || return 1
    state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || true)"
    case "$state" in
      healthy) return 0 ;;
      none) [ "$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null || true)" = true ] ;;
      *) return 1 ;;
    esac
  fi
}

main() {
  trap finish EXIT
  trap 'exit 143' HUP INT TERM
  command -v docker >/dev/null 2>&1 || { log "Missing required command: docker"; exit 1; }

  log "Directory: $CD_DIRECTORY"
  log "Compose file: $CD_COMPOSE_FILE; service: $CD_SERVICE"
  cd "$CD_DIRECTORY"
  [ -f "$CD_COMPOSE_FILE" ] || { log "Compose file not found: $CD_DIRECTORY/$CD_COMPOSE_FILE"; exit 1; }

  R_PREV="$(full_id "$(compose images -q "$CD_SERVICE" 2>/dev/null | first_line)")"
  log "Current image id: ${R_PREV:-<none>}"

  if [ "$CD_BACKUP" = postgres ]; then
    backup_postgres
  fi

  if [ -n "$CD_REGISTRY_USERNAME" ]; then
    log "Logging in to ${CD_REGISTRY:-Docker Hub}"
    # The active context lives in config.json, which may not be copied below: pin it so every
    # later command talks to the same daemon as the backup and image-id steps did.
    ctx="$(docker context show 2>/dev/null || true)"
    if [ -n "$ctx" ] && [ "$ctx" != default ] && [ -z "${DOCKER_HOST:-}" ]; then
      export DOCKER_CONTEXT="$ctx"
    fi
    TMP_DOCKER_CONFIG="$(mktemp -d)"
    orig_config="${DOCKER_CONFIG:-${HOME:-}/.docker}"
    # Keep plugins, contexts, proxies and other registries' auths working.
    if [ -d "$orig_config/cli-plugins" ]; then
      ln -s "$orig_config/cli-plugins" "$TMP_DOCKER_CONFIG/cli-plugins"
    fi
    if [ -d "$orig_config/contexts" ]; then
      ln -s "$orig_config/contexts" "$TMP_DOCKER_CONFIG/contexts"
    fi
    if [ -f "$orig_config/config.json" ]; then
      if grep -q '"credsStore"\|"credHelpers"' "$orig_config/config.json"; then
        log "config.json uses a credential helper; registry login uses an empty temp config"
      else
        cp "$orig_config/config.json" "$TMP_DOCKER_CONFIG/config.json"
      fi
    fi
    export DOCKER_CONFIG="$TMP_DOCKER_CONFIG"
    printf '%s' "$CD_REGISTRY_PASSWORD" |
      docker login ${CD_REGISTRY:+"$CD_REGISTRY"} -u "$CD_REGISTRY_USERNAME" --password-stdin
  fi

  log "Pulling: $CD_PULL"
  # shellcheck disable=SC2086
  compose pull $CD_PULL

  log "Starting stack"
  up_failed=0
  if ! compose up -d --remove-orphans; then
    up_failed=1
    log "compose up failed"
  fi

  cid="$(service_container "$CD_SERVICE")"
  if [ -n "$cid" ]; then
    R_IMAGE="$(full_id "$(docker inspect -f '{{.Image}}' "$cid" 2>/dev/null || true)")"
  fi
  log "Running image id: ${R_IMAGE:-<none>}"

  if [ "$up_failed" = 0 ]; then
    log "Checking health"
    attempt=1
    while [ "$attempt" -le "$CD_HEALTH_RETRIES" ]; do
      if health_ok; then
        log "Health check passed on attempt $attempt"
        R_STATUS=deployed
        compose ps || true
        return 0
      fi
      log "Health check attempt $attempt/$CD_HEALTH_RETRIES failed"
      attempt=$((attempt + 1))
      if [ "$attempt" -le "$CD_HEALTH_RETRIES" ]; then sleep "$CD_HEALTH_INTERVAL"; fi
    done
    log "Health check failed; service logs follow"
  else
    log "Deploy failed; service logs follow"
  fi
  compose logs --tail="$CD_LOG_LINES" "$CD_SERVICE" || true

  if [ "$CD_ROLLBACK" != true ]; then
    log "Rollback disabled"
    exit 1
  fi
  if [ -z "$R_PREV" ]; then
    log "No previous image id captured; rollback skipped"
    exit 1
  fi
  # The configured ref is what `compose up` uses; the container's ref may still be the old one.
  ref="$(service_image)"
  if [ -z "$ref" ] && [ -n "$cid" ]; then
    ref="$(docker inspect -f '{{.Config.Image}}' "$cid" 2>/dev/null || true)"
  fi
  if [ -z "$ref" ]; then
    log "Cannot determine the image reference; rollback skipped"
    exit 1
  fi
  case "$ref" in
    *@sha256:*)
      log "Image is pinned by digest ($ref); rollback by retag is impossible"
      exit 1
      ;;
  esac
  log "Rolling back to image $R_PREV ($ref)"
  docker tag "$R_PREV" "$ref"
  pull_never=
  if docker compose up --help 2>&1 | grep -q -- '--pull'; then pull_never=never; fi
  # shellcheck disable=SC2086
  compose up -d --no-deps ${pull_never:+--pull never} "$CD_SERVICE" ||
    log "Rollback compose up failed"
  cid="$(service_container "$CD_SERVICE")"
  R_IMAGE=
  if [ -n "$cid" ]; then
    R_IMAGE="$(full_id "$(docker inspect -f '{{.Image}}' "$cid" 2>/dev/null || true)")"
  fi
  if [ "$R_IMAGE" = "$R_PREV" ]; then
    R_STATUS=rolled-back
  else
    log "Rollback did not restore $R_PREV (running: ${R_IMAGE:-<none>})"
  fi
  exit 1
}

main </dev/null
