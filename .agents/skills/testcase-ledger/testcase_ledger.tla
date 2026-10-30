--------------------------- MODULE testcase_ledger ---------------------------
(*
  The write protocol of `artifacts/testcases/results.jsonl`, the ledger of benchmark verdicts.
  Every action below names the line of code it stands for.

  scripts/testcases.mjs
    recordResult(entry)
      await mkdir(OUT)                              -> OUT exists (Init)
      writeFile(lock, pid, { flag: 'wx' })          -> Acquire      the exclusive create succeeds
                                                       Retry        EEXIST: sleep 100 ms, try again
                                                       GiveUp       `attempt > 100`: throw
      const runs = await previousRuns()             -> Read
      writeFile(`${RESULTS}.tmp`, lines.join(''))   -> WriteTmp
      rename(`${RESULTS}.tmp`, RESULTS)             -> Commit       atomic replace
      finally { await unlink(lock).catch(..) }      -> Release
    previousRuns()
      readFile + split + map(JSON.parse), catch -> []  -> Parse
    main()
      --summary / --resume read the file, no lock   -> ReaderRead
      a runner killed by SIGKILL, a power cut, a
      hung adb call, Ctrl-C on a laptop lid         -> Crash        the `finally` never runs

  scripts/mobile-agent/testcase-suite.mjs
    oneLinePerCase(entries) keeps the last verdict
    per id; recordResult drops the old line first    -> the filter in WriteTmp

  The constants at the bottom turn individual steps off, so this one module also describes the code
  without its lock (UseLock), without its rename (AtomicCommit), and the inputs the code reads but
  does not create: a line that is not JSON (DamagePossible) and a killed runner (CrashPossible).
*)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS Writers,        \* the runners that record verdicts, e.g. {"r1", "r2"}
          Cases,          \* case ids, e.g. {"c1", "c2"}
          Verdicts,       \* e.g. {"pass", "fail"}
          MaxAttempts,    \* the code's `attempt > 100`, as a small natural
          UseLock,        \* FALSE: the lock-file loop removed
          AtomicCommit,   \* FALSE: writeFile(RESULTS, ...) instead of tmp + rename
          CrashPossible,  \* a runner is killed while it records
          DamagePossible  \* a line in the file is not JSON

NoLock == "free"

\* A ledger line the reader can use. A half-written line has no verdict: JSON.parse throws on it.
Whole(line) == "verdict" \in DOMAIN line
TornLine == [id |-> "legacy"]

Lines(file) == {file[i] : i \in DOMAIN file}
Ids(file) == {l.id : l \in {x \in Lines(file) : Whole(x)}}

\* previousRuns(): one unreadable line and the whole read is "no results yet".
Parse(file) == IF \A l \in Lines(file) : Whole(l) THEN file ELSE <<>>

\* The states in which the code holds the lock file.
Holding == {"read", "write", "truncate", "fill", "commit"}
Recording == Holding \cup {"release"}

VARIABLES lock,      \* NoLock, or the writer whose exclusive create returned
          ledger,    \* results.jsonl as committed
          tmp,       \* results.jsonl.tmp as written
          pc,        \* per-writer program counter
          attempts,  \* per-writer failed exclusive creates so far
          view,      \* per-writer copy of the ledger it read inside the lock
          out,       \* per-writer entry it is recording
          ever,      \* case ids that have had a verdict committed, ever
          seen       \* ledger contents a reader got

vars == <<lock, ledger, tmp, pc, attempts, view, out, ever, seen>>

Init ==
  /\ lock = NoLock
  /\ ledger = <<>>
  /\ tmp = <<>>
  /\ pc = [w \in Writers |-> "idle"]
  /\ attempts = [w \in Writers |-> 0]
  /\ view = [w \in Writers |-> <<>>]
  /\ out = [w \in Writers |-> TornLine]
  /\ ever = {}
  /\ seen = {}

\* A case finished: the runner is about to record its verdict.
Begin(w) ==
  /\ pc[w] = "idle"
  /\ \E c \in Cases, v \in Verdicts :
       /\ out' = [out EXCEPT ![w] = [id |-> c, verdict |-> v]]
       /\ pc' = [pc EXCEPT ![w] = "tryLock"]
       /\ UNCHANGED <<lock, ledger, tmp, attempts, view, ever, seen>>

\* The exclusive create succeeded: no lock file existed.
Acquire(w) ==
  /\ pc[w] = "tryLock"
  /\ lock = NoLock \/ ~UseLock
  /\ lock' = w
  /\ pc' = [pc EXCEPT ![w] = "read"]
  /\ UNCHANGED <<ledger, tmp, attempts, view, out, ever, seen>>

\* EEXIST: the lock file is there, so sleep 100 ms and count the attempt.
Retry(w) ==
  /\ pc[w] = "tryLock"
  /\ UseLock
  /\ lock # NoLock
  /\ attempts[w] < MaxAttempts
  /\ attempts' = [attempts EXCEPT ![w] = @ + 1]
  /\ pc' = [pc EXCEPT ![w] = "waitLock"]
  /\ UNCHANGED <<lock, ledger, tmp, view, out, ever, seen>>

Wake(w) ==
  /\ pc[w] = "waitLock"
  /\ pc' = [pc EXCEPT ![w] = "tryLock"]
  /\ UNCHANGED <<lock, ledger, tmp, attempts, view, out, ever, seen>>

