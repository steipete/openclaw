#!/usr/bin/env bash
set -euo pipefail

# Run from the installed, immutable candidate checkout. Proof files are transient
# root scripts; log directory and synthetic certificate directory stay outside it.
lane=${1:?buzz or feishu}
expectation=${2:?red or green}
log_file=${3:?absolute log file}
case "$lane" in
  buzz)
    script=buzz-transport-proof.ts
    red_marker='Error: BUZZ_THREAD_REGRESSION:implicit'
    green_marker=BUZZ_TRANSPORT_PROOF_GREEN
    ;;
  feishu)
    script=feishu-runtime-proof.ts
    red_marker='Error: FEISHU_MENTION_REGRESSION:'
    green_marker=FEISHU_RUNTIME_PROOF_GREEN
    ;;
  feishu-debounce)
    script=feishu-debounce-runtime-proof.ts
    red_marker='Error: FEISHU_DEBOUNCE_REGRESSION:'
    green_marker=FEISHU_DEBOUNCE_PROOF_GREEN
    ;;
  *) exit 64 ;;
esac
case "$expectation" in red|green) ;; *) exit 64 ;; esac
args=(.)
cert_dir=''
cleanup() {
  if [[ -n "$cert_dir" ]]; then rm -rf -- "$cert_dir"; fi
}
trap cleanup EXIT
if [[ "$lane" == feishu* ]]; then
  cert_dir=$(mktemp -d /tmp/openclaw-feishu-proof-ca.XXXXXX)
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
    -subj '/CN=localhost' \
    -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
    -addext 'basicConstraints=critical,CA:TRUE' \
    -keyout "$cert_dir/key.pem" -out "$cert_dir/cert.pem" >/dev/null 2>&1
  args+=("$cert_dir/key.pem" "$cert_dir/cert.pem")
fi
set +e
if [[ "$lane" == feishu* ]]; then
  NODE_EXTRA_CA_CERTS="$cert_dir/cert.pem" timeout 150s \
    node --import ./scripts/tsx.mjs "$script" "${args[@]}" >"$log_file" 2>&1
else
  timeout 150s node --import ./scripts/tsx.mjs "$script" "${args[@]}" >"$log_file" 2>&1
fi
proof_exit=$?
set -e
cat "$log_file"
if [[ "$expectation" == red ]]; then
  if [[ "$proof_exit" -eq 0 || "$proof_exit" -eq 124 || "$proof_exit" -eq 137 ]] ||
      ! grep -Fq "$red_marker" "$log_file"; then
    echo "Unexpected $lane baseline result (exit $proof_exit); not regression evidence" >&2
    exit 1
  fi
  echo "EXPECTED_BASELINE_RED:$lane"
else
  if [[ "$proof_exit" -ne 0 ]] || ! grep -Fxq "$green_marker" "$log_file"; then
    echo "Candidate $lane did not pass complete transport proof (exit $proof_exit)" >&2
    exit 1
  fi
  echo "CANDIDATE_GREEN:$lane"
fi
