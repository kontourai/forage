#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <tagged-commit> [remote]" >&2
}

check_tag_ancestry() {
  local tagged_commit=$1
  local remote=${2:-origin}
  local git_command=${3:-git}
  local main_ref='refs/heads/main'
  local main_tip

  if ! "${git_command}" rev-parse --verify --quiet "${tagged_commit}^{commit}" >/dev/null; then
    echo "Tagged commit ${tagged_commit} is not available locally" >&2
    return 1
  fi

  if ! "${git_command}" fetch --no-tags "${remote}" "${main_ref}"; then
    echo "Could not fetch ${remote}/${main_ref} for tag ancestry verification" >&2
    return 1
  fi

  if ! main_tip=$("${git_command}" rev-parse --verify --quiet 'FETCH_HEAD^{commit}'); then
    echo "Fetched ${remote}/${main_ref} did not resolve to a commit" >&2
    return 1
  fi

  if ! "${git_command}" merge-base --is-ancestor "${tagged_commit}" "${main_tip}"; then
    echo "Tagged commit ${tagged_commit} is not reachable from ${remote}/${main_ref}" >&2
    return 1
  fi
}

self_test_temp_dir=''
self_test_temp_created=false

cleanup_self_test() {
  local primary_status=$?

  trap - EXIT HUP INT TERM
  if [[ ${self_test_temp_created} == true && -n ${self_test_temp_dir} ]]; then
    if ! rm -rf -- "${self_test_temp_dir}"; then
      echo "Could not remove self-test directory ${self_test_temp_dir}" >&2
      if [[ ${primary_status} -eq 0 ]]; then
        primary_status=1
      fi
    fi
  fi

  exit "${primary_status}"
}

fixture_git() {
  env \
    -u GIT_ALLOW_PROTOCOL \
    -u GIT_CONFIG_PARAMETERS \
    -u GIT_DIR \
    -u GIT_PROTOCOL_FROM_USER \
    -u GIT_TEMPLATE_DIR \
    -u GIT_WORK_TREE \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_SYSTEM=/dev/null \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_COUNT=0 \
    git \
      -c core.hooksPath=/dev/null \
      -c commit.gpgSign=false \
      -c tag.gpgSign=false \
      -c push.gpgSign=false \
      -c protocol.file.allow=always \
      "$@"
}

