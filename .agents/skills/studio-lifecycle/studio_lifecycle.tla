--------------------------- MODULE studio_lifecycle ---------------------------
(*
  The run lifecycle of the studio's store: one task at a time, one terminal status per run.

  apps/jev-studio/server/store.mjs
    start({goal, maxSteps})
      if (active()) throw 409                      -> Start        only one run may be active
      runs.set(id, run) with status 'running'      -> Start
      spawn(...) returns a child                   -> Spawned
      spawn throws                                 -> SpawnFails   finish('failed')
      child.stdout 'data' {type:'result'}          -> Result       run.outcome := event.outcome
      child.stdout 'data' {type:'error'}           -> ErrorEvent   run.error := event.message
      child.stdout 'data' over 1 MB                -> OutputLimit  run.error := the limit, then the task is
                                                                     killed the way `stop` kills one
      child.once('error') -> finish('failed')      -> SpawnError   the run ends while the child lives
      child.once('close', code)                    -> Close        the one place a run is reported
        if (run.status === 'stopping')                     -> 'stopped'
        else if (code !== 0 || run.error || !outcome)      -> 'failed'
        else if (outcome === 'done')                       -> 'succeeded'
        else if (outcome is step_limit | decision_limit)   -> 'exhausted'
        else                                               -> 'blocked'
    stop(id)
      if (!child || run.endedAt !== null) return   -> StopChecksEnded: an ended run takes no stop
      run.status = 'stopping'; kill('SIGTERM')     -> Stop
      setTimeout(3 s): if (processes.has(id))
        kill('SIGKILL')                            -> KillTimer    the escalation, armed by Stop
      a timer that fires after finish (which
        deletes the id from `processes`)           -> LateKill     does nothing
    finish(status, message)
      if (run.endedAt !== null) return             -> every report below requires ended = "none"
      run.status = status; run.endedAt = now()     -> the report, and the `ended` latch

  The constants at the bottom turn one mechanism off at a time, so this module also describes the
  store without its 409 guard (OneAtATime), with `stop` resurrecting a run that already ended
  (StopChecksEnded), without the SIGKILL escalation (EscalateStop), and with a clean exit taken as
  success whatever the task reported (OutcomeDecides).
*)
EXTENDS Naturals

CONSTANTS Runs,           \* run ids a client may start, e.g. {"r1", "r2"}
          OneAtATime,      \* FALSE: `active()` no longer refuses a second start
          StopChecksEnded, \* FALSE: `stop` no longer returns early for a run that ended
          EscalateStop,    \* FALSE: `stop` never arms the 3 s SIGKILL
          OutcomeDecides   \* FALSE: any exit code 0 is reported as success

Terminal == {"succeeded", "failed", "stopped", "exhausted", "blocked"}
Active == {"running", "stopping"}
\* Three outcomes are enough to reach every branch of the report: success, "not done", "ran out".
Outcomes == {"done", "blocked", "step_limit"}
Codes == {0, 1}

VARIABLES status,        \* id, running, stopping, or a terminal status
          process,       \* none, spawning, live, dead
          outcome,       \* none, or the last result the task printed
          error,         \* none, or an error event / a failed spawn
          signal,        \* none, term, kill: what the store sent the task
          timer,         \* none, armed, fired: the 3 s SIGKILL timer
          ended,         \* none, or the terminal status the store reported first
          closedOutcome  \* the outcome in hand when it was reported

vars == <<status, process, outcome, error, signal, timer, ended, closedOutcome>>

Init ==
  /\ status = [r \in Runs |-> "idle"]
  /\ process = [r \in Runs |-> "none"]
  /\ outcome = [r \in Runs |-> "none"]
  /\ error = [r \in Runs |-> "none"]
  /\ signal = [r \in Runs |-> "none"]
  /\ timer = [r \in Runs |-> "none"]
  /\ ended = [r \in Runs |-> "none"]
  /\ closedOutcome = [r \in Runs |-> "none"]

\* A request arrives for an idle run while no other run holds the device.
Start(r) ==
  /\ status[r] = "idle"
  /\ OneAtATime => \A o \in Runs : status[o] \notin Active
  /\ status' = [status EXCEPT ![r] = "running"]
  /\ process' = [process EXCEPT ![r] = "spawning"]
  /\ UNCHANGED <<outcome, error, signal, timer, ended, closedOutcome>>

Spawned(r) ==
  /\ process[r] = "spawning"
  /\ process' = [process EXCEPT ![r] = "live"]
  /\ UNCHANGED <<status, outcome, error, signal, timer, ended, closedOutcome>>

\* spawn() threw: the run exists and is reported failed without ever having a task.
SpawnFails(r) ==
  /\ process[r] = "spawning"
  /\ ended[r] = "none"
  /\ process' = [process EXCEPT ![r] = "dead"]
  /\ status' = [status EXCEPT ![r] = "failed"]
  /\ ended' = [ended EXCEPT ![r] = "failed"]
  /\ UNCHANGED <<outcome, error, signal, timer, closedOutcome>>

