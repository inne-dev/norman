export const OLLAMA_RAM_THRESHOLD_BYTES = 16_000_000_000;

const model = (name, tag, size, comparison) => ({ name, tag, size, comparison });

// Approximate local tradeoffs; verify tags and download sizes against Ollama's model pages.
export const OLLAMA_RECOMMENDATIONS = Object.freeze([
  {
    minRamGb: 8,
    recommended: model('Qwen 3.5 4B', 'qwen3.5:4b', '3,3–4 ГБ', 'Быстрее крупных моделей; меньше запас на сложных задачах.'),
    alternatives: [model('DeepSeek R1 8B', 'deepseek-r1:8b', '5,2 ГБ', 'Лучше рассуждает, но медленнее Qwen 4B.')],
  },
  {
    minRamGb: 16,
    recommended: model('Gemma 4 12B', 'gemma4:12b', '7,7–8 ГБ', 'Баланс качества и скорости; медленнее 9B.'),
    alternatives: [
      model('Qwen 3.5 9B', 'qwen3.5:9b', '6,6–7,6 ГБ', 'Быстрее 12B/14B, но слабее на сложных задачах.'),
      model('DeepSeek R1 14B', 'deepseek-r1:14b', '9 ГБ', 'Лучше рассуждает; требует больше времени и памяти.'),
    ],
  },
  {
    minRamGb: 24,
    recommended: model('Qwen 3.6 27B Q4', 'qwen3.6:27b-q4_K_M', '17 ГБ', 'Больше запас для сложных задач; Q4 быстрее и легче Q8.'),
    alternatives: [model('Gemma 4 26B A4B', 'gemma4:26b-a4b', '16–19 ГБ', 'MoE-модель; скорость зависит от устройства.')],
  },
  {
    minRamGb: 32,
    recommended: model('Qwen 3.6 27B', 'qwen3.6:27b', '18–19 ГБ', 'Больше запас, чем у 12B/14B; нужно больше памяти.'),
    alternatives: [
      model('Gemma 4 31B Q4', 'gemma4:31b-it-q4_K_M', '20 ГБ', 'Крупнее 27B; обычно медленнее.'),
      model('Qwen 3.6 35B Q4', 'qwen3.6:35b-a3b-q4_K_M', '24 ГБ', 'MoE-модель; скорость зависит от GPU.'),
    ],
  },
  {
    minRamGb: 40,
    recommended: model('Qwen 3.6 27B Q8', 'qwen3.6:27b-q8_0', '30 ГБ', 'Q8 может быть точнее Q4, но требует больше памяти и времени.'),
    alternatives: [model('Qwen 3.6 35B Q4', 'qwen3.6:35b-a3b-q4_K_M', '24 ГБ', 'MoE-модель; скорость зависит от GPU.')],
  },
  {
    minRamGb: 48,
    recommended: model('Qwen 3.6 35B Q8', 'qwen3.6:35b-a3b-q8_0', '39 ГБ', 'MoE 35B в Q8; требует больше памяти и времени.'),
    alternatives: [model('Qwen 3.6 27B Q8', 'qwen3.6:27b-q8_0', '30 ГБ', 'Q8 может быть точнее Q4, но требует больше памяти и времени.')],
  },
  {
    minRamGb: 64,
    recommended: model('Qwen3-Next 80B', 'qwen3-next:80b', '50 ГБ', 'MoE-модель; нужна большая память.'),
    alternatives: [model('Qwen 3.6 35B Q8', 'qwen3.6:35b-a3b-q8_0', '39 ГБ', 'MoE 35B в Q8; требует больше памяти и времени.')],
  },
  {
    minRamGb: 96,
    recommended: model('gpt-oss 120B', 'gpt-oss:120b', '65 ГБ', 'Сильные рассуждения; высокие требования к ресурсам.'),
    alternatives: [model('Qwen 3.5 122B', 'qwen3.5:122b', '81 ГБ · погранично', 'Крупнее 120B; нужна почти вся доступная память.')],
  },
  {
    minRamGb: 128,
    recommended: model('Qwen 3.5 122B', 'qwen3.5:122b', '81 ГБ', 'Крупная модель; требует много памяти и времени.'),
    alternatives: [model('gpt-oss 120B', 'gpt-oss:120b', '65 ГБ', 'Сильные рассуждения; высокие требования к ресурсам.')],
  },
  {
    minRamGb: 192,
    recommended: model('Qwen 3 235B Q4', 'qwen3:235b-a22b-q4_K_M', '142 ГБ', 'Максимальный запас; нужно очень много памяти.'),
    alternatives: [model('Qwen 3.5 122B', 'qwen3.5:122b', '81 ГБ', 'Крупная модель; требует много памяти и времени.')],
  },
]);

export function recommendationForMemory(totalMemoryBytes) {
  if (!Number.isFinite(totalMemoryBytes)) return null;
  const ramGb = totalMemoryBytes / 1_000_000_000;
  return [...OLLAMA_RECOMMENDATIONS].reverse().find((row) => ramGb >= row.minRamGb) || null;
}

export function allModelsForRecommendation(recommendation) {
  if (!recommendation) return [];
  return [recommendation.recommended, ...recommendation.alternatives];
}
