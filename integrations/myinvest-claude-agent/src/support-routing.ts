import { tenantKeySchema, type TenantKey } from './domain.js'
import type { SupportChannel } from './support-brain.js'

export interface SupportRoutingMetadata {
  conversationTenant?: unknown
  conversationChannel?: unknown
  sourceTenant?: unknown
}

export interface SupportRoute {
  tenant: TenantKey
  channel: SupportChannel
}

const SUPPORT_CHANNELS = new Set<SupportChannel>(['web', 'whatsapp'])

/** Central bridge conversations carry product identity on both immutable
 * source messages and their conversation. Dedicated legacy accounts predate
 * that metadata and retain their account/inbox-derived route. */
export function resolveSupportRoute(
  metadata: SupportRoutingMetadata | undefined,
  legacyRoute: SupportRoute,
): SupportRoute | undefined {
  const conversationTenant = metadata?.conversationTenant
  const conversationChannel = metadata?.conversationChannel
  const sourceTenant = metadata?.sourceTenant
  if (
    conversationTenant == null &&
    conversationChannel == null &&
    sourceTenant == null
  ) {
    return legacyRoute
  }

  const parsedConversationTenant = tenantKeySchema.safeParse(conversationTenant)
  const parsedSourceTenant = tenantKeySchema.safeParse(sourceTenant)
  if (
    !parsedConversationTenant.success ||
    !parsedSourceTenant.success ||
    parsedConversationTenant.data !== parsedSourceTenant.data ||
    typeof conversationChannel !== 'string' ||
    !SUPPORT_CHANNELS.has(conversationChannel as SupportChannel)
  ) {
    return undefined
  }
  return {
    tenant: parsedConversationTenant.data,
    channel: conversationChannel as SupportChannel,
  }
}
