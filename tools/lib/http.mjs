/**
 * Network access for tools/ scripts. Use this fetch, never Node's global one.
 *
 * jsdom 30 depends on undici 8. When undici 8 loads before Node's built-in fetch (undici 7) has
 * created its dispatcher, it installs itself as the global dispatcher behind a compatibility
 * wrapper, and Node's fetch then returns compressed (br) bodies undecoded. Whether that happens
 * depends on import order, so use undici 8 end to end instead.
 */
export { fetch, FormData } from 'undici';
