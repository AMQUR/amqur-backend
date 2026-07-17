import {
  InventoryPatch,
  InventoryUpdate,
} from '../engines/inventory.extractor';

import { ConversationInventoryState } from './conversation.store';

export function applyInventoryUpdate(
  current: ConversationInventoryState,
  update: InventoryUpdate,
): ConversationInventoryState {
  // reset everything
  if (update.resetAll) {
    return {
      lead: {},
      appointment: {},
    };
  }

  const next: ConversationInventoryState = {
    ...current,
  };

  // remove filters
  for (const key of update.remove) {
    delete (next as any)[key];
  }

  // apply patch
  for (const [key, value] of Object.entries(update.patch)) {
    if (value !== undefined) {
      (next as any)[key] = value;
    }
  }

  return next;
}
