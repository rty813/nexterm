# Nexterm shell integration for bash (sourced once per shell; see shell_integration.rs).
# OSC 133 A/C/D: prompt / command start / end (exit code), OSC 633 E: command line,
# OSC 7: host and directory. Needs bash 4.4+ (PS0) for the command part.
rm -f -- "${BASH_SOURCE[0]}"
if [[ $- == *i* && -z ${__wt_si-} ]]; then
  __wt_si=1
  # Drop the loader line from history when it was recorded (no ignorespace).
  [[ $(HISTTIMEFORMAT= builtin history 1) == *.nexterm-si-* ]] && builtin history -d -1 2>/dev/null
  if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then
    __wt_hist() { local h; h=$(HISTTIMEFORMAT= builtin history 1); h=${h#"${h%%[! ]*}"}; printf '%s' "${h%%[!0-9]*}"; }
    __wt_prompt() {
      local ec=$?
      __wt_last=$(__wt_hist)
      printf '\e]133;D;%s\a\e]7;file://%s%s\a\e]133;A\a' "$ec" "$HOSTNAME" "$PWD"
      return $ec
    }
    # Runs in a subshell (PS0): compares with the history number seen at the prompt, so a
    # command kept out of history (ignorespace) sends no stale line.
    __wt_preexec() {
      local h c bs='\' semi='\x3b'
      h=$(HISTTIMEFORMAT= builtin history 1)
      if [[ $h =~ ^\ *([0-9]+)\*?\ +(.*)$ && ${BASH_REMATCH[1]} != "${__wt_last-}" ]]; then
        c=${BASH_REMATCH[2]}
        c=${c//"$bs"/"$bs$bs"}; c=${c//;/$semi}; c=${c//$'\n'/ }
      fi
      printf '\e]633;E;%s\a\e]133;C\a' "$c"
    }
    __wt_last=$(__wt_hist)
    PS0='$(__wt_preexec)'"${PS0-}"
  else
    __wt_prompt() { local ec=$?; printf '\e]7;file://%s%s\a' "$HOSTNAME" "$PWD"; return $ec; }
  fi
  PROMPT_COMMAND="__wt_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi
printf '\e]633;P;NextermShellIntegration=1\a'
