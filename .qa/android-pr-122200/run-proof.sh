#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ $# == 7 ]] || { echo 'expected tooling, task, artifacts, JDK, SDK, image OS and version' >&2; exit 2; }
tooling=$1
task_root=$2
artifacts=$3
jdk=$4
sdk=$5
image_os=$6
image_version=$7
manifest="$tooling/.qa/android-pr-122200/manifest.json"
overlay="$tooling/.qa/android-pr-122200/overlay.patch"
driver="$tooling/.qa/android-pr-122200/native-driver.sh"
emulator_pid=''
fixture_group=''
adb=''

mkdir -m 700 "$task_root" "$artifacts"
mkdir -m 700 "$task_root/home" "$task_root/gradle" "$task_root/source"
export HOME="$task_root/home" GRADLE_USER_HOME="$task_root/gradle"
export JAVA_HOME="$jdk" ANDROID_HOME="$sdk" ANDROID_SDK_ROOT="$sdk"
export ANDROID_USER_HOME="$task_root/android" ANDROID_EMULATOR_HOME="$task_root/android"
export ANDROID_AVD_HOME="$task_root/avd"
export PATH="$jdk/bin:/usr/local/bin:/usr/bin:/bin"
mkdir -m 700 "$ANDROID_USER_HOME" "$ANDROID_AVD_HOME"

cleanup() {
  local command_rc=$? cleanup_rc=0
  trap - EXIT
  if [[ -n "$fixture_group" ]]; then
    kill -TERM -- "-$fixture_group" 2>/dev/null || true
    for _ in {1..20}; do
      kill -0 -- "-$fixture_group" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 -- "-$fixture_group" 2>/dev/null; then
      kill -KILL -- "-$fixture_group" 2>/dev/null || true
      cleanup_rc=1
    fi
  fi
  if [[ -n "$adb" ]]; then
    timeout 10 "$adb" -s emulator-5554 emu kill >/dev/null 2>&1 || true
  fi
  if [[ -n "$emulator_pid" ]]; then
    for _ in {1..40}; do
      kill -0 -- "-$emulator_pid" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 -- "-$emulator_pid" 2>/dev/null; then
      kill -TERM -- "-$emulator_pid" 2>/dev/null || true
      cleanup_rc=1
    fi
    for _ in {1..20}; do
      kill -0 -- "-$emulator_pid" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 -- "-$emulator_pid" 2>/dev/null; then kill -KILL -- "-$emulator_pid" 2>/dev/null || true; fi
    wait "$emulator_pid" 2>/dev/null || true
  fi
  if [[ -n "$adb" ]]; then timeout 10 "$adb" kill-server >/dev/null 2>&1 || cleanup_rc=1; fi
  jq -n --argjson commandExit "$command_rc" --argjson cleanupExit "$cleanup_rc" \
    '{commandExit:$commandExit,cleanupExit:$cleanupExit}' > "$artifacts/cleanup.json"
  [[ "$command_rc" != 0 ]] || command_rc=$cleanup_rc
  exit "$command_rc"
}
trap cleanup EXIT

# An unpublished skeleton must never accidentally launch an unbound proof.
jq -e '
  (keys | sort) == (["enabled","expectedFailures","mode","nativeAssertions","nativeDriverSha256","overlayPaths","overlaySha256","sourceSha","testFilters","version"] | sort) and
  .version == 1 and .enabled == true and
  (.mode == "unit" or .mode == "native") and
  (.sourceSha | type == "string" and test("^[a-f0-9]{40}$")) and
  (.overlaySha256 | type == "string" and test("^[a-f0-9]{64}$")) and
  (.overlayPaths | type == "array" and length > 0 and all(.[]; type == "string" and test("^apps/android/app/src/(test|androidTest)/java/[A-Za-z0-9_./-]+\\.kt$") and (contains("..") | not))) and
  (.testFilters | type == "array" and all(.[]; type == "string" and test("^[A-Za-z0-9_.$*]+$"))) and
  (.expectedFailures | type == "array" and all(.[]; (keys | sort) == ["classname","messageContains","name"] and all(.[]; type == "string" and length > 0))) and
  (.nativeAssertions | type == "array" and all(.[]; type == "string" and test("^[a-z][a-z0-9_]+$")) and (length == (unique | length))) and
  (if .mode == "unit" then (.testFilters | length > 0) and .nativeDriverSha256 == null and (.nativeAssertions | length == 0)
   else (.nativeDriverSha256 | type == "string" and test("^[a-f0-9]{64}$")) and (.expectedFailures | length == 0) and (.nativeAssertions | length > 0) end)
