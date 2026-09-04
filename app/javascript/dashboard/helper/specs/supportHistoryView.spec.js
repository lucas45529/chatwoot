import wootConstants from 'dashboard/constants/globals';
import { getInitialConversationListFilters } from '../supportHistoryView';

describe('getInitialConversationListFilters', () => {
  it('shows every status and assignee only for the signed support-history target', () => {
    expect(
      getInitialConversationListFilters({
        route: {
          name: 'home',
          query: { support_history: '1' },
        },
        uiSettings: {
          conversations_filter_by: {
            status: wootConstants.STATUS_TYPE.OPEN,
            order_by: wootConstants.SORT_BY_TYPE.CREATED_AT_ASC,
          },
        },
      })
    ).toEqual({
      assigneeType: wootConstants.ASSIGNEE_TYPE.ALL,
      status: wootConstants.STATUS_TYPE.ALL,
      sortBy: wootConstants.SORT_BY_TYPE.CREATED_AT_ASC,
    });
  });

  it('preserves Chatwoot defaults and saved settings on every normal route', () => {
    expect(
      getInitialConversationListFilters({
        route: {
          name: 'inbox_dashboard',
          query: { support_history: '1' },
        },
        uiSettings: {},
      })
    ).toEqual({
      assigneeType: wootConstants.ASSIGNEE_TYPE.ME,
      status: wootConstants.STATUS_TYPE.OPEN,
      sortBy: wootConstants.SORT_BY_TYPE.LAST_ACTIVITY_AT_DESC,
    });
  });
});
