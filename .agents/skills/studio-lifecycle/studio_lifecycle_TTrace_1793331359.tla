---- MODULE studio_lifecycle_TTrace_1793331359 ----
EXTENDS studio_lifecycle, Sequences, TLCExt, Toolbox, Naturals, TLC

_expression ==
    LET studio_lifecycle_TEExpression == INSTANCE studio_lifecycle_TEExpression
    IN studio_lifecycle_TEExpression!expression
----

_trace ==
    LET studio_lifecycle_TETrace == INSTANCE studio_lifecycle_TETrace
    IN studio_lifecycle_TETrace!trace
----

_inv ==
    ~(
        TLCGet("level") = Len(_TETrace)
        /\
        timer = ([r1 |-> "none", r2 |-> "none"])
        /\
        process = ([r1 |-> "spawning", r2 |-> "none"])
        /\
        ended = ([r1 |-> "none", r2 |-> "none"])
        /\
        closedOutcome = ([r1 |-> "none", r2 |-> "none"])
        /\
        error = ([r1 |-> "none", r2 |-> "none"])
        /\
        signal = ([r1 |-> "term", r2 |-> "none"])
        /\
        outcome = ([r1 |-> "none", r2 |-> "none"])
        /\
        status = ([r1 |-> "stopping", r2 |-> "idle"])
    )
----

_init ==
    /\ ended = _TETrace[1].ended
    /\ error = _TETrace[1].error
    /\ closedOutcome = _TETrace[1].closedOutcome
    /\ timer = _TETrace[1].timer
    /\ outcome = _TETrace[1].outcome
    /\ status = _TETrace[1].status
    /\ signal = _TETrace[1].signal
    /\ process = _TETrace[1].process
----

_next ==
    /\ \E i,j \in DOMAIN _TETrace:
        /\ \/ /\ j = i + 1
              /\ i = TLCGet("level")
        /\ ended  = _TETrace[i].ended
        /\ ended' = _TETrace[j].ended
        /\ error  = _TETrace[i].error
        /\ error' = _TETrace[j].error
        /\ closedOutcome  = _TETrace[i].closedOutcome
        /\ closedOutcome' = _TETrace[j].closedOutcome
        /\ timer  = _TETrace[i].timer
        /\ timer' = _TETrace[j].timer
        /\ outcome  = _TETrace[i].outcome
        /\ outcome' = _TETrace[j].outcome
        /\ status  = _TETrace[i].status
        /\ status' = _TETrace[j].status
        /\ signal  = _TETrace[i].signal
        /\ signal' = _TETrace[j].signal
        /\ process  = _TETrace[i].process
        /\ process' = _TETrace[j].process

\* Uncomment the ASSUME below to write the states of the error trace
\* to the given file in Json format. Note that you can pass any tuple
\* to `JsonSerialize`. For example, a sub-sequence of _TETrace.
    \* ASSUME
    \*     LET J == INSTANCE Json
    \*         IN J!JsonSerialize("studio_lifecycle_TTrace_1793331359.json", _TETrace)

=============================================================================

 Note that you can extract this module `studio_lifecycle_TEExpression`
  to a dedicated file to reuse `expression` (the module in the 
  dedicated `studio_lifecycle_TEExpression.tla` file takes precedence 
  over the module `studio_lifecycle_TEExpression` below).

---- MODULE studio_lifecycle_TEExpression ----
EXTENDS studio_lifecycle, Sequences, TLCExt, Toolbox, Naturals, TLC

expression == 
    [
        \* To hide variables of the `studio_lifecycle` spec from the error trace,
        \* remove the variables below.  The trace will be written in the order
        \* of the fields of this record.
        ended |-> ended
        ,error |-> error
        ,closedOutcome |-> closedOutcome
        ,timer |-> timer
        ,outcome |-> outcome
        ,status |-> status
        ,signal |-> signal
        ,process |-> process
        
        \* Put additional constant-, state-, and action-level expressions here:
        \* ,_stateNumber |-> _TEPosition
        \* ,_endedUnchanged |-> ended = ended'
        
        \* Format the `ended` variable as Json value.
        \* ,_endedJson |->
        \*     LET J == INSTANCE Json
        \*     IN J!ToJson(ended)
        
        \* Lastly, you may build expressions over arbitrary sets of states by
        \* leveraging the _TETrace operator.  For example, this is how to
        \* count the number of times a spec variable changed up to the current
        \* state in the trace.
        \* ,_endedModCount |->
        \*     LET F[s \in DOMAIN _TETrace] ==
        \*         IF s = 1 THEN 0
        \*         ELSE IF _TETrace[s].ended # _TETrace[s-1].ended
        \*             THEN 1 + F[s-1] ELSE F[s-1]
        \*     IN F[_TEPosition - 1]
    ]

=============================================================================



Parsing and semantic processing can take forever if the trace below is long.
 In this case, it is advised to uncomment the module below to deserialize the
 trace from a generated binary file.

\*
\*---- MODULE studio_lifecycle_TETrace ----
\*EXTENDS studio_lifecycle, IOUtils, TLC
\*
\*trace == IODeserialize("studio_lifecycle_TTrace_1793331359.bin", TRUE)
\*
\*=============================================================================
\*

---- MODULE studio_lifecycle_TETrace ----
EXTENDS studio_lifecycle, TLC

trace == 
    <<
    ([timer |-> [r1 |-> "none", r2 |-> "none"],process |-> [r1 |-> "none", r2 |-> "none"],ended |-> [r1 |-> "none", r2 |-> "none"],closedOutcome |-> [r1 |-> "none", r2 |-> "none"],error |-> [r1 |-> "none", r2 |-> "none"],signal |-> [r1 |-> "none", r2 |-> "none"],outcome |-> [r1 |-> "none", r2 |-> "none"],status |-> [r1 |-> "idle", r2 |-> "idle"]]),
    ([timer |-> [r1 |-> "none", r2 |-> "none"],process |-> [r1 |-> "spawning", r2 |-> "none"],ended |-> [r1 |-> "none", r2 |-> "none"],closedOutcome |-> [r1 |-> "none", r2 |-> "none"],error |-> [r1 |-> "none", r2 |-> "none"],signal |-> [r1 |-> "none", r2 |-> "none"],outcome |-> [r1 |-> "none", r2 |-> "none"],status |-> [r1 |-> "running", r2 |-> "idle"]]),
    ([timer |-> [r1 |-> "none", r2 |-> "none"],process |-> [r1 |-> "spawning", r2 |-> "none"],ended |-> [r1 |-> "none", r2 |-> "none"],closedOutcome |-> [r1 |-> "none", r2 |-> "none"],error |-> [r1 |-> "none", r2 |-> "none"],signal |-> [r1 |-> "term", r2 |-> "none"],outcome |-> [r1 |-> "none", r2 |-> "none"],status |-> [r1 |-> "stopping", r2 |-> "idle"]])
    >>
----


=============================================================================

---- CONFIG studio_lifecycle_TTrace_1793331359 ----
CONSTANTS
    Runs = { "r1" , "r2" }
    OneAtATime = TRUE
    StopChecksEnded = TRUE
    EscalateStop = FALSE
    OutcomeDecides = TRUE

INVARIANT
    _inv

CHECK_DEADLOCK
    \* CHECK_DEADLOCK off because of PROPERTY or INVARIANT above.
    FALSE

INIT
    _init

NEXT
    _next

CONSTANT
    _TETrace <- _trace

ALIAS
    _expression
=============================================================================
\* Generated on Fri Oct 30 11:36:00 CST 2026