' "$manifest" >/dev/null
source_sha=$(jq -r .sourceSha "$manifest")
mode=$(jq -r .mode "$manifest")
printf '%s  %s\n' "$(jq -r .overlaySha256 "$manifest")" "$overlay" | sha256sum --check -
cp "$manifest" "$artifacts/manifest.json"
git -C "$tooling" rev-parse HEAD > "$artifacts/tooling-sha.txt"
[[ -x "$jdk/bin/java" && ( -d "$sdk/platforms/android-37" || -d "$sdk/platforms/android-37.0" ) ]]
[[ -x "$sdk/build-tools/36.0.0/aapt2" && -x "$sdk/platform-tools/adb" ]]
"$jdk/bin/java" -version 2> "$artifacts/java-version.txt"
grep -q 'version "21\.' "$artifacts/java-version.txt"
df -Pk "$task_root" > "$artifacts/disk-before.txt"
free -m > "$artifacts/memory-before.txt"
jq -n --arg os "$image_os" --arg version "$image_version" '{os:$os,version:$version}' > "$artifacts/runner-image.json"
free_kib=$(df -Pk "$task_root" | awk 'NR == 2 {print $4}')
[[ "$free_kib" -ge 10485760 ]] || { echo 'Less than 10 GiB free before source proof' >&2; exit 1; }

if [[ "$mode" == native ]]; then
  printf '%s  %s\n' "$(jq -r .nativeDriverSha256 "$manifest")" "$driver" | sha256sum --check -
  [[ -c /dev/kvm ]]
  # Standard hosted VMs need device access; scope it to this disposable runner group.
  sudo -n chgrp "$(id -g)" /dev/kvm
  sudo -n chmod g+rw /dev/kvm
  [[ -r /dev/kvm && -w /dev/kvm ]]
  [[ -s "$sdk/licenses/android-sdk-license" ]]
  sdkmanager="$sdk/cmdline-tools/latest/bin/sdkmanager"
  avdmanager="$sdk/cmdline-tools/latest/bin/avdmanager"
  [[ -x "$sdkmanager" && -x "$avdmanager" ]]
  curl -fsSL --connect-timeout 10 --max-time 60 \
    https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-4.xml \
    -o "$task_root/system-image-repository.xml"
  python3 - "$task_root/system-image-repository.xml" <<'PY'
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
for item in root.iter():
    item.tag = item.tag.split("}")[-1]
packages = [item for item in root.iter("remotePackage") if item.get("path") == "system-images;android-36;google_apis;x86_64"]
assert len(packages) == 1, "Image package identity missing/ambiguous"
package = packages[0]
assert package.findtext("revision/major") == "7", "Image revision drift"
assert package.find("uses-license").get("ref") == "android-sdk-license", "Image license drift"
assert package.findtext("archives/archive/complete/checksum") == "c6bf44bdcd885bb902b4ba752d111a073ad7a817", "Image archive digest drift"
assert package.findtext("archives/archive/complete/url") == "x86_64-36_r07.zip", "Image archive URL drift"
PY
  # Never accept a new license. Missing or changed agreements fail with closed stdin.
  "$sdkmanager" --sdk_root="$sdk" --install emulator \
    'system-images;android-36;google_apis;x86_64' </dev/null > "$artifacts/sdk-install.log" 2>&1
  image="$sdk/system-images/android-36/google_apis/x86_64"
  grep -qx 'Pkg.Revision=7' "$image/source.properties"
  cp "$image/source.properties" "$artifacts/system-image.properties"
  sha256sum "$image/system.img" > "$artifacts/system-image-sha256.txt"
  "$sdk/emulator/emulator" -version > "$artifacts/emulator-version.txt" 2>&1
  "$sdk/emulator/emulator" -accel-check > "$artifacts/emulator-acceleration.txt" 2>&1
  "$sdk/emulator/emulator" -help-gpu > "$artifacts/emulator-gpu-options.txt" 2>&1
  grep -qw swiftshader "$artifacts/emulator-gpu-options.txt"
  printf 'no\n' | "$avdmanager" create avd --name openclaw-pr-122200 \
    --package 'system-images;android-36;google_apis;x86_64' --device pixel_7 \
    > "$artifacts/avd-create.log" 2>&1
fi

# Exact public Git objects only; no credentials, submodules, hooks or moving refs.
source_dir="$task_root/source"
git -c credential.helper= -c core.hooksPath=/dev/null -C "$source_dir" init
git -c credential.helper= -c core.hooksPath=/dev/null -C "$source_dir" fetch \
  --depth=1 --no-tags https://github.com/openclaw/openclaw.git "$source_sha"
