import { describe, expect, it } from 'vitest';

import ReplyBox from '../ReplyBox.vue';

const syncStoredDraft = ReplyBox.watch.storedDraftMessage;
const exposeMyinvestSupportBridge =
  ReplyBox.methods.exposeMyinvestSupportBridge;
const removeMyinvestSupportBridge =
  ReplyBox.methods.removeMyinvestSupportBridge;

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

describe('ReplyBox MyInvest support bridge', () => {
  it('exposes live composer state on the owned DOM node and removes it on cleanup', () => {
    const replyEditor = {};
    const context = {
      replyEditor,
      message: 'Erster Entwurf',
      isPrivate: false,
      isEditorDisabled: false,
      replyType: 'REPLY',
      currentChat: { id: 77, messages: [{ id: 55 }] },
      toggleSignatureForDraft: value => `normalized:${value}`,
    };

    exposeMyinvestSupportBridge.call(context);

    expect('__vueParentComponent' in replyEditor).toBe(false);
    expect(replyEditor.myinvestSupportReplyBox.read()).toEqual({
      isPrivate: false,
      isEditorDisabled: false,
      replyType: 'REPLY',
      message: 'Erster Entwurf',
      currentChat: context.currentChat,
    });
    context.message = 'Bearbeitet';
    expect(replyEditor.myinvestSupportReplyBox.read().message).toBe(
      'Bearbeitet'
    );
    expect(replyEditor.myinvestSupportReplyBox.normalizeDraft('Text')).toBe(
      'normalized:Text'
    );

    removeMyinvestSupportBridge.call(context);
    expect(replyEditor.myinvestSupportReplyBox).toBeUndefined();
  });
});
