import { shallowMount } from '@vue/test-utils';
import { vi } from 'vitest';

import ReplyBottomPanel from '../ReplyBottomPanel.vue';

vi.mock('activestorage', () => ({ start: vi.fn() }));
vi.mock('dashboard/composables/useKeyboardEvents', () => ({
  useKeyboardEvents: vi.fn(),
}));
vi.mock('dashboard/composables/useUISettings', () => ({
  useUISettings: () => ({
    setSignatureFlagForInbox: vi.fn(),
    fetchSignatureFlagFromUISettings: vi.fn(() => false),
  }),
}));

const NextButtonStub = {
  name: 'NextButton',
  props: {
    label: { type: String, default: '' },
    icon: { type: String, default: '' },
    type: { type: String, default: 'button' },
    disabled: { type: Boolean, default: false },
    color: { type: String, default: '' },
  },
  emits: ['click'],
  template: `
    <button
      :type="type"
      :disabled="disabled"
      :data-icon="icon"
      :data-color="color"
      @click="$emit('click')"
    >
      {{ label }}
    </button>
  `,
};

const mountPanel = (props = {}) =>
  shallowMount(ReplyBottomPanel, {
    props: {
      conversationId: 67,
      portalSlug: '',
      inbox: {
        channel_type: 'Channel::Whatsapp',
        provider: 'whatsapp_cloud',
      },
      sendButtonText: 'Senden',
      ...props,
    },
    global: {
      mocks: {
        $t: key => key,
        $store: {
          getters: {
            getCurrentAccountId: 1,
            'accounts/isFeatureEnabledonAccount': () => false,
            'integrations/getUIFlags': { isFetching: false },
          },
        },
      },
      stubs: {
        NextButton: NextButtonStub,
        FileUpload: true,
        VideoCallButton: true,
        'fluent-icon': true,
        transition: false,
      },
    },
  });

describe('ReplyBottomPanel', () => {
  it('shows the WhatsApp template action where Send normally sits after the 24-hour window expires', async () => {
    const wrapper = mountPanel({
      enableWhatsAppTemplates: true,
      isEditorDisabled: true,
      isSendDisabled: true,
    });

    const action = wrapper.find('.right-wrap button');

    expect(action.attributes('data-icon')).toBe('i-ph-whatsapp-logo');
    expect(action.attributes('data-color')).toBe('blue');
    expect(action.text()).toBe('CONVERSATION.FOOTER.WHATSAPP_TEMPLATES');
    expect(action.attributes('disabled')).toBeUndefined();
    expect(
      wrapper.find('.left-wrap [data-icon="i-ph-whatsapp-logo"]').exists()
    ).toBe(false);

    await action.trigger('click');
    expect(wrapper.emitted('selectWhatsappTemplate')).toHaveLength(1);
  });

  it('keeps the compact template shortcut and regular Send action while free replies are allowed', () => {
    const wrapper = mountPanel({
      enableWhatsAppTemplates: true,
      isEditorDisabled: false,
    });

    const shortcut = wrapper.find(
      '.left-wrap [data-icon="i-ph-whatsapp-logo"]'
    );
    const send = wrapper.find('.right-wrap button');

    expect(shortcut.exists()).toBe(true);
    expect(shortcut.text()).toBe('');
    expect(send.text()).toBe('Senden');
    expect(send.attributes('type')).toBe('submit');
  });
});
