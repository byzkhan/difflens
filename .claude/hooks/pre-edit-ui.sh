#!/bin/bash
# PreToolUse hook: remind Claude to snapshot before editing UI files
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Check if file has a UI-related extension
if [[ "$FILE_PATH" =~ \.(html|css|jsx|tsx|vue|svelte|scss|sass|less)$ ]]; then
  cat <<'EOF'
{
  "additionalContext": "[DiffLens] You are about to edit a UI file. BEFORE making this edit, ensure you have already called `snapshot` on the dev server URL to save a baseline. If you haven't taken a snapshot yet for this task, do it NOW before proceeding with the edit. If the user hasn't told you the dev server URL, ask them first."
}
EOF
  exit 0
fi

exit 0
