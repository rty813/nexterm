#!/usr/bin/env bash
# Terminal throughput benchmark, after https://github.com/kingToolbox/WindTerm#terminal-performance
# Run inside the terminal under test (over SSH):  ./bench.sh cat  |  ./bench.sh seq 1000000
f=./benchmark_randomdata
[ -f "$f" ] || head -c 102400000 /dev/urandom | base64 > "$f"   # ~100 MB, like urandom_test.sh

# DSR (ESC[6n): the terminal answers only after it has parsed everything before it,
# so the reply marks the moment the output was really processed, not just read.
dsr() { local o; o=$(stty -g); stty raw -echo
        printf '\e[6n' >/dev/tty; IFS= read -r -d R _ </dev/tty; stty "$o"; }

bytes=$( [ "$1" = cat ] && stat -c%s "$f" || seq 1 "${2:-1000000}" | wc -c )
t0=$(date +%s.%N)
case $1 in cat) cat "$f";; seq) seq 1 "${2:-1000000}";; *) echo "usage: $0 cat | seq N"; exit 1;; esac
t1=$(date +%s.%N); dsr; t2=$(date +%s.%N)

awk -v a=$t0 -v b=$t1 -v c=$t2 -v n=$bytes 'BEGIN{
  printf "\ncommand done: %.3fs   processed: %.3fs   rate: %.1f MB/s\n", b-a, c-a, n/1048576/(c-a)}'
