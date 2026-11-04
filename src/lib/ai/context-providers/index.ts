// Fixed, read-only context providers for the AI business assistant.
//
// Context is fetched BEFORE a model call by these providers only; the model
// has no tools and no provider ever takes model output as input. Each
// provider runs inside withTenant for the requesting member (or the worker
// for a job whose requester was rechecked) and declares the lowest role and
// the audiences it may serve; loadContext enforces both.
//
// Built in: conversation, contactBasics, openDeal, orderStatus (staff),
// appointmentStatus (staff), knowledge and insightData (staff; defined in the
// insights module, which owns the fixed report queries).

import { registerContextProvider } from './core';
import { conversationProvider } from './conversation';
import { appointmentStatusProvider, contactBasicsProvider, openDealProvider, orderStatusProvider } from './crm';
import { knowledgeProvider } from './knowledge';
import { insightDataProvider } from '../insights/context-provider';

export * from './core';

for (const provider of [conversationProvider, contactBasicsProvider, openDealProvider, orderStatusProvider, appointmentStatusProvider, knowledgeProvider, insightDataProvider]) {
  registerContextProvider(provider);
}
