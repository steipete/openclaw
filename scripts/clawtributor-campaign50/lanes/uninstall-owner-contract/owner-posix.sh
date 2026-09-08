#!/usr/bin/env bash
set -euo pipefail
# A fresh process owns exactly one producer; the sourced scripts' globals/traps never overlap.
lane_dir=$1
case_name=$2
repo_dir=$3
prefix_dir=$4
source_sha=$5
[[ "$source_sha" == f5a30f8484671abdb422a9ea8b39837a668ed019 ]]
[[ "$PWD" == "$repo_dir" ]]
[[ "${CI:-}" == 1 && "${NPM_CONFIG_OFFLINE:-}" == true ]]
case "$case_name" in
  posix-git)
    export OPENCLAW_INSTALL_SH_NO_RUN=1 OPENCLAW_NO_ONBOARD=1 OPENCLAW_NO_PROMPT=1
    source "$lane_dir/source/install.sh"
    OPENCLAW_VERSION=$(git -C "$repo_dir" rev-parse HEAD)
    GIT_UPDATE=0
    install_openclaw_from_git "$repo_dir"
    ;;
  prefix-git|prefix-npm)
    export OPENCLAW_INSTALL_CLI_SH_NO_RUN=1 OPENCLAW_NO_ONBOARD=1
    export OPENCLAW_PREFIX="$prefix_dir" OPENCLAW_NODE_VERSION=24.20.0
    source "$lane_dir/source/install-cli.sh"
    # Select the admitted existing Node runtime using the actual runtime-link owner.
    link_node_runtime_paths "$(command -v node)" "$(command -v npm)"
    install_node "$(os_detect)" "$(arch_detect)"
    if [[ "$case_name" == prefix-git ]]; then
      OPENCLAW_VERSION=$(git -C "$repo_dir" rev-parse HEAD)
      GIT_UPDATE=0
      install_openclaw_from_git "$repo_dir"
    else
      OPENCLAW_VERSION="$repo_dir/openclaw-0.0.0-synthetic-owner-proof.tgz"
      install_openclaw
    fi
    commit_wrapper_backup
    ;;
  *) printf '%s\n' 'Unknown owner case' >&2; exit 2 ;;
esac
