// Public schedule endpoint (issue #2 section A: "Weekly programme schedule
// with current and next show clearly marked"). All shaping lives in
// scheduleGrid.js so the marking logic is unit-testable without a server.
import { loadSchedule } from '../scheduler/scheduleUtil.js';
import { buildWeeklyGrid } from './scheduleGrid.js';

export function registerScheduleRoute(fastify) {
  fastify.get('/api/schedule', () => buildWeeklyGrid(loadSchedule(), new Date()));
}
