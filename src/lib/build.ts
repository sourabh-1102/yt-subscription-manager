declare const __BUILD_ID__: string;

/** Identifies this build; the dashboard compares it with the service worker's. */
export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';
