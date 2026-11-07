export const OLLAMA_RAM_THRESHOLD_BYTES = 16_000_000_000;

const model = (name, tag, size) => ({ name, tag, size });

// shortcut: Ollama has no documented public catalog API; refresh tags from its official pages when updating this table.
export const OLLAMA_RECOMMENDATIONS = Object.freeze([
  {
    minRamGb: 8,
    recommended: model('Qwen 3.5 4B', 'qwen3.5:4b', '3,3–4 ГБ'),
    alternatives: [model('DeepSeek R1 8B', 'deepseek-r1:8b', '5,2 ГБ')],
  },
  {
    minRamGb: 16,
    recommended: model('Gemma 4 12B', 'gemma4:12b', '7,7–8 ГБ'),
    alternatives: [
      model('Qwen 3.5 9B', 'qwen3.5:9b', '6,6–7,6 ГБ'),
      model('DeepSeek R1 14B', 'deepseek-r1:14b', '9 ГБ'),
    ],
  },
  {
    minRamGb: 24,
    recommended: model('Qwen 3.6 27B Q4', 'qwen3.6:27b-q4_K_M', '17 ГБ'),
    alternatives: [model('Gemma 4 26B A4B', 'gemma4:26b-a4b', '16–19 ГБ')],
  },
  {
    minRamGb: 32,
    recommended: model('Qwen 3.6 27B', 'qwen3.6:27b', '18–19 ГБ'),
    alternatives: [
      model('Gemma 4 31B Q4', 'gemma4:31b-it-q4_K_M', '20 ГБ'),
      model('Qwen 3.6 35B Q4', 'qwen3.6:35b-a3b-q4_K_M', '24 ГБ'),
    ],
  },
  {
    minRamGb: 40,
    recommended: model('Qwen 3.6 27B Q8', 'qwen3.6:27b-q8_0', '30 ГБ'),
    alternatives: [model('Qwen 3.6 35B Q4', 'qwen3.6:35b-a3b-q4_K_M', '24 ГБ')],
  },
  {
    minRamGb: 48,
    recommended: model('Qwen 3.6 35B Q8', 'qwen3.6:35b-a3b-q8_0', '39 ГБ'),
    alternatives: [model('Qwen 3.6 27B Q8', 'qwen3.6:27b-q8_0', '30 ГБ')],
  },
  {
    minRamGb: 64,
    recommended: model('Qwen3-Next 80B', 'qwen3-next:80b', '50 ГБ'),
    alternatives: [model('Qwen 3.6 35B Q8', 'qwen3.6:35b-a3b-q8_0', '39 ГБ')],
  },
  {
    minRamGb: 96,
    recommended: model('gpt-oss 120B', 'gpt-oss:120b', '65 ГБ'),
    alternatives: [model('Qwen 3.5 122B', 'qwen3.5:122b', '81 ГБ · погранично')],
  },
  {
    minRamGb: 128,
    recommended: model('Qwen 3.5 122B', 'qwen3.5:122b', '81 ГБ'),
    alternatives: [model('gpt-oss 120B', 'gpt-oss:120b', '65 ГБ')],
  },
  {
    minRamGb: 192,
    recommended: model('Qwen 3 235B Q4', 'qwen3:235b-a22b-q4_K_M', '142 ГБ'),
    alternatives: [model('Qwen 3.5 122B', 'qwen3.5:122b', '81 ГБ')],
  },
]);

export function recommendationForMemory(totalMemoryBytes) {
  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes < OLLAMA_RAM_THRESHOLD_BYTES) return null;
  const ramGb = totalMemoryBytes / 1_000_000_000;
  return [...OLLAMA_RECOMMENDATIONS].reverse().find((row) => ramGb >= row.minRamGb) || null;
}

export function allModelsForRecommendation(recommendation) {
  if (!recommendation) return [];
  return [recommendation.recommended, ...recommendation.alternatives];
}
