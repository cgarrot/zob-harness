#!/usr/bin/env bash
set -euo pipefail

TEAM_ID="agent-factory-pacman-multiplayer"
SESSION_NAME="zob-agent-factory-pacman-multiplayer"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENTRY_AGENT="agent-factory-pacman-chief"
RUNTIME_SCRIPT=".pi/zteams/agent-factory-pacman-multiplayer-runtime.mjs"

AGENTS=(
  "agent-factory-pacman-chief"
  "agent-factory-pacman-game-designer"
  "agent-factory-pacman-game-architect"
  "agent-factory-pacman-engine-builder"
  "agent-factory-pacman-frontend-builder"
  "agent-factory-pacman-qa-oracle"
)

ALIASES=(
  "pacman_chief"
  "game_designer"
  "game_architect"
  "engine_builder"
  "frontend_builder"
  "qa_oracle"
)

require_tmux() {
  command -v tmux >/dev/null 2>&1 || { echo "tmux is required for this launcher" >&2; exit 1; }
}

session_exists() {
  tmux has-session -t "$SESSION_NAME" 2>/dev/null
}

safe_window_name() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9_-' '-'
}

is_known_agent() {
  local candidate="${1:-}"
  local agent alias
  for agent in "${AGENTS[@]}"; do
    [ "$agent" = "$candidate" ] && return 0
  done
  for alias in "${ALIASES[@]}"; do
    [ "$alias" = "$candidate" ] && return 0
  done
  return 1
}

agent_for_alias() {
  local requested="${1:-$ENTRY_AGENT}"
  local i
  for i in "${!AGENTS[@]}"; do
    if [ "${AGENTS[$i]}" = "$requested" ] || [ "${ALIASES[$i]}" = "$requested" ]; then
      printf '%s' "${AGENTS[$i]}"
      return 0
    fi
  done
  echo "Unknown agent/window: $requested" >&2
  echo "Known agents:" >&2
  local agent alias
  for i in "${!AGENTS[@]}"; do
    agent="${AGENTS[$i]}"
    alias="${ALIASES[$i]}"
    printf '  %s (%s)\n' "$agent" "$alias" >&2
  done
  exit 2
}

window_exists() {
  local window="$1"
  tmux list-windows -t "$SESSION_NAME" -F '#{window_name}' 2>/dev/null | grep -Fx -- "$window" >/dev/null
}

kickoff_for_agent() {
  local agent="$1"
  if [ "$agent" = "$ENTRY_AGENT" ]; then
    local chief="${AGENT_FACTORY_PACMAN_CHIEF_KICKOFF_FILE:-}"
    [ -n "$chief" ] || { echo "missing AGENT_FACTORY_PACMAN_CHIEF_KICKOFF_FILE" >&2; exit 3; }
    [ -f "$chief" ] || { echo "chief kickoff file not found: $chief" >&2; exit 3; }
    printf '%s' "$chief"
    return 0
  fi
  local dir="${AGENT_FACTORY_PACMAN_WORKER_KICKOFF_DIR:-}"
  [ -n "$dir" ] || { echo "missing AGENT_FACTORY_PACMAN_WORKER_KICKOFF_DIR" >&2; exit 3; }
  local file="$dir/$agent-kickoff.md"
  [ -f "$file" ] || { echo "worker kickoff file not found: $file" >&2; exit 3; }
  printf '%s' "$file"
}

launch_command_for_agent() {
  local agent="$1"
  local kickoff
  kickoff="$(kickoff_for_agent "$agent")"
  printf 'ZOB_ZAGENT_ID=%q pi @%q' "$agent" "$kickoff"
}

start_detached() {
  require_tmux
  local target
  target="$(agent_for_alias "${1:-$ENTRY_AGENT}")"
  if session_exists; then
    echo "session already running: $SESSION_NAME"
    echo "Attach with: $0 attach $target"
    exit 0
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
  local target_window
  target_window="$(safe_window_name "$target")"
  tmux select-window -t "$SESSION_NAME:$target_window"
  echo "started detached session: $SESSION_NAME"
  echo "entry: $ENTRY_AGENT"
  echo "attach with: $0 attach $target"
}

prepare_run() {
  local run_id="${1:-}"
  if [ -n "$run_id" ]; then
    node "$PROJECT_DIR/$RUNTIME_SCRIPT" prepare "$run_id" "${@:2}"
  else
    node "$PROJECT_DIR/$RUNTIME_SCRIPT" prepare
  fi
}

auto_run() {
  local run_id="${1:-}"
  if [ -n "$run_id" ]; then
    node "$PROJECT_DIR/$RUNTIME_SCRIPT" auto "$run_id" "${@:2}"
  else
    node "$PROJECT_DIR/$RUNTIME_SCRIPT" auto
  fi
}

