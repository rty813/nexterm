#!/usr/bin/env bash
# Multi-test terminal benchmark. Run inside the terminal under test:
#   bash compare.sh <label> [reps]
# Every timing ends with a DSR (ESC[6n) round trip, so it covers parsing, not just reading.
# Results: ~/.nxbench/results/<label>.csv  (test,rep,bytes,seconds,mb_s)
set -u
label=${1:?usage: compare.sh <label> [reps]}; reps=${2:-3}
d=~/.nxbench; mkdir -p "$d/results"; out="$d/results/$label.csv"

gen() { [ -s "$d/$1" ] && return; echo "generating $1 ..."; "${@:2}" > "$d/$1.tmp" && mv "$d/$1.tmp" "$d/$1"; }
gen base64.txt bash -c 'head -c 102400000 /dev/urandom | base64'                    # ~132 MB, WindTerm's urandom test
gen seq.txt    seq 1 3000000                                                          # ~22 MB of short lines (scroll heavy)
gen sgr.txt    awk 'BEGIN{for(i=0;i<400000;i++){s="";for(j=0;j<8;j++)s=s sprintf("\033[38;5;%dm\033[48;5;%dmword%02d ",(i+j)%256,(i*7+j)%256,j);print s "\033[0m"}}'
gen cjk.txt    awk 'BEGIN{t="中文终端性能测试，日本語のテキスト、한국어 텍스트 ★☆♪ ";for(i=0;i<300000;i++)print i ": " t t}'

now() { echo "$EPOCHREALTIME"; }
dsr() { local o; o=$(stty -g); stty raw -echo
        printf '\e[6n' >/dev/tty; IFS= read -r -d R _ </dev/tty; stty "$o"; }

declare -A res
run() {  # name file
  local n=$1 f=$2 bytes t0 t1 r
  bytes=$(stat -c%s "$f")
  for ((r=1; r<=reps; r++)); do
    printf '\e[0m\e[2J\e[H'; dsr
    t0=$(now); cat "$f"; dsr; t1=$(now)
    local s; s=$(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.3f", b-a}')
    local m; m=$(awk -v n="$bytes" -v s="$s" 'BEGIN{printf "%.1f", n/1048576/s}')
    echo "$n,$r,$bytes,$s,$m" >> "$out"; res[$n]+="$m "
  done
}

echo "test,rep,bytes,seconds,mb_s" > "$out"
echo "start,$(date +%s)" > "$d/results/$label.time"
for t in base64 seq sgr cjk; do run "$t" "$d/$t.txt"; done

# Response latency: 300 DSR round trips on an idle screen.
printf '\e[0m\e[2J\e[H'; o=$(stty -g); stty raw -echo
t0=$(now); for ((i=0; i<300; i++)); do printf '\e[6n' >/dev/tty; IFS= read -r -d R _ </dev/tty; done; t1=$(now)
stty "$o"; lat=$(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.3f", (b-a)*1000/300}')
echo "dsr_latency_ms,1,0,$lat,0" >> "$out"
echo "end,$(date +%s)" >> "$d/results/$label.time"

printf '\e[0m\e[2J\e[H== %s ==  (MB/s per run)\n' "$label"
for t in base64 seq sgr cjk; do printf '%-7s %s\n' "$t" "${res[$t]}"; done
printf 'DSR round trip: %s ms\nsaved: %s\n' "$lat" "$out"
