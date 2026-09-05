import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MessageMeta from './MessageMeta.vue';

const mocks = vi.hoisted(() => ({ context: null }));
vi.mock('./provider.js', () => ({ useMessageContext: () => mocks.context }));
vi.mock('dashboard/composables/useInbox', () => ({
  useInbox: () =>
    Object.fromEntries(
      [
        'isAFacebookInbox',
        'isALineChannel',
        'isAPIInbox',
        'isASmsInbox',
        'isATelegramChannel',
        'isATwilioChannel',
        'isAWebWidgetInbox',
        'isAWhatsAppChannel',
        'isAnEmailChannel',
        'isAnInstagramChannel',
        'isATiktokChannel',
      ].map(key => [key, { value: key === 'isAPIInbox' }])
    ),
}));
vi.mock('./MessageStatus.vue', () => ({
  default: { template: '<span data-testid="delivery-status" />' },
}));
vi.mock('next/icon/Icon.vue', () => ({
  default: { template: '<span />' },
}));

const importedAttributes = {
  myinvestAgentAction: 'preprocessed',
  myinvestTenant: 'new_academy',
  myinvestHistoryMessageId: 'history-message-123',
  myinvestHistoryAuthor: 'bot',
  externalCreatedAt: '2026-08-21T09:30:00.000Z',
};
const translation = key => key.split('.').at(-1);
const render = () =>
  mount(MessageMeta, { global: { mocks: { $t: translation } } });

beforeEach(() => {
  mocks.context = {
    status: ref('sent'),
    isPrivate: ref(false),
    createdAt: ref(1788595200),
    sourceId: ref('mip:history:new_academy:history-message-123'),
    messageType: ref(1),
    contentAttributes: ref({ ...importedAttributes }),
  };
});

describe('imported message provenance', () => {
  it('shows the original date and original AI author instead of implying a fresh send', () => {
    const wrapper = render();
    expect(wrapper.text()).toContain('IMPORTED_HISTORY');
    expect(wrapper.text()).toContain('HISTORY_BOT');
    expect(wrapper.find('time').attributes('datetime')).toBe(
      importedAttributes.externalCreatedAt
    );
    expect(wrapper.find('[data-testid="delivery-status"]').exists()).toBe(
      false
    );
  });

  it.each([
    [0, null, 'HISTORY_CUSTOMER'],
    [1, 'agent', 'HISTORY_AGENT'],
    [1, null, 'HISTORY_UNKNOWN'],
  ])(
    'uses the recorded author type without inventing an individual sender',
    (type, author, label) => {
      mocks.context.messageType.value = type;
      mocks.context.contentAttributes.value.myinvestHistoryAuthor = author;
      expect(render().text()).toContain(label);
    }
  );

  it('marks older imports without pretending the import time was the original send time', () => {
    delete mocks.context.contentAttributes.value.externalCreatedAt;
    delete mocks.context.contentAttributes.value.myinvestHistoryAuthor;
    const wrapper = render();
    expect(wrapper.text()).toContain('HISTORY_TIME_UNKNOWN');
    expect(wrapper.find('time').exists()).toBe(false);
    expect(wrapper.find('[data-testid="delivery-status"]').exists()).toBe(
      false
    );
  });

  it.each([
    { source: 'other:message', attrs: importedAttributes },
    {
      source: 'mip:history:saas:history-message-123',
      attrs: importedAttributes,
    },
    {
      source: 'mip:history:new_academy:wrong-message',
      attrs: importedAttributes,
    },
    {
      source: 'mip:history:new_academy:history-message-123',
      attrs: { ...importedAttributes, myinvestAgentAction: 'draft' },
    },
    {
      source: 'mip:web:saas:history-message-123',
      attrs: { myinvestTenant: 'saas', myinvestAgentAction: 'preprocessed' },
    },
  ])(
    'preserves ordinary message time and status without the exact import binding',
    ({ source, attrs }) => {
      mocks.context.sourceId.value = source;
      mocks.context.contentAttributes.value = attrs;
      const wrapper = render();
      expect(wrapper.text()).not.toContain('IMPORTED_HISTORY');
      expect(wrapper.find('[data-testid="delivery-status"]').exists()).toBe(
        true
      );
    }
  );

  it('recognizes website backfills only when their explicit history ID is present', () => {
    mocks.context.sourceId.value = 'mip:web:saas:history-message-123';
    mocks.context.contentAttributes.value.myinvestTenant = 'saas';
    expect(render().text()).toContain('IMPORTED_HISTORY');
  });
});
