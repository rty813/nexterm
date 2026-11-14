# Run by the pane loader, in the current shell's user account (never sudo).
set -eu
if [ -n "$1" ]; then s=fish; elif [ -n "$2" ]; then s=zsh; elif [ -n "$3" ]; then s=bash; else
    printf '\033]633;P;NextermShellIntegration=0\007' >&2
    exit 0
fi
trap 'if [ "$?" -ne 0 ]; then printf "\033]633;P;NextermShellIntegration=2\007" >&2; fi' 0
: "${HOME:?HOME is not set}"
umask 077
d="$HOME/.local/share/nexterm/shell-integration"
mkdir -p "$d"
script="$d/$s"
# NEXTERM_SCRIPT
mv -f "$script.tmp" "$script"

# Append once, preserving existing content and a backup of the original file.
add_loader() {
    if [ -f "$1" ] && grep -Fqx '# >>> Nexterm shell integration >>>' "$1"; then return; fi
    if [ -e "$1" ] && [ ! -e "$1.nexterm-si.bak" ]; then cp -p "$1" "$1.nexterm-si.bak"; fi
    printf '\n# >>> Nexterm shell integration >>>\n%s\n# <<< Nexterm shell integration <<<\n' "$2" >> "$1"
}
case $s in
    bash)
        loader='case $- in *i*) if [ -n "${BASH_VERSION-}" ] && [ -r "$HOME/.local/share/nexterm/shell-integration/bash" ]; then . "$HOME/.local/share/nexterm/shell-integration/bash"; fi ;; esac'
        add_loader "$HOME/.bashrc" "$loader"
        # A login shell reads only the first existing file in this order.
        login="$HOME/.profile"
        if [ -f "$HOME/.bash_profile" ]; then login="$HOME/.bash_profile"; elif [ -f "$HOME/.bash_login" ]; then login="$HOME/.bash_login"; fi
        add_loader "$login" "$loader"
        ;;
    zsh)
        rcdir="${5:-$HOME}"
        mkdir -p "$rcdir"
        add_loader "$rcdir/.zshrc" '[ ! -r "$HOME/.local/share/nexterm/shell-integration/zsh" ] || source "$HOME/.local/share/nexterm/shell-integration/zsh"'
        ;;
    fish)
        conf="${6:-$HOME/.config}/fish/conf.d"
        mkdir -p "$conf"
        add_loader "$conf/nexterm-shell-integration.fish" 'if status is-interactive; and test -r "$HOME/.local/share/nexterm/shell-integration/fish"; source "$HOME/.local/share/nexterm/shell-integration/fish"; end'
        ;;
esac
# Source a disposable copy immediately; the installed script must never delete itself.
cat "$script" > "$4"
printf '\nrm -f -- %s\n' "$4" >> "$4"
