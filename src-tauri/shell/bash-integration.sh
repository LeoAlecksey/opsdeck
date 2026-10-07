# OpsDeck shell integration for bash (loaded via --rcfile).
# Emits OSC 133 marks (A prompt, B command input, C output, D;exit) plus
# OSC 133;E;<base64 command> and OSC 7 (cwd) so the terminal can build command blocks.

[ -f /etc/bash.bashrc ] && . /etc/bash.bashrc
[ -f ~/.bashrc ] && . ~/.bashrc

if [[ -z "$__OPSDECK_SI" && $- == *i* ]]; then
  __OPSDECK_SI=1

  __opsdeck_prompt() {
    local ec=$?
    printf '\e]133;D;%s\a\e]133;A\a\e]7;file://%s%s\a' "$ec" "$HOSTNAME" "$PWD"
    return $ec
  }

  # PS0 is expanded (in a subshell) after a command line is read, right before it runs
  __opsdeck_preexec() {
    local cmd
    cmd=$(HISTTIMEFORMAT= builtin history 1 | sed 's/^ *[0-9]* *//')
    printf '\e]133;E;%s\a\e]133;C\a' "$(printf '%s' "$cmd" | base64 -w0)"
  }

  if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    PROMPT_COMMAND=(__opsdeck_prompt "${PROMPT_COMMAND[@]}")
  else
    PROMPT_COMMAND="__opsdeck_prompt${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
  fi
  PS0='$(__opsdeck_preexec)'"$PS0"
  PS1="$PS1"'\[\e]133;B\a\]'
fi

# ssh typed in an OpsDeck tab shares its connection with the resource bar (ControlMaster);
# `command ssh` bypasses this wrapper if ever needed
if [[ -n "$OPSDECK_SSH_CP" && -z "$__OPSDECK_SSH_WRAP" ]]; then
  __OPSDECK_SSH_WRAP=1
  ssh() { command ssh -o ControlMaster=auto -o "ControlPath=\"$OPSDECK_SSH_CP\"" -o ControlPersist=60 "$@"; }
fi