\* `attempt > 100`: throw "The results file stayed locked".
GiveUp(w) ==
  /\ pc[w] = "tryLock"
  /\ UseLock
  /\ lock # NoLock
  /\ attempts[w] >= MaxAttempts
  /\ pc' = [pc EXCEPT ![w] = "gaveUp"]
  /\ UNCHANGED <<lock, ledger, tmp, attempts, view, out, ever, seen>>

\* previousRuns() inside the lock: the other cases' verdicts, as this runner reads them.
Read(w) ==
  /\ pc[w] = "read"
  /\ view' = [view EXCEPT ![w] = Parse(ledger)]
  /\ pc' = [pc EXCEPT ![w] = "write"]
  /\ UNCHANGED <<lock, ledger, tmp, attempts, out, ever, seen>>

\* writeFile(RESULTS.tmp, lines): drop this case's old line, append the new verdict.
WriteTmp(w) ==
  /\ pc[w] = "write"
  /\ AtomicCommit
  /\ tmp' = Append(SelectSeq(view[w], LAMBDA r : r.id # out[w].id), out[w])
  /\ pc' = [pc EXCEPT ![w] = "commit"]
  /\ UNCHANGED <<lock, ledger, attempts, view, out, ever, seen>>

\* rename(RESULTS.tmp, RESULTS): the new content becomes the file in one step, so a reader never
\* sees the write in progress.
Commit(w) ==
  /\ pc[w] = "commit"
  /\ AtomicCommit
  /\ ledger' = tmp
  /\ ever' = ever \cup Ids(ledger')
  /\ pc' = [pc EXCEPT ![w] = "release"]
  /\ UNCHANGED <<lock, tmp, attempts, view, out, seen>>

\* The variant without the rename: writeFile(RESULTS, lines) truncates the file, and a reader can
\* read what is there before the rest of the line arrives.
DirectTruncate(w) ==
  /\ pc[w] = "write"
  /\ ~AtomicCommit
  /\ tmp' = Append(SelectSeq(view[w], LAMBDA r : r.id # out[w].id), out[w])
  /\ ledger' = <<[id |-> out[w].id]>>
  /\ pc' = [pc EXCEPT ![w] = "truncate"]
  /\ UNCHANGED <<lock, attempts, view, out, ever, seen>>

DirectFill(w) ==
  /\ pc[w] = "truncate"
  /\ ~AtomicCommit
  /\ ledger' = tmp
  /\ ever' = ever \cup Ids(ledger')
  /\ pc' = [pc EXCEPT ![w] = "release"]
  /\ UNCHANGED <<lock, tmp, attempts, view, out, seen>>

\* finally { unlink(lock) }.
Release(w) ==
  /\ pc[w] = "release"
  /\ lock' = NoLock
  /\ pc' = [pc EXCEPT ![w] = "done"]
  /\ UNCHANGED <<ledger, tmp, attempts, view, out, ever, seen>>

\* Killed while it records: the `finally` block never runs, so a held lock file stays on disk.
Crash(w) ==
  /\ CrashPossible
  /\ pc[w] \in {"tryLock", "waitLock"} \cup Holding
  /\ pc' = [pc EXCEPT ![w] = "dead"]
  /\ UNCHANGED <<lock, ledger, tmp, attempts, view, out, ever, seen>>

\* A reader: --summary, or --resume at the start of a later run. It takes no lock.
ReaderRead ==
  /\ seen' = seen \cup {ledger}
  /\ UNCHANGED <<lock, ledger, tmp, pc, attempts, view, out, ever>>

\* A line in the file that is not JSON: an append-only run of an earlier version was interrupted
\* mid-line, or someone edited the file.
Damage ==
  /\ DamagePossible
  /\ \A l \in Lines(ledger) : Whole(l)
  /\ ledger' = Append(ledger, TornLine)
  /\ UNCHANGED <<lock, tmp, pc, attempts, view, out, ever, seen>>

Next ==
  /\ \E w \in Writers :
       \/ Begin(w) \/ Acquire(w) \/ Retry(w) \/ Wake(w) \/ GiveUp(w) \/ Read(w) \/ WriteTmp(w)
       \/ Commit(w) \/ DirectTruncate(w) \/ DirectFill(w) \/ Release(w) \/ Crash(w)
  \/ ReaderRead
  \/ Damage

Spec == Init /\ [][Next]_vars

\* One line per case. A second line for a case would make `--resume` and the summary disagree about
\* which verdict counts.
OneLinePerCase ==
  \A c \in Cases : Cardinality({l \in Lines(ledger) : Whole(l) /\ l.id = c}) =< 1

\* A verdict, once written, is still in the file: only the same case may replace it.
NoVerdictLost == ever \subseteq Ids(ledger)

\* A reader never sees a file with a line it cannot parse.
ReadersSeeWholeContent == \A L \in seen : \A l \in Lines(L) : Whole(l)

\* The lock file is only ever held by a runner that is still in its critical section.
LockHeldByALiveWriter == \A w \in Writers : lock = w => pc[w] \in Recording

\* What a counterexample prints: the runners' positions, who holds the lock, and the file. The rest
\* of the state (attempts, views) only says how a runner got there.
TraceView == [lock |-> lock, ledger |-> ledger, pc |-> pc, recording |-> [w \in Writers |-> out[w].id]]

TypeOK ==
  /\ lock \in Writers \cup {NoLock}
  /\ \A l \in Lines(ledger) : l.id \in Cases \cup {"legacy"}
  /\ \A w \in Writers : pc[w] \in {"idle", "tryLock", "waitLock", "read", "write", "truncate",
                                    "commit", "release", "done", "gaveUp", "dead"}
  /\ \A w \in Writers : view[w] \in Seq([id : Cases, verdict : Verdicts])
=============================================================================