Result(r, o) ==
  /\ process[r] = "live"
  /\ status[r] \in Active
  /\ o \in Outcomes
  /\ outcome' = [outcome EXCEPT ![r] = o]
  /\ UNCHANGED <<status, process, error, signal, timer, ended, closedOutcome>>

ErrorEvent(r) ==
  /\ process[r] = "live"
  /\ error[r] = "none"
  /\ error' = [error EXCEPT ![r] = "message"]
  /\ UNCHANGED <<status, process, outcome, signal, timer, ended, closedOutcome>>

Stop(r) ==
  /\ process[r] \in {"spawning", "live"}
  /\ status[r] \in Active \/ (~StopChecksEnded /\ status[r] \in Terminal)
  /\ status' = [status EXCEPT ![r] = "stopping"]
  /\ signal' = [signal EXCEPT ![r] = "term"]
  /\ timer' = [timer EXCEPT ![r] = IF EscalateStop THEN "armed" ELSE "none"]
  /\ UNCHANGED <<process, outcome, error, ended, closedOutcome>>

\* `child.stdout 'data'` past the 1 MB limit: the store records why, then takes the device away from
\* the task the way `stop` does, so a flood cannot leave a live child the store no longer tracks.
OutputLimit(r) ==
  /\ process[r] = "live"
  /\ status[r] \in Active
  /\ error' = [error EXCEPT ![r] = "output limit"]
  /\ status' = [status EXCEPT ![r] = "stopping"]
  /\ signal' = [signal EXCEPT ![r] = "term"]
  /\ timer' = [timer EXCEPT ![r] = IF EscalateStop THEN "armed" ELSE "none"]
  /\ UNCHANGED <<process, outcome, ended, closedOutcome>>

\* Three seconds later: the id is still in `processes`, so it is killed.
KillTimer(r) ==
  /\ status[r] = "stopping"
  /\ timer[r] = "armed"
  /\ process[r] = "live"
  /\ ended[r] = "none"
  /\ signal' = [signal EXCEPT ![r] = "kill"]
  /\ timer' = [timer EXCEPT ![r] = "fired"]
  /\ UNCHANGED <<status, process, outcome, error, ended, closedOutcome>>

\* The same timer firing after `finish` deleted the id: it finds nothing to kill.
LateKill(r) ==
  /\ status[r] \in Terminal
  /\ timer[r] = "armed"
  /\ timer' = [timer EXCEPT ![r] = "fired"]
  /\ UNCHANGED <<status, process, outcome, error, signal, ended, closedOutcome>>

\* `child.once('error')`: the run is reported before the child is closed.
SpawnError(r) ==
  /\ process[r] = "live"
  /\ ended[r] = "none"
  /\ status' = [status EXCEPT ![r] = "failed"]
  /\ ended' = [ended EXCEPT ![r] = "failed"]
  /\ error' = [error EXCEPT ![r] = "could not start"]
  /\ UNCHANGED <<outcome, signal, timer, process, closedOutcome>>

\* `child.once('close', code)`: the one place the finished status is decided.
Close(r, code) ==
  /\ process[r] = "live"
  /\ code \in Codes
  /\ ended[r] = "none"
  /\ LET report ==
           IF status[r] = "stopping" THEN "stopped"
           ELSE IF ~OutcomeDecides /\ code = 0 THEN "succeeded"
           ELSE IF code # 0 \/ error[r] # "none" \/ outcome[r] = "none" THEN "failed"
           ELSE IF outcome[r] = "done" THEN "succeeded"
           ELSE IF outcome[r] \in {"step_limit", "decision_limit"} THEN "exhausted"
           ELSE "blocked"
     IN /\ status' = [status EXCEPT ![r] = report]
        /\ ended' = [ended EXCEPT ![r] = report]
        /\ closedOutcome' = [closedOutcome EXCEPT ![r] = outcome[r]]
  /\ process' = [process EXCEPT ![r] = "dead"]
  /\ UNCHANGED <<outcome, error, signal, timer>>

Next ==
  \/ \E r \in Runs : Start(r) \/ Spawned(r) \/ SpawnFails(r) \/ ErrorEvent(r) \/ Stop(r)
       \/ OutputLimit(r) \/ KillTimer(r) \/ LateKill(r) \/ SpawnError(r)
  \/ \E r \in Runs, o \in Outcomes : Result(r, o)
  \/ \E r \in Runs, code \in Codes : Close(r, code)
  \/ UNCHANGED vars        \* no request and no event pending: the store is quiescent

Spec == Init /\ [][Next]_vars

\* The studio drives one device, so a second run must wait for the first to end.
SingleActive ==
  \A r, o \in Runs : (status[r] \in Active /\ status[o] \in Active) => r = o

\* A run the store has reported never changes its mind, and never takes the device back.
EndedIsFinal ==
  \A r \in Runs : ended[r] # "none" => status[r] = ended[r]

\* Every stop leaves a kill behind it, so a task that ignores SIGTERM cannot hold the run forever.
StoppingIsArmed ==
  \A r \in Runs : status[r] = "stopping" => timer[r] # "none"

\* Success is the task's own answer, not a clean exit code.
SucceededNeedsDone ==
  \A r \in Runs : ended[r] = "succeeded" => closedOutcome[r] = "done"

=================================================================================
