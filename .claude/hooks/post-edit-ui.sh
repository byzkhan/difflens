#!/bin/bash
# PostToolUse hook: remind Claude to run visual check after editing UI files
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Check if file has a UI-related extension
if [[ "$FILE_PATH" =~ \.(html|css|jsx|tsx|vue|svelte|scss|sass|less)$ ]]; then
  cat <<'EOF'
{
  "additionalContext": "[DiffLens] You just edited a UI file. Once you are done with ALL edits for this change, call `check` (or `check_responsive` for layout changes) on the dev server URL to verify there are no unintended visual regressions. Do NOT skip this step."
}
EOF
  exit 0
fi

exit 0
