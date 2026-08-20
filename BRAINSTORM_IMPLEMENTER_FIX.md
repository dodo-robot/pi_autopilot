# Brainstorm: Fixing Implementer Completion Detection

## Problem Statement

The autopilot implementer successfully completes work but doesn't call `submit_result`, causing the orchestrator to mark the run as FAILED with "no structured result submitted by implementer".

**Observed behavior:**
- Implementer writes correct code
- All tests pass (verification would succeed)
- Implementer ends turn naturally with `rawStopReason: "end_turn"`
- Final message contains "COMPLETED" text
- But `submit_result` tool is never called
- Result: orchestrator treats this as FAILED

**Current architecture:**
1. Guard extension (`src/pi/guard-extension.ts`) registers `submit_result` tool
2. Implementer prompt (`src/workflow/run-service.ts`) says "Report COMPLETED only when done" but doesn't mention the tool
3. Pi runner (`src/pi/pi-runner.ts`) checks for `result.json` file existence after process exits
4. If file doesn't exist → throw `PiRunError("no structured result submitted by ${role}")`

## Root Causes

1. **Prompt ambiguity**: "Report COMPLETED" is vague - the implementer interprets it as "say the word COMPLETED in my response" not "call the submit_result tool"
2. **Tool discoverability**: The implementer sees `submit_result` in its tool list but the prompt doesn't emphasize it must be called
3. **Natural completion**: Modern LLMs naturally end conversations with `end_turn` when they feel done, without explicitly calling a submission tool

## Solution Options

### Option A: Detect Natural Completion (Parser Approach)

**Concept**: Make the orchestrator recognize when implementer is "done" even without calling `submit_result`.

**Implementation:**
1. After Pi session ends, check if `result.json` exists
2. If not, parse the session log for signals of completion:
   - Last assistant message has `rawStopReason: "end_turn"`
   - Final text contains patterns like "COMPLETED", "implementation is complete", etc.
   - No tool calls in final turn (suggests wrap-up, not mid-work interruption)
3. If detected as complete, synthesize a minimal result from git state:
   ```typescript
   {
     outcome: "COMPLETED",
     summary: extractedFromFinalMessage,
     changedPaths: getGitStatusPaths(),
     commandsAttempted: [],
     unresolvedProblems: [],
     evidenceLocations: []
   }
   ```

**Pros:**
- Backward compatible - works with any LLM that naturally ends conversations
- No prompt engineering needed
- Handles the "forgetting to call submit_result" gracefully

**Cons:**
- Heuristic-based, could have false positives
- Loses structured data (summary quality depends on parsing)
- Doesn't enforce discipline

**Files to modify:**
- `src/pi/pi-runner.ts` - add fallback logic after process exits
- New: `src/pi/completion-detector.ts` - parse session log for completion signals

---

### Option B: Strengthen Prompt (Explicit Instructions)

**Concept**: Make the prompt crystal clear that `submit_result` must be called.

**Implementation:**
Change `buildImplementerPrompt` in `src/workflow/run-service.ts`:
```typescript
function buildImplementerPrompt(snapshot: TaskSnapshot): string {
  return [
    "You are the implementer for a bounded, supervised task.",
    "",
    "IMPORTANT: When you finish the task, you MUST call the submit_result tool",
    "with outcome='COMPLETED' and a summary. Do not just say 'COMPLETED' in text.",
    "The run will fail if submit_result is not called.",
    "",
    "Implement exactly the task snapshot below:",
    JSON.stringify(snapshot, null, 2),
  ].join("\n\n");
}
```

Add similar emphasis to correction prompts.

**Pros:**
- Simple, direct fix
- Preserves structured result contract
- Forces implementer to think about what to report

**Cons:**
- Relies on LLM instruction-following (may still forget)
- Doesn't help if implementer is interrupted or times out mid-work
- Verbose prompt

---

### Option C: Make submit_result Non-optional (System Constraint)

**Concept**: Change the guard extension to make `submit_result` mandatory before session can end.

**Implementation:**
1. Add a global flag in guard extension: `let resultSubmitted = false`
2. In `submit_result` tool handler, set flag to true
3. Hook into Pi's session lifecycle:
   - Add a `pi.on("session_end")` or similar hook
   - If `!resultSubmitted`, block the natural end and inject a user message:
     "You must call submit_result before ending. What is the outcome?"
