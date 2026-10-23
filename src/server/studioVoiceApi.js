// Studio voice/script status (issue #2 section B.5). All facts come from
// voiceStatus.js's filesystem scans; this route is a thin projection.
// Read-only: mode switching requires a config.json edit + service restart,
// and the response says so explicitly rather than offering a fake control.
import { voiceStatus } from './voiceStatus.js';

export function registerStudioVoiceApi(fastify) {
  fastify.get('/api/voice', () => voiceStatus());
}
