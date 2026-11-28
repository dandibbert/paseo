if [[ -n "${_PASEO_ZSH_INTEGRATION_LOADED-}" ]]; then
  return
fi
typeset -g _PASEO_ZSH_INTEGRATION_LOADED=1

autoload -Uz add-zsh-hook add-zle-hook-widget

typeset -g _PASEO_ZSH_COMMAND_ACTIVE=0
typeset -g _PASEO_ZSH_LINE_INIT_HOOKED=0

function _paseo_osc633() {
  printf '\e]633;%s\a' "$1"
}

function _paseo_precmd() {
  local command_status=$?
  if [[ "$_PASEO_ZSH_COMMAND_ACTIVE" == "1" ]]; then
    _paseo_osc633 "D;${command_status}"
    _PASEO_ZSH_COMMAND_ACTIVE=0
  fi
  printf '\e]2;%s\a' "${PWD/#$HOME/~}"
  _paseo_osc633 "A"
  # This file loads from .zshenv, which also runs for non-interactive shells, and zsh loads
  # the line editor module lazily, so add-zle-hook-widget fails before it is loaded.
  # precmd only runs before an interactive prompt, so load it here and register once.
  if [[ "$_PASEO_ZSH_LINE_INIT_HOOKED" == "0" ]]; then
    _PASEO_ZSH_LINE_INIT_HOOKED=1
    zmodload zsh/zle 2>/dev/null && add-zle-hook-widget line-init _paseo_line_init
  fi
}

# B marks where the command line starts: the line editor begins reading right after the
# prompt, so clients can tell the editable input from the prompt and the output above it.
function _paseo_line_init() {
  _paseo_osc633 "B"
}

function _paseo_preexec() {
  _PASEO_ZSH_COMMAND_ACTIVE=1
  _paseo_osc633 "C"
  printf '\e]2;%s\a' "$1"
}

add-zsh-hook precmd _paseo_precmd
add-zsh-hook preexec _paseo_preexec
