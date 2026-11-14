# Nexterm shell integration for zsh (sourced once per shell; see shell_integration.rs).
rm -f -- "${(%):-%x}"
if [[ -o interactive && -z ${__wt_si-} ]]; then
  typeset -g __wt_si=1
  __wt_precmd() {
    local ec=$?
    printf '\e]133;D;%s\a\e]7;file://%s%s\a\e]133;A\a' "$ec" "$HOST" "$PWD"
    return $ec
  }
  __wt_preexec() {
    local bs='\' semi='\x3b' c=$1
    c=${c//"$bs"/"$bs$bs"}; c=${c//;/$semi}; c=${c//$'\n'/ }
    printf '\e]633;E;%s\a\e]133;C\a' "$c"
  }
  # First, so the exit code is still the command's (themes run their own hooks after).
  typeset -ga precmd_functions preexec_functions
  precmd_functions=(__wt_precmd ${precmd_functions:#__wt_precmd})
  preexec_functions=(__wt_preexec ${preexec_functions:#__wt_preexec})
fi
printf '\e]633;P;NextermShellIntegration=1\a'
