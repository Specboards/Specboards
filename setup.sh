#!/usr/bin/env bash
# Stand up a self-hosted Specboards with one command.
#
#   ./setup.sh              # pull, migrate, start; http://localhost:3000
#   ./setup.sh --build      # compile this working tree instead of pulling
#   ./setup.sh --stop       # stop the stack, keep the data
#   ./setup.sh --destroy    # stop and delete the database volume
#
# Everything this does by hand, a person previously had to do by reading:
# generate a secret, write infra/.env, bring up compose, discover the database
# was empty, find the migration command in a different section of the README,
# and run that too. The 2026-08-31 clean-machine run stopped on each of those in
# turn, so they are automated here rather than documented harder.
#
# Re-running is safe: an existing infra/.env is never overwritten, and the
# migration runner is idempotent.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$root"

compose=(docker compose -f infra/docker-compose.yml)
env_file="infra/.env"

# The database volume, and the name it had before the compose project was
# given one. See the `volumes:` block in infra/docker-compose.yml.
volume="specboard_db"
legacy_volume="infra_specboard_db"

adopt_legacy=false
# --start is "I know about the old volume, start fresh anyway". Without it a
# bare run stops rather than silently ignoring a database someone may want.
skip_legacy=false
# Pull the published image unless asked to compile the working tree.
build_from_source=false
case "${1:-}" in
  --stop)
    exec "${compose[@]}" down
    ;;
  --adopt-legacy-volume)
    adopt_legacy=true
    ;;
  --start)
    skip_legacy=true
    ;;
  --build)
    build_from_source=true
    ;;
  --destroy)
    # -v drops the named volume, which is the database. Ask first: this is the
    # one thing here that destroys data someone may care about.
    printf 'This deletes the Specboards database volume and everything in it.\n'
    read -r -p 'Type "destroy" to confirm: ' reply
    [ "$reply" = "destroy" ] || { echo "Aborted."; exit 1; }
    exec "${compose[@]}" down -v
    ;;
  "") ;;
  *)
    echo "usage: ./setup.sh [--start|--build|--stop|--destroy|--adopt-legacy-volume]" >&2
    exit 64
    ;;
esac

# --- prerequisites ----------------------------------------------------------
# Checked up front and reported together: finding out about the second missing
# tool after a four-minute image build is a bad way to learn it.
missing=()
command -v docker >/dev/null 2>&1 || missing+=("docker (https://docs.docker.com/get-docker/)")
docker compose version >/dev/null 2>&1 || missing+=("docker compose v2 (bundled with Docker Desktop)")
if [ ${#missing[@]} -gt 0 ]; then
  echo "Specboards needs:" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but not running. Start Docker and try again." >&2
  exit 1
fi

# The database's host port: an override on this run wins, else whatever a
# previous run recorded, else the default. Read before the checks below so a
# stack already moved off 5432 is checked on the port it actually uses.
recorded_port=""
if [ -f "$env_file" ]; then
  recorded_port="$(sed -n 's/^POSTGRES_PORT=//p' "$env_file" | tr -d '"' | head -1)"
fi
web_port=3000
db_port="${POSTGRES_PORT:-${recorded_port:-5432}}"

# Ports, before the build rather than after it. A machine with its own Postgres
# on 5432 is the common case, and compose's own failure for this arrives several
# minutes in and names a container rather than a fix.
#
# Skipped when this stack is already up, because then the thing holding the
# ports is us, and re-running ./setup.sh on a running instance has to stay a
# safe no-op rather than a confusing refusal.
port_busy() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    # No lsof (many slim Linux images): try to open the port instead.
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3<&-; return 0; }
    return 1
  fi
}

if [ -z "$("${compose[@]}" ps -q 2>/dev/null)" ]; then
  if port_busy "$web_port"; then
    echo "Port $web_port is already in use, and Specboards serves on it." >&2
    echo "Stop whatever is using it, then re-run ./setup.sh." >&2
    exit 1
  fi
  if port_busy "$db_port"; then
    echo "Port $db_port is already in use (often another Postgres)." >&2
    echo "Re-run with a free port, e.g.:" >&2
    echo "    POSTGRES_PORT=55432 ./setup.sh" >&2
    echo "Only the host side moves; nothing inside the stack changes." >&2
    exit 1
  fi
fi

# --- secrets ----------------------------------------------------------------
# BETTER_AUTH_SECRET has no default anywhere and compose refuses to start
# without it, so a first run has to produce one. Generated here rather than
# asked for: a secret a human pastes from a tutorial is worse than one nobody
# has ever seen, and "run openssl and edit a file" was a step people stopped on.
random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    # Every machine that can run Docker has one of these; do not require openssl.
    head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

if [ ! -f "$env_file" ]; then
  echo "Creating $env_file with generated secrets…"
  umask 077
  cat > "$env_file" <<EOF
# Generated by ./setup.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Keep this file secret.
#
# Rotating BETTER_AUTH_SECRET signs everyone out AND makes anything encrypted
# under the old key unreadable (the GitHub App private key, webhook signing
# secrets, each workspace's model provider key). Treat it as a migration.
BETTER_AUTH_SECRET=$(random_hex 32)

