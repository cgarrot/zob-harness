#!/usr/bin/env bash
set -euo pipefail

TEAM_ID="zob-harness-devs"
BUNDLE_ID="${ZOB_ZTEAM_BUNDLE_ID:-zob-harness-devs}"
LAUNCH_ID="${ZOB_ZTEAM_LAUNCH_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
SESSION_NAME="zob-harness-devs"
PROJECT_DIR="/Users/cgarrot/zob/zob-harness"
ENTRY_AGENT="harness-chief"
PI_BIN="${PI_BIN:-pi}"
AGENTS=(
  "harness-chief"
  "harness-architect"
  "harness-implementer"
  "harness-coms-steward"
  "harness-factory-engineer"
  "harness-oracle"
)

require_tmux() {
  command -v tmux >/dev/null 2>&1 || { echo "tmux is required" >&2; exit 1; }
}

require_project_dir() {
  if [ ! -d "$PROJECT_DIR" ]; then
    echo "Project directory not found: $PROJECT_DIR" >&2
    exit 1
  fi
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

profile_id_for_agent() {
  local agent="$1"
  printf 'zteam-%s-%s' "$(safe_window_name "$BUNDLE_ID")" "$(safe_window_name "$agent")"
}

launch_command_for_agent() {
  local agent="$1"
  local profile_id
  profile_id="$(profile_id_for_agent "$agent")"
  printf 'cd %q && ZOB_ZTEAM_ID=%q ZOB_ZTEAM_BUNDLE_ID=%q ZOB_ZTEAM_LAUNCH_ID=%q ZOB_ZPEER_PROFILE_ID=%q ZOB_ZAGENT_ID=%q %q' "$PROJECT_DIR" "$TEAM_ID" "$BUNDLE_ID" "$LAUNCH_ID" "$profile_id" "$agent" "$PI_BIN"
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

start_detached_session() {
  require_tmux
  require_project_dir
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
  echo "session started detached: $SESSION_NAME"
  echo "team: $TEAM_ID"
  echo "bundle: $BUNDLE_ID"
  echo "launch: $LAUNCH_ID"
  echo "entry agent: $ENTRY_AGENT"
  echo "attach with: $0 attach $target"
}

start_session() {
  local target
  target="$(resolve_target_agent "${1:-$ENTRY_AGENT}")"
  if session_exists; then
    attach_to_agent "$target"
    exit 0
  fi
  start_detached_session "$target"
  attach_to_agent "$target"
}

status_session() {
  require_tmux
  if session_exists; then
    tmux list-windows -t "$SESSION_NAME" -F '#{window_index}: #{window_name} #{pane_current_command} active=#{window_active} panes=#{window_panes}'
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

list_agents() {
  printf 'team: %s\n' "$TEAM_ID"
  printf 'bundle: %s\n' "$BUNDLE_ID"
  printf 'launch: %s\n' "$LAUNCH_ID"
  printf 'session: %s\n' "$SESSION_NAME"
  printf 'project: %s\n' "$PROJECT_DIR"
  printf 'entry: %s\n' "$ENTRY_AGENT"
  printf 'agents:\n'
  printf '  %s\n' "${AGENTS[@]}"
}

close_session() {
  require_tmux
  if session_exists; then
    tmux kill-session -t "$SESSION_NAME"
    echo "session closed: $SESSION_NAME"
    echo "presence lifecycle: runtime releases matching stable team-agent leases on graceful shutdown; relaunch reclaims only nonresponsive scoped leases after ping; /zteam reset sends Pi /new without closing tmux"
  else
    echo "session not running: $SESSION_NAME"
  fi
}

usage() {
  cat <<'USAGE'
Usage: ./.pi/zteams/zob-harness-devs.tmux.sh [COMMAND] [agent]

Commands:
  start [agent]           create the tmux session if absent, then attach entry agent or named agent
  start-detached [agent]  create all windows detached without attaching
  attach [agent]          attach entry agent or named agent in an existing session
  window <agent>          alias for attach <agent>
  list                    list entry agent and available agent windows
  status                  list windows for this team session
  close                   close only this team tmux session; lease cleanup is runtime-owned/ping-gated
  new                     send Pi /new to every existing team agent window without closing tmux

Manual launch:
  /zteam launch-plan zob-harness-devs
  ./.pi/zteams/zob-harness-devs.tmux.sh start
  # each pane gets ZOB_ZTEAM_ID, ZOB_ZTEAM_BUNDLE_ID, ZOB_ZTEAM_LAUNCH_ID,
  # stable per-agent ZOB_ZPEER_PROFILE_ID, and ZOB_ZAGENT_ID
USAGE
}

case "${1:-start}" in
  start) start_session "${2:-$ENTRY_AGENT}" ;;
  start-detached) start_detached_session "${2:-$ENTRY_AGENT}" ;;
  attach) attach_to_agent "${2:-$ENTRY_AGENT}" ;;
  window)
    if [ "${2:-}" = "" ]; then
      echo "window requires an agent id" >&2
      usage >&2
      exit 2
    fi
    attach_to_agent "$2"
    ;;
  list) list_agents ;;
  status) status_session ;;
  close) close_session ;;
  new) send_new_to_agents ;;
  -h|--help|help) usage ;;
  *) echo "Unknown command: ${1:-}" >&2; usage >&2; exit 2 ;;
esac
