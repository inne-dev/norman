export const OLLAMA_RAM_THRESHOLD_BYTES = 16_000_000_000;

const model = (name, tag, size, comparison) => ({ name, tag, size, comparison });

// Approximate local tradeoffs; verify tags and download sizes against Ollama's model pages.
export const OLLAMA_RECOMMENDATIONS = Object.freeze([
  {
    minRamGb: 8,
    recommended: model('Qwen 3.5 4B', 'qwen3.5:4b', '3,3–4 ГБ', 'Компактная модель, обычно быстрее крупных; на сложных задачах запас может быть меньше.'),
    alternatives: [model('DeepSeek R1 8B', 'deepseek-r1:8b', '5,2 ГБ', 'С упором на рассуждения; может отвечать медленнее, чем Qwen 4B.')],
  },
  {
    minRamGb: 16,
    recommended: model('Gemma 4 12B', 'gemma4:12b', '7,7–8 ГБ', 'Баланс памяти и качества; потенциально лучше на сложных задачах, чем 9B, но медленнее.'),
    alternatives: [
      model('Qwen 3.5 9B', 'qwen3.5:9b', '6,6–7,6 ГБ', 'Компактнее 12B/14B и обычно быстрее; на сложных задачах запас может быть меньше.'),
      model('DeepSeek R1 14B', 'deepseek-r1:14b', '9 ГБ', 'Модель с упором на рассуждения; обычно требует больше памяти и времени, чем 9B.'),
    ],
  },
  {
    minRamGb: 24,
    recommended: model('Qwen 3.6 27B Q4', 'qwen3.6:27b-q4_K_M', '17 ГБ', 'Крупнее моделей 12–14B; Q4 экономит память и обычно быстрее Q8.'),
    alternatives: [model('Gemma 4 26B A4B', 'gemma4:26b-a4b', '16–19 ГБ', 'MoE-модель 26B с 4B активными параметрами; фактическая скорость зависит от устройства.')],
  },
  {
    minRamGb: 32,
    recommended: model('Qwen 3.6 27B', 'qwen3.6:27b', '18–19 ГБ', 'Крупная модель с большим запасом для сложных задач; требует больше памяти, чем 12–14B.'),
    alternatives: [
      model('Gemma 4 31B Q4', 'gemma4:31b-it-q4_K_M', '20 ГБ', 'Плотная модель большего размера; может работать медленнее Qwen 27B.'),
      model('Qwen 3.6 35B Q4', 'qwen3.6:35b-a3b-q4_K_M', '24 ГБ', 'MoE 35B с 3B активными параметрами; высокая ёмкость, скорость зависит от GPU.'),
    ],
  },
  {
    minRamGb: 40,
    recommended: model('Qwen 3.6 27B Q8', 'qwen3.6:27b-q8_0', '30 ГБ', 'Менее агрессивная квантовка, чем Q4; потенциально выше точность, но больше памяти и времени.'),
    alternatives: [model('Qwen 3.6 35B Q4', 'qwen3.6:35b-a3b-q4_K_M', '24 ГБ', 'MoE 35B с 3B активными параметрами; высокая ёмкость, скорость зависит от GPU.')],
  },
  {
    minRamGb: 48,
    recommended: model('Qwen 3.6 35B Q8', 'qwen3.6:35b-a3b-q8_0', '39 ГБ', 'Менее агрессивная квантовка 35B MoE; требует больше памяти, скорость зависит от GPU.'),
    alternatives: [model('Qwen 3.6 27B Q8', 'qwen3.6:27b-q8_0', '30 ГБ', 'Менее агрессивная квантовка, чем Q4; потенциально выше точность, но больше памяти и времени.')],
  },
  {
    minRamGb: 64,
    recommended: model('Qwen3-Next 80B', 'qwen3-next:80b', '50 ГБ', 'MoE 80B с 3B активными параметрами; экономнее в расчётах, но требует много памяти.'),
    alternatives: [model('Qwen 3.6 35B Q8', 'qwen3.6:35b-a3b-q8_0', '39 ГБ', 'Менее агрессивная квантовка 35B MoE; требует больше памяти, скорость зависит от GPU.')],
  },
  {
    minRamGb: 96,
    recommended: model('gpt-oss 120B', 'gpt-oss:120b', '65 ГБ', 'Модель для сильных рассуждений; очень ресурсоёмкая и может отвечать медленно.'),
    alternatives: [model('Qwen 3.5 122B', 'qwen3.5:122b', '81 ГБ · погранично', 'Ещё крупнее; занимает почти всю доступную память и может работать медленно.')],
  },
  {
    minRamGb: 128,
    recommended: model('Qwen 3.5 122B', 'qwen3.5:122b', '81 ГБ', 'Крупная модель с большим запасом для сложных задач; требует много памяти и времени.'),
    alternatives: [model('gpt-oss 120B', 'gpt-oss:120b', '65 ГБ', 'Модель для сильных рассуждений; очень ресурсоёмкая и может отвечать медленно.')],
  },
  {
    minRamGb: 192,
    recommended: model('Qwen 3 235B Q4', 'qwen3:235b-a22b-q4_K_M', '142 ГБ', 'Самая крупная модель в списке; требует очень много памяти и производительное устройство.'),
    alternatives: [model('Qwen 3.5 122B', 'qwen3.5:122b', '81 ГБ', 'Крупная модель с большим запасом для сложных задач; требует много памяти и времени.')],
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