4. Give implementer one more turn to submit

**Pros:**
- Enforces the contract at runtime
- Catches the issue immediately
- Works regardless of prompt clarity

**Cons:**
- Requires Pi extension API to support session lifecycle hooks (may not exist)
- Could create infinite loops if implementer still doesn't call it
- More complex guard logic

**Risk**: If Pi doesn't support blocking session end, this isn't feasible.

---

### Option D: Hybrid - Gentle Reminder + Fallback Detection

**Concept**: Strengthen prompt (Option B) AND add fallback detection (Option A).

**Implementation:**
1. Update prompts to explicitly mention `submit_result`
2. Add session log parser as safety net
3. If natural completion detected, write a WARNING to the run diagnostics but still accept it

**Pros:**
- Best of both worlds
- Robust to both instruction-following failures and timeouts
- Provides telemetry (can track how often fallback triggers)

**Cons:**
- Most code to write
- Introduces complexity

---

## Resume Capability Analysis

### Current Resume Behavior

`autopilot resume <run-id>` command exists but:
- Only works on runs in `BLOCKED` stage
- FAILED runs are terminal and cannot be resumed
- Resume creates a fresh implementer session with no prior transcript

**Relevant code:**
- `src/commands/resume.ts` - CLI entry point
- `src/workflow/recovery-service.ts` - validates stage is BLOCKED
- `buildResumeCorrectionPrompt()` - prompt for resumed session

### Can We Resume FAILED Runs?

**Current limitation**: The recovery service explicitly checks for BLOCKED:
```typescript
// RecoveryService.resume() probably does:
if (run.stage !== "BLOCKED") {
  throw new Error("can only resume BLOCKED runs");
}
```

**Options to enable FAILED resume:**

#### Option 1: Extend Resume to Accept FAILED
Change `RecoveryService.resume()` to allow FAILED runs:
```typescript
if (run.stage !== "BLOCKED" && run.stage !== "FAILED") {
  throw new Error("can only resume BLOCKED or FAILED runs");
}
```

**Trade-off**: FAILED could mean many things (implementer crashed, timeout, bad result format). Resume assumes workspace is intact, which may not be true for all failure modes.

#### Option 2: Add a Manual Recovery Command
New command: `autopilot recover <run-id>` that:
- Works on FAILED runs
- Checks if worktree still exists
- Transitions FAILED → BLOCKED
- Then user runs `resume`

This separates the "mark recoverable" decision from the actual resume.

#### Option 3: Detect Recoverable vs Non-recoverable Failures
Add failure classification:
```typescript
type FailureReason = 
  | "NO_RESULT_SUBMITTED"  // Recoverable
  | "INVALID_RESULT_FORMAT"  // Recoverable
  | "PROCESS_CRASHED"  // Maybe recoverable
  | "WORKSPACE_CORRUPTED"  // NOT recoverable
```

Only allow resume on recoverable failures.

---

## Recommendation

**Short term (MVP fix):**
- **Option B**: Strengthen the prompt to explicitly mention `submit_result`
- Test with a few runs to see if it reduces the failure rate

**Medium term (robustness):**
- **Option D**: Add fallback detection as safety net
- Collect metrics on how often fallback triggers

**Long term (recovery):**
- **Option 3**: Classify failure reasons and allow resume only on recoverable failures
- This handles the current run 0c32c40a which has good code but just needs to submit

**Immediate workaround for run 0c32c40a:**
Since the work is actually complete, we could:
1. Manually construct the `result.json` file
2. Write it to the expected path
3. Manually transition the run from FAILED → BLOCKED or create a new recovery path

---

## Questions for User

1. **Prompt strength preference**: Do you prefer explicit "MUST call submit_result" language, or more implicit guidance?

2. **Fallback detection**: Should we parse session logs for natural completion, or strictly enforce the tool call?

3. **Resume scope**: Should FAILED runs be resumable, or only specific failure types?

4. **Current run**: For run `0c32c40a-d64d-4a90-a0ef-3b30b735f3b1`, do you want to:
   - Manually recover it (code is good, just needs formal submission)?
   - Abandon and re-run with a fixed prompt?
   - Use it as a test case for the new fallback detector?

5. **Testing strategy**: Should we add integration tests that intentionally omit `submit_result` to verify fallback behavior?
