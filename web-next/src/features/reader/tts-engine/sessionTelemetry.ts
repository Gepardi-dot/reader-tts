export class FirstAudioGate {
  private reportedSessionId: number | null = null

  reset() {
    this.reportedSessionId = null
  }

  shouldReport(sessionId: number, currentSessionId: number) {
    if (sessionId !== currentSessionId) return false
    if (this.reportedSessionId === sessionId) return false
    this.reportedSessionId = sessionId
    return true
  }
}
