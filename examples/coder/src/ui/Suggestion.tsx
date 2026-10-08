/** Next-prompt suggestion: the dim placeholder of an empty prompt, accepted with Tab or →. */
import { useInput } from 'ink'

/** Props of {@link SuggestionKeys}. */
export interface SuggestionKeysProps {
  /** The suggestion, or undefined when there is none. */
  suggestion: string | undefined
  /** Only an empty prompt with nothing else open may accept it. */
  enabled: boolean
  onAccept(text: string): void
}

/** Renders nothing; listens for Tab / → while a suggestion is shown on an empty prompt. */
export function SuggestionKeys({ suggestion, enabled, onAccept }: SuggestionKeysProps): null {
  useInput(
    (_input, key) => {
      if (!suggestion) return
      if ((key.tab && !key.shift) || key.rightArrow) onAccept(suggestion)
    },
    { isActive: enabled && suggestion !== undefined },
  )
  return null
}
