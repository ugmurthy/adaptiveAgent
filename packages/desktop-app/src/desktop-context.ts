import { getContext } from 'svelte';
import type { DesktopApi } from './desktop';

export const DESKTOP_API_CONTEXT = Symbol('desktop-api');

export function desktopApi(): DesktopApi {
  const api = getContext<DesktopApi>(DESKTOP_API_CONTEXT);
  if (!api) throw new Error('Agent workspace API is unavailable.');
  return api;
}
