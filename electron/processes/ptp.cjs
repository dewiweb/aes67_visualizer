/**
 * PTP Monitor Child Process
 * Delegates to protocols/ptp.cjs which listens directly on IEEE 1588
 * ports 319 (event) and 320 (general) and parses Announce/Sync/Follow_Up messages.
 *
 * Emits 'ptp-clocks' with the full list of detected PTP clocks on the network.
 */

// protocols/ptp.cjs contains all logic - just require it here as the child process entry point
require('../protocols/ptp.cjs');
