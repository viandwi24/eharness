/** Resolve after `ms` milliseconds. Shared by the conformance suites; not exported from the barrel. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))