# Baked into the database volume on first start. Changing it later means
# ALTER USER in psql, not just editing this file.
POSTGRES_PASSWORD=$(random_hex 24)

# Public origin of this deployment. The default suits a local trial. Set this
# to a real HTTPS origin before anyone else can reach the instance.
APP_URL=http://localhost:3000

# Host port the database is published on, loopback only. Move it if something
# else already owns 5432; only the host side changes.
POSTGRES_PORT=${db_port}

# Outbound email (verification, password reset, invites). Unset means email is
# skipped; sign-up then does not require verification, because the link could
# never arrive. Set both to turn real verification on.
# POSTMARK_SERVER_TOKEN=
# EMAIL_FROM=Specboards <no-reply@example.com>
EOF
  echo "  secrets generated; this file is not overwritten on later runs."
else
  echo "Using existing $env_file."
  # Never overwritten, but it does need extending. A file written by an older
  # version has only the keys that version knew about, so an upgrading operator
  # never sees the ones added since, nor the comments explaining them. Nothing
  # breaks (compose defaults cover both), but the documented way to point the
  # instance at a real origin or turn on email is invisible to exactly the
  # people who have been running it longest.
  #
  # Only ever appends, only keys that are absent, and never a secret: a file
  # that already has BETTER_AUTH_SECRET must not gain a second one.
  added=()
  add_key() {
    grep -qE "^[#[:space:]]*$1=" "$env_file" && return 0
    printf '%s\n' "" "$2" >> "$env_file"
    added+=("$1")
  }
  add_key APP_URL "# Public origin of this deployment. The default suits a local trial. Set this
# to a real HTTPS origin before anyone else can reach the instance.
APP_URL=http://localhost:3000"
  add_key POSTGRES_PORT "# Host port the database is published on, loopback only. Move it if something
# else already owns 5432; only the host side changes.
POSTGRES_PORT=${db_port}"
  add_key POSTMARK_SERVER_TOKEN "# Outbound email (verification, password reset, invites). Unset means email is
# skipped; sign-up then does not require verification, because the link could
# never arrive. Set both to turn real verification on.
# POSTMARK_SERVER_TOKEN=
# EMAIL_FROM=Specboards <no-reply@example.com>"
  if [ ${#added[@]} -gt 0 ]; then
    echo "  added newer settings to $env_file: ${added[*]}"
    echo "  (values are the defaults this version already used; nothing changed behaviour)"
  fi
fi

# --- legacy volume ----------------------------------------------------------
# Before the compose project was named, the database volume was called
# `infra_specboard_db` after the directory this file's compose config lives in.
# Anyone who installed then still has their data under that name. Starting
# clean on top of it is silent: compose creates the new empty volume, the
# migrate service fills it with 63 empty tables, the app comes up healthy, and
# the operator sees every account and every spec gone. Their data is fine and
# nothing says so.
#
# So: refuse to be silent. Adopt the old volume, or make the operator say they
# do not want it.
volume_exists() { docker volume inspect "$1" >/dev/null 2>&1; }

if [ "$skip_legacy" = true ]; then
  : # --start: the operator has already been told and chose to start fresh.
elif ! volume_exists "$volume" && volume_exists "$legacy_volume"; then
  if [ "$adopt_legacy" != true ]; then
    echo
    echo "Found a database from an older Specboards install."
    echo
    echo "  It lives in the Docker volume '$legacy_volume'. This version uses"
    echo "  '$volume', so starting now would bring up an EMPTY instance and"
    echo "  leave your existing accounts and specs untouched but unreachable."
    echo
    echo "  Copy the old database into the new volume?"
    echo "  Nothing is deleted either way: '$legacy_volume' is left exactly as it is."
    echo
    # Prompt on a terminal when there is one. Piped, or in CI, there is not,
    # and the safe answer is to stop and let a human choose rather than guess
    # at what happens to their database.
    reply=""
    if [ -t 0 ]; then
      read -r -p "Copy it? [y/N] " reply || reply=""
    elif { exec 3</dev/tty; } 2>/dev/null; then
      read -r -p "Copy it? [y/N] " reply <&3 || reply=""
      exec 3<&-
    fi
    case "$reply" in
      [yY] | [yY][eE][sS]) adopt_legacy=true ;;
      *)
        echo
        echo "Not copying. Start fresh with:   ./setup.sh --start"
        echo "Copy it later with:              ./setup.sh --adopt-legacy-volume"
        exit 1
        ;;
    esac
  fi

  echo "Copying '$legacy_volume' -> '$volume'…"
  # Let compose create the volume rather than `docker volume create`, so it
  # carries compose's own labels. A hand-made volume works, but compose warns
  # "already exists but was not created by Docker Compose" on every subsequent
  # up, which is an alarming thing to read in the middle of moving your
  # database. `create` only makes the container and its volume; the db service
  # is a plain image, so this pulls at worst and never builds.
  "${compose[@]}" create db >/dev/null 2>&1 || true
  if ! volume_exists "$volume"; then
    docker volume create "$volume" >/dev/null
  fi
  # cp -a inside a throwaway container: the only way to move a volume's
  # contents without knowing where the driver put them on disk. Postgres is not
  # running against either volume at this point, so the copy is consistent.
  if docker run --rm \
    -v "$legacy_volume":/from:ro \
    -v "$volume":/to \
    alpine sh -c 'cd /from && cp -a . /to'; then
    echo "  copied. '$legacy_volume' is untouched if you need to go back."
  else
    # Do not leave a half-copied volume behind to be mistaken for a database.
    docker volume rm "$volume" >/dev/null 2>&1 || true
    echo "Copy failed; nothing was changed. '$legacy_volume' is intact." >&2
    exit 1
  fi

  # Postgres bakes the superuser password into the data directory when it
  # initializes and ignores POSTGRES_PASSWORD forever after, so the copy still
  # answers to the password the old install used. If infra/.env was generated
  # fresh (a new clone adopting an old volume) those differ, and the stack comes
  # up with the database refusing every connection: "password authentication
  # failed for user postgres", which reads like the copy failed when it did not.
  #
  # Single-user mode bypasses authentication entirely, which is the supported
  # way to reset a password you no longer know. Nothing is listening on a socket
  # while this runs.
  target_password="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$env_file" | tr -d '"' | head -1)"
  if [ -n "$target_password" ]; then
    echo "  aligning the copied database's password with ${env_file}…"
    if ! printf "ALTER USER postgres PASSWORD '%s';\n" "$target_password" |
      docker run --rm -i --user postgres \
        -v "$volume":/var/lib/postgresql/data postgres:16-alpine \
        postgres --single -D /var/lib/postgresql/data postgres >/dev/null 2>&1; then
      echo "Could not reset the password on the copied database." >&2
      echo "Set POSTGRES_PASSWORD in $env_file to the value your old install used." >&2
      exit 1
    fi
  fi