attach_to_agent() {
  require_tmux
  local target window
  target="$(agent_for_alias "${1:-$ENTRY_AGENT}")"
  window="$(safe_window_name "$target")"
  if ! session_exists; then
    echo "session not running: $SESSION_NAME" >&2
    echo "Run: npm run demo:pacman" >&2
    exit 1
  fi
  if ! window_exists "$window"; then
    echo "window not running: $SESSION_NAME:$window" >&2
    exit 1
  fi
  tmux select-window -t "$SESSION_NAME:$window"
  tmux attach -t "$SESSION_NAME:$window"
}

ensure_agent() {
  require_tmux
  local target window launch_command
  target="$(agent_for_alias "${1:-$ENTRY_AGENT}")"
  window="$(safe_window_name "$target")"
  if ! session_exists; then
    echo "session not running: $SESSION_NAME" >&2
    echo "Run: npm run demo:pacman" >&2
    exit 1
  fi
  if window_exists "$window"; then
    echo "window already running: $SESSION_NAME:$window"
    return 0
  fi
  tmux new-window -t "$SESSION_NAME" -n "$window" -c "$PROJECT_DIR"
  launch_command="$(launch_command_for_agent "$target")"
  tmux send-keys -t "$SESSION_NAME:$window" "$launch_command" C-m
  echo "started window: $SESSION_NAME:$window"
}

list_agents() {
  printf 'team: %s\n' "$TEAM_ID"
  printf 'session: %s\n' "$SESSION_NAME"
  printf 'project: %s\n' "$PROJECT_DIR"
  printf 'entry: %s\n' "$ENTRY_AGENT"
  printf 'agents:\n'
  local i
  for i in "${!AGENTS[@]}"; do
    printf '  %s (%s)\n' "${AGENTS[$i]}" "${ALIASES[$i]}"
  done
}

status_session() {
  require_tmux
  if session_exists; then
    tmux list-windows -t "$SESSION_NAME"
  else
    echo "session not running: $SESSION_NAME"
  fi
}

send_new_to_agents() {
  require_tmux
  if ! session_exists; then
    echo "session not running: $SESSION_NAME" >&2
    exit 1
  fi
  local agent window missing=0
  for agent in "${AGENTS[@]}"; do
    window="$(safe_window_name "$agent")"
    if ! window_exists "$window"; then
      echo "missing agent window: $SESSION_NAME:$window" >&2
      missing=1
    fi
  done
  if [ "$missing" -ne 0 ]; then
    echo "new aborted: one or more team agent windows are missing" >&2
    exit 1
  fi
  for agent in "${AGENTS[@]}"; do
    window="$(safe_window_name "$agent")"
    tmux send-keys -t "$SESSION_NAME:$window" C-u "/new" C-m
    echo "sent /new: $SESSION_NAME:$window"
  done
}

close_session() {
  require_tmux
  if session_exists; then
    tmux kill-session -t "$SESSION_NAME"
    echo "closed session: $SESSION_NAME"
  else
    echo "session not running: $SESSION_NAME"
  fi
}

usage() {
  cat <<USAGE
Usage: ./.pi/zteams/agent-factory-pacman-multiplayer.tmux.sh COMMAND [agent|run_id]

Commands:
  auto [run_id]          prepare run artifacts and start the tmux team detached
  prepare [run_id]       prepare run artifacts only; no tmux/Pi launch, no game generation
  list                   list team agents without launching
  status                 list this tmux session's windows if running
  start-detached [agent] create all windows detached; requires rendered kickoff file env vars
  attach [agent]         attach entry or named agent in an existing session
  window <agent>         alias for attach <agent>
  ensure <agent>         add/start one known agent window in the existing session
  close                  close only this demo tmux session
  new                    send Pi /new to every existing team agent window without closing tmux
  help                   show this message

Full auto may launch multiple Pi sessions and consume model/API budget.
USAGE
}

case "${1:-help}" in
  auto) shift; auto_run "$@" ;;
  prepare) shift; prepare_run "$@" ;;
  list) list_agents ;;
  status) status_session ;;
  start-detached) start_detached "${2:-$ENTRY_AGENT}" ;;
  attach) attach_to_agent "${2:-$ENTRY_AGENT}" ;;
  window)
    [ $# -ge 2 ] || { echo "window requires an agent" >&2; exit 2; }
    attach_to_agent "$2"
    ;;
  ensure)
    [ $# -ge 2 ] || { echo "ensure requires an agent" >&2; exit 2; }
    ensure_agent "$2"
    ;;
  close) close_session ;;
  new) send_new_to_agents ;;
  help|-h|--help) usage ;;
  *) usage; exit 2 ;;
esac
