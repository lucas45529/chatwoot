import { shallowMount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import UpgradePage from '../UpgradePage.vue';
import { useMapGetter, useStore } from 'dashboard/composables/store';
import { useAccount } from 'dashboard/composables/useAccount';
import { useConfig } from 'dashboard/composables/useConfig';
import { useAdmin } from 'dashboard/composables/useAdmin';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';

vi.mock('dashboard/composables/store');
vi.mock('dashboard/composables/useAccount');
vi.mock('dashboard/composables/useConfig');
vi.mock('dashboard/composables/useAdmin');
vi.mock('vue-i18n');
vi.mock('vue-router');

const dispatch = vi.fn();

const mountPage = () =>
  shallowMount(UpgradePage, {
    global: {
      mocks: { $t: key => key },
      stubs: { NextButton: true, Icon: true },
    },
  });

describe('UpgradePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.mockReturnValue({ dispatch });
    useMapGetter.mockReturnValue({ value: false });
    useAccount.mockReturnValue({
      accountId: { value: 1 },
      currentAccount: { value: null },
    });
    useConfig.mockReturnValue({ isEnterprise: true });
    useAdmin.mockReturnValue({ isAdmin: { value: false } });
    useI18n.mockReturnValue({ t: key => key });
    useRouter.mockReturnValue({ push: vi.fn() });
  });

  it('does not request cloud-only account limits when self-hosted', () => {
    mountPage();

    expect(dispatch).not.toHaveBeenCalledWith('accounts/limits');
  });

  it('requests account limits on Chatwoot Cloud enterprise', () => {
    useMapGetter.mockReturnValue({ value: true });

    mountPage();

    expect(dispatch).toHaveBeenCalledWith('accounts/limits');
  });
});
