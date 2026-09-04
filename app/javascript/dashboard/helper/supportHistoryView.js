import wootConstants from 'dashboard/constants/globals';

const SUPPORT_HISTORY_MARKER = '1';

export const isSupportHistoryView = route =>
  route.name === 'home' &&
  route.query?.support_history === SUPPORT_HISTORY_MARKER;

export const getInitialConversationListFilters = ({ route, uiSettings }) => {
  const { conversations_filter_by: filterBy = {} } = uiSettings;
  const { status, order_by: orderBy } = filterBy;
  const sortBy = Object.values(wootConstants.SORT_BY_TYPE).includes(orderBy)
    ? orderBy
    : wootConstants.SORT_BY_TYPE.LAST_ACTIVITY_AT_DESC;

  if (isSupportHistoryView(route)) {
    return {
      assigneeType: wootConstants.ASSIGNEE_TYPE.ALL,
      status: wootConstants.STATUS_TYPE.ALL,
      sortBy,
    };
  }

  return {
    assigneeType: wootConstants.ASSIGNEE_TYPE.ME,
    status: status || wootConstants.STATUS_TYPE.OPEN,
    sortBy,
  };
};
