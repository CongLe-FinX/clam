#!/usr/bin/env bash
# Two isolated CL Agent Mesh nodes (node-a, node-b) in Docker, each with its own Cloudflare quick tunnel.
# See deploy/docker/README.md. Needs: docker (compose v2), curl, jq on the host.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE=(docker compose -f "$HERE/compose.yml")
UI_PORT=4317
DOMAIN_SUFFIX=".trycloudflare.com"

die() { echo "clam-nodes: $*" >&2; exit 1; }
info() { echo "==> $*" >&2; }
need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required on the host but was not found in PATH"; }

usage() {
	cat >&2 <<'EOF'
usage: clam-nodes.sh <command> [args]

  build                          build the clam-node:dev image (repo root as context)
  up                             create + start node-a and node-b, wait until healthy
  creds                          stream OMP + gh credentials from the host into both nodes, then import the gh login into CLAM
  init <node> <name>             set node name + owner password (read from STDIN), enable remote UI, start the quick
                                 tunnel, wait until its URL resolves publicly, print it.   e.g.  printf '%s' "$PW" | clam-nodes.sh init a "Alice's node"
  url <node>                     print the node's current public URL
  status                         container, tunnel and peer overview of both nodes
  logs <node> [docker-logs-args] container logs (default: last 200 lines; add -f to follow)
  stop <node>                    stop the container (simulates the machine going off; volume + credentials are kept)
  start <node>                   start it again (waits for the tunnel; the quick-tunnel URL CHANGES)
  exec <node> -- <cmd...>        run a command in the node (as user clam, HOME=/home/clam)
  down                           remove both containers AND their volumes (deletes every credential)

<node> is a, b, node-a, node-b or clam-node-a / clam-node-b.
EOF
	exit 2
}

container_of() {
	case "${1:-}" in
		a | node-a | clam-node-a) echo clam-node-a ;;
		b | node-b | clam-node-b) echo clam-node-b ;;
		"") die "missing <node> (a or b)" ;;
		*) die "unknown node '$1' (expected a, b, node-a or node-b)" ;;
	esac
}

# Container exists / is running / is healthy.
exists() { docker inspect "$1" >/dev/null 2>&1; }
running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || true)" = "true" ]; }
require_running() {
	exists "$1" || die "$1 does not exist; run: clam-nodes.sh up"
	running "$1" || die "$1 is not running; run: clam-nodes.sh start ${1#clam-node-}"
}

wait_healthy() { # container [timeout_s]
	local c="$1" limit="${2:-120}" waited=0 status
	while :; do
		status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c" 2>/dev/null || echo missing)"
		[ "$status" = "healthy" ] && return 0
		running "$c" || die "$c is not running (status: $status); see: clam-nodes.sh logs ${c#clam-node-}"
		[ "$waited" -ge "$limit" ] && die "$c did not become healthy within ${limit}s (status: $status); see: clam-nodes.sh logs ${c#clam-node-}"
		sleep 2
		waited=$((waited + 2))
	done
}

# Loopback-only admin call inside the container: api <container> <METHOD> <path> [<json body on stdin>]
# Prints the response body; exits non-zero (with the body on stderr) on HTTP >= 400.
api() {
	local c="$1" method="$2" path="$3" out code
	local args=(-sS -X "$method" -H 'Accept: application/json' -w '\n%{http_code}')
	if [ ! -t 0 ] && [ "${API_NO_BODY:-0}" != "1" ]; then
		args+=(-H 'Content-Type: application/json' --data-binary @-)
	fi
	out="$(docker exec -i "$c" curl "${args[@]}" "http://127.0.0.1:${UI_PORT}${path}")" || die "request $method $path to $c failed (curl error)"
	code="${out##*$'\n'}"
	out="${out%$'\n'*}"
	if [ "$code" -ge 400 ] 2>/dev/null; then
		echo "clam-nodes: $method $path on $c -> HTTP $code: $out" >&2
		return 1
	fi
	printf '%s' "$out"
}
api_get() { API_NO_BODY=1 api "$1" GET "$2" </dev/null; }
api_post_empty() { API_NO_BODY=1 api "$1" POST "$2" </dev/null; }

tunnel_url() { api_get "$1" /api/local/tunnel | jq -r '.publicUrl // empty'; }

# DNS over HTTPS: does the name exist in public DNS yet? (A quick tunnel's hostname lags behind its announcement.)
public_dns_has() {
	curl -fsS --max-time 8 -H 'accept: application/dns-json' "https://cloudflare-dns.com/dns-query?name=$1&type=A" 2>/dev/null |
		jq -e '(.Answer // []) | map(select(.type == 1)) | length > 0' >/dev/null 2>&1
}

