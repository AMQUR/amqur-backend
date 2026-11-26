import type { GroupOrigin } from './group-routing.types';

export const GROUP_SITE_LEAD_SOURCE = 'group_site';

/**
 * Lead source for a rooftop conversation. A sales lead that came through the group site is
 * marked `group_site` so the rooftop's staff can see where it came from. Service and parts
 * leads keep `widget_service` / `widget_parts`: lead delivery picks the department from
 * those exact values, and routing must not change because of where the customer started.
 */
export function leadSourceFor(
  origin: GroupOrigin | undefined,
  source: 'widget' | 'widget_service' | 'widget_parts',
): string {
  return origin && source === 'widget' ? GROUP_SITE_LEAD_SOURCE : source;
}
