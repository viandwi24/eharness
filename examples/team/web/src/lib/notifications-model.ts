// The bell (notifications: alerts and the daily digest). Pure.
import type { Notification } from './api/client';

/** Where a notification leads: its own link, else nothing. */
export const notificationLink = (n: Pick<Notification, 'link'>): string | null => (n.link && n.link.startsWith('/') ? n.link : null);
