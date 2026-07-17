import { LeadStage } from './lead-intelligence';

export function inventoryResponseByStage(stage: LeadStage): string {
  switch (stage) {
    case 'hot':
      return (
        'These are in the mix right now — solid options to move on. ' +
        'Pick one and I’ll pull details, payments, or a test drive.'
      );

    case 'warm':
      return (
        'Here are a few that fit what you said — I’d start with these. ' +
        'Tell me if you want cheapest payment, lowest miles, or newest year.'
      );

    default:
      return (
        'Here are some solid matches based on what you told me. ' +
        'Tap one to go deeper, or tell me if you want to tighten price or miles.'
      );
  }
}
