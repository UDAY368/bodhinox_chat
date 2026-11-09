/** Thrown when an agent has paused bot replies on the conversation. Its own module so tests that mock bot-pause keep the class. */
export class BotRepliesPausedError extends Error {
  constructor() {
    super('Bot replies are paused by an agent; resume them in the inbox')
    this.name = 'BotRepliesPausedError'
  }
}
