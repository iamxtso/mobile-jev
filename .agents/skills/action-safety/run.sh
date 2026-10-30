#!/usr/bin/env bash
# Check the run loop's action safety, one command, no device, no network, no API key.
#
#   .agents/skills/action-safety/run.sh                                # everything
#   .agents/skills/action-safety/run.sh long-press noop,uncertain      # one schedule, in the loop's words
#   .agents/skills/action-safety/run.sh long-press noop,uncertain changes-its-mind
#
# Exit code 0 means the loop behaves as this skill records: three promises hold, the fourth is the
# finding recorded in SKILL.md and nothing new, and every broken variant of those promises is still
# caught where the code passes. Anything else needs a decision, and the last lines say which.
set -u

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
failed=0

# What the code does at the sync commit in SKILL.md.
holds="NoStaleDispatch NoSameActionTwice RespectsStepLimit"
finding="NoInputAfterUncertain"

if [ "$#" -gt 0 ]; then
  action=${1:-tap-element}
  schedule=${2:-applied}
  policy=${3:-changes-its-mind}
  exec node "$here/explore.mjs" --action "$action" --schedule "$schedule" --policy "$policy"
fi

echo "== the code still offers what the exploration assumes =="
node "$here/anchors.mjs" || failed=1

echo
echo "== the run loop against its action-safety properties =="
out=$(node "$here/explore.mjs")
echo "$out"
gones=$(printf '%s\n' "$out" | awk '/GONE/ {print $2}' | tr '\n' ' ')
for property in $gones; do
  case " $finding " in
    *" $property "*) printf '  %-26s still the finding on record\n' "$property" ;;
    *)
      printf '  %-26s no longer holds and is not on record\n' "$property"
      failed=1
      ;;
  esac
done
for property in $finding; do
  case " $gones " in
    *" $property "*) ;;
    *)
      printf '  %-26s now holds: the recorded finding was fixed. Update SKILL.md.\n' "$property"
      failed=1
      ;;
  esac
done

echo
echo "== each property on the broken variant it guards =="
node "$here/explore.mjs" --mutants || failed=1

# The verification describes the code at this commit. When the covered files moved after it, say so
# without failing: an unrelated commit must not turn this into a red check.
sync=$(sed -n 's/^<!-- sync-commit: \([0-9a-f]*\) -->$/\1/p' "$here/SKILL.md" | head -1)
if [ -n "$sync" ] && command -v git >/dev/null 2>&1; then
  changed=$(git -C "$root" log --oneline "$sync..HEAD" -- scripts/mobile-agent 2>/dev/null)
  if [ -n "$changed" ]; then
    echo
    echo "note: scripts/mobile-agent changed since the sync commit $sync:"
    printf '  %s\n' "$changed"
    echo "Read those changes. When this exploration still describes the loop, move the sync commit in"
    echo "SKILL.md forward; otherwise update the exploration, or report what it no longer covers."
  fi
fi

if [ "$failed" -ne 0 ]; then
  cat <<'EOT'

The loop does not behave as this skill records. Decide which side is out of date:

  - The loop changed on purpose and still promises the same thing. Bring the exploration in line with
    the code as it is now, and move the sync commit in SKILL.md forward.
  - The loop lost a promise. That is a finding on the code. Do not weaken the property; report the
    counterexample in the loop's words, as `run.sh <action> <schedule> [policy]` prints it.
  - A GONE anchor means the code no longer offers what the exploration assumes, so a pass would mean
    nothing. Fix the exploration before reading any property as a result.
  - A recorded finding that now passes is news. Update SKILL.md and the lists above in one change.
EOT
fi

exit "$failed"
