/**
 * In-process queue of questions for the user (docs/plans/P30-coder-example.md §6.4). The UI shows
 * `pending()` and calls `answer()`; main agent and subagents ask through the same broker.
 */
import type {
  ApprovalAnswer,
  ApprovalBroker,
  ApprovalRequest,
  QuestionRequest,
  QuestionResult,
} from '../contracts.ts'

interface Entry {
  request: ApprovalRequest
  resolve: (answer: ApprovalAnswer) => void
  cleanup: () => void
}

interface QuestionEntry {
  request: QuestionRequest
  resolve: (result: QuestionResult) => void
  cleanup: () => void
}

const INTERRUPTED: ApprovalAnswer = { approved: false, feedback: 'Interrupted.' }

/**
 * Create a broker with a FIFO queue. `ask` resolves when `answer(id, …)` is called, or with
 * `{ approved: false, feedback: 'Interrupted.' }` when its signal aborts (it never rejects).
 */
export function createBroker(): ApprovalBroker {
  const queue: Entry[] = []
  const questions: QuestionEntry[] = []
  const listeners = new Set<(pending: ApprovalRequest[]) => void>()

  const pending = (): ApprovalRequest[] => queue.map((entry) => entry.request)
  const notify = (): void => {
    const snapshot = pending()
    for (const listener of [...listeners]) listener(snapshot)
  }
  const removeQuestion = (entry: QuestionEntry): boolean => {
    const index = questions.indexOf(entry)
    if (index < 0) return false
    questions.splice(index, 1)
    entry.cleanup()
    return true
  }
  const remove = (entry: Entry): boolean => {
    const index = queue.indexOf(entry)
    if (index < 0) return false
    queue.splice(index, 1)
    entry.cleanup()
    return true
  }

  return {
    ask(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalAnswer> {
      if (signal?.aborted === true) return Promise.resolve(INTERRUPTED)
      return new Promise<ApprovalAnswer>((resolve) => {
        const entry: Entry = { request, resolve, cleanup: () => {} }
        if (signal !== undefined) {
          const onAbort = (): void => {
            if (remove(entry)) {
              notify()
              resolve(INTERRUPTED)
            }
          }
          signal.addEventListener('abort', onAbort, { once: true })
          entry.cleanup = () => signal.removeEventListener('abort', onAbort)
        }
        queue.push(entry)
        notify()
      })
    },
    pending,
    answer(id: string, answer: ApprovalAnswer): void {
      const entry = queue.find((e) => e.request.id === id)
      if (entry === undefined) return
      remove(entry)
      notify()
      entry.resolve(answer)
    },
    question(request: QuestionRequest, signal?: AbortSignal): Promise<QuestionResult> {
      if (signal?.aborted === true) return Promise.resolve(null)
      return new Promise<QuestionResult>((resolve) => {
        const entry: QuestionEntry = { request, resolve, cleanup: () => {} }
        if (signal !== undefined) {
          const onAbort = (): void => {
            if (removeQuestion(entry)) {
              notify()
              resolve(null)
            }
          }
          signal.addEventListener('abort', onAbort, { once: true })
          entry.cleanup = () => signal.removeEventListener('abort', onAbort)
        }
        questions.push(entry)
        notify()
      })
    },
    pendingQuestions: () => questions.map((entry) => entry.request),
    answerQuestion(id: string, result: QuestionResult): void {
      const entry = questions.find((e) => e.request.id === id)
      if (entry === undefined) return
      removeQuestion(entry)
      notify()
      entry.resolve(result)
    },
    subscribe(listener: (pending: ApprovalRequest[]) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * A broker for print mode: nothing is ever shown, every approval is denied with `reason` and every `ask_user_question` is dismissed.
 *
 * @param reason - Feedback the model reads. Default: approval is not available non-interactively.
 */
export function createDenyingBroker(reason?: string): ApprovalBroker {
  const feedback = reason ?? 'Approval is not available in non-interactive mode.'
  return {
    ask: () => Promise.resolve({ approved: false, feedback }),
    pending: () => [],
    answer: () => {},
    question: () => Promise.resolve(null),
    pendingQuestions: () => [],
    answerQuestion: () => {},
    subscribe: () => () => {},
  }
}
