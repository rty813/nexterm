# Nexterm shell integration for fish (sourced once per shell; see shell_integration.rs).
rm -f -- (status filename)
if status is-interactive; and not set -q __wt_si
    set -g __wt_si 1
    function __wt_preexec --on-event fish_preexec
        set -l bs (printf '\x5c')
        set -l c (string split \n -- $argv[1] | string replace -a -- $bs $bs$bs | string replace -a -- ';' $bs'x3b' | string join ' ')
        printf '\e]633;E;%s\a\e]133;C\a' "$c"
    end
    function __wt_postexec --on-event fish_postexec
        printf '\e]133;D;%s\a' $status
    end
    function __wt_prompt --on-event fish_prompt
        printf '\e]7;file://%s%s\a\e]133;A\a' $hostname $PWD
    end
end
printf '\e]633;P;NextermShellIntegration=1\a'