setup_self_test_temp() {
  if [[ -n ${RELEASE_ANCESTRY_SELF_TEST_TMPDIR:-} ]]; then
    self_test_temp_dir=${RELEASE_ANCESTRY_SELF_TEST_TMPDIR}
    if [[ -e ${self_test_temp_dir} ]]; then
      echo "Refusing to reuse self-test directory ${self_test_temp_dir}" >&2
      return 1
    fi
    mkdir -p -- "${self_test_temp_dir}"
  else
    self_test_temp_dir=$(mktemp -d)
  fi
  self_test_temp_created=true
  trap cleanup_self_test EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

configure_hostile_fixture_environment() {
  local hostile_config=$1
  local hostile_hooks=$2
  local hook_marker=$3

  mkdir -p -- "${hostile_hooks}"
  printf '%s\n' '#!/usr/bin/env bash' "touch '${hook_marker}'" 'exit 97' >"${hostile_hooks}/pre-push"
  chmod +x "${hostile_hooks}/pre-push"
  fixture_git config --file "${hostile_config}" commit.gpgSign true
  fixture_git config --file "${hostile_config}" tag.gpgSign true
  fixture_git config --file "${hostile_config}" push.gpgSign true
  fixture_git config --file "${hostile_config}" gpg.program /usr/bin/false
  fixture_git config --file "${hostile_config}" core.hooksPath "${hostile_hooks}"
  export GIT_CONFIG_GLOBAL="${hostile_config}"
  export GIT_ALLOW_PROTOCOL=https
  export GIT_PROTOCOL_FROM_USER=0
}

build_fixture_graph() {
  local remote=$1
  local seed=$2
  local base_commit

  fixture_git init --bare --initial-branch=main "${remote}" >/dev/null
  fixture_git init --initial-branch=main "${seed}" >/dev/null
  (
    cd "${seed}"
    fixture_git remote add origin "${remote}"
    fixture_git -c user.email=release-test@example.invalid -c user.name='Release test' \
      commit --quiet --allow-empty -m 'base'
    base_commit=$(fixture_git rev-parse HEAD)
    fixture_git tag v0.4.0
    fixture_git -c user.email=release-test@example.invalid -c user.name='Release test' \
      commit --quiet --allow-empty -m 'main after release'
    fixture_git switch --quiet -c side "${base_commit}"
    fixture_git -c user.email=release-test@example.invalid -c user.name='Release test' \
      commit --quiet --allow-empty -m 'side release'
    fixture_git tag v0.4.0-side
    fixture_git tag main
    fixture_git push --quiet origin \
      refs/heads/main:refs/heads/main \
      refs/heads/side:refs/heads/side \
      refs/tags/main:refs/tags/main \
      refs/tags/v0.4.0:refs/tags/v0.4.0 \
      refs/tags/v0.4.0-side:refs/tags/v0.4.0-side
  )
}

assert_fixture_ancestry() {
  local remote=$1
  local fresh=$2
  local reachable_tag side_tag collision_tag

  fixture_git clone --quiet "${remote}" "${fresh}"
  (
    cd "${fresh}"
    fixture_git checkout --quiet --detach refs/tags/v0.4.0
    reachable_tag=$(fixture_git rev-parse refs/tags/v0.4.0)
    side_tag=$(fixture_git rev-parse refs/tags/v0.4.0-side)
    collision_tag=$(fixture_git rev-parse refs/tags/main)

    if [[ ${collision_tag} != "${side_tag}" ]]; then
      echo 'Collision fixture does not point refs/tags/main at the side-branch release' >&2
      exit 1
    fi

    check_tag_ancestry "${reachable_tag}" origin fixture_git
    if check_tag_ancestry "${side_tag}" origin fixture_git >/dev/null 2>&1; then
      echo 'Unreachable side-branch tag unexpectedly passed ancestry verification' >&2
      exit 1
    fi
  )
}

assert_hook_isolation() {
  local hook_marker=$1

  if [[ -e ${hook_marker} ]]; then
    echo 'Ambient pre-push hook unexpectedly ran in the isolated fixture' >&2
    return 1
  fi
}

probe_early_failure_cleanup() {
  local cleanup_probe_dir=$1
  local script_path=$2
  local cleanup_probe_output cleanup_probe_status

  cleanup_probe_status=0
  if cleanup_probe_output=$( \
    RELEASE_ANCESTRY_SELF_TEST_TMPDIR="${cleanup_probe_dir}" \
    RELEASE_ANCESTRY_SELF_TEST_EARLY_FAILURE=1 \
    "${script_path}" --self-test 2>&1
  ); then
    echo 'Intentional early-failure cleanup probe unexpectedly passed' >&2
    return 1
  else
    cleanup_probe_status=$?
  fi
  if [[ ${cleanup_probe_status} -ne 86 ]]; then
    echo "Cleanup probe replaced primary status 86 with ${cleanup_probe_status}" >&2
    return 1
  fi
  if [[ ${cleanup_probe_output} != *'Intentional early failure after self-test cleanup registration'* ]]; then
    echo 'Cleanup probe lost the primary failure diagnostic' >&2
    return 1
  fi
  if [[ -e ${cleanup_probe_dir} ]]; then
    echo "Cleanup probe leaked ${cleanup_probe_dir}" >&2
    return 1
  fi
}

self_test() {
  local remote seed fresh hostile_config hostile_hooks hook_marker
  local cleanup_probe_dir script_path

  setup_self_test_temp
  if [[ ${RELEASE_ANCESTRY_SELF_TEST_EARLY_FAILURE:-0} == 1 ]]; then
    echo 'Intentional early failure after self-test cleanup registration' >&2
    return 86
  fi

  remote="${self_test_temp_dir}/remote.git"
  seed="${self_test_temp_dir}/seed"
  fresh="${self_test_temp_dir}/fresh"
  hostile_config="${self_test_temp_dir}/hostile.gitconfig"
  hostile_hooks="${self_test_temp_dir}/hostile-hooks"
  hook_marker="${self_test_temp_dir}/ambient-hook-ran"
  cleanup_probe_dir="${self_test_temp_dir}/early-failure-probe"
  script_path=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")

  configure_hostile_fixture_environment "${hostile_config}" "${hostile_hooks}" "${hook_marker}"
  build_fixture_graph "${remote}" "${seed}"
  assert_fixture_ancestry "${remote}" "${fresh}"
  assert_hook_isolation "${hook_marker}"
  probe_early_failure_cleanup "${cleanup_probe_dir}" "${script_path}"
  echo 'Release tag ancestry regression passed.'
}

if [[ ${1:-} == '--self-test' ]]; then
  if [[ $# -ne 1 ]]; then
    usage
    exit 2
  fi
  self_test
  exit 0
fi

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 2
fi

check_tag_ancestry "$1" "${2:-origin}" git
