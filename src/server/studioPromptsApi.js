// Persona roster editing, backed by promptsUtil.js (dataDir/prompts.json,
// read fresh on every access -- edits here take effect on the next script
// generated, no restart needed). Registered under the /studio prefix (see
// studioAuth.js).
//
// Val 28 ("samo skripte brez AI modelov"): the script-review prompt editor
// is gone with the AI layer -- the review pass was an LLM step, and
// template-rendered scripts can't drift, so there is nothing to review.
import { loadPersonas, savePersonas } from '../scheduler/promptsUtil.js';

export function registerStudioPromptsApi(fastify) {
  fastify.get('/api/personas', () => ({ personas: loadPersonas() }));

  fastify.put('/api/personas', async (request, reply) => {
    const { personas } = request.body ?? {};
    if (!personas || typeof personas !== 'object') {
      return reply.code(400).send({ error: '"personas" object is required.' });
    }
    await savePersonas(personas);
    return { personas };
  });
}
