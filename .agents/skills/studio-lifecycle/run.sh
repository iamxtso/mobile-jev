#!/usr/bin/env bash
# Model check the studio's run lifecycle, and check the model still describes the store. One command,
# no device, no network after the tools are fetched once.
#
#   .agents/skills/studio-lifecycle/run.sh                   # check every configuration
#   .agents/skills/studio-lifecycle/run.sh stop-after-end    # one configuration, full TLC output
#
# Exit code 0 means every configuration behaved as this skill records. Anything else is a change that
# needs a decision, and the last lines say which.
set -u

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
jar="$root/tmp/tla/tla2tools.jar"
sha=fc6878c603f0fdc18b9fe3e5bf51860cb90ab5b1154e3c371660c036d6bdd63e
url=https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar
work="$root/tmp/tla/studio"

# Every configuration, and what a correct run of it produces.
#   pass      no invariant was violated
#   violated  the named invariant was violated, which is the proof that it is able to fail
expect() {
  case "$1" in
    baseline) echo pass ;;
    two-active) echo violated:SingleActive ;;
    stop-after-end) echo violated:EndedIsFinal ;;
    no-kill-timer) echo violated:StoppingIsArmed ;;
    any-outcome-succeeds) echo violated:SucceededNeedsDone ;;
  esac
}
configs="baseline two-active stop-after-end no-kill-timer any-outcome-succeeds"
all=$configs

if [ "$#" -gt 0 ]; then
  configs=$*
fi

command -v java >/dev/null 2>&1 || {
  echo "TLC needs a JRE. Install one (brew install openjdk) and run this again." >&2
  exit 3
}
if [ ! -f "$jar" ]; then
  echo "Fetching the pinned TLA+ tools into tmp/tla/ (gitignored, one time) ..."
  mkdir -p "$(dirname "$jar")"
  curl -sSL --max-time 300 -o "$jar" "$url" || {
    echo "Could not fetch $url" >&2
    echo "Fetch it by hand and check it is $sha:" >&2
    echo "  curl -sSL -o $jar $url && shasum -a 256 $jar" >&2
    exit 3
  }
fi
have=$(shasum -a 256 "$jar" | cut -d' ' -f1)
[ "$have" = "$sha" ] || {
  echo "$jar is not the pinned build." >&2
  echo "  expected $sha" >&2
  echo "  found    $have" >&2
  exit 3
}

# TLC writes trace and fingerprint files next to the module, so it runs on a copy: every artifact lands
# in tmp/tla/ and this directory stays exactly what is in git.
mkdir -p "$work/spec"
cp "$here"/studio_lifecycle.tla "$here"/*.cfg "$work/spec/"
failed=0

echo "== model against code =="
node "$here/anchors.mjs" || failed=1

# A .cfg in this directory that the list above does not name is a check nobody runs, so it can stop
# passing without anyone noticing. Name it here, or delete it.
for cfg in "$here"/*.cfg; do
  name=$(basename "$cfg" .cfg)
  case " $all " in
    *" $name "*) ;;
    *)
      echo "  $name.cfg is not one of the configurations this script runs" >&2
      failed=1
      ;;
  esac
done

for cfg in $configs; do
  log="$work/$cfg.log"
  java -cp "$jar" tlc2.TLC -config "$work/spec/$cfg.cfg" -workers 1 -metadir "$work/states-$cfg" \
    -cleanup "$work/spec/studio_lifecycle.tla" >"$log" 2>&1
  if grep -q "No error has been found" "$log"; then
    got=pass
  elif grep -q "is violated" "$log"; then
    got="violated:$(grep -o "Invariant [A-Za-z]* is violated" "$log" | head -1 | cut -d' ' -f2)"
  else
    got="error:$(grep -m1 -E '^(Error|\*\*\*)' "$log" | cut -c1-100)"
  fi
  want=$(expect "$cfg")
  if [ "$got" = "$want" ]; then
    printf '  %-22s %s\n' "$cfg" "$got"
  else
    printf '  %-22s %s   EXPECTED %s\n' "$cfg" "$got" "$want"
    failed=1
  fi
done

# The model describes the store at this commit. When the covered file moved after it, say so without
# failing: an unrelated commit must not turn this into a red check.
sync=$(sed -n 's/^<!-- sync-commit: \([0-9a-f]*\) -->$/\1/p' "$here/SKILL.md" | head -1)
if [ -n "$sync" ] && command -v git >/dev/null 2>&1; then
  changed=$(git -C "$root" log --oneline "$sync..HEAD" -- apps/jev-studio/server 2>/dev/null)
  if [ -n "$changed" ]; then
    echo
    echo "note: apps/jev-studio/server changed since the sync commit $sync:"
    printf '  %s\n' "$changed"
    echo "Read those changes. When the model still describes the store, move the sync commit in"
    echo "SKILL.md forward; otherwise update the model, or report what it no longer covers."
  fi
fi

if [ "$failed" -ne 0 ]; then
  cat <<'EOT'

A configuration did not behave as this skill records, so the model and the code disagree. Read the
configuration's log in tmp/tla/studio/ and decide which one is out of date:

  - The store changed on purpose. Update studio_lifecycle.tla to describe it, move the sync commit in
    SKILL.md forward, and change the expected result above only if the property really moved.
  - The model found a new failure. Leave the invariant alone. Report the counterexample, in the
    store's words, as a finding on the code.
  - A finding that was recorded here now passes. Say so, and update this skill: a silently fixed bug
    must not stay in the record as an open one.
EOT
fi

exit "$failed"
