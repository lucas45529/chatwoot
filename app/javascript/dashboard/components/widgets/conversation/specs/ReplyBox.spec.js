import { describe, expect, it } from 'vitest';

import ReplyBox from '../ReplyBox.vue';

const syncStoredDraft = ReplyBox.watch.storedDraftMessage;

describe('ReplyBox external draft synchronization', () => {
  it('replaces an untouched AI draft with the fresher stored draft', () => {
    const context = {
      message: 'Alter Entwurf',
      toggleSignatureForDraft: value => value,
    };

    syncStoredDraft.call(context, 'Neuer Entwurf', 'Alter Entwurf');

    expect(context.message).toBe('Neuer Entwurf');
  });

  it('preserves a human edit made after the previous AI draft', () => {
    const context = {
      message: 'Von Lucas bearbeitet',
      toggleSignatureForDraft: value => value,
    };

    syncStoredDraft.call(context, 'Neuer Entwurf', 'Alter Entwurf');

    expect(context.message).toBe('Von Lucas bearbeitet');
  });
});
