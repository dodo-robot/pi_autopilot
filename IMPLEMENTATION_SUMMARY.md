# Implementation Summary: Explicit submit_result Prompt (Option B)

## Changes Made

### Modified File
`src/workflow/run-service.ts` - Updated 4 prompt builder functions

### Functions Updated

1. **`buildImplementerPrompt`** (initial implementation attempt)
2. **`buildResumeCorrectionPrompt`** (administratively resumed run)
3. **`buildVerificationCorrectionPrompt`** (fixing failed verification)
4. **`buildReviewCorrectionPrompt`** (addressing review findings)

### New Prompt Structure

Each prompt now includes an explicit instruction block:

```
IMPORTANT: When you finish [implementing/fixing/addressing] [the task/issues/review], 
you MUST call the submit_result tool with your outcome (COMPLETED, BLOCKED, 
NEEDS_REFINEMENT, or NEEDS_REPLAN). Do not just write 'COMPLETED' in text. 
The run will fail if submit_result is not called.
```

### Example: buildImplementerPrompt

**Before:**
```typescript
return [
  "You are the implementer for a bounded, supervised task.",
  "Implement exactly the task snapshot below. Report COMPLETED only when done.",
  JSON.stringify(snapshot, null, 2),
].join("\n\n");
```

**After:**
```typescript
return [
  "You are the implementer for a bounded, supervised task.",
  "",
  "IMPORTANT: When you finish implementing the task, you MUST call the",
  "submit_result tool with your outcome (COMPLETED, BLOCKED, NEEDS_REFINEMENT,",
  "or NEEDS_REPLAN). Do not just write 'COMPLETED' in text. The run will fail",
  "if submit_result is not called.",
  "",
  "Implement exactly the task snapshot below:",
  JSON.stringify(snapshot, null, 2),
].join("\n\n");
```

## Verification

### Type Check
✅ `npx tsc --noEmit` - passes

### Tests
✅ All 388 tests pass
- 31 test files
- Duration: 12.18s
- No regressions

### Build
✅ `npm run build` - clean compilation

### Prompt Content Check
✅ All 4 implementer prompt functions now mention `submit_result`:
- buildImplementerPrompt: ✅
- buildResumeCorrectionPrompt: ✅
- buildVerificationCorrectionPrompt: ✅
- buildReviewCorrectionPrompt: ✅

## Expected Behavior Changes

### Before This Fix
1. Implementer completes work
2. Writes "COMPLETED" in final message
3. Ends turn naturally with `end_turn`
4. Never calls `submit_result` tool
5. Orchestrator marks run as FAILED

### After This Fix
1. Implementer sees explicit instruction about `submit_result`
2. Understands it MUST call the tool (not just write text)
3. Calls `submit_result` with structured outcome
4. Tool writes `result.json` file
5. Orchestrator recognizes completion successfully

## Testing the Fix

### Manual Test
```bash
cd /Users/andrea.dodero/Work/minerva/minerva-engine-core

# Clean up previous attempts
git worktree list  # check for old worktrees
git worktree prune
git branch -D autopilot/177-*  # if any exist

# Run with new prompt
autopilot run 177
```

### Expected Result
The implementer should now call `submit_result` before ending, and the run should:
- Complete successfully to PR_OPEN stage
- Have a valid `result.json` file
- Not fail with "no structured result submitted"

### Monitoring
Watch for:
```bash
# Check run status
autopilot status <run-id>

# Check for result file
ls -la ~/.local/share/pi-autopilot/runs/<run-id>/implementer-1/diagnostics/result.json

# Tail session log to see when submit_result is called
tail -f ~/.local/share/pi-autopilot/runs/<run-id>/implementer-1/session/*.jsonl | grep submit_result
```

## Rollback Plan

If this doesn't work or causes issues:
```bash
git checkout HEAD -- src/workflow/run-service.ts
npm run build
```

## Next Steps

1. **Test on issue #177**: Run `autopilot run 177` to verify fix works
2. **Monitor success rate**: Track if implementers now consistently call `submit_result`
3. **Collect data**: If failures still occur, they may justify implementing Option D (hybrid fallback)
4. **Consider Option D**: If prompt alone isn't sufficient, add natural completion detection as fallback

## Related Documents

- `BRAINSTORM_IMPLEMENTER_FIX.md` - Full analysis of all solution options
- `IMPLEMENTER_COMPLETION_ISSUE.md` - Original issue investigation and evidence
- Failed run for reference: `0c32c40a-d64d-4a90-a0ef-3b30b735f3b1`
