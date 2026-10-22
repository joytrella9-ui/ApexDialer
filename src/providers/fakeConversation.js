import { aiOpening, aiReplyFor, classifyIntent } from '../services/ai.js';

// Conversation boundary. The fake adapter reuses the existing deterministic,
// offline intent classifier and scripted replies — it contacts no model. A real
// adapter would implement `classify`/`reply` against an LLM while preserving the
// same intent vocabulary so routing and dispositions are unchanged.
export class FakeConversationProvider {
  constructor() {
    this.name = 'fake-conversation';
  }

  opening(lead) {
    return aiOpening(lead);
  }

  classify(text) {
    return classifyIntent(text);
  }

  reply(intent) {
    return aiReplyFor(intent);
  }
}
