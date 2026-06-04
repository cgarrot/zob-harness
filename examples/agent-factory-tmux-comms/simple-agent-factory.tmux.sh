#!/usr/bin/env bash
set -euo pipefail

TEAM_ID="simple-agent-factory"
SESSION_NAME="zob-simple-agent-factory"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENTRY_AGENT="factory-chief"
PI_BIN="${PI_BIN:-pi}"
AGENTS=(
  "factory-chief"
  "context-scout"
  "builder"
  "oracle"
)

require_tmux() {
  command -v tmux >/dev/null 2>&1 || { echo "tmux is required" >&2; exit 1; }
}

session_exists() {
  tmux has-session -t "$SESSION_NAME" 2>/dev/null
}

window_exists() {
  local window="$1"
  tmux list-windows -t "$SESSION_NAME" -F '#{window_name}' 2>/dev/null | grep -Fx -- "$window" >/dev/null
}

safe_window_name() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9_-' '-'
}

is_known_agent() {
  local candidate="${1:-}"
  local agent
  for agent in "${AGENTS[@]}"; do
    if [ "$agent" = "$candidate" ]; then return 0; fi
  done
  return 1
}

resolve_target_agent() {
  local requested="${1:-$ENTRY_AGENT}"
  if ! is_known_agent "$requested"; then
    echo "Unknown agent/window: $requested" >&2
    echo "Known agents:" >&2
    printf '  %s\n' "${AGENTS[@]}" >&2
    exit 2
  fi
  printf '%s' "$requested"
}

resolve_chief_kickoff_file() {
  local candidate="${AGENT_FACTORY_CHIEF_KICKOFF_FILE:-}"
  [ -n "$candidate" ] || return 1
  if [ ! -f "$candidate" ]; then
    echo "chief kickoff file not found: $candidate" >&2
    exit 2
  fi
  printf '%s' "$candidate"
}

resolve_worker_kickoff_file() {
  local agent="$1"
  local dir="${AGENT_FACTORY_WORKER_KICKOFF_DIR:-}"
  [ -n "$dir" ] || return 1
  local candidate="$dir/$agent-kickoff.md"
  if [ ! -f "$candidate" ]; then
    echo "worker kickoff file not found for $agent: $candidate" >&2
    exit 2
  fi
  printf '%s' "$candidate"
}

launch_command_for_agent() {
  local agent="$1"
  local run_id="${AGENT_FACTORY_RUN_ID:-}"
  local kickoff_file=""

  if [ "$agent" = "$ENTRY_AGENT" ] && kickoff_file="$(resolve_chief_kickoff_file)"; then
    if [ -n "$run_id" ]; then
      printf 'cd %q && AGENT_FACTORY_RUN_ID=%q ZOB_ZAGENT_ID=%q %q %q' "$PROJECT_DIR" "$run_id" "$agent" "$PI_BIN" "@$kickoff_file"
    else
      printf 'cd %q && ZOB_ZAGENT_ID=%q %q %q' "$PROJECT_DIR" "$agent" "$PI_BIN" "@$kickoff_file"
    fi
    return
  fi

  if [ "$agent" != "$ENTRY_AGENT" ] && kickoff_file="$(resolve_worker_kickoff_file "$agent")"; then
    if [ -n "$run_id" ]; then
      printf 'cd %q && AGENT_FACTORY_RUN_ID=%q ZOB_ZAGENT_ID=%q %q %q' "$PROJECT_DIR" "$run_id" "$agent" "$PI_BIN" "@$kickoff_file"
    else
      printf 'cd %q && ZOB_ZAGENT_ID=%q %q %q' "$PROJECT_DIR" "$agent" "$PI_BIN" "@$kickoff_file"
    fi
    return
  fi

  if [ -n "$run_id" ]; then
    printf 'cd %q && AGENT_FACTORY_RUN_ID=%q ZOB_ZAGENT_ID=%q %q' "$PROJECT_DIR" "$run_id" "$agent" "$PI_BIN"
  else
    printf 'cd %q && ZOB_ZAGENT_ID=%q %q' "$PROJECT_DIR" "$agent" "$PI_BIN"
  fi
}