# Wait for the tunnel of <container> to be running with a publicUrl, then for that hostname to resolve publicly
# (DoH) and for the node to answer through it from THIS host. Prints the URL on stdout.
wait_public_url() { # container [timeout_s]
	local c="$1" limit="${2:-300}" waited=0 state url="" host last=""
	info "waiting for $c's tunnel ..."
	while :; do
		state="$(api_get "$c" /api/local/tunnel 2>/dev/null || true)"
		url="$(jq -r 'select(.state == "running") | .publicUrl // empty' <<<"$state" 2>/dev/null || true)"
		[ -n "$url" ] && break
		if [ "$waited" -ge "$limit" ]; then
			die "$c: no tunnel URL after ${limit}s (state: $(jq -r '.state + " " + (.lastError // "")' <<<"${state:-{\}}" 2>/dev/null || echo unknown)); see: clam-nodes.sh logs ${c#clam-node-}"
		fi
		sleep 3
		waited=$((waited + 3))
	done
	host="${url#https://}"
	host="${host%%/*}"
	[[ "$host" == *"$DOMAIN_SUFFIX" ]] || die "$c: unexpected tunnel URL '$url' (expected *$DOMAIN_SUFFIX)"
	info "$c tunnel: $url — waiting for $host to resolve publicly ..."
	while :; do
		if public_dns_has "$host"; then break; fi
		[ "$waited" -ge "$limit" ] && die "$c: $host does not resolve publicly after ${limit}s"
		sleep 3
		waited=$((waited + 3))
	done
	info "resolves; waiting until the node answers through the tunnel from this host ..."
	while :; do
		if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$url/api/v1/node/info" 2>/dev/null || true)" = "200" ]; then
			break
		fi
		[ "$waited" -ge "$limit" ] && die "$c: $url/api/v1/node/info does not answer 200 from this host after ${limit}s"
		sleep 3
		waited=$((waited + 3))
	done
	echo "$url"
}

cmd_build() {
	need docker
	info "building clam-node:dev (context: repo root)"
	"${COMPOSE[@]}" build node-a
}

cmd_up() {
	need docker
	exists_image=$(docker image inspect clam-node:dev >/dev/null 2>&1 && echo yes || echo no)
	[ "$exists_image" = yes ] || die "image clam-node:dev not found; run: clam-nodes.sh build"
	"${COMPOSE[@]}" up -d --no-build
	wait_healthy clam-node-a
	wait_healthy clam-node-b
	info "both nodes are up (no published ports; next: creds, then init a / init b)"
}

cmd_creds() {
	need docker
	need omp
	need gh
	local c
	for c in clam-node-a clam-node-b; do
		require_running "$c"
		info "$c: importing OMP credentials (streamed, nothing written to disk)"
		omp auth export | docker exec -i "$c" omp auth import - >/dev/null || die "$c: 'omp auth export | omp auth import -' failed"
		info "$c: importing the gh login (streamed)"
		gh auth token | docker exec -i "$c" gh auth login --with-token || die "$c: 'gh auth login --with-token' failed"
		info "$c: importing the gh login into CLAM"
		api_post_empty "$c" /api/local/github/import-gh | jq -r '"    github account: " + (.login // .username // .id // "imported")' >&2 || die "$c: CLAM import-gh failed"
	done
	info "credentials imported into both volumes (removed again by: clam-nodes.sh down)"
}

cmd_init() {
	need docker
	need jq
	need curl
	local c name password url
	c="$(container_of "${1:-}")"
	name="${2:-}"
	[ -n "$name" ] || die "usage: printf '%s' \"\$PASSWORD\" | clam-nodes.sh init <node> <name>"
	[ -t 0 ] && die "the owner password is read from STDIN (it must not appear in the command line): printf '%s' \"\$PASSWORD\" | clam-nodes.sh init ${1} \"$name\""
	IFS= read -r password || [ -n "$password" ] || die "no password on STDIN"
	[ "${#password}" -ge 12 ] || die "the owner password must have at least 12 characters"
	require_running "$c"
	wait_healthy "$c" 60

	info "$c: node name -> $name"
	jq -n --arg n "$name" '{nodeName: $n}' | api "$c" PATCH /api/local/settings >/dev/null
	info "$c: owner password (this ends every existing remote session)"
	jq -n --arg p "$password" '{password: $p}' | api "$c" PUT /api/local/access/password >/dev/null
	info "$c: remote UI on"
	echo '{"remoteUiEnabled":true}' | api "$c" PATCH /api/local/access >/dev/null
	info "$c: quick tunnel (autoStart) + start"
	echo '{"mode":"quick","autoStart":true}' | api "$c" PUT /api/local/tunnel/config >/dev/null
	api_post_empty "$c" /api/local/tunnel/start >/dev/null
	url="$(wait_public_url "$c")"
	echo "$url"
}

