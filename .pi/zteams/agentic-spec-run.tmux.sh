#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/Users/cgarrot/zob/zob-harness"
ENTRY_AGENT="spec-chief"
PI_BIN="/Users/cgarrot/.nvm/versions/node/v24.14.0/bin/pi"
AGENTS=(
  "spec-chief"
  "source-intake-steward"
  "data-profile-analyst"
  "domain-modeler"
  "ux-flow-analyst"
  "spec-writer"
  "bdd-writer"
  "planner-handoff-writer"
  "spec-oracle"
)

require_tmux() {
  command -v tmux >/dev/null 2>&1 || { echo "tmux is required" >&2; exit 1; }
}

safe_token() {
  printf '%s' "${1:-}" | tr -c 'A-Za-z0-9_-' '-' | sed 's/^-*//; s/-*$//; s/--*/-/g' | cut -c1-120
}

session_name() {
  local run_id="$(safe_token "${1:-}")"
  [ -n "$run_id" ] || { echo "missing run_id" >&2; exit 2; }
  printf 'agentic-spec-run-%s' "$run_id"
}

is_known_agent() {
  local candidate="${1:-}"
  local agent
  for agent in "${AGENTS[@]}"; do
    [ "$agent" = "$candidate" ] && return 0
  done
  return 1
}

resolve_agent() {
  local requested="${1:-$ENTRY_AGENT}"
  if ! is_known_agent "$requested"; then
    echo "Unknown run agent/window: $requested" >&2
    printf 'Known agents:\n' >&2
    printf '  %s\n' "${AGENTS[@]}" >&2
    exit 2
  fi
  printf '%s' "$requested"
}

session_exists() {
  local session="$1"
  tmux has-session -t "$session" 2>/dev/null
}

start_detached() {
  require_tmux
  local run_id="$(safe_token "${1:-}")"
  local session="$(session_name "$run_id")"
  cd "$PROJECT_DIR"

  if session_exists "$session"; then
    echo "session already running: $session"
    return 0
  fi

  local first="${AGENTS[0]}"
  tmux new-session -d -s "$session" -n "$first" -c "$PROJECT_DIR"
  tmux send-keys -t "$session:$first" "cd '$PROJECT_DIR' && unset npm_config_prefix && AGENTIC_SPEC_RUN_ID='$run_id' ZOB_ZAGENT_ID=$first '$PI_BIN'" C-m

  local agent
  for agent in "${AGENTS[@]:1}"; do
    tmux new-window -t "$session" -n "$agent" -c "$PROJECT_DIR"
    tmux send-keys -t "$session:$agent" "cd '$PROJECT_DIR' && unset npm_config_prefix && AGENTIC_SPEC_RUN_ID='$run_id' ZOB_ZAGENT_ID=$agent '$PI_BIN'" C-m
  done

  tmux select-window -t "$session:$ENTRY_AGENT"
  echo "session started detached: $session"
}

attach() {
  require_tmux
  local run_id="$(safe_token "${1:-}")"
  local session="$(session_name "$run_id")"
  local agent="$(resolve_agent "${2:-$ENTRY_AGENT}")"
  if ! session_exists "$session"; then
    echo "session not running: $session" >&2
    echo "Run: $0 start-detached $run_id" >&2
    exit 1
  fi
  tmux select-window -t "$session:$agent"
  tmux attach -t "$session:$agent"
}

status() {
  require_tmux
  local run_id="$(safe_token "${1:-}")"
  local session="$(session_name "$run_id")"
  if session_exists "$session"; then
    tmux list-windows -t "$session" -F '#{window_index}: #{window_name} #{pane_current_command} active=#{window_active} panes=#{window_panes}'
  else
    echo "session not running: $session"
  fi
}

close() {
  require_tmux
  local run_id="$(safe_token "${1:-}")"
  local session="$(session_name "$run_id")"
  if session_exists "$session"; then
    tmux kill-session -t "$session"
    echo "session closed: $session"
  else
    echo "session not running: $session"
  fi
}

list_agents() {
  printf 'entry: %s\n' "$ENTRY_AGENT"
  printf 'agents:\n'
  printf '  %s\n' "${AGENTS[@]}"
}

case "${1:-}" in
  start|start-detached) start_detached "${2:-}" ;;
  attach|window) attach "${2:-}" "${3:-$ENTRY_AGENT}" ;;
  status) status "${2:-}" ;;
  close) close "${2:-}" ;;
  list) list_agents ;;
  session-name) session_name "${2:-}" ;;
  *) echo "Usage: $0 start-detached <run_id>|status <run_id>|attach <run_id> [agent]|close <run_id>|list|session-name <run_id>" >&2; exit 2 ;;
esac