git -c core.hooksPath=/dev/null -C "$source_dir" checkout --detach "$source_sha"
[[ "$(git -C "$source_dir" rev-parse HEAD)" == "$source_sha" ]]
git -C "$source_dir" apply --check --index "$overlay"
git -C "$source_dir" apply --index "$overlay"
git -C "$source_dir" diff --cached --name-only | sort > "$task_root/actual-overlay-paths"
jq -r '.overlayPaths[]' "$manifest" | sort > "$task_root/expected-overlay-paths"
diff -u "$task_root/expected-overlay-paths" "$task_root/actual-overlay-paths"
git -C "$source_dir" diff --cached --binary > "$artifacts/applied-overlay.patch"
cp "$source_dir/apps/android/gradle/wrapper/gradle-wrapper.properties" "$artifacts/gradle-wrapper.properties"
cp "$source_dir/apps/android/gradle/gradle-daemon-jvm.properties" "$artifacts/gradle-daemon-jvm.properties"
cd "$source_dir/apps/android"

if [[ "$mode" == unit ]]; then
  gradle_args=(--no-daemon --max-workers=1 --console=plain :app:testPlayDebugUnitTest)
  while IFS= read -r test_filter; do gradle_args+=(--tests "$test_filter"); done < <(jq -r '.testFilters[]' "$manifest")
  command_rc=0
  timeout --signal=TERM --kill-after=20s 1800 ./gradlew "${gradle_args[@]}" > "$artifacts/gradle.log" 2>&1 || command_rc=$?
  printf '%s\n' "$command_rc" > "$artifacts/gradle-exit.txt"
  mkdir "$artifacts/junit"
  shopt -s nullglob
  reports=(app/build/test-results/testPlayDebugUnitTest/TEST-*.xml)
  [[ ${#reports[@]} -gt 0 ]] || { echo 'No JUnit reports; not behavior proof' >&2; exit 1; }
  cp "${reports[@]}" "$artifacts/junit/"
  python3 "$tooling/.qa/android-pr-122200/verify-unit-result.py" "$manifest" "$artifacts" "$command_rc"
  exit 0
fi

timeout --signal=TERM --kill-after=20s 1800 ./gradlew --no-daemon --max-workers=1 --console=plain \
  :app:assemblePlayDebug :app:assemblePlayDebugAndroidTest > "$artifacts/gradle.log" 2>&1
shopt -s nullglob
apps=(app/build/outputs/apk/play/debug/*.apk)
tests=(app/build/outputs/apk/androidTest/play/debug/*.apk)
[[ ${#apps[@]} == 1 && ${#tests[@]} == 1 ]]
app_apk="$PWD/${apps[0]}"
test_apk="$PWD/${tests[0]}"
sha256sum "$app_apk" "$test_apk" > "$artifacts/apk-sha256.txt"

adb="$sdk/platform-tools/adb"
export ANDROID_SERIAL=emulator-5554
setsid "$sdk/emulator/emulator" -avd openclaw-pr-122200 -port 5554 -no-window -no-audio \
  -no-boot-anim -no-snapshot -gpu swiftshader -accel on -cores 2 -memory 2048 \
  > "$artifacts/emulator.log" 2>&1 &
emulator_pid=$!
timeout 300 "$adb" -s "$ANDROID_SERIAL" wait-for-device
booted=false
for _ in {1..150}; do
  kill -0 "$emulator_pid"
  if [[ "$("$adb" -s "$ANDROID_SERIAL" shell getprop sys.boot_completed | tr -d '\r')" == 1 ]]; then booted=true; break; fi
  sleep 2
done
[[ "$booted" == true ]]
"$adb" -s "$ANDROID_SERIAL" exec-out screencap -p > "$artifacts/boot.png"
"$adb" -s "$ANDROID_SERIAL" install "$app_apk" > "$artifacts/app-install.log" 2>&1
"$adb" -s "$ANDROID_SERIAL" install "$test_apk" > "$artifacts/test-install.log" 2>&1
export PROOF_ADB="$adb" PROOF_APP_APK="$app_apk" PROOF_TEST_APK="$test_apk" PROOF_ARTIFACTS="$artifacts"
# The reviewed owner driver owns its instrumentation/fixture children and visible assertions.
setsid timeout --signal=TERM --kill-after=20s 900 /bin/bash "$driver" > "$artifacts/native-driver.log" 2>&1 &
fixture_group=$!
driver_rc=0
wait "$fixture_group" || driver_rc=$?
printf '%s\n' "$driver_rc" > "$artifacts/native-driver-exit.txt"
[[ "$driver_rc" == 0 ]]
[[ -s "$artifacts/native-result.json" ]]
jq -e --slurpfile manifest "$manifest" '
  .result == "pass" and
  (.assertions | type == "array" and length > 0 and all(.[]; .outcome == "pass")) and
  ([.assertions[].id] | sort) == ($manifest[0].nativeAssertions | sort)
' "$artifacts/native-result.json" >/dev/null
