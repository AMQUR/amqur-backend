import { isRecallQuestion } from './recall';

describe('isRecallQuestion', () => {
  it.each([
    'What am I trading in, and how many miles are on it?',
    "What's my budget at this point?",
    "Two things: what was the first question I asked you, and what's my budget now?",
    "What's my total now?",
    "What's my name again?",
    'What did I ask you right before this message?',
    'What color and body style am I looking for right now?',
    'How many kids did I mention, and how long is my commute?',
    'Give me a short summary of everything you know about me and what I want.',
    'Do you remember what I said about towing?',
    '¿Cuál es mi presupuesto ahora?',
  ])('recall: %s', (m) => expect(isRecallQuestion(m)).toBe(true));

  it.each([
    "What's my trade worth?",
    'What is my trade-in value?',
    'My trade-in is a 2014 Chevy Cruze with 127,000 miles',
    "What's my payment on the second one?",
    'I want to trade in my truck',
    'Do you have anything under $20,000?',
    'Book a test drive tomorrow',
    'What are your hours?',
    'Change of plans: raise my budget by $5,500.',
  ])('not recall: %s', (m) => expect(isRecallQuestion(m)).toBe(false));
});
