/**
 * The event name that opens QuickFind.
 *
 * In its own module so a Server Component can import it for a client trigger
 * without pulling the whole QuickFind bundle -- and so the name cannot drift
 * between the dispatcher and the listener.
 */
export const QUICKFIND_OPEN_EVENT = "gml:quickfind-open";