start_detached_session() {
  require_tmux
  local target
  target="$(resolve_target_agent "${1:-$ENTRY_AGENT}")"
  local target_window
  target_window="$(safe_window_name "$target")"

  if session_exists; then
    echo "session already running: $SESSION_NAME"
    echo "Attach with: $0 attach $target"
    return 0
  fi

  local first="${AGENTS[0]}"
  local first_window
  first_window="$(safe_window_name "$first")"
  tmux new-session -d -s "$SESSION_NAME" -n "$first_window" -c "$PROJECT_DIR"

  local i agent window launch_command
  for i in "${!AGENTS[@]}"; do
    agent="${AGENTS[$i]}"
    window="$(safe_window_name "$agent")"
    if [ "$i" -ne 0 ]; then
      tmux new-window -t "$SESSION_NAME" -n "$window" -c "$PROJECT_DIR"
    fi
    launch_command="$(launch_command_for_agent "$agent")"
    tmux send-keys -t "$SESSION_NAME:$window" "$launch_command" C-m
  done

  tmux select-window -t "$SESSION_NAME:$target_window"
  echo "started detached session: $SESSION_NAME"
  echo "entry agent: $ENTRY_AGENT"
  if [ -n "${AGENT_FACTORY_RUN_ID:-}" ]; then echo "run id: $AGENT_FACTORY_RUN_ID"; fi
  if [ -n "${AGENT_FACTORY_CHIEF_KICKOFF_FILE:-}" ]; then echo "chief kickoff file: $AGENT_FACTORY_CHIEF_KICKOFF_FILE"; fi
  if [ -n "${AGENT_FACTORY_WORKER_KICKOFF_DIR:-}" ]; then echo "worker kickoff dir: $AGENT_FACTORY_WORKER_KICKOFF_DIR"; fi
  echo "attach with: $0 attach $target"
}

attach_to_agent() {
  require_tmux
  local target
  target="$(resolve_target_agent "${1:-$ENTRY_AGENT}")"
  local window
  window="$(safe_window_name "$target")"
  if ! session_exists; then
    echo "session not running: $SESSION_NAME" >&2
    echo "Run: $0 start $target" >&2
    exit 1
  fi
  tmux select-window -t "$SESSION_NAME:$window"
  tmux attach -t "$SESSION_NAME:$window"
}

ensure_agent_window() {
  require_tmux
  local target
  target="$(resolve_target_agent "${1:-}")"
  local window
  window="$(safe_window_name "$target")"
  if ! session_exists; then
    echo "session not running: $SESSION_NAME" >&2
    echo "Run: $0 start-detached $target" >&2
    exit 1
  fi
  if window_exists "$window"; then
    echo "window already running: $SESSION_NAME:$window"
    return 0
  fi
  local launch_command
  launch_command="$(launch_command_for_agent "$target")"
  tmux new-window -t "$SESSION_NAME" -n "$window" -c "$PROJECT_DIR"
  tmux send-keys -t "$SESSION_NAME:$window" "$launch_command" C-m
  echo "started window: $SESSION_NAME:$window"
}

list_agents() {
  printf 'team: %s\n' "$TEAM_ID"
  printf 'session: %s\n' "$SESSION_NAME"
  printf 'project: %s\n' "$PROJECT_DIR"
  printf 'entry: %s\n' "$ENTRY_AGENT"
  printf 'agents:\n'
  printf '  %s\n' "${AGENTS[@]}"
}

status_session() {
  require_tmux
  if session_exists; then
    tmux list-windows -t "$SESSION_NAME"
  else
    echo "session not running: $SESSION_NAME"
  fi
}

close_session() {
  require_tmux
  if session_exists; then
    tmux kill-session -t "$SESSION_NAME"
  else
    echo "session not running: $SESSION_NAME"
  fi
}

usage() {
  cat <<'USAGE'
Usage: bash examples/agent-factory-tmux-comms/simple-agent-factory.tmux.sh COMMAND [agent]

Commands:
  list                   list entry agent and available windows without launching Pi
  status                 list tmux windows if the example session is running
  start [agent]          create all windows if absent, then attach entry or named agent
  start-detached [agent] create all windows without attaching
  attach [agent]         attach entry agent or named agent in an existing session
  window <agent>         alias for attach <agent>
  ensure <agent>         add/start one known agent window in the existing session
  close                  close only this example tmux session
  help                   show this message

Optional startup file environment:
  AGENT_FACTORY_RUN_ID=<run_id>
  AGENT_FACTORY_CHIEF_KICKOFF_FILE=reports/agent-factory-runs/<run_id>/chief-kickoff.md
  AGENT_FACTORY_WORKER_KICKOFF_DIR=reports/agent-factory-runs/<run_id>/worker-kickoffs

Default is help. Nothing launches unless start/start-detached/ensure is requested.
USAGE
}

case "${1:-help}" in
  list) list_agents ;;
  status) status_session ;;
  start) start_detached_session "${2:-$ENTRY_AGENT}"; attach_to_agent "${2:-$ENTRY_AGENT}" ;;
  start-detached) start_detached_session "${2:-$ENTRY_AGENT}" ;;
  attach) attach_to_agent "${2:-$ENTRY_AGENT}" ;;
  window)
    if [ "${2:-}" = "" ]; then echo "window requires an agent id" >&2; usage >&2; exit 2; fi
    attach_to_agent "$2"
    ;;
  ensure)
    if [ "${2:-}" = "" ]; then echo "ensure requires an agent id" >&2; usage >&2; exit 2; fi
    ensure_agent_window "$2"
    ;;
  close) close_session ;;
  help|-h|--help) usage ;;
  *) echo "Unknown command: ${1:-}" >&2; usage >&2; exit 2 ;;
esac
