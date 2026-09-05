import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import MessageList from './MessageList.vue';

vi.mock('./Message.vue', () => ({
  default: {
    props: ['groupWithNext'],
    template: '<li :data-grouped="groupWithNext" />',
  },
}));
vi.mock('dashboard/composables/useTransformKeys', () => ({
  useCamelCase: value => value,
}));
vi.mock('dashboard/composables/store.js', () => ({
  useMapGetter: () => ({ value: null }),
}));
vi.mock('dashboard/api/inbox/message.js', () => ({ default: {} }));

const message = {
  id: 1,
  senderId: 4,
  messageType: 1,
  createdAt: 1788595200,
  status: 'sent',
};
const imported = {
  ...message,
  sourceId: 'mip:history:new_academy:history-message-123',
  contentAttributes: {
    myinvestTenant: 'new_academy',
    myinvestHistoryMessageId: 'history-message-123',
    myinvestAgentAction: 'preprocessed',
    myinvestHistoryAuthor: 'bot',
    externalCreatedAt: '2026-08-21T09:30:00.000Z',
  },
};

describe('history rows retain individual provenance', () => {
  it.each([
    [imported, message],
    [message, imported],
    [imported, imported],
  ])(
    'does not hide provenance by grouping imported messages with their neighbor',
    (first, second) => {
      const wrapper = mount(MessageList, {
        props: { currentUserId: 4, messages: [first, { ...second, id: 2 }] },
      });
      expect(wrapper.find('li').attributes('data-grouped')).toBe('false');
    }
  );

  it('keeps ordinary same-minute sender grouping unchanged', () => {
    const wrapper = mount(MessageList, {
      props: { currentUserId: 4, messages: [message, { ...message, id: 2 }] },
    });
    expect(wrapper.find('li').attributes('data-grouped')).toBe('true');
  });
});
