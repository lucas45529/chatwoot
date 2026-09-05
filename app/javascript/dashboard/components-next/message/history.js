import { MESSAGE_TYPES } from './constants';

/** Only importer-owned source IDs with matching tenant/message markers qualify. */
export const historyProvenance = message => {
  const attributes = message.contentAttributes || {};
  const tenant = attributes.myinvestTenant;
  const id = attributes.myinvestHistoryMessageId;
  if (
    !['saas', 'new_academy', 'legacy_academy'].includes(tenant) ||
    typeof id !== 'string' ||
    !/^[A-Za-z0-9:_-]{8,180}$/.test(id) ||
    attributes.myinvestAgentAction !== 'preprocessed' ||
    ![MESSAGE_TYPES.INCOMING, MESSAGE_TYPES.OUTGOING].includes(
      message.messageType
    )
  ) {
    return null;
  }
  const expectedSource = `mip:history:${tenant}:${id}`;
  const websiteSource = tenant === 'saas' && `mip:web:saas:${id}`;
  if (
    message.sourceId !== expectedSource &&
    message.sourceId !== websiteSource
  ) {
    return null;
  }

  const original = attributes.externalCreatedAt;
  const milliseconds =
    typeof original === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(original)
      ? Date.parse(original)
      : NaN;
  const originalCreatedAt = Number.isFinite(milliseconds)
    ? new Date(milliseconds)
    : null;
  let author = 'unknown';
  if (message.messageType === MESSAGE_TYPES.INCOMING) author = 'customer';
  else if (['bot', 'agent'].includes(attributes.myinvestHistoryAuthor)) {
    author = attributes.myinvestHistoryAuthor;
  }
  return { author, originalCreatedAt };
};