cmd_url() {
	need docker
	need jq
	local c url
	c="$(container_of "${1:-}")"
	require_running "$c"
	url="$(tunnel_url "$c")"
	[ -n "$url" ] || die "$c has no tunnel URL yet; run: clam-nodes.sh init ${1} <name>"
	echo "$url"
}

cmd_status() {
	need docker
	need jq
	local c state health info tunnel peers
	for c in clam-node-a clam-node-b; do
		if ! exists "$c"; then
			echo "$c: (not created)"
			continue
		fi
		state="$(docker inspect -f '{{.State.Status}}' "$c")"
		health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}' "$c")"
		echo "$c: container=$state health=$health"
		if [ "$state" = running ]; then
			if info="$(api_get "$c" /api/local/node 2>/dev/null)"; then
				jq -r '"    node:    \(.name) (\(.id))\n    fingerprint: \(.fingerprint)"' <<<"$info"
			else
				echo "    node:    (server not answering)"
				continue
			fi
			tunnel="$(api_get "$c" /api/local/tunnel 2>/dev/null || true)"
			jq -r '"    tunnel:  \(.state) \(.publicUrl // "-") (mode \(.config.mode), connections \(.connections))"' <<<"${tunnel:-null}" 2>/dev/null || true
			peers="$(api_get "$c" /api/local/network/peers 2>/dev/null || true)"
			jq -r 'if length == 0 then "    peers:   none" else .[] | "    peer:    \(.name) \(.status // "?") \(.url // "")" end' <<<"${peers:-[]}" 2>/dev/null || true
		fi
	done
}

cmd_logs() {
	need docker
	local c
	c="$(container_of "${1:-}")"
	shift || true
	exists "$c" || die "$c does not exist; run: clam-nodes.sh up"
	if [ "$#" -eq 0 ]; then set -- --tail 200; fi
	docker logs "$@" "$c"
}

cmd_stop() {
	need docker
	local c
	c="$(container_of "${1:-}")"
	exists "$c" || die "$c does not exist; run: clam-nodes.sh up"
	if running "$c"; then
		docker stop "$c" >/dev/null
		info "$c stopped (its volume is kept; 'unless-stopped' keeps it down until you run: clam-nodes.sh start ${c#clam-node-})"
	else
		info "$c is already stopped"
	fi
}

cmd_start() {
	need docker
	need jq
	local c url
	c="$(container_of "${1:-}")"
	exists "$c" || die "$c does not exist; run: clam-nodes.sh up"
	if running "$c"; then info "$c is already running"; else docker start "$c" >/dev/null; fi
	wait_healthy "$c"
	url="$(wait_public_url "$c")"
	info "$c public URL (quick tunnels get a NEW URL after every restart):"
	echo "$url"
}

cmd_exec() {
	need docker
	local c flags=(-i)
	c="$(container_of "${1:-}")"
	shift || true
	[ "${1:-}" = "--" ] && shift
	[ "$#" -gt 0 ] || die "usage: clam-nodes.sh exec <node> -- <cmd...>"
	require_running "$c"
	[ -t 0 ] && [ -t 1 ] && flags+=(-t)
	exec docker exec "${flags[@]}" "$c" "$@"
}

cmd_down() {
	need docker
	"${COMPOSE[@]}" down -v --remove-orphans
	local v
	for v in clam-node-a-home clam-node-b-home; do
		docker volume inspect "$v" >/dev/null 2>&1 && docker volume rm "$v" >/dev/null
	done
	info "containers and volumes removed (every imported credential is gone). The image clam-node:dev is kept."
}

cmd="${1:-}"
[ -n "$cmd" ] || usage
shift
case "$cmd" in
	build) cmd_build "$@" ;;
	up) cmd_up "$@" ;;
	creds) cmd_creds "$@" ;;
	init) cmd_init "$@" ;;
	url) cmd_url "$@" ;;
	status) cmd_status "$@" ;;
	logs) cmd_logs "$@" ;;
	stop) cmd_stop "$@" ;;
	start) cmd_start "$@" ;;
	exec) cmd_exec "$@" ;;
	down) cmd_down "$@" ;;
	-h | --help | help) usage ;;
	*) echo "clam-nodes: unknown command '$cmd'" >&2; usage ;;
esac