elif [ "$adopt_legacy" = true ]; then
  if volume_exists "$volume"; then
    echo "'$volume' already exists; not overwriting it." >&2
    echo "Remove it first if you really mean to replace it with '$legacy_volume'." >&2
  else
    echo "No '$legacy_volume' volume found; nothing to adopt." >&2
  fi
  exit 1
fi


# --- pull (or build), migrate, start ----------------------------------------
# `up` waits on the migrate service, which waits on the database being healthy,
# so by the time this returns the schema exists.
#
# The published image is pulled by default: a self-host should be a download,
# not a Next.js build on someone else's laptop. --build compiles from the
# working tree instead, which is what anyone modifying the code wants.
if [ "$build_from_source" = true ]; then
  echo "Building from this working tree (a few minutes)…"
else
  echo "Pulling the Specboards image and starting…"
fi
# Explicit rather than inherited: a POSTGRES_PORT passed on this script's
# command line has to reach compose, and one already recorded in infra/.env is
# read from there.
export POSTGRES_PORT="$db_port"

# The commit being built, passed through as a build arg exactly as
# scripts/deploy.sh does on the Fly path. Without it NEXT_PUBLIC_GIT_SHA is
# empty and /legal's "Source code" link degrades to the repo root, which does
# not name the source actually running and so does not satisfy the AGPL
# section 13 offer. That matters most precisely here: `--build` is the path for
# someone running a MODIFIED copy, which the licence positively invites, and it
# was the one path that stopped naming its source.
#
# A source tarball with no git metadata leaves this empty, which is the
# pre-existing fallback rather than a failure. A dirty tree is marked, because
# then no commit fully describes what is running.
if [ "$build_from_source" = true ]; then
  git_sha="$(git -C "$root" rev-parse --short HEAD 2>/dev/null || true)"
  if [ -n "$git_sha" ] && ! git -C "$root" diff --quiet HEAD 2>/dev/null; then
    git_sha="${git_sha}-dirty"
  fi
  export GIT_SHA="$git_sha"
fi

if [ "$build_from_source" = true ]; then
  "${compose[@]}" up -d --build
else
  # Fall back to building rather than dying, so a network without reach to
  # ghcr.io, or a version tag that was never published, still ends with a
  # running instance instead of a registry error the operator has to decode.
  if ! "${compose[@]}" up -d --pull always; then
    echo
    echo "Could not pull the image; building from this working tree instead." >&2
    "${compose[@]}" up -d --build
  fi
fi

url="$(grep -E '^APP_URL=' "$env_file" | cut -d= -f2- | tr -d '"' || true)"
url="${url:-http://localhost:3000}"

# Wait for the app to actually answer rather than declaring victory on `up`.
echo -n "Waiting for Specboards to answer"
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://localhost:3000/" 2>/dev/null; then
    echo
    echo
    echo "Specboards is running at $url"
    echo "Open it and create your account; the first account becomes the admin."
    echo
    echo "  ./setup.sh --stop      stop, keep data"
    echo "  ./setup.sh --destroy   stop and delete the database"
    exit 0
  fi
  echo -n "."
  sleep 2
done

echo
echo "The stack started but nothing answered on :3000 within two minutes." >&2
echo "Check the logs with: docker compose -f infra/docker-compose.yml logs web" >&2
exit 1